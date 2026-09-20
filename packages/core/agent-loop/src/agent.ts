/**
 * 默认 Agent 驱动器，负责处理排队的 turn 输入与 step 边界输入。
 *
 * 驱动器编排四个由不同服务负责的能力：
 *
 * - {@link ReactLoopInbox} 保存尚未进入 step 的工作；
 * - `ctx.systemPrompt` 与 `agent/pre-step` 组装并接纳 step 输入；
 * - `ctx.llm` 根据 Session 派生的消息生成 assistant 流；
 * - `ctx.tools` 执行工具调用，并可为下一个 step 追加上下文。
 *
 * Session 是这些阶段之间的事实来源。驱动器先提交全部模型可见的 system
 * 与 user 输入，再打开模型流；先提交完整的 assistant attempt，再执行其中的
 * 工具；先提交工具结果，再派生下一次请求。因此请求始终从持久事件重建，
 * 不存在另一份可能与 Session 不一致的私有对话数组。
 *
 * 建议按 `send()` -> `wakeDriver()` -> `kick()` -> `turn()` -> `preStep()` ->
 * `step()` -> `prepareRequest()` -> `buildRequest()` 的顺序阅读。step 可能留下
 * 待处理的工具上下文，使 `turn()` 继续下一个 step；待处理的 next-turn 输入
 * 则会让 `kick()` 打开一个新的 turn。
 *
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  LlmError,
  createAssistantMessage,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Context } from '@deepseek-ai/cordis'
import { ReactLoopInbox } from './inbox.ts'
import { RuntimeContextProjection } from './runtime-context.ts'
import { AssistantStreamAttempt } from './assistant-stream.ts'
import { SystemPromptProjection } from './runtime-context.ts'
import { executeToolCalls } from './tool-calls.ts'

/**
 * 一个驱动器实例唯一的可变生命周期状态。
 *
 * `idle` 只保留最后一个持久 turn 编号；`maintenance` 在 setup 或其他非 turn
 * 操作期间独占 Agent；`running` 持有当前取消信号及 turn/step 计数器。
 * `wakeRequested` 记住当前活动无法消费的唤醒请求，使活动收敛后可以启动新
 * 驱动器，同时保证同一 Agent 不会并发运行两个驱动器。
 */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** 成功的 step 可以正常结束 turn，也可以保留达到 token 上限的结果。 */
type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

/**
 * 提交 `step/start` 之前的接纳结果。enter 决策携带当前 step 实际使用的消息
 * 与 prompt 组装结果；同一 step 内的重试复用二者，不会再次执行接纳阶段。
 */
type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
    assembly: PromptAssembly
  }

/** 插件提出下一次请求配置前，移除由 adapter 推导出的默认值。 */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/**
 * 驱动一个已挂接的 Session，串行通过 turn 与 step 边界。
 *
 * 公开输入方法只修改持久 Inbox，并按需唤醒驱动器；私有驱动器负责写入全部
 * Session turn/step 事件。这样，请求执行期间到达的 steering 只会进入下一
 * 个 step，不会修改已经发出的请求。
 */
export class ReactLoopAgent implements Agent {
  readonly inbox: ReactLoopInbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** Agent 级注册作用域；生命周期所有者在驱动器退出后撤销其中的注册。 */
  readonly scope: Scope
  readonly ctx: Context

  /** 绑定 Agent 与作用域的事件分发器；构造一次，避免热路径重复分配。 */
  private readonly dispatch: AgentEventDispatch

  /** 当前挂接实例是否已经写入首个 request-header 锚点。 */
  private requestHeaderLogged = false
  /** 挂接时或上一次构建请求时的 Session surface 版本。 */
  private requestSurfaceGeneration: number
  private readonly runtimeContext: RuntimeContextProjection
  /** 当前进程中，这个已挂接 Session 的 assistant frame 修订号。 */
  private assistantStreamRevision = 0
  /** 仅用于标识当前进程实时 frame 的单调递增 attempt 编号。 */
  private assistantAttemptCounter = 0
  private readonly systemPrompt: SystemPromptProjection
  /** 已由本循环完整冻结的消息对象；弱引用不会阻止被替换历史的回收。 */
  private readonly frozenMessages = new WeakSet<Message>()

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    // 构造函数只把辅助对象挂到已准备的 Session，不发布或启动 Agent；
    // 发布与启动由 AgentLoop 的生命周期事务负责。
    this.requestSurfaceGeneration = session.surface.contentGeneration
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.inbox = new ReactLoopInbox(this.ctx.sessionProjections, session, this.dispatch)
    /* v8 ignore next -- the loop registers its own turnBoundary unit, so the key is always present */
    const lastTurn = this.loopCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    this.systemPrompt = new SystemPromptProjection(session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** 提交内部 phase，并在公开 status 发生变化时发布通知。 */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  /**
   * 把一条消息存入持久 Inbox，并按需调度执行。活动信号已经中止后到达的
   * 唤醒消息属于新 turn；旧驱动器此时只负责排空，不能再安全领取新输入。
   */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // 唤醒输入不能加入已中止的活动，因此必须进入下一个 turn。这里在插入
    // 前完成判断，避免 splice 观察者重入 cancel 后改变这条消息的分类。
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  /** 将普通用户输入排入独立 turn，并唤醒空闲 Agent。 */
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  /** 将紧急输入排入当前 turn 的下一个 step，并唤醒 Agent。 */
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  /** 将补充上下文排入下一个 step，但不单独触发执行。 */
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  /**
   * 协作式中止当前活动，默认同时取消队列中的输入。模型流与工具执行观察
   * 同一个 phase 信号；清空 Inbox 则是独立的持久变更，使回放能够识别尚未
   * 执行就被取消的工作。
   */
  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  /**
   * 为 setup 或其他必须排斥 turn 的操作预留空闲 Agent。期间消息仍可进入
   * Inbox；需要唤醒的消息会被锁存，maintenance 释放预留后再启动正常驱动器。
   */
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = maintenance.abort.signal.reason as AgentCancelCause | undefined
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * 启动一个驱动器；若 Agent 正处于 maintenance 或正在排空已中止活动，则
   * 锁存本次唤醒。空闲时收到的唤醒一定会打开 turn 边界，即使对应消息稍后
   * 被删除；只有在队列已经没有工作时，才抑制锁存唤醒的重放。
   * @param wakeAfterAbort - {@link send} 在 Inbox 插入前捕获的分类，避免重入
   *   cancel 改变这次唤醒所属的 turn。
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // maintenance 与已中止的驱动器无法消费唤醒，因此把它锁存到活动收敛时
      // 重放。正常运行的驱动器会自行领取队列；dispose 不锁存，避免销毁过程
      // 又等待一个新的模型 turn。
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  /**
   * 等待最新活动完全静止。循环重读 `activityDone`，消除旧活动完成后、当前
   * waiter 恢复前又唤醒新驱动器所形成的竞态。
   */
  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** 在实时边界报告一次失败，并继续抛出，交给驱动器边界统一收敛。 */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  /**
   * 收敛一个串行驱动器生命周期。只有待处理工作应立即在同一驱动器中打开
   * 新 turn 时，`turn()` 才返回 `true`。
   */
  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // 失败已经通过 agent/error 报告；取消与错误都在驱动器边界收敛。
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /**
   * 为一个候选 step 领取输入、组装当前系统上下文，再让 pre-step 插件接纳
   * 或拒绝请求。拒绝发生在 `step/start` 之前，因此被拒输入不会成为 Session
   * 日志中的模型请求。
   */
  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    // claim 通过持久 Inbox splice 移除消息。后续 reject 不会把消息放回；
    // 被拒 turn 会记录输入已被消费、但从未进入模型历史这一事实。
    const claimed = this.inbox.claim(target, position.turn)
    // prompt 组装使用 Agent scope，因此全局贡献与该 Agent 的 preset、工具、
    // restriction 会被解析成同一个快照。
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    // 动态上下文以 user-role 快照表示。此处只生成候选消息；待请求路由也成功
    // prepare 后，step() 才会把它与其他被接纳消息一起提交。
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    if (decision.kind === 'reject') return decision
    return { ...decision, assembly }
  }

  /** 本次组装的工具 schema 是否与日志中最新 request header 不同。 */
  private toolsChanged(tools: PromptAssembly['tools']): boolean {
    const baseline = this.session.requestHeader()
    if (baseline === undefined) return false
    return !headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }))
  }

  /**
   * 从 `turn/start` 驱动一个持久 turn，直到最终 `turn/end`。每个被接纳的 step
   * 都由 `step/start` 与 `step/end` 包围；工具结果上下文可以在同一 turn 内
   * 追加 step，而新的普通用户输入会唤醒后续 turn。
   */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      // 一次唤醒拥有一个持久 turn，即使对应消息在 claim 前消失。先记录 start
      // 也为随后的 Inbox claim 提供所属 turn 编号。
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    // `null` 表示上一个 step 还需要后续 step，通常因为模型发出了工具调用。
    // 非空 reason 表示只要 next-step Inbox 与 turn-stopping 监听器不再产生工作，
    // 当前 turn 就可以结束。
    let turnEnds: TurnEndReason | null = null
    // 第一个 step 消费一条普通 prompt 及全部已累积的 next-step 上下文；
    // 后续 step 只消费 next-step 上下文。
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          // 此时尚未提交 step 边界或模型可见消息，但 Inbox claim 已被消费，
          // 因此仍要把 turn 以 blocked 结束。
          turnEnds = { kind: 'blocked' }
          return false
        }
        // turn-stopping 检查点加入的 steering 可以重新打开一个已可结束的
        // turn；重新接纳后若没有消息，则真正关闭它。
        if (turnEnds && decision.messages.length === 0) break
        // 被移除的唤醒消息，或被插件改写为空的 enter 决策，仍拥有初始 turn
        // 边界，但不会消耗一次模型调用。
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          // max-tokens 是粘性的：任一 step 达到上限后，后续正常完成的 step
          // 不能把整个 turn 的结果降级为普通 completed。
          const stepEnd = await this.step(decision)
          // 保留此前的 max-tokens；后续 completed 不能覆盖它。
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          // 这个 awaited 检查点允许策略追加最后一条 steering。全部监听器结束
          // 后会再次检查 Inbox，再决定是否关闭 turn。
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // 每个失败都以结构化形式写入 turn/end：LlmError 保留原始 failure 信息，
      // 其他异常则用 errorChain 展平，并统一标记为 UNKNOWN。
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // 每个已提交的 turn/start 都必须对应且只对应一个 turn/end，包括 blocked、
        // cancelled 与 failed。回放、持久化修复、UI 和 SDK 投影都依赖此边界。
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    // 此时 next-step 工作已经排空。若仍有输入，它属于 next-turn；复用当前
    // 驱动器，但为新 turn 创建独立的取消信号。
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // 新 controller 使旧信号上的锁存状态失效；仍存活的驱动器会自行领取队列。
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /**
   * 为一个已接纳 step 运行“请求、重试、工具”循环。没有工具调用的模型输出
   * 会完成 turn；工具结果成为 next-step 上下文；重试只重复当前 step 内的
   * request attempt。
   */
  private async step(decision: Extract<PreparedStep, { kind: 'enter' }>): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    const { assembly } = decision
    // 每个 step 只执行一次接纳。request-error 中间件重试 provider 时，渲染后
    // 的 prompt 与已接纳 user 消息保持不变。
    const renderedPrompt = renderPrompt(assembly)
    let firstAttempt = true
    while (true) {
      // 在提交任何候选 system/user 输入前先 prepare 路由。若此处取消或 adapter
      // 失败，Session 不会留下只提交一半的模型可见 step 内容。
      const { config, preparedCall } = await this.prepareRequest(turn, step, signal)
      const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true
      const commits = this.systemPrompt.project(renderedPrompt, {
        inHistory: preparedCall?.systemPromptUpdate === 'in-history',
        startsSeries: startsRequestSeries
          || this.requestSurfaceGeneration !== this.session.surface.contentGeneration
          || this.toolsChanged(assembly.tools),
      })
      // 打开 provider 流之前提交所有模型可见输入。因此即使 provider 在首个
      // assistant chunk 前失败，请求仍能完全从 Session 重建。
      for (const { message, intent } of commits) {
        this.session.append('system/message', { turn, step, message }, intent)
      }
      if (firstAttempt) {
        // 重试属于同一个 step，必须复用历史中已经提交的 user 消息，不能重复追加。
        for (const message of decision.messages) {
          this.session.append('user/message', message, { surfaceOp: 'append' })
        }
      }
      firstAttempt = false
      const request = this.buildRequest(config, preparedCall, assembly.tools, startsRequestSeries, signal)
      const live = new AssistantStreamAttempt(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        turn,
        step,
        (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
      )
      // stream frame 是供 UI 实时观察的临时数据；下面的 live.settle(...) 才是
      // 把本次 attempt 转换为持久 Session 事件的提交点。
      let started = false
      try {
        // prepared call 固定本次 attempt 使用的 adapter 及其能力，避免执行中途
        // adapter 被替换。registry 路径用于 prepare 时没有 adapter、但可能由
        // llm/stream 中间件处理的路由。
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        live.start()
        started = true
        for await (const chunk of stream) {
          signal.throwIfAborted()
          live.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        // `start()` 前失败时没有实时 attempt 需要关闭。一旦 start，任何退出路径
        // 都会发布 end frame，并尝试把紧凑流保存在持久 assistant 事件中。
        if (!started) throw error
        try {
          if (signal.aborted) {
            // 取消时可以把语法安全的可见前缀保存为 interrupted assistant 消息；
            // 若没有安全前缀，则只保存日志 attempt，不进入后续模型历史。
            const content = live.interruptedBlocks()
            if (content.length > 0) {
              live.settle('assistant/message', () => this.session.append('assistant/message', {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: {
                    provider: request.provider,
                    model: request.model,
                    ...live.replayState === undefined ? {} : { replayState: live.replayState },
                  },
                }),
                interrupted: true,
                ...live.usage === undefined ? {} : { usage: live.usage },
                stream: live.stream,
              }, { surfaceOp: 'append' }).seq)
            } else {
              live.settle(
                'assistant/attempt',
                () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
              )
            }
          } else {
            live.settle(
              'assistant/attempt',
              () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
            )
          }
        } catch (settlementError: unknown) {
          throw new AggregateError(
            [error, settlementError],
            'Assistant stream failed and its durable settlement was rejected',
            { cause: error },
          )
        }
        throw error
      }
      try {
        const finish = live.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          // adapter 把请求失败规范化为终止 finish chunk。先记录本次 attempt，
          // 再由策略决定是否重试。
          live.settle(
            'assistant/attempt',
            () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
          )
          const action = await this.dispatch.waterfall(
            'agent/request-error', {
              turn,
              step,
              provider: request.provider,
              failure: finish.failure,
              retryPolicy: preparedCall?.retryPolicy,
              signal,
            },
            () => Promise.resolve<RequestErrorAction>(undefined),
          )
          signal.throwIfAborted()
          if (action?.kind !== 'retry') {
            throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
          }
          // retry 留在当前循环：不重新接纳、不写新 step/start，也不重复写 user
          // 消息；但会重新 prepare 路由并协调 prompt，因为中间件可能已改变它们。
          continue
        }

        // 成功流在执行工具前先变成 assistant/message。后续请求因此能从 Session
        // 同时重建 assistant 文本与其中的 tool-call block。
        const message = createAssistantMessage({
          content: live.blocks(),
          source: {
            provider: request.provider,
            model: request.model,
            ...live.replayState !== undefined ? { replayState: live.replayState } : {},
          },
        })
        live.settle(
          'assistant/message',
          () => this.session.append('assistant/message', {
            turn,
            step,
            message,
            ...live.usage === undefined ? {} : { usage: live.usage },
            stream: live.stream,
          }, { surfaceOp: 'append' }).seq,
        )
        if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

        const toolCalls = message.content.filter(block => block.type === 'tool-call')
        if (toolCalls.length === 0) return { kind: 'completed' }
        // 工具结果按模型给出的顺序提交。additional context 先排入 next-step，
        // 只有下一次接纳成功后才成为 user 消息。
        const { concluded } = await executeToolCalls(
          this.loopCtx, turn, step, toolCalls, signal,
          context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
        )
        return concluded ? { kind: 'completed' } : null
      } catch (error: unknown) {
        if (!live.ended) live.abandon()
        throw error
      }
    }
  }

  /** 在接纳模型可见输入前解析请求配置，并绑定本次 attempt 的 adapter。 */
  private async prepareRequest(
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<{ config: LlmCallConfig; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // 请求配置分三层：AgentOptions 提供初始路由，最新 request header 提供应当
    // 保留的显式值，agent/request 中间件提出本次 attempt 的配置；最后 adapter
    // 在 prepareCall() 中解析自己的默认值。
    //
    // 循环从声明路由开始，只恢复属于同一 provider/model 的显式 reasoning
    // effort。被标记为 adapter 默认值的字段会在后续 step 重新解析。
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const persistedReasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort
    const maxTokens = this.options.maxTokens
    // 插件收到的是分离且冻结的 proposal；它们可以返回新对象，但不能修改其他
    // 消费者背后共享的持久 header 对象。
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      // prepareCall 校验路由、填充 adapter 默认值并绑定 stream 函数，使 adapter
      // 替换不会把同一次 attempt 分割到两个实现上。
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // llm/stream 中间件可能处理尚未注册 adapter 的路由，因此这里只放行
      // NO_ADAPTER。若没有中间件接管，最终分发会抛出权威的 NO_ADAPTER 错误。
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()
    return { config, ...preparedCall === undefined ? {} : { preparedCall } }
  }

  /** 记录已解析的请求 envelope，并从已接纳的 Session surface 派生冻结请求。 */
  private buildRequest(
    config: LlmCallConfig,
    preparedCall: PreparedLlmCall | undefined,
    tools: GenerateOptions['tools'] & object,
    startsRequestSeries: boolean,
    signal: AbortSignal,
  ): GenerateOptions {
    const { session } = this
    const surfaceGeneration = session.surface.contentGeneration
    // header 保存请求配置与模型可见工具 schema，刻意不保存 messages；messages
    // 必须从下面的 Session surface 投影得到。
    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    const startsSeries = startsRequestSeries
      || this.requestSurfaceGeneration !== surfaceGeneration
    // header 是稀疏的 epoch 锚点：只在首次挂接、路由/schema 变化或显式开始新
    // request series 时追加。消费者折叠最新 header，而不是期待每次 provider
    // 调用都有一条 header 事件。
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', {
        header,
        reason: 'change',
        ...startsSeries ? { startsSeries: true } : {},
      })
    } else if (startsSeries) {
      this.session.append('request/header', { header, reason: 'series' })
    }
    this.requestSurfaceGeneration = surfaceGeneration

    const contextWindow = preparedCall?.context?.contextWindow
    const systemPromptUpdate = preparedCall?.systemPromptUpdate
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
    }
    // request context 记录已 prepare 路由的能力，这些信息不属于模型可见 header。
    // 与 header 相同，内容未变时沿用上一份快照。
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow
      || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    // canonicalHeader 只做浅层规范化；append 记录的是分离快照，不是这些局部值。
    deepFreeze(header)
    // 这是 provider 请求唯一的消息来源。deriveMessages 对持久事件应用 surface
    // replacement 与消息投影，因此不存在会偏离回放或持久化结果的私有 transcript。
    const boundaryMessages = session.deriveMessages()
    // 每个已挂接驱动器只深度冻结同一消息对象一次。WeakSet 保存冻结证明，同时
    // 不会让 surface 变化后已被替换的消息继续存活。
    for (const message of boundaryMessages) {
      if (this.frozenMessages.has(message)) continue
      deepFreeze(message)
      this.frozenMessages.add(message)
    }
    Object.freeze(boundaryMessages)
    // 嵌套 header/messages 冻结后，再浅冻结 envelope 本身。AbortSignal 刻意保持
    // 可变，使取消能到达 adapter，同时全部模型可见字段保持不可变。
    const request = markAgentLoopRequest(Object.freeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return request
  }
}
