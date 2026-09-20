import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import * as FlowTrace from '@deepseek-ai/dsh-flow-trace'

function lines(ctx: Context): string[] {
  return ctx.logger.buffer
    .filter(message => message.name === 'flow-trace')
    .map(message => String(message.args[0]))
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as Agent
}

function emitSessionEvent(
  ctx: Context,
  session: Session,
  event: Record<string, unknown>,
): void {
  ctx.emit('session/event', session, event as never)
}

function fakeExecution(name = 'read_file'): ToolExecution {
  return {
    callId: ToolCallId(`call-${name}`),
    rootCallId: ToolCallId(`call-${name}`),
    name,
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('execution'),
  } as ToolExecution
}

describe('flow trace', () => {
  it('observes committed events and policy waterfalls without exposing content', async () => {
    const ctx = new Context()
    await ctx.plugin(FlowTrace, { level: 'info', assistantChunks: false })
    const session = Session.create(SessionId('session-1'))
    const agent = fakeAgent(session)

    ctx.emit('session/event', session, {
      type: 'tool/call',
      seq: SessionSeq(4),
      time: 1,
      data: {
        turn: 1,
        step: 2,
        callId: ToolCallId('call-1'),
        name: 'read_file',
        arguments: '{"path":"/private/secret.txt"}',
      },
    })

    const decision = await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'private prompt' }],
        source: { kind: 'user' },
      })],
      turn: 1,
      step: 2,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))

    expect(decision.kind).toBe('enter')
    expect(lines(ctx)).toEqual([
      'session id=session-1 seq=4 event=tool/call turn=1 step=2 call=call-1 tool=read_file',
      'agent id=session-1 phase=pre-step-enter turn=1 step=2 messages=1',
      'agent id=session-1 phase=pre-step-exit turn=1 step=2 decision=enter messages=0 newSeries=false',
    ])
    expect(lines(ctx).join('\n')).not.toContain('private')
  })

  it('describes every core Session event variant without serializing payloads', async () => {
    const ctx = new Context()
    await ctx.plugin(FlowTrace, { level: 'info' })
    const session = Session.create(SessionId('session-events'))

    emitSessionEvent(ctx, session, {
      type: 'session/end-seed', seq: SessionSeq(1), time: 1, data: {},
    })
    emitSessionEvent(ctx, session, {
      type: 'turn/end', seq: SessionSeq(2), time: 1,
      data: { turn: 2, reason: { kind: 'completed' } },
    })
    emitSessionEvent(ctx, session, {
      type: 'request/header', seq: SessionSeq(3), time: 1,
      data: {
        turn: 2,
        step: 1,
        reason: 'initial',
        header: { config: { provider: 'provider-1', model: 'model-1' } },
      },
    })
    emitSessionEvent(ctx, session, {
      type: 'request/context', seq: SessionSeq(4), time: 1,
      data: { provider: 'provider-2', model: 'model-2' },
    })
    emitSessionEvent(ctx, session, {
      type: 'tool/result', seq: SessionSeq(5), time: 1,
      data: { message: { content: [{ toolCallId: ToolCallId('call-1'), isError: true }] } },
    })
    emitSessionEvent(ctx, session, {
      type: 'assistant/message', seq: SessionSeq(6), time: 1,
      data: { turn: 2, step: 1, interrupted: true, private: 'private response' },
    })

    expect(lines(ctx)).toEqual([
      'session id=session-events seq=1 event=session/end-seed',
      'session id=session-events seq=2 event=turn/end turn=2 reason=completed',
      'session id=session-events seq=3 event=request/header turn=2 step=1 reason=initial provider=provider-1 model=model-1',
      'session id=session-events seq=4 event=request/context provider=provider-2 model=model-2',
      'session id=session-events seq=5 event=tool/result call=call-1 error=true',
      'session id=session-events seq=6 event=assistant/message turn=2 step=1 interrupted=true',
    ])
    expect(lines(ctx).join('\n')).not.toContain('private response')
  })

  it('observes Agent lifecycle, decisions, stream boundaries, and errors', async () => {
    const ctx = new Context()
    for (const exporter of ctx.logger.exporters.values()) exporter.levels = { default: 3 }
    await ctx.plugin(FlowTrace, { level: 'debug', assistantChunks: true })
    const session = Session.create(SessionId('session-agent'))
    const agent = fakeAgent(session)
    const message = createUserMessage({
      content: [{ type: 'text', text: 'private message' }],
      source: { kind: 'user' },
    })
    const signal = new AbortController().signal

    await ctx.serial('agent/created', { agent, source: 'startup' })
    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/inbox/inserted', { agent, message })
    ctx.emit('agent/inbox/claimed', { agent, message, turn: 3 })
    ctx.emit('agent/inbox/discarded', { agent, message })
    ctx.emit('agent/disposed', { agent })

    const rejected = await ctx.waterfall(ctx as never, 'agent/pre-step', {
      agent, messages: [], turn: 3, step: 1, signal,
    }, () => Promise.resolve({ kind: 'reject' as const }))
    expect(rejected).toEqual({ kind: 'reject' })
    const request = await ctx.waterfall(ctx as never, 'agent/request', {
      agent, turn: 3, step: 1, signal,
    }, () => Promise.resolve({ provider: 'provider-1', model: 'model-1' }))
    expect(request).toEqual({ provider: 'provider-1', model: 'model-1' })
    const retried = await ctx.waterfall(ctx as never, 'agent/request-error', {
      agent,
      turn: 3,
      step: 1,
      provider: 'provider-1',
      failure: { code: 'RATE_LIMIT', message: 'private failure' },
      retryPolicy: undefined,
      signal,
    }, () => Promise.resolve({ kind: 'retry' as const }))
    expect(retried).toEqual({ kind: 'retry' })
    const stopped = await ctx.waterfall(ctx as never, 'agent/request-error', {
      agent,
      turn: 3,
      step: 1,
      provider: 'provider-1',
      failure: { code: 'FATAL', message: 'private failure' },
      retryPolicy: undefined,
      signal,
    }, () => Promise.resolve(undefined))
    expect(stopped).toBeUndefined()

    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start',
        attemptId: LlmAttemptId('attempt-start'),
        revision: 1,
        turn: 3,
        step: 1,
      },
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'end',
        attemptId: LlmAttemptId('attempt-committed'),
        revision: 2,
        index: 4,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: SessionSeq(9) },
      },
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'end',
        attemptId: LlmAttemptId('attempt-abandoned'),
        revision: 3,
        index: 2,
        outcome: { kind: 'abandoned' },
      },
    })
    await ctx.serial('agent/turn-stopping', { agent, turn: 3, signal })
    ctx.emit('agent/error', { agent, turn: 3, step: 1, error: new TypeError('private') })
    ctx.emit('agent/error', { agent, turn: 3, step: 1, error: 'private' })

    expect(lines(ctx)).toContain('agent id=session-agent phase=created source=startup')
    expect(lines(ctx)).toContain('agent id=session-agent phase=request-error-exit turn=3 step=1 action=retry')
    expect(lines(ctx)).toContain('agent id=session-agent phase=request-error-exit turn=3 step=1 action=stop')
    expect(lines(ctx)).toContain('agent id=session-agent stream phase=start attempt=attempt-start revision=1 turn=3 step=1')
    expect(lines(ctx)).toContain('agent id=session-agent stream phase=end attempt=attempt-committed revision=2 chunks=4 outcome=committed event=assistant/message seq=9')
    expect(lines(ctx)).toContain('agent id=session-agent stream phase=end attempt=attempt-abandoned revision=3 chunks=2 outcome=abandoned')
    expect(lines(ctx)).toContain('agent id=session-agent phase=error turn=3 step=1 name=TypeError')
    expect(lines(ctx)).toContain('agent id=session-agent phase=error turn=3 step=1 name=UnknownError')
    expect(lines(ctx).join('\n')).not.toMatch(/private message|private failure/)
  })

  it('logs tool outcome metadata while preserving the delegated result', async () => {
    const ctx = new Context()
    await ctx.plugin(FlowTrace, { level: 'info' })
    const exec = {
      callId: ToolCallId('call-2'),
      rootCallId: ToolCallId('call-2'),
      name: 'bash',
      arguments: { command: 'cat secret.txt' },
      signal: new AbortController().signal,
      token: Symbol('execution'),
    } as ToolExecution
    const result = {
      isError: true as const,
      error: { message: 'private failure', info: { name: 'ShellError', code: 'EXIT_1' } },
      content: [{ type: 'text' as const, text: 'private output' }],
    }

    const observed = await ctx.waterfall(ctx as never, 'tools/execute', exec, () => Promise.resolve(result))

    expect(observed).toBe(result)
    expect(lines(ctx)).toEqual([
      'tool call=call-2 name=bash phase=dispatch-enter',
      'tool call=call-2 name=bash phase=dispatch-exit error=true code=EXIT_1 concludesTurn=false',
    ])
    expect(lines(ctx).join('\n')).not.toMatch(/secret|private/)
  })

  it('observes pre, post, and final tool stages for successful and unclassified failures', async () => {
    const ctx = new Context()
    await ctx.plugin(FlowTrace, { level: 'info' })
    const exec = fakeExecution()
    const success = {
      isError: false as const,
      value: null,
      content: [{ type: 'text' as const, text: 'private output' }],
      concludesTurn: true as const,
    }
    const unknownFailure = {
      isError: true as const,
      error: { message: 'private failure' },
      content: [{ type: 'text' as const, text: 'private output' }],
    }

    const pre = await ctx.waterfall(ctx as never, 'tools/pre-execute', exec, () =>
      Promise.resolve({ kind: 'allow' as const }))
    const post = await ctx.waterfall(ctx as never, 'tools/post-execute', exec, success, () =>
      Promise.resolve({ kind: 'accept' as const }))
    ctx.emit('tools/result', exec, success)
    ctx.emit('tools/result', exec, unknownFailure)

    expect(pre).toEqual({ kind: 'allow' })
    expect(post).toEqual({ kind: 'accept' })
    expect(lines(ctx)).toEqual([
      'tool call=call-read_file name=read_file phase=pre-enter',
      'tool call=call-read_file name=read_file phase=pre-exit decision=allow',
      'tool call=call-read_file name=read_file phase=post-enter',
      'tool call=call-read_file name=read_file phase=post-exit decision=accept',
      'tool call=call-read_file name=read_file phase=result error=false concludesTurn=true',
      'tool call=call-read_file name=read_file phase=result error=true code=UNKNOWN concludesTurn=false',
    ])
    expect(lines(ctx).join('\n')).not.toContain('private')
  })

  it('omits chunk frames by default and emits metadata when requested', async () => {
    const session = Session.create(SessionId('session-stream'))
    const agent = fakeAgent(session)
    const frame = {
      type: 'chunk' as const,
      attemptId: LlmAttemptId('attempt-1'),
      revision: 3,
      index: 7,
      time: 1,
      chunk: { type: 'text-delta' as const, index: 0, text: 'private model output' },
    }

    const quiet = new Context()
    await quiet.plugin(FlowTrace, { level: 'info' })
    quiet.emit('agent/assistant-stream', { agent, frame })
    expect(lines(quiet)).toEqual([])

    const verbose = new Context()
    await verbose.plugin(FlowTrace, { level: 'info', assistantChunks: true })
    verbose.emit('agent/assistant-stream', { agent, frame })
    expect(lines(verbose)).toEqual([
      'agent id=session-stream stream phase=chunk attempt=attempt-1 revision=3 index=7',
    ])
    expect(lines(verbose).join('\n')).not.toContain('private model output')
  })

  it('observes the final model stream without logging request or response content', async () => {
    const ctx = new Context()
    await ctx.plugin(FlowTrace, { level: 'info' })
    const options = {
      provider: 'provider-1',
      model: 'model-1',
      sessionId: SessionId('session-llm'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'private prompt' }],
        source: { kind: 'user' },
      })],
      tools: [{
        name: 'private-tool',
        description: 'private description',
        parameters: { type: 'object', properties: {} },
      }],
    } as GenerateOptions
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: 'private model output' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]

    const observed: StreamChunk[] = []
    const stream = ctx.waterfall(ctx as never, 'llm/stream', options, () => (async function* () {
      yield* chunks
    })())
    for await (const chunk of stream) observed.push(chunk)

    expect(observed).toEqual(chunks)
    expect(lines(ctx)).toEqual([
      'llm session=session-llm phase=stream-enter provider=provider-1 model=model-1 messages=1 tools=1',
      'llm session=session-llm phase=stream-exit provider=provider-1 model=model-1 chunks=2 outcome=stop',
    ])
    expect(lines(ctx).join('\n')).not.toMatch(/private/)
  })

  it('distinguishes model-stream EOF, early consumer stop, and thrown error classes', async () => {
    const ctx = new Context()
    await ctx.plugin(FlowTrace, { level: 'info' })
    const options = {
      provider: 'provider-2',
      model: 'model-2',
      messages: [],
    } as GenerateOptions

    const eof = ctx.waterfall(ctx as never, 'llm/stream', options, () => (async function* () {})())
    for await (const _chunk of eof) {
      throw new Error('unreachable')
    }

    const stopped = ctx.waterfall(ctx as never, 'llm/stream', options, () => (async function* () {
      yield { type: 'text-delta', index: 0, text: 'private' } satisfies StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } satisfies StreamChunk
    })())
    for await (const _chunk of stopped) break

    const errorStream = ctx.waterfall(ctx as never, 'llm/stream', options, () => (async function* () {
      throw new RangeError('private')
    })())
    await expect(async () => {
      for await (const _chunk of errorStream) {
        throw new Error('unreachable')
      }
    }).rejects.toThrow(RangeError)

    const unknownStream = ctx.waterfall(ctx as never, 'llm/stream', options, () => (async function* () {
      throw 'private'
    })())
    await expect(async () => {
      for await (const _chunk of unknownStream) {
        throw new Error('unreachable')
      }
    }).rejects.toBe('private')

    expect(lines(ctx)).toEqual([
      'llm session=- phase=stream-enter provider=provider-2 model=model-2 messages=0 tools=0',
      'llm session=- phase=stream-exit provider=provider-2 model=model-2 chunks=0 outcome=eof',
      'llm session=- phase=stream-enter provider=provider-2 model=model-2 messages=0 tools=0',
      'llm session=- phase=stream-exit provider=provider-2 model=model-2 chunks=1 outcome=consumer-stopped',
      'llm session=- phase=stream-enter provider=provider-2 model=model-2 messages=0 tools=0',
      'llm session=- phase=stream-exit provider=provider-2 model=model-2 chunks=0 outcome=threw:RangeError',
      'llm session=- phase=stream-enter provider=provider-2 model=model-2 messages=0 tools=0',
      'llm session=- phase=stream-exit provider=provider-2 model=model-2 chunks=0 outcome=threw:UnknownError',
    ])
    expect(lines(ctx).join('\n')).not.toContain('private')
  })
})
