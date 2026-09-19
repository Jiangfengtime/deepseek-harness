# Session implementation walkthrough

English | [中文](11-session-code-walkthrough.zh.md)

## Summary

This chapter reads the `Session` implementation as an append transaction plus incremental projections. It shows how an event becomes immutable history, how `SurfaceManager` decides model-visible order, how `deriveMessages()` caches work, and where persistence joins the lifecycle.

## Table of Contents

- [Source map](#source-map)
- [Core state](#state)
- [Construction and restoration](#construction)
- [The append transaction](#append)
- [Surface planning](#surface)
- [Message derivation](#messages)
- [Persistence integration](#persistence)
- [Worked event sequence](#worked-sequence)
- [Debugging and exercises](#debugging)

-----

<a id="source-map"></a>
## Source map

| Concern | Implementation |
|---|---|
| Session event types, class, and store | [`packages/core/session/src/index.ts`](../../packages/core/session/src/index.ts) |
| Surface validation and folding | [`packages/core/session/src/surface.ts`](../../packages/core/session/src/surface.ts) |
| Request-header projection | [`packages/core/session/src/request-header.ts`](../../packages/core/session/src/request-header.ts) |
| Agent creation and persistence handoff | [`packages/core/agent-loop/src/index.ts`](../../packages/core/agent-loop/src/index.ts) |
| Persistence providers | [`packages/session/`](../../packages/session/) |

The raw log answers what was recorded. `Session.surface.nodes` answers which event sequence numbers currently form model history. `deriveMessages()` converts those nodes into provider-independent `Message` objects.

<a id="state"></a>
## Core state

`Session.log` is the private append-only array. `seq` is always `log.length`, so the next event position is also the expected sequence number. `header` stores durable creation metadata outside the event log. `inheritedEventCount` marks the forked prefix, while `firstLiveSeq` marks the constructor seed boundary in this process; the two offsets answer different questions after resume.

`surfaceManager` is the single incremental owner of surface acceptance and projection state. The Session does not maintain a second list of model messages. Its message cache stores derived values only and is invalidated from surface generation counters.

Three other folds avoid rescanning the complete log on every step: `requestHeader()` advances `headerFoldSeq`, `requestContext()` advances `contextFoldSeq`, and `deriveMessages()` advances `derivedNodes`. Each reads only unseen events unless a content-changing operation forces a rebuild.

<a id="construction"></a>
## Construction and restoration

`Session.create()` uses snapshot mode. It validates and deep-copies borrowed seed events so later caller mutation cannot alter history. `Session.fromRestore()` accepts independently owned or already frozen events from storage and avoids copying them again, but still validates envelopes, sequence continuity, and surface transitions.

The constructor processes the seed one event at a time. For each event it performs lossless JSON validation, checks `event.seq === index`, asks `surfaceManager.validateNext()` to plan the transition, and only then pushes the event. A failed event therefore cannot leave the surface ahead of the log or the log ahead of the surface.

After seed acceptance, the constructor fixes `firstLiveSeq`, validates header and inheritance metadata, and records `session/end-seed` when required. A new fork owns a marker exactly at its inherited cut. A restored session retains the stored marker and appends only when the loaded history does not already end with one.

<a id="append"></a>
## The append transaction

`append(type, data, opts)` is the central commit boundary. Its order is:

1. Copy `data` and surface metadata through `snapshotJsonValue()`.
2. Construct a candidate with `seq = log.length` and `time = Date.now()`.
3. Deep-freeze the candidate and validate event-specific rules.
4. Call `surfaceManager.validateNext(candidate)` without mutating committed surface state.
5. Collect current `session/event` observers.
6. Push the event into `log` and clear the full-log snapshot cache.
7. Notify observers while containing each observer failure.

Steps 1–4 are the rejection region: an error leaves the log unchanged. Step 6 is the commit. Observer failure after the push cannot roll back accepted history, so persistence listeners and UI listeners see one stable event identity.

The `appending` flag rejects reentrant append while observers of the current append are running. Without it, one observer could insert an event before later observers received the original event and break the shared ordering assumption.

Surface-producing event types require `surfaceOp`. `sourceEventSeqs` records provenance for transformations such as tool results and replacements. Log-only events such as `turn/start`, `step/end`, and `assistant/attempt` cannot silently enter model history.

<a id="surface"></a>
## Surface planning

`planSurfaceEvent()` validates the next sequence and returns one of three plans. An `append` plan adds the candidate sequence to the tail. A `replace` plan identifies a contiguous surface range, validates source references and special rewrite rules, then replaces the range with the new sequence. A `project` plan applies a plugin-owned message projection without changing node membership.

`SurfaceManager.validateNext()` stores the candidate and its prepared plan in `_pendingPlan`. After `Session.append()` pushes the exact candidate object, the next `_processDelta()` recognizes it and calls `applySurfacePlan()` without repeating stateful projection work. If another source supplies the event, `_processDelta()` validates it normally.

`replaceGeneration` changes only for positional replacement. `contentGeneration` changes for replacement and message projection because either can alter previously derived model content. `deriveMessages()` keys cache invalidation to `contentGeneration`, which is the broader condition.

Replacement has two important restrictions. The node at position zero may be rewritten only by a `system/message` replacing exactly that node. A tool-result rewrite must retain valid linkage to the tool call it represents. These checks prevent a general compaction mechanism from producing structurally invalid model history.

<a id="messages"></a>
## Message derivation

`deriveMessages()` reads `surface.nodes`, compares `surface.contentGeneration` with `derivedGeneration`, and resets the cache only when old content may have changed. It then derives only nodes after `derivedNodes`. The returned array is new on every call, while its message objects are shared and deeply frozen.

`SurfaceManager.deriveEventMessage()` delegates to the pure event-to-message mapping plus committed plugin projections. A surface node can still derive to `null`; an empty assistant message that only carries usage is the main example. This is why surface membership and output array length are related but not identical.

The cache design gives append-only traffic O(new nodes) behavior. A compaction replacement or projection rebuilds because prior messages may differ. Callers cannot mutate the durable log through the returned messages.

<a id="persistence"></a>
## Persistence integration

Persistence is attached by lifecycle code rather than by `Session.append()` itself. During agent creation, `createStoredSession()` asks the configured backend for a write handle. Setup may append events before publication, so `appendUnstoredSuffix()` explicitly writes the constructor and setup suffix before `prepared.publish()` exposes the live Session.

After publication, store-owned `session/event` listeners route accepted events to the active handle. `append()` remains synchronous and does not wait for disk I/O. The handle buffers writes and its `close()` or flush boundary establishes durability.

Teardown first cancels and drains the agent, then closes the persistence handle, and only afterward detaches agent and Session registries. Closing in this order lets final loop events reach the still-owned write path.

<a id="worked-sequence"></a>
## Worked event sequence

Consider a request that reads a file. A simplified log can contain:

```text
0 system/message   surface append
1 turn/start       log only
2 step/start       log only
3 user/message     surface append
4 request/header   log only
5 assistant/message surface append; contains tool-call
6 tool/call        log only
7 tool/result      surface append; sourceEventSeqs=[6]
8 step/end         log only
9 step/start       log only
10 assistant/message surface append; final answer
11 step/end        log only
12 turn/end        log only
```

The raw log has thirteen events. The model surface has events 0, 3, 5, 7, and 10. The next request after the tool result sees nodes 0, 3, 5, and 7; lifecycle markers stay available for diagnosis without appearing as conversation messages.

<a id="debugging"></a>
## Debugging and exercises

Set breakpoints in the Session constructor, `append()`, `planSurfaceEvent()`, `applySurfacePlan()`, `_processDelta()`, and `deriveMessages()`. Watch `log.length`, `_pendingPlan`, `nodes`, `contentGeneration`, and `derivedNodes` across one append and one replacement.

Exercise one: explain why validation must happen before `log.push()` but observer dispatch must happen afterward. Exercise two: construct a surface replacement on paper and state which caches reset. Exercise three: compare `firstLiveSeq` and `inheritedEventCount` for a resumed fork whose stored log contains child-owned events.
