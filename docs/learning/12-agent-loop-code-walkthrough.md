# Agent loop implementation walkthrough

English | [中文](12-agent-loop-code-walkthrough.zh.md)

## Summary

This chapter follows `ReactLoopAgent` from inbox wake-up to a settled turn. It identifies the driver state machine, event commit order, request retry boundary, stream settlement rules, and lifecycle transaction used to create and dispose an agent.

## Table of Contents

- [Source map](#source-map)
- [Driver state](#driver)
- [From input to a turn](#input)
- [Preparing a step](#pre-step)
- [Building the request](#request)
- [Streaming and retries](#streaming)
- [Tool continuation and turn completion](#completion)
- [Creation and teardown](#lifecycle)
- [Debugging and exercises](#debugging)

-----

<a id="source-map"></a>
## Source map

| Concern | Implementation |
|---|---|
| Driver, turn, step, and request construction | [`packages/core/agent-loop/src/agent.ts`](../../packages/core/agent-loop/src/agent.ts) |
| Factory, publication, resume, and teardown | [`packages/core/agent-loop/src/index.ts`](../../packages/core/agent-loop/src/index.ts) |
| Inbox projection and mutations | [`packages/core/agent-loop/src/inbox.ts`](../../packages/core/agent-loop/src/inbox.ts) |
| Tool-call scheduler | [`packages/core/agent-loop/src/tool-calls.ts`](../../packages/core/agent-loop/src/tool-calls.ts) |
| Assistant stream accumulator | [`packages/core/agent-loop/src/assistant-stream.ts`](../../packages/core/agent-loop/src/assistant-stream.ts) |

The driver has one active owner. Public methods enqueue work or request cancellation; `kick()` and `turn()` serialize mutation of the running phase.

<a id="driver"></a>
## Driver state

`ReactLoopAgent.phase` is either idle, running, or maintenance. Running state carries the current turn, step, `AbortController`, and a `wakeRequested` latch. `setPhase()` publishes status transitions, while the phase object is the internal synchronization state.

`followup()`, `steer()`, and `inject()` differ in inbox target and delivery semantics, then converge on inbox mutation and `wakeDriver()`. `cancel()` aborts the current controller; depending on options it may also clear pending inbox items. `whenIdle()` lets lifecycle code wait for driver quiescence.

`wakeDriver()` does not start a second loop when one already runs. It sets the wake latch so the active driver will re-check pending work at its boundary. From idle it reserves the running phase before starting `kick()`, which prevents two callers from both observing idle and becoming the driver.

`kick()` repeatedly calls `turn()`. Its `finally` block returns the machine to idle and immediately re-wakes it when work arrived at the last boundary. Errors are reported by `throwError()` and contained at this driver boundary so a failed turn does not become an unhandled background rejection.

<a id="input"></a>
## From input to a turn

`turn()` increments the previous turn number and first appends `turn/start`. Only after this durable event succeeds does it update `phase.turn`. A local `turnEnds` value accumulates the final reason and becomes sticky for `max-tokens` so a later step cannot downgrade that outcome.

The first loop iteration targets `next-turn`; later iterations target `next-step`. `preStep()` claims the appropriate inbox items, assembles the system prompt, projects runtime context, and runs the `agent/pre-step` waterfall. A listener can reject the step or replace admitted messages before any `step/start` event is recorded.

An initial empty decision completes the turn without a model call. Otherwise `turn()` appends `step/start`, updates `phase.step`, calls `step()`, and appends `step/end` in `finally`. This means every started step has a closing marker even when request preparation, streaming, or tool execution throws.

Before stopping a completed step, `agent/turn-stopping` gets one awaited opportunity to add work. If `next-step` remains empty, the turn exits. The outer `finally` always appends `turn/end` with completed, max-tokens, blocked, aborted, or structured error reason.

<a id="pre-step"></a>
## Preparing a step

Prompt assembly occurs before input admission. `systemPrompt.assemble()` collects contributions; `renderContextSections()` and `runtimeContext.project()` may produce an additional user-context message. The pre-step waterfall receives the claimed messages and cancellation signal.

Claiming and admission are distinct. Inbox items leave the pending projection when claimed, but `user/message` events are appended only in `step()` after request preparation succeeds. This ordering prevents an unroutable request from recording user input as though a model attempt had accepted it.

The `PreparedStep` also carries the prompt assembly so schema and prompt contributions are computed once for this step. Retry attempts reuse this admitted step rather than re-claiming inbox messages.

<a id="request"></a>
## Building the request

`prepareRequest()` starts with explicit `AgentOptions` and the folded request header. It retains a stored reasoning effort only when it belongs to the exact same provider and model and was not an adapter default. The `agent/request` waterfall can replace the proposed route before adapter resolution.

`llm.prepareCall()` resolves adapter defaults, context metadata, retry policy, and a bound stream function. A `NO_ADAPTER` error is deferred because middleware may still serve the request; other preparation errors fail immediately. Provider and model must be non-empty before this point.

Back in `step()`, `systemPrompt.project()` decides which system-message events must commit. It considers whether the adapter supports in-history updates, whether this is a new request series, whether the Session surface changed, and whether tool schemas changed.

On the first attempt only, the step appends every admitted `user/message`. Retries skip this block. `buildRequest()` then appends a `request/header` for initial, resume, changed, or new-series state and appends `request/context` when resolved route metadata changed.

Finally `buildRequest()` calls `session.deriveMessages()`, freezes the boundary array and unseen message objects, and returns a marked immutable request containing route fields, messages, visible tools, Session id, and cancellation signal. The model therefore receives exactly the recorded Session surface at that commit boundary.

<a id="streaming"></a>
## Streaming and retries

Each attempt creates an `AssistantStreamAttempt` with a unique attempt number and revision generator. The stream starts only after a provider iterator exists and cancellation is rechecked. Each incoming chunk updates the accumulator and emits a transient `agent/assistant-stream` frame for live interfaces.

If streaming fails after it started, the attempt must settle durably. Cancellation with visible content records an interrupted `assistant/message`; cancellation without content records `assistant/attempt`. A non-cancellation stream failure also records `assistant/attempt`. These attempt events preserve diagnostics but do not enter the model Surface.

When the provider returns an error or aborted finish, `agent/request-error` decides whether to retry. A retry continues the inner `while` loop. The system prompt and request header may be reconsidered, but user messages are not appended again because `firstAttempt` is already false.

A successful finish creates and appends one `assistant/message` with content, provider/model source, optional replay state, usage, and exact stream. This append settles the live attempt and enters the model Surface. A max-token finish returns a sticky max-token step result.

<a id="completion"></a>
## Tool continuation and turn completion

If the assistant message has no tool calls, `step()` returns completed. Otherwise it passes the tool-call blocks to `executeToolCalls()`. Tool results are appended in model order and any `additionalContexts` are inserted into `next-step` through the callback supplied by the agent.

When a tool marks `concludesTurn`, the step returns completed. Otherwise it returns `null`: the current turn continues, claims `next-step` context, and starts another model step. Tool output reaches the next request through recorded `tool/result` messages rather than an in-memory side channel.

Cancellation propagates through the running phase signal into prompt assembly, request preparation, provider streaming, and tool dispatch. The turn catches an aborted signal, records an aborted end reason, and rethrows so the driver boundary performs the common cleanup.

<a id="lifecycle"></a>
## Creation and teardown

`AgentLoop.prepare()` constructs the machine inside an owner Context effect, fuses caller, owner, and factory cancellation, and creates one memoized reverse-order `dispose()` transaction. Registry publication has not happened yet.

`setupAndPublish()` runs caller setup under `runMaintenance()`, commits setup-owned state, flushes the unpublished Session suffix to persistence, and calls `prepared.publish()`. Publication enters the Session registry, enters the Agent registry, announces the Session, and finally awaits Agent announcement. Failure triggers the same memoized rollback.

Disposal aborts setup or active work, waits for publication if it is in progress, cancels the machine, waits for idle, disposes the agent scope, closes the persistence handle, detaches both registries, and releases ownership bookkeeping. This order keeps final Session events writable until the driver is quiescent.

Resume uses the same preparation and publication path after acquiring storage write ownership and rebuilding the Session. Sharing the final transaction prevents create and resume from developing different cleanup rules.

<a id="debugging"></a>
## Debugging and exercises

Set breakpoints at `wakeDriver()`, `kick()`, `turn()`, `preStep()`, `step()`, `prepareRequest()`, and `buildRequest()`. Watch `phase`, both inbox queues, `firstAttempt`, folded request header, surface generation, and emitted Session events.

Exercise one: trace a provider failure followed by retry and list which events occur once versus per attempt. Exercise two: cancel after three visible chunks and compare the durable event with a cancellation before the first chunk. Exercise three: explain why `step/end` belongs in `finally` while `turn/end` needs a computed reason.
