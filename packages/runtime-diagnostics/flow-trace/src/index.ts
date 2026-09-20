/**
 * Opt-in execution tracing for the agent, Session, and tool pipelines.
 *
 * @module @deepseek-ai/dsh-flow-trace
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AssistantStreamFrame, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Flow-trace output options. */
export interface Config {
  /** Cordis log level used for every trace line. */
  level?: 'info' | 'debug'
  /** Log assistant chunk indexes and revisions without logging chunk content. */
  assistantChunks?: boolean
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  level: z.union(['info', 'debug'] as const).default('info'),
  assistantChunks: z.boolean().default(false),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = 'flow-trace'

type Trace = (message: string) => void

function sessionEventPosition(event: SessionEvent): string {
  const data = event.data as { turn?: unknown; step?: unknown }
  const turn = typeof data.turn === 'number' ? ` turn=${data.turn}` : ''
  const step = typeof data.step === 'number' ? ` step=${data.step}` : ''
  return `${turn}${step}`
}

function sessionEventDetails(event: SessionEvent): string {
  switch (event.type) {
    case 'turn/end':
      return ` reason=${event.data.reason.kind}`
    case 'request/header':
      return ` reason=${event.data.reason} provider=${event.data.header.config.provider} model=${event.data.header.config.model}`
    case 'request/context':
      return ` provider=${event.data.provider} model=${event.data.model}`
    case 'tool/call':
      return ` call=${event.data.callId} tool=${event.data.name}`
    case 'tool/result':
      return ` call=${event.data.message.content[0].toolCallId} error=${event.data.message.content[0].isError === true}`
    case 'assistant/message':
      return ` interrupted=${event.data.interrupted === true}`
    default:
      return ''
  }
}

function preStepDecision(decision: PreStepDecision): string {
  return decision.kind === 'enter'
    ? `enter messages=${decision.messages.length} newSeries=${decision.startsRequestSeries === true}`
    : 'reject'
}

function requestErrorDecision(action: RequestErrorAction): string {
  return action?.kind ?? 'stop'
}

function toolResult(result: Readonly<ToolExecutionResult>): string {
  const code = result.isError ? ` code=${result.error.info?.code ?? 'UNKNOWN'}` : ''
  return `error=${result.isError}${code} concludesTurn=${result.concludesTurn === true}`
}

function assistantFrame(frame: AssistantStreamFrame): string {
  switch (frame.type) {
    case 'start':
      return `phase=start attempt=${frame.attemptId} revision=${frame.revision} turn=${frame.turn} step=${frame.step}`
    case 'chunk':
      return `phase=chunk attempt=${frame.attemptId} revision=${frame.revision} index=${frame.index}`
    case 'end':
      return frame.outcome.kind === 'committed'
        ? `phase=end attempt=${frame.attemptId} revision=${frame.revision} chunks=${frame.index} outcome=committed event=${frame.outcome.eventType} seq=${frame.outcome.seq}`
        : `phase=end attempt=${frame.attemptId} revision=${frame.revision} chunks=${frame.index} outcome=abandoned`
  }
}

/**
 * Wrap the final model stream without retaining request or response content.
 * The exit line is emitted from `finally`, so early consumer cancellation is
 * distinguishable from adapter EOF and terminal finish records.
 */
async function* observeLlmStream(
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
  trace: Trace,
): AsyncIterable<StreamChunk> {
  const session = options.sessionId ?? '-'
  trace(`llm session=${session} phase=stream-enter provider=${options.provider} model=${options.model} messages=${options.messages.length} tools=${options.tools?.length ?? 0}`)
  let chunks = 0
  let terminal: StreamChunk & { type: 'finish' } | undefined
  let reachedEof = false
  let thrown: unknown
  try {
    for await (const chunk of next()) {
      chunks += 1
      if (chunk.type === 'finish') terminal = chunk
      yield chunk
    }
    reachedEof = true
  } catch (error: unknown) {
    thrown = error
    throw error
  } finally {
    const outcome = terminal?.reason.kind
      ?? (thrown !== undefined
        ? `threw:${thrown instanceof Error ? thrown.name : 'UnknownError'}`
        : reachedEof ? 'eof' : 'consumer-stopped')
    trace(`llm session=${session} phase=stream-exit provider=${options.provider} model=${options.model} chunks=${chunks} outcome=${outcome}`)
  }
}

/**
 * Install privacy-safe observers around the main execution flow.
 *
 * Waterfall listeners always delegate and return the downstream value. The
 * plugin therefore observes policy decisions without becoming a policy owner.
 * Session lines run after append commitment and identify the durable facts that
 * can reconstruct the conversation; live lines explain the work around those
 * commit points.
 *
 * @param ctx - plugin context that owns the observers.
 * @param config - output level and optional chunk-metadata switch.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  const trace: Trace = config.level === 'debug'
    ? (message) => { logger.debug(message) }
    : (message) => { logger.info(message) }

  ctx.on('session/event', (session, event) => {
    trace(`session id=${session.id} seq=${event.seq} event=${event.type}${sessionEventPosition(event)}${sessionEventDetails(event)}`)
  }, { global: true })

  ctx.on('agent/created', ({ agent, source }) => {
    trace(`agent id=${agent.id} phase=created source=${source}`)
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    trace(`agent id=${agent.id} phase=disposed`)
  }, { global: true })
  ctx.on('agent/status', ({ agent, status }) => {
    trace(`agent id=${agent.id} phase=status value=${status}`)
  }, { global: true })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    trace(`agent id=${agent.id} phase=inbox-inserted message=${message.id}`)
  }, { global: true })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    trace(`agent id=${agent.id} phase=inbox-claimed message=${message.id} turn=${turn}`)
  }, { global: true })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    trace(`agent id=${agent.id} phase=inbox-discarded message=${message.id}`)
  }, { global: true })

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    trace(`agent id=${payload.agent.id} phase=pre-step-enter turn=${payload.turn} step=${payload.step} messages=${payload.messages.length}`)
    // Delegation is behavior: omitting next() would reject the step by replacing
    // the rest of the waterfall, rather than merely observing it.
    const decision = await next()
    trace(`agent id=${payload.agent.id} phase=pre-step-exit turn=${payload.turn} step=${payload.step} decision=${preStepDecision(decision)}`)
    return decision
  }, { global: true })

  ctx.on('agent/request', async (payload, next) => {
    trace(`agent id=${payload.agent.id} phase=request-enter turn=${payload.turn} step=${payload.step}`)
    const request = await next()
    trace(`agent id=${payload.agent.id} phase=request-exit turn=${payload.turn} step=${payload.step} provider=${request.provider} model=${request.model}`)
    return request
  }, { global: true })

  ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    trace(`agent id=${payload.agent.id} phase=request-error-enter turn=${payload.turn} step=${payload.step} provider=${payload.provider} code=${payload.failure.code}`)
    const action = await next()
    trace(`agent id=${payload.agent.id} phase=request-error-exit turn=${payload.turn} step=${payload.step} action=${requestErrorDecision(action)}`)
    return action
  }, { global: true })

  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> =>
    observeLlmStream(options, next, trace), { global: true })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'chunk' && config.assistantChunks !== true) return
    trace(`agent id=${agent.id} stream ${assistantFrame(frame)}`)
  }, { global: true })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    trace(`agent id=${agent.id} phase=turn-stopping turn=${turn}`)
  }, { global: true })

  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    const errorName = error instanceof Error ? error.name : 'UnknownError'
    trace(`agent id=${agent.id} phase=error turn=${turn} step=${step} name=${errorName}`)
  }, { global: true })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    trace(`tool call=${exec.callId} name=${exec.name} phase=pre-enter`)
    const decision = await next()
    trace(`tool call=${exec.callId} name=${exec.name} phase=pre-exit decision=${decision.kind}`)
    return decision
  }, { global: true })

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    trace(`tool call=${exec.callId} name=${exec.name} phase=dispatch-enter`)
    const result = await next()
    trace(`tool call=${exec.callId} name=${exec.name} phase=dispatch-exit ${toolResult(result)}`)
    return result
  }, { global: true })

  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    trace(`tool call=${exec.callId} name=${exec.name} phase=post-enter`)
    const decision = await next()
    trace(`tool call=${exec.callId} name=${exec.name} phase=post-exit decision=${decision.kind}`)
    return decision
  }, { global: true })

  ctx.on('tools/result', (exec, result) => {
    trace(`tool call=${exec.callId} name=${exec.name} phase=result ${toolResult(result)}`)
  }, { global: true })
}
