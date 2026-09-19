# 3. Sessions, events, and projections

English | [中文](03-sessions-and-projections.zh.md)

## Summary

This chapter explains how one append-only Session event log supports model requests, conversation rendering, resume, forks, search, and durable feature state. You will distinguish recorded facts from derived views, follow an append through publication and projection, and understand why model-visible data must be reconstructable from the log.

## Table of Contents

- [Session identity](#identity)
- [Append and publication](#append)
- [Event families](#families)
- [Model Surface](#surface)
- [State projections](#state)
- [Transcript and live stream](#transcript)
- [Fork and resume](#fork)
- [Invariants](#invariants)
- [Exercises](#exercises)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="identity"></a>
## Session identity

A Session owns an immutable header and an ordered event sequence. The header records identity and creation metadata such as the working directory and lineage. Each event receives a sequence and timestamp envelope around its typed payload.

[`SessionStore`](../../packages/core/session/src/index.ts) is the live in-memory registry. It can prepare a Session without publication, enter it into the store, and announce creation. The split lets the Agent factory include Session publication in a larger rollback-covered transaction.

The live store is not persistence. A Session created outside the production Agent lifecycle remains memory-only unless another owner attaches a write path. Keep these questions separate:

- Does the Session exist in the current process?
- Is a writer buffering its events?
- Has a durability checkpoint completed?
- Can a cold reader open it after process exit?

<a id="append"></a>
## Append and publication

`Session.append()` validates an event, assigns its envelope, commits it to the in-memory log, updates registered projections, and publishes the post-commit `session/event` notification. Projection state is current when append returns. Notification listeners observe an already committed event, so their failures are contained rather than reversing history.

This order lets the live inbox projection and other state readers observe an append synchronously. Persistence listens to publication and may buffer physical writes. Callers that need an explicit durability point use `ctx.sessions.flush(session)`, which dispatches awaited `session/flush` listeners through the store's captured carrier.

Do not dispatch raw `session/flush` events from consumers. The store owns the entry point and the session's scope carrier. Bypassing it can miss the correct routing and weakens the single-owner durability model.

<a id="families"></a>
## Event families

Events serve different readers. The exact union lives in [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts) and plugin declaration merges.

| Family | Examples | Primary purpose |
|---|---|---|
| Boundaries | `turn/start`, `step/end`, `turn/end` | Reconstruct lifecycle and stopping outcomes. |
| Messages | `system/message`, `user/message`, `assistant/message`, `tool/result` | Produce or update model history. |
| Attempts | `assistant/attempt` | Retain failed, retried, or empty interrupted streams without adding history. |
| Request facts | `request/header`, `request/context` | Reconstruct route, tools, defaults, and model capability context. |
| Tool facts | `tool/call`, `tool/result` | Pair requested external work with authoritative outcomes. |
| Feature state | `agent/inbox/spliced` and plugin events | Rebuild durable state owned by a feature. |

The Session event union is merge-extensible. A plugin can add a durable fact through declaration merging, but it must also provide every interpretation needed by its consumers. A new model-visible fact requires a message projection or a message-producing event; a new UI fact needs replayable presentation; a new state fact needs a projection when cold readers require it.

<a id="surface"></a>
## Model Surface

The model Surface is the ordered set of event nodes that currently produce messages. [`surface.ts`](../../packages/core/session/src/surface.ts) folds append and replacement operations, then `deriveMessages()` returns the messages for the next request.

The four built-in message-producing event types are system, user, assistant, and tool result. Empty system and assistant messages can preserve a node or usage record without emitting a wire message. Lifecycle, request metadata, and failed attempts remain in the log but do not become model messages.

Replacement operations shadow a model-visible range without deleting its source events. Compaction can therefore replace older conversation with a summary for future model requests while retaining the events needed for audit, transcript rendering, and lineage.

Plugins that change existing message content register pure message projections. The same definitions must be available to detached readers; otherwise a live process and a cold reader would derive different model history from the same log.

The central invariant is:

> Anything that reaches a model request must be reconstructable from committed Session events and registered pure projections.

This rule excludes hidden process memory from model input. Runtime context must first become a recorded user or system message before request construction.

<a id="state"></a>
## State projections

Not every feature state is a model message. `dsh-session-projection` registers typed projection units that fold committed events incrementally. Hosts can read current typed state through `stateOf()` and produce cropped client snapshots through `snapshot()`.

The inbox illustrates the distinction. `agent/inbox/spliced` records structural queue changes. The inbox projection rebuilds pending messages. Claim and discard notifications help live consumers react, but cold readers use the durable splice events.

A host reader that requires a projection service fails explicitly when the service or key is absent. Silent fallback to an empty value would make a missing plugin indistinguishable from legitimate empty state.

<a id="transcript"></a>
## Transcript and live stream

The human transcript and model Surface have different deletion semantics. A replacement that removes old material from future model context must not erase messages a user already saw. Transcript readers therefore start from append-origin message events and apply presentation rules appropriate to the human conversation.

Assistant streaming has a live and durable form:

```text
adapter chunks
  -> process-local agent/assistant-stream frames
  -> complete assistant/message or assistant/attempt event
```

The Web follow path uses transient frames for incremental display. The completed compact stream is embedded in its settlement event. A hard process loss before settlement can leave no durable attempt stream, so reconnect logic must prefer committed events over previously observed transient frames.

<a id="fork"></a>
## Fork and resume

A fork copies a stable Session prefix ending outside an open turn and records lineage in the child header. It copies facts rather than re-running effects. The child derives its own current views from the seeded events and registered projection definitions.

Resume opens persisted events, constructs a Session from validated current logical records, repairs the supported interrupted-turn case at the Agent layer, and attaches a new live Agent. Restored message identities remain stable so request-freeze evidence and projections can reuse them safely.

Cold operations such as stat, list, page, and search should not require a live Agent. Their owners read persistence and projections directly. Use live Agent access only for actions that must change active execution, such as steering or cancellation.

<a id="invariants"></a>
## Invariants

Retain these rules while reading or changing Session code:

- Sequence order is the canonical order; asynchronous observers cannot reorder committed history.
- Events are lossless JSON at the durable boundary.
- Model-visible content comes from logged facts.
- Replacements change derived history; committed generations and source events are not overwritten.
- Projection definitions are pure and must be present wherever the log is interpreted.
- A live notification cannot substitute for a durable event when state must survive reload.
- Append completion proves in-memory commitment and projection update, not necessarily disk durability.

<a id="exercises"></a>
## Exercises

1. Starting at `Session.append()`, list validation, envelope assignment, log mutation, projection update, and event publication in order.
2. For one successful tool call, identify every event that enters the log and which of them becomes a model message.
3. Compare `assistant/message` with `assistant/attempt`. Explain how each affects transcript, model history, and diagnostics.
4. Find the inbox projection definition and replay three splice events by hand.
5. Choose a compaction fixture and identify source events, replacement events, the resulting Surface, and the human transcript source.

You have completed the chapter when you can derive the next model message list and the current durable feature state from one event prefix without consulting live objects.

<a id="further"></a>
## Further Exploration

Continue with the [Agent loop](04-agent-loop.md), which is the main producer of Session lifecycle and message events. Use the [Session subsystem](../subsystems/session.md) for public types and [persistence](../subsystems/persistence.md) for storage contracts.

<a id="dev-note"></a>
## Dev Note

None.
