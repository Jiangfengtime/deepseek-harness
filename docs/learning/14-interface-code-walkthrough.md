# Web and SDK implementation walkthrough

English | [中文](14-interface-code-walkthrough.zh.md)

## Summary

This chapter traces user input across the Host Remote API and the SDK JSON-RPC server. It explains command validation, lazy Agent resume, prompt admission, durable event following, transient assistant frames, reconnect continuity, and SDK-owned lifecycle.

## Table of Contents

- [Source map](#source-map)
- [Host service structure](#host)
- [Web prompt path](#web-prompt)
- [Following history and live output](#follow)
- [Client continuity checks](#client)
- [SDK initialization and prompt path](#sdk)
- [Comparing ownership models](#comparison)
- [End-to-end traces](#traces)
- [Debugging and exercises](#debugging)

-----

<a id="source-map"></a>
## Source map

| Concern | Implementation |
|---|---|
| Remote Session namespace facade | [`packages/api/session-controller/src/index.ts`](../../packages/api/session-controller/src/index.ts) |
| Create, prompt, fork, and queue commands | [`packages/api/session-controller/src/commands.ts`](../../packages/api/session-controller/src/commands.ts) |
| Live Agent resolution and resume | [`packages/api/session-controller/src/agent.ts`](../../packages/api/session-controller/src/agent.ts) |
| Page and follow streams | [`packages/api/session-controller/src/history.ts`](../../packages/api/session-controller/src/history.ts) |
| Client event-stream adapter | [`packages/api/session-controller/src/client/transport.ts`](../../packages/api/session-controller/src/client/transport.ts) |
| SDK JSON-RPC server | [`packages/sdk/server/src/server.ts`](../../packages/sdk/server/src/server.ts) |

Both products reach the same Agent loop, Session, LLM, and tool services. They differ in transport protocol, who owns Session discovery, and how long a live Agent is retained.

<a id="host"></a>
## Host service structure

`SessionController` extends `TypertRemoteService` with the `session` namespace. Decorated methods define the wire operations, but the facade delegates business behavior to four focused objects: `ApiSessionAgentController`, `SessionCommandController`, `SessionHistoryController`, and `SessionControlController`.

The constructor registers file-upload Agent lookup, Session file/media/skill reference plugins, and event bridges for added, removed, status, error, model selection, and activity updates. These bridges project domain events into Host-facing notifications; they do not replace the Session event log.

`ApiSessionAgentController.resolveAgent()` first checks the live registry. If absent, it deduplicates concurrent resume requests in the `resumes` Map. All waiters share one persistence load and publication transaction. After resume, it checks ownership again because another route may have adopted the Session while callers waited.

Create uses a corresponding `creations` Map. `ensureSession()` either creates or adopts the requested identity, verifies preset and working directory compatibility, and returns the exact live Agent. Identity collision and held writer ownership become stable Remote error codes.

<a id="web-prompt"></a>
## Web prompt path

The wire call reaches `SessionController.prompt()`, which checks caller cancellation and delegates to `SessionCommandController.prompt()`. The command rejects empty content and invalid client time zones before resolving an Agent.

`requestId` supplies idempotency. `hasPromptRequest()` checks existing Agent state; a repeated accepted request returns success without enqueuing a duplicate message. The command also checks that the selected provider is currently served before processing attachments.

File receipts are resolved against the target Agent, and `attachments.admitPromptContent()` turns incoming references into durable content blocks. Image prompts additionally resolve current model metadata and reject unsupported image input. Image admission is serialized per Agent because model selection may change concurrently.

After asynchronous admission, the command verifies that the same Agent instance remains in the live registry. It creates a `UserMessage` with user source, RPC id, and optional canonical timezone, then binds upload receipts to this request.

`mode === 'steer'` calls `agent.steer(message)`; other prompts call `agent.followup(message)`. The upload binding commits only after the Agent accepts the message. The returned `{ accepted: true }` acknowledges queue admission, not completion of the turn.

<a id="follow"></a>
## Following history and live output

`SessionHistoryController.follow()` installs listeners before obtaining its opening observation. New `session/event` items are buffered while storage is read, closing the gap between snapshot and live subscription. A `session/created` listener also recovers constructor seed suffixes because constructor events were never published on the live firehose.

The first yielded frame is always `snapshot`: header, durable cursor, bounded records, pagination flag, projection baseline, and optional assistant-stream baseline. For a cold ordinary Session, the controller can retain the observation and promote it to a live Agent after the snapshot is safe to send.

Durable events then leave the buffer only when `event.seq` equals the next expected sequence. Older duplicates are ignored; a forward gap raises an internal Remote error. This rule makes reconnect bugs visible instead of presenting incomplete history as complete.

Assistant stream frames are optional and cursorless. The listener records the last durable cursor beside a stream start and assigns a process-local ordinal. Frames already represented by the opening baseline are skipped after the snapshot cut.

On cancellation or teardown, `finally` removes all listeners and the follower registration. The stream owns its subscriptions for exactly the lifetime of the Remote carrier.

<a id="client"></a>
## Client continuity checks

`SessionEventStream` adapts Remote frames into the generic journal stream. Snapshot becomes an `opened` frame, durable events become ordered entries, and assistant chunks become notifications.

The client validates every wire event and requires the opted-in opening assistant baseline. It stores the baseline revision and requires each subsequent assistant frame to increment it by one. A skipped revision throws `RemoteStreamCarrierError`, causing the surrounding reconnect mechanism to reopen from durable state instead of rendering a corrupt partial stream.

The UI can therefore rebuild settled content from durable events and use assistant frames only for in-progress presentation. Once `assistant/message` commits, the durable entry is authoritative and the transient attempt can disappear.

<a id="sdk"></a>
## SDK initialization and prompt path

The SDK server receives JSON-RPC methods through `handleRequest()`. It dispatches `initialize`, `session/prompt`, and `shutdown`; unknown methods throw and become JSON-RPC error responses at the transport layer.

`initialize()` validates reasoning effort and max tokens, resolves the working directory, and ensures an adapter exists. It mounts the DeepSeek adapter only when the requested official provider is otherwise unowned, then calls `llm.resolveCallConfig()` to reject an unusable route before marking the server initialized.

`prompt()` obtains a record through `getOrCreateSession()`. The `sessionCreations` Map deduplicates concurrent creation for one SDK Session id. `createSession()` calls `ctx.agents.create()` with SDK-owned cwd and model options, then stores the returned handle.

Before and after durable attachment conversion, `assertLiveAgent()` verifies that the retained handle still points to the registry's current Agent. It then creates a user message and calls `followup()`. The returned message id identifies admitted content; it does not claim that later Agent activity belongs exclusively to this RPC.

`shutdown()` marks the server closing, waits for in-progress creations, removes subscriptions, disposes every Agent handle and any dynamically mounted adapter, and aggregates teardown failures. The surrounding Cordis root remains alive because the SDK server owns only these resources.

<a id="comparison"></a>
## Comparing ownership models

| Question | Web/Host path | SDK server path |
|---|---|---|
| Session discovery | Live registry plus persisted query/resume | Server-local record map |
| Duplicate creation | Shared `creations`/`resumes` promises | Shared `sessionCreations` promise |
| Input protocol | Typed Remote namespace | JSON-RPC method |
| History delivery | Snapshot, durable entries, live frames | SDK notifications and client collection |
| Agent lifetime | Host Session lifecycle and promotion | Explicit SDK server handle ownership |
| Shutdown | Remote carrier closes subscriptions | Server disposes records and optional adapter |

The shared invariant is that input enters through an Agent API and settled model-visible output enters through Session events. Transport acknowledgements and transient frames never replace that history.

<a id="traces"></a>
## End-to-end traces

Web prompt:

```text
Client Remote call
  -> SessionController.prompt()
  -> SessionCommandController.prompt()
  -> ApiSessionAgentController.resolveAgent()
  -> attachment admission
  -> agent.followup()/steer()
  -> Agent inbox -> turn -> Session events
  -> SessionHistoryController.follow()
  -> SessionEventStream -> UI state
```

SDK prompt:

```text
JSON-RPC session/prompt
  -> Server.handleRequest()
  -> Server.prompt()
  -> getOrCreateSession()
  -> ctx.agents.create() when absent
  -> durablePromptContent()
  -> agent.followup()
  -> Agent loop and Session events
  -> SDK notifications / final collection
```

<a id="debugging"></a>
## Debugging and exercises

For Web, set breakpoints at `SessionController.prompt()`, `SessionCommandController.prompt()`, `ApiSessionAgentController.resolve()`, `SessionHistoryController.follow()`, and `SessionEventStream.follow()`. Watch request id, Agent object identity, snapshot cursor, buffered event sequences, and assistant revision.

For SDK, stop at `handleRequest()`, `initialize()`, `getOrCreateSession()`, `createSession()`, `prompt()`, and `performShutdown()`. Exercise one: explain why prompt acknowledgement precedes turn completion. Exercise two: trace reconnect while an assistant stream is active. Exercise three: issue two concurrent first prompts for one SDK id on paper and show why only one Agent is created.
