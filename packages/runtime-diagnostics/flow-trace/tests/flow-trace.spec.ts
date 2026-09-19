import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm'
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
})
