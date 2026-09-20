/**
 * 管理 Agent 循环写入 Session surface 的两类上下文消息：system prompt，以及
 * 动态 runtime-context 快照。
 *
 * system prompt 以 `system/message` 保存，可能替换已有节点，也可能在支持
 * in-history 更新的路由上追加新节点。动态上下文以 `user/message` 保存，只在
 * 内容变化时生成候选快照。两个投影都只计算“应提交什么”，真正的 Session
 * append 仍由 `ReactLoopAgent.step()` 在请求接纳边界统一完成。
 *
 * @module @deepseek-ai/dsh-agent-loop/runtime-context
 */

import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSnapshotSection, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, SurfaceIntent, SystemMessage, UserMessage } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

const SOURCE = '@deepseek-ai/dsh-system-prompt'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function textOf(message: Message): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

/** 请求接纳或协调阶段尚未提交的一次 system-prompt surface 操作。 */
export interface SystemPromptCommit {
  /** 渲染后的 prompt 或空内容；空 head 表示无 prompt，空 tail 节点处于休眠状态。 */
  message: SystemMessage
  /** 新 system 节点使用 append，否则替换一个仍在 surface 中的节点。 */
  intent: SurfaceIntent<'system/message'>
}

/** system prompt 决策所依据的 request-series 信息。 */
export interface SystemPromptDecisionInput {
  /** 本次 attempt 的已 prepare 路由是否把后续 system 消息当作有效 prompt。 */
  inHistory: boolean
  /**
   * 当前 step 是否开始新的模型消息序列：pre-step 监听器显式声明、上次请求后
   * surface 被替换，或本次组装的工具 schema 与日志中的 header 不同。
   */
  startsSeries: boolean
}

/** 从最新事件开始反向读取；恢复投影找到首个匹配项后即可停止。 */
function eventsNewestFirst(session: Session): readonly SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents().toReversed()
}

/**
 * 计算渲染后的 system prompt 应如何进入 surface，但不负责实际提交。首个 prompt
 * 即使为空，也会预留 surface 节点 0。支持 in-history 且仍在同一 series 的路由，
 * 会把变化后的非空文本追加到可缓存历史之后；不支持该能力、series 已断开或
 * prompt 被清空时，则统一改写首个 system 节点并清空后续活动节点。已为空的
 * tail 节点不提供有效文本，也不需要重复替换。
 */
export class SystemPromptProjection {
  constructor(private readonly session: Session) {}

  /** 按 surface 顺序返回仍存活的 system/message 节点。 */
  private systemNodes(): { seq: SessionSeq; text: string | undefined }[] {
    const nodes: { seq: SessionSeq; text: string | undefined }[] = []
    for (const seq of this.session.surface.nodes) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = this.session.eventAt(seq)
      if (event?.type !== 'system/message') continue
      const content = event.data.message.content
      const text = content.length === 0 ? '' : textOf(event.data.message)
      nodes.push({ seq, text })
    }
    return nodes
  }

  /**
   * 根据已 prepare 路由与 series 状态，协调有效文本和保留节点。
   * @param rendered - 完整渲染后的 system prompt；没有活动 prompt 时为 `''`。
   * @param input - 当前 step 的路由能力与 series 信息。
   * @returns 按顺序执行的逐节点更新；空数组表示无需更新。
   */
  project(rendered: string, input: SystemPromptDecisionInput): SystemPromptCommit[] {
    const nodes = this.systemNodes()
    const head = nodes[0]
    if (head === undefined) {
      return [{ message: createSystemMessage(rendered, SOURCE), intent: { surfaceOp: 'append' } }]
    }
    const latest = nodes.findLast(node => node.text !== '') ?? head
    if (!input.inHistory || input.startsSeries || rendered.length === 0) {
      const updates = nodes.slice(1).filter(node => node.text !== '')
        .map(node => this.replace(node.seq, ''))
      if (head.text !== rendered) updates.push(this.replace(head.seq, rendered))
      return updates
    }
    if (latest.text === rendered) return []
    return [{ message: createSystemMessage(rendered, SOURCE), intent: { surfaceOp: 'append' } }]
  }

  private replace(seq: SessionSeq, text: string): SystemPromptCommit {
    return {
      message: createSystemMessage(text, SOURCE),
      intent: { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    }
  }
}

/** 跟踪 surface 中最后保留的 runtime-context 快照，但不负责提交。 */
export class RuntimeContextProjection {
  /** undefined 表示从未存在快照；null 表示曾经存在，但当前没有保留节点。 */
  private retained: { seq: SessionSeq; text: string | undefined } | null | undefined

  /**
   * 构造时从现有 Session 恢复一次投影状态，之后跟随权威 session/event 更新。
   * @param ctx - Agent scope 内的事件 Context。
   * @param session - 接收投影消息的 Session。
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (const event of eventsNewestFirst(session)) {
      if (event.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
        break
      }
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
      } else if (this.retained
        && isReplacementSurfaceEvent(event)
        && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = null
      }
    })
  }

  /**
   * 仅当当前内容与保留值不同时创建尚未提交的快照。
   * @param current - 完整渲染后的动态上下文。
   * @param sections - 组成当前快照的具名贡献项。
   * @returns 候选 user 消息；无需更新时返回 undefined。
   */
  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      // 清空标记已不再包含任何贡献项，因此不记录 sections 归属。
      source: sections.length === 0
        ? { kind: 'plugin', plugin: SOURCE }
        : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections },
    })
  }
}
