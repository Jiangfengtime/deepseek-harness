# 4. Agent loop lifecycle

English | [中文](04-agent-loop.zh.md)

## Summary

This chapter follows the default Agent implementation from creation through inbox admission, turns, steps, model attempts, tool continuation, cancellation, and ordered teardown. It focuses on the state transitions and commit points that keep live execution consistent with the Session log.

## Table of Contents

- [Public interface and implementation](#interface)
- [Creation transaction](#creation)
- [Inbox and waking](#inbox)
- [Turn machine](#turn)
- [Step and attempt](#step)
- [Tool continuation](#tools)
- [Cancellation and failure](#cancellation)
- [Teardown](#teardown)
- [Trace checklist](#trace)
- [Exercises](#exercises)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="interface"></a>
## Public interface and implementation

`dsh-agent` defines the Agent contract, live registry, handle, events, and input vocabulary. `dsh-agent-loop` supplies the default implementation. Consumers call `ctx.agents`; they do not import `ReactLoopAgent` as a product dependency.

The concrete driver keeps a small phase machine:

```text
idle -> running -> idle
  \-> maintenance -> idle
```

`running` owns one AbortController plus the current turn and step numbers. `maintenance` reserves the Agent for exclusive non-turn work. `activityDone` is a moving quiescence promise; `whenIdle()` rechecks it so a wake that starts another activity before the first settles cannot produce a false idle result.

Open [`packages/core/agent-loop/src/agent.ts`](../../packages/core/agent-loop/src/agent.ts) and keep [`README.md`](../../packages/core/agent-loop/README.md) beside it. The README owns the public behavior; the source shows how that behavior is sequenced.

<a id="creation"></a>
## Creation transaction

[`agent-loop/src/index.ts`](../../packages/core/agent-loop/src/index.ts) implements the Agent factory. Creation is one rollback-covered transaction:

1. Resolve identity and create or open the persistence write handle.
2. Prepare an unpublished Session.
3. Construct the concrete Agent and its scope.
4. Run caller setup for scoped contributions.
5. Enter Session and Agent registries.
6. Announce `session/created`.
7. Await serial `agent/created` initialization.
8. Release queued input to the driver.

No listener should observe a half-published Agent. Setup or initialization failure unwinds entered resources. Input waits until initialization completes, so a listener can install tools, restrictions, or prompt context before the first request.

Resume first obtains exclusive write ownership, reads and validates persisted history, appends the supported interrupted-turn closers, and then enters the same publication transaction. A concurrent resume of the same Session cannot acquire the same write ownership.

<a id="inbox"></a>
## Inbox and waking

The Agent exposes three input intents:

| Method | Queue target | Wakes idle work? | Intended use |
|---|---|---|---|
| `followup()` | next turn | Yes | A later user request |
| `steer()` | next step | Yes | Mid-turn correction or direction |
| `inject()` | next step | No | Context to consume when other input wakes the loop |

[`inbox.ts`](../../packages/core/agent-loop/src/inbox.ts) records mutations as normalized `agent/inbox/spliced` events and uses the shared projection as its source of pending state. Message ids remain unique across both queues.

`wakeDriver()` starts one driver only from idle. A wake during live running usually needs no second driver because the current loop will claim pending work. A wake during maintenance or after an aborted activity is latched for replay at convergence. Disposal does not latch another turn.

<a id="turn"></a>
## Turn machine

`kick()` repeatedly calls `turn()` while pending work remains. A turn begins by recording `turn/start`, then claims the first input. Later steps claim only next-step input.

`preStep()` performs work that can affect admission:

```text
claim inbox input
  -> assemble prompt and tool schemas
  -> project runtime context
  -> agent/pre-step waterfall
  -> reject or enter(messages, startsRequestSeries?)
```

A rejected decision ends the turn as blocked. An empty first admission records a completed turn without opening a step. An empty later admission lets an already completed step finish normally.

For an admitted batch, the loop records `step/start`, runs `step()`, then records `step/end` in `finally`. When a step produces a terminal reason and no next-step input is pending, serial `agent/turn-stopping` listeners get one chance to contribute work. The loop records `turn/end` for every exit, including cancellation and error.

<a id="step"></a>
## Step and attempt

A step can contain several model attempts because request errors may retry. Prompt and tool assembly, runtime-context projection, and `agent/pre-step` run once for the step. Each attempt performs these operations:

1. `agent/request` proposes the route and explicit options.
2. `llm.prepareCall()` resolves adapter-owned defaults and capabilities.
3. The loop reconciles the rendered system prompt for that route.
4. The first attempt records admitted users; retries do not.
5. The loop records a changed request header or context when needed.
6. `deriveMessages()` reconstructs history from the log.
7. The loop freezes the request while retaining the live abort signal.
8. The prepared call streams chunks into an `AssistantStreamAttempt`.

Route preparation occurs before pending prompt and users commit. Cancellation during either asynchronous preparation stage leaves them uncommitted. After admission, request construction is synchronous so the logged prefix and frozen request remain aligned.

A successful stream settles one `assistant/message` containing the compact stream and assembled content. A failed or retried stream settles `assistant/attempt`; it remains diagnostic and does not add ordinary model history. A cancelled stream with delivered content settles an interrupted assistant message so future history contains what the user saw.

<a id="tools"></a>
## Tool continuation

After a successful assistant message, the loop selects its tool-call blocks. With none, the step completes. With calls, [`tool-calls.ts`](../../packages/core/agent-loop/src/tool-calls.ts) schedules them and records results.

Tool results enter the Session before the next step derives history. `additionalContexts` enter the next-step inbox after their owning results commit. A result can mark `concludesTurn`, causing the current work to stop after ordered result finalization. Otherwise the step returns no terminal reason and the turn continues.

Execution can overlap, but result events commit in model order. Exclusive calls form barriers; parallel-safe groups use a bounded rolling pool. The execution chapter examines this scheduler in detail.

<a id="cancellation"></a>
## Cancellation and failure

`cancel()` optionally clears pending inbox work, then aborts the current controller. Cancellation is cooperative: model adapters, tool executions, and process consumers receive the signal and must react at their supported boundary.

Failure classification affects recovery:

- Adapter selection, dispatch, and stream failures become request failures and can enter `agent/request-error` retry policy.
- A handled request error retries within the same step.
- Tool, middleware, result-processing, and other plugin failures close the turn as errors.
- Cancellation closes the turn with an aborted reason.
- A failure outside a durable turn position emits live `agent/error` and is contained at the driver boundary.

If cancellation leaves undispatched model tool calls, the scheduler records synthetic call/result pairs for the skipped calls. Started calls drain before the group finishes. This keeps replay structurally valid without pretending an unstarted tool body ran.

<a id="teardown"></a>
## Teardown

The AgentHandle owns teardown. Its memoized disposal performs an ordered convergence:

```text
request driver stop
  -> await driver quiescence
  -> unwind agent scope
  -> close and drain persistence writer
  -> detach Agent
  -> detach Session
```

The exact order prevents final events from being emitted after publication or persistence listeners disappear. Detach disposers bind exact objects, so an old handle cannot remove a later same-id replacement.

<a id="trace"></a>
## Trace checklist

When diagnosing one turn, collect these facts in order:

1. Which inbox event inserted the input and which method woke the Agent?
2. Which scope assembled prompt sections and tool schemas?
3. What did `agent/pre-step` admit?
4. Which route did `agent/request` and `prepareCall()` resolve?
5. Which header and context were inherited or recorded?
6. Which event prefix produced `deriveMessages()`?
7. How did the assistant stream settle?
8. Which tool calls and results committed?
9. Why did the next step start or the turn stop?
10. What final `turn/end` reason was recorded?

<a id="exercises"></a>
## Exercises

1. Draw the phase transitions for an idle follow-up, a steer during running, and a follow-up during maintenance.
2. Trace a request that fails before its first chunk and retries successfully. Identify which work runs once and which work repeats.
3. Trace cancellation after three visible text chunks but before stream completion. Identify live frames and durable settlement.
4. Locate the creation rollback path and list which announcements can already have been observed when failure occurs.
5. Explain why teardown cannot detach the Session before the driver stops.

You have completed the chapter when you can explain every Session event in one turn from its corresponding loop transition.

<a id="further"></a>
## Further Exploration

Continue with [Prompt and LLM](05-prompt-and-llm.md) for request contents and adapter behavior, then [Tools and execution](06-tools-and-execution.md) for calls produced by an assistant message. The [agent lifecycle diagram](../agent-lifecycle.md) provides a cross-package sequence view.

<a id="dev-note"></a>
## Dev Note

None.
