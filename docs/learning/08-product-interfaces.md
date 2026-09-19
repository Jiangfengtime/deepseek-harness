# 8. Web, Desktop, SDK, and ACP interfaces

English | [中文](08-product-interfaces.zh.md)

## Summary

This chapter connects the shared Agent and Session runtime to its product interfaces. You will follow a Web prompt through Client, API, Host, and Agent layers; distinguish durable events from live frames; and compare Desktop, SDK, and ACP process ownership.

## Table of Contents

- [Host and Client split](#split)
- [Remote API](#api)
- [Session control](#session)
- [Client composition](#client)
- [Live and durable updates](#updates)
- [Desktop carrier](#desktop)
- [SDK](#sdk)
- [ACP and other integrations](#acp)
- [Exercises](#exercises)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="split"></a>
## Host and Client split

The Host runs trusted Node capabilities: Agent lifecycle, persistence, filesystem and process providers, settings, and API controllers. The Client runs in the browser: connection, observable stores, localization, slots, renderers, and UI feature plugins.

The split is a process and trust boundary. Client code cannot import Host services and call them directly. It uses typed Remote methods, streams, or feature-owned fetch routes. Shared Typert definitions generate the protocol-facing type graph without merging Host and Client Cordis service declarations into one TypeScript program.

<a id="api"></a>
## Remote API

`packages/api/` provides the typed Remote layer. Controllers own domain behavior; the gateway owns invocation transport. For example, the Session Controller owns list, resume, prompt, cancel, page, follow, fork, rename, and attachment access, while the gateway maps calls and streams over the application connection.

This separation keeps transport concerns out of domain controllers. A controller can decide that an operation needs a live Agent, persistence read, projection snapshot, or authorization proof. The gateway validates and carries the request but does not invent Session policy.

Large byte streams that do not fit ordinary Remote invocation use exact connection fetch routes owned by their feature, such as uploads or downloads.

<a id="session"></a>
## Session control

A Web prompt follows this conceptual path:

```text
composer
  -> Client Session remote
  -> Host Session Controller
  -> resolve workspace and Session identity
  -> create or resume Agent
  -> queue identified user message
  -> follow durable and live updates
```

Prompt acceptance acknowledges inbox admission rather than claiming a causally paired assistant answer. More messages, steering, injected context, tools, or turn-stopping work can contribute before the Agent becomes idle.

Cold reads such as list and page should stay cold. Prompt, cancel, and pending-queue mutation need a live Agent and may resume it. Attachment reads additionally prove that the Session log reaches the referenced content.

<a id="client"></a>
## Client composition

The browser is also a Cordis plugin application. `client/modules` loads declared client modules. `connection` manages Host communication. React-free stores expose observable state. `ui-slots` defines typed extension locations, and `ui-renderer` mounts the assembled React application.

Feature packages contribute focused UI behavior: conversation, chat nodes, tools, approvals, sidebar resources, goals, plans, jobs, schedules, settings, and workspace controls. A feature normally registers data and a renderer through a slot instead of editing one central application component.

Client UI copy belongs to typed locale dictionaries. Domain plugins should pass localized values into Cordis-free primitives rather than hardcode product text in components.

<a id="updates"></a>
## Live and durable updates

Session follow carries a complete opening snapshot and gap-free durable event frames from a cursor. Assistant-stream frames are optional cursorless live additions. The Client reconciles these two sources:

- Durable events rebuild state after reconnect and define committed history.
- Live frames improve latency while the current assistant attempt is running.
- A settlement event replaces provisional live display with durable content.
- A reconnect does not assume that previously displayed transient chunks committed.

Tool cards derive from recorded calls, results, failure state, and metadata. This lets a page reload reproduce presentation without a live ToolDefinition or executor.

<a id="desktop"></a>
## Desktop carrier

The Electron application packages the exact production runtime and owns its reserved Desktop profile. Electron starts the Desktop Host, loads packaged Web assets immediately, and injects readiness and connection facts before Client plugins activate.

Web remains responsible for RPC and streams. Electron IPC carries boot injections, readiness, fatal errors, and shutdown between the carrier and Host. Desktop and CLI share product data but keep executable packages, profile activation, and lockfiles separate.

<a id="sdk"></a>
## SDK

The TypeScript and Python SDKs start or connect to a `dsh --profile sdk` runtime and communicate over stdio JSON-RPC. The server's stdout contains protocol frames only; diagnostics use stderr.

`initialize` waits for the Loader composition to settle, validates the model route, and stores runtime options. A prompt returns its message id after queue admission. Notifications report Session events and Agent status. The high-level TypeScript client waits from durable inbox receipt through the next whole-Agent idle and returns the last committed root assistant response in that interval.

The client owns process startup and cleanup. Its shutdown ladder asks the protocol to shut down, closes stdin, then escalates termination until actual process exit. The runtime server owns root-context disposal after protocol shutdown so Agents and persistence reach quiescence.

<a id="acp"></a>
## ACP and other integrations

ACP exposes an automation-focused protocol through another shipped profile. It still uses the shared Agent, Session, tools, and provider plugins; the protocol adapter owns only its external mapping and lifecycle.

MCP brings external servers into the native tool registry. Hooks connect other coding-agent protocols. Webhooks validate external deliveries, apply trusted rules, and create Workspace Sessions. These integrations should convert boundary data into existing Harness capabilities instead of creating separate execution loops.

<a id="exercises"></a>
## Exercises

1. Trace one Web prompt from a localized composer action to an inbox event.
2. Find the opening snapshot and incremental frame types used by Session follow.
3. Select one tool card and identify which persisted metadata allows it to survive reload.
4. Compare ownership of a Web Host process, Desktop Host process, and SDK runtime child.
5. Explain why an SDK prompt result cannot promise one assistant response caused only by that prompt.

You have completed the chapter when you can identify the domain owner, transport, durable facts, transient updates, and process owner for one product interaction.

<a id="further"></a>
## Further Exploration

Continue with [Extension and debugging](09-extension-and-debugging.md). Use the [API group](../../packages/api/README.md), [Client group](../../packages/client/README.md), [Desktop README](../../apps/desktop/README.md), and [SDK client](../../packages/sdk/client/README.md) for package-specific behavior.

<a id="dev-note"></a>
## Dev Note

None.
