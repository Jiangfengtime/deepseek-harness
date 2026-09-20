/**
 * 调度一个 assistant step 中的全部工具调用。exclusive 调用形成顺序屏障；
 * parallel 调用进入有上限的滚动池，并在真正启动前重新分类。
 *
 * 整体算法分三层：`executeToolCalls()` 按执行模式切分 group；`runGroup()` 控制
 * 并发池与模型顺序提交；`ctx.tools[TOOL_RUNTIME_SCHEDULER]` 负责 pre/execute/post
 * 工具管线。工具 body 可以并发执行，但策略阶段、Session 结果与 additional
 * context 始终保持模型给出的调用顺序。
 *
 * 取消会停止补充新任务、等待已启动调用结束，并为未启动调用记录合成错误，
 * 从而保证回放历史仍是完整的 call/result 对。调度器内部失败同样排空已启动
 * Promise，但不会虚构工具结果；已经提交的 `tool/call` 会保留用于诊断。
 * @module dsh-agent-loop/tool-calls
 */

import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER, type ToolExecutionInput, type ToolExecutionMode, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** 参数已经解析、等待调度的一次工具调用。 */
interface PlannedCall {
  block: ToolCallBlock
  exec: ToolExecutionInput
}

/** body 已结算、等待按模型顺序完成 post 阶段并写入结果的 slot。 */
interface Slot {
  exec: ToolRunContext
  result: ToolExecutionResult
  needsPost: boolean
}

/** 一个调度 group 的结果，包括已经排空的取消状态。 */
interface GroupOutcome {
  consumed: number
  aborted: boolean
  /** 任一已提交结果是否带有 {@link ToolExecutionResult.concludesTurn}。 */
  concluded: boolean
}

/**
 * 按工具的实时并发模式调度一个 assistant step 中的调用。普通完成与取消都会按
 * 顺序提交已启动调用的结果。取消先排空这些调用、接纳它们产生的上下文，再为
 * 未启动调用记录合成结果；调用方把 additional context 暂存到 next-step Inbox。
 * 调度器内部失败会停止新分发、排空已经启动的调用，并抛出第一个失败，不生成
 * 虚假结果。当前 AgentLoop 驱动边界提供 initiating Agent，并显式写入每个
 * {@link ToolExecutionInput.agent}。
 *
 * @param ctx - 拥有工具注册表并携带 initiating Agent 的循环 Context。
 * @param turn - 当前 turn 编号。
 * @param step - 当前 step 编号。
 * @param toolCalls - 按模型输出顺序排列的工具调用。
 * @param signal - 当前 step 共享的取消信号。
 * @param acceptContext - 接纳已提交结果产生的上下文，供下一个 step 使用。
 */
export async function executeToolCalls(
  ctx: Context,
  turn: number,
  step: number,
  toolCalls: ToolCallBlock[],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<{ concluded: boolean }> {
  const agent = ctx.agents.requireInitiator()
  const { session } = agent

  // 每个调用拥有独立 input，因为 tools/execute wrapper 可能替换 exec.signal。
  const planned: PlannedCall[] = toolCalls.map(block => ({
    block,
    exec: {
      callId: block.id,
      name: block.name,
      arguments: parseArguments(block.arguments),
      agent,
      signal,
    },
  }))

  let next = 0
  let concluded = false
  while (next < planned.length) {
    // 每个 group 提交完成后再分类，使运行期间的 registry 变化能影响未启动调用。
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    const first = planned[next]!
    const mode = ctx.tools.executionMode(first.exec).kind
    const group = mode === 'parallel' ? planned.slice(next) : [first]
    const outcome = await runGroup(
      ctx, turn, step, group, mode, signal, acceptContext,
    )
    next += outcome.consumed
    concluded ||= outcome.concluded
    if (outcome.aborted) {
      for (const call of planned.slice(next)) appendSkippedToolCall(session, turn, step, call.block)
      return { concluded }
    }
  }
  return { concluded }
}

/** 解析模型参数：无效 JSON 保留为文本，空输入映射为 `{}`。 */
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}

/**
 * 运行一个 exclusive 屏障或 parallel 池。后续调用在启动前重新分类；若其中一个
 * 被重新分类为 exclusive，它会留给调用方的下一个 group，并等待当前池先排空。
 * 结果和上下文按模型顺序提交。取消会停止启动新调用、排空并提交已启动调用、
 * 接纳其上下文、记录跳过调用的结果，再返回 aborted。调度器失败只排空分发，
 * 不提交合成恢复结果。
 */
async function runGroup(
  ctx: Context,
  turn: number,
  step: number,
  group: PlannedCall[],
  mode: ToolExecutionMode['kind'],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<GroupOutcome> {
  const { session } = ctx.agents.requireInitiator()
  const { maxParallelToolCalls } = ctx.agentLoop.config
  const slots: (Slot | undefined)[] = group.map(() => undefined)
  // 已启动 slot 保存自己的 tool/call seq，后续 tool/result 必须引用它。
  const callSeqs: Array<SessionSeq | undefined> = group.map(() => undefined)
  let nextToStart = 0
  let committed = 0
  let started = 0
  let aborted: boolean = signal.aborted
  let concluded = false
  let schedulerFailure: { error: unknown } | undefined
  const throwSchedulerFailure = (): void => {
    if (schedulerFailure !== undefined) throw schedulerFailure.error
  }

  // committed 只能跨过从头开始连续就绪的 slot，不能越过尚未完成的前序调用。
  const commitReady = async (): Promise<void> => {
    while (committed < group.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = group[committed]
      const result = slot.needsPost
        ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
        : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
      appendToolResult(session, turn, step, call!.block, result, callSeqs[committed]!)
      for (const context of result.additionalContexts ?? []) acceptContext(context)
      concluded ||= result.concludesTurn === true
      committed++
    }
  }

  const inFlight = new Map<number, Promise<number>>()

  const startCall = async (index: number): Promise<void> => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
    const call = group[index]!
    callSeqs[index] = appendToolCall(session, turn, step, call.block)
    started++
    const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
    throwSchedulerFailure()
    switch (prepared.kind) {
      case 'dispatch': {
        const promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then(
          (outcome) => {
            slots[index] = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
            return index
          },
          (error: unknown) => {
            schedulerFailure ??= { error }
            return index
          },
        )
        inFlight.set(index, promise)
        break
      }
      case 'post-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: true }
        break
      case 'final-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: false }
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(prepared, 'tool-call scheduler prepare result')
    }
  }

  const fillPool = async (): Promise<void> => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
      // 有序提交后重新读取后续调用模式，使 registry 变化可以创建新屏障。
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const nextCall = group[nextToStart]!
      if (nextToStart > 0 && mode === 'parallel'
        && ctx.tools.executionMode(nextCall.exec).kind !== 'parallel') break
      await startCall(nextToStart)
      nextToStart++
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // 等待 pre-execute 时也可能收到取消。
      if (signal.aborted) aborted = true
    }
  }

  // pre-execute 严格按模型顺序执行且可能 await；只有 dispatch/body 允许重叠。
  // 调度器失败会停止新分发，并等待所有已启动分发结算后再回到 turn 边界。
  try {
    await fillPool()
    while (inFlight.size > 0) {
      const settledIndex = await Promise.race(inFlight.values())
      inFlight.delete(settledIndex)
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // 等待工具 body 或有序提交时也可能收到取消。

      if (signal.aborted) aborted = true
      await fillPool()
    }
  } catch (error: unknown) {
    schedulerFailure ??= { error }
    await Promise.allSettled(inFlight.values())
    throw schedulerFailure.error
  }

  if (aborted) {
    // 先结算已启动调用及其上下文，再按模型顺序为其余调用补合成结果，最后中止 turn。
    for (const call of group.slice(started)) appendSkippedToolCall(session, turn, step, call.block)
    return { consumed: group.length, aborted: true, concluded }
  }
  /* v8 ignore next -- unreachable: a non-aborted group commits every started call */
  if (committed !== started) throw new Error('tool-call scheduler: uncommitted settled calls')
  return { consumed: started, aborted: false, concluded }
}

/** 为取消后未启动的模型调用追加完整持久 call/result 对。 */
function appendSkippedToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): void {
  const callSeq = appendToolCall(session, turn, step, block)
  appendToolResult(session, turn, step, block, {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
  }, callSeq)
}

/** 追加已启动调用，并返回对应结果必须引用的事件 seq。 */
function appendToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): SessionSeq {
  const event = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
  return event.seq
}

/** 追加按模型顺序结算、且引用对应 call 事件的结果。 */
function appendToolResult(
  session: Session,
  turn: number,
  step: number,
  block: ToolCallBlock,
  result: ToolExecutionResult,
  callSeq: SessionSeq,
): void {
  const message = createToolResultMessage({
    callId: block.id,
    content: result.content,
    isError: result.isError,
  })
  session.append('tool/result', {
    turn, step,
    message,
    ...result.error?.info ? { error: result.error.info } : {},
    // 工具私有的展示数据（例如结果阶段生成的 diff）也要持久化，使 UI bridge
    // 能在回放时还原同一张结果卡片。
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
