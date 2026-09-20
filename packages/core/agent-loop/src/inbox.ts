/**
 * 由驱动器负责的持久 Agent Inbox 投影与命令门面。
 *
 * Inbox 包含两个调度语义不同的队列。`next-turn` 保存普通 prompt，每个 turn 的
 * 第一个 step 最多领取一条；`next-step` 保存 steering、注入上下文和工具产生的
 * 上下文，每次 step claim 会先清空该队列，再按需领取一条 `next-turn` prompt。
 *
 * 待处理数组从来不是 Agent 上的权威可变字段。每次修改都会追加一条
 * `agent/inbox/spliced` Session 事件，下面的投影同步把事件折叠为当前状态。
 * 因此待处理工作可在重启后回放，取消操作也能记录尚未进入 turn 就被移除的消息。
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  AgentEventDispatch,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
  InboxWireState,
} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'

/** 对由持久 Inbox splice 重建出的待处理 Agent 输入执行 wire 校验。 */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/**
 * 从规范化 splice 事件重建待处理输入的标准 fold。实时写入方虽已执行同样规则，
 * 但回放数据跨越了持久化边界，因此仍需校验坐标和消息标识唯一性。
 */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event) {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    try {
      // 持久 splice 必须使用已规范化的非负坐标。遇到不可能的历史时直接拒绝，
      // 避免静默投影出一份与原进程观察结果不同的队列。
      const inbox = state[splice.target]
      const removedCount = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || splice.start + removedCount > inbox.length) {
        throw new Error('invalid inbox splice')
      }
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step']]
        : [...state['next-turn'], ...next]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      return splice.target === 'next-turn'
        ? { 'next-turn': next, 'next-step': state['next-step'] }
        : { 'next-turn': state['next-turn'], 'next-step': next }
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // wire 值就是 fold 状态本身：每条待处理消息已经在 Session 日志中以无损
    // JSON 往返。这里仅把静态类型收窄为投影表中的 JSON-safe 类型。
    viewSchema: inboxProjectionSchema as unknown as z.ZodType<InboxWireState>,
    view: (state: InboxState) => state as unknown as InboxWireState,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'inbox', InboxState>

/**
 * ReactLoopAgent 使用的持久 Inbox 投影命令门面。方法负责追加事件，getter 读取
 * 由这些事件更新的投影。inserted/claimed/discarded 实时通知在持久变更之后才
 * 发出，因此观察者读取到的始终是更新后的投影状态。
 * @param projections - 已由 AgentLoop 注册标准 Inbox 投影的注册表。
 * @param session - 通过持久事件保存待处理输入的 Session。
 * @param dispatch - 发布 Inbox 生命周期事件的 Agent scope 分发器。
 */
export class ReactLoopInbox implements InboxContract {
  constructor(
    private readonly projections: SessionProjectionRegistry,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  /** 等待各自独立 turn 的普通 prompt。 */
  get nextTurn(): readonly UserMessage[] {
    return this.current()['next-turn']
  }

  /** 等待下一个 step 边界的 steering 或补充上下文。 */
  get nextStep(): readonly UserMessage[] {
    return this.current()['next-step']
  }

  /** 两个待处理队列中是否至少有一个仍包含工作。 */
  get hasPending(): boolean {
    const state = this.current()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /** 持久取消全部待处理输入；先清 next-step，再清 next-turn。 */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * 移除并返回一个候选 step 的完整输入批次。
   * @param target - 该边界是否还需要消费一条 next-turn 输入。
   * @param turn - 拥有本批已领取消息的 turn。
   * @returns next-step 输入在前；需要时，末尾再跟一条 next-turn 输入。
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    // step 本地上下文排在可选普通 prompt 前面。这样 steering 或工具上下文可以
    // 影响下一次请求，同时不会饿死打开新 turn 的那条排队 prompt。
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /**
   * 在指定待处理队列末尾追加一条消息。
   * @param target - 要扩展的待处理队列。
   * @param message - 要追加的消息。
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.current()[target].length, 0, [message])
  }

  /**
   * 在指定待处理队列开头插入一条消息。
   * @param target - 要扩展的待处理队列。
   * @param message - 要前插的消息。
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * 原位替换一条仍在等待的消息。
   * @param messageId - 要替换的待处理消息标识。
   * @param newMessage - 替换消息。
   * @returns 原消息是否仍在待处理队列中并已被替换。
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * 移除一条仍在等待的消息。
   * @param messageId - 要移除的待处理消息标识。
   * @returns 原消息是否仍在待处理队列中并已被移除。
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * 按标准 splice 语义修改队列，并持久记录规范化后的结果。
   * @param target - 要修改的待处理队列。
   * @param start - splice 起始位置。
   * @param deleteCount - 最多移除的消息数量。
   * @param inserted - 要插入到解析后位置的消息。
   * @returns 本次 splice 实际移除的消息。
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** 在两个队列中查找一个待处理消息标识。 */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.current()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** 读取当前持久投影状态；投影未注册表示生命周期装配错误。 */
  private current(): InboxState {
    const state = this.projections.stateOf(this.session, 'inbox')
    if (state === undefined) {
      throw new Error(
        `agent "${this.session.id}" cannot read inbox state: its projection registration is not active`,
      )
    }
    return state
  }

  /**
   * 规范化 JavaScript splice 坐标，校验跨队列消息标识，追加持久事件，再发布
   * 实时通知。`discardRemoved` 用来区分调用方取消/编辑与驱动器 claim：两者都
   * 会移除消息，但只有前者把消息标记为未执行即取消。
   */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const state = this.current()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    // 消息标识在整个 Inbox 中唯一，而不只是队列内唯一。因此替换或移动消息
    // 不能为同一逻辑输入制造两个仍存活的句柄。
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    // Session.append 会同步推进已注册投影。随后再 dispatch，保证监听器读取到
    // 权威的变更后状态。
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
