# Learning DeepSeek Harness from its source

English | [中文](learning-guide.zh.md)

## Summary

Follow “read a file and explain its contents” through application composition, model requests, tool execution, durable history, and product interfaces. This tutorial assumes basic TypeScript, asynchronous programming, and HTTP knowledge; it requires neither previous Cordis experience nor a model API key. After reading it, you can locate the owner of a behavior, trace its recorded events, and choose an extension point. The linked architecture reference and package READMEs own complete configuration and behavior.

## Table of Contents

- [Learning path](#learning-path)
- [Source implementation labs](#implementation-labs)
- [1. Understand the product](#product)
- [2. Learn plugins and application composition](#composition)
- [3. Separate runtime concepts](#concepts)
- [4. Trace a request](#request)
- [5. Understand Sessions and model history](#session)
- [6. Follow a real tool](#tools)
- [7. Inspect cancellation and resource ownership](#lifecycle)
- [8. Explore supporting systems](#systems)
- [9. Connect product interfaces](#interfaces)
- [10. Practice source navigation](#practice)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="learning-path"></a>
## Learning path

This page is the map and first reading pass. The following chapters form the detailed course; read them in order for a complete path, or enter at the chapter that owns your current question.

| Chapter | Outcome |
|---|---|
| [1. Architecture and composition](learning/01-architecture-and-composition.md) | Trace CLI selection through profiles, bundles, patches, and Cordis activation. |
| [2. Cordis runtime](learning/02-cordis-runtime.md) | Understand Context, services, events, effects, scopes, and reload-safe ownership. |
| [3. Sessions and projections](learning/03-sessions-and-projections.md) | Separate the event log, model history, transcript, and durable state projections. |
| [4. Agent loop](learning/04-agent-loop.md) | Follow inbox admission, turns, steps, attempts, tools, cancellation, and teardown. |
| [5. Prompt and LLM](learning/05-prompt-and-llm.md) | Trace prompt assembly, route preparation, immutable requests, streaming, and retries. |
| [6. Tools and execution](learning/06-tools-and-execution.md) | Follow one tool through schema, policy, scheduling, filesystem, subprocess, and sandbox layers. |
| [7. Persistence and context](learning/07-persistence-and-context.md) | Understand write ownership, generations, recovery, compaction, spill, and attachments. |
| [8. Product interfaces](learning/08-product-interfaces.md) | Connect Host, API, Client, Desktop, SDK, ACP, and live versus durable updates. |
| [9. Extension and debugging](learning/09-extension-and-debugging.md) | Choose extension points, implement a change, and select evidence for diagnosis and review. |
| [10. Boot implementation walkthrough](learning/10-boot-code-walkthrough.md) | Follow environment capture, profile composition, Loader mounting, readiness, and rollback function by function. |
| [11. Session implementation walkthrough](learning/11-session-code-walkthrough.md) | Read constructor validation, append transactions, Surface plans, caches, and persistence handoff in code order. |
| [12. Agent loop implementation walkthrough](learning/12-agent-loop-code-walkthrough.md) | Trace the driver state machine, request commit boundary, streaming attempts, retries, and lifecycle teardown. |
| [13. Tool runtime and scheduler implementation](learning/13-tool-runtime-code-walkthrough.md) | Follow registry resolution, policy stages, parallel pools, exclusive barriers, cancellation, and ordered commits. |
| [14. Web and SDK implementation walkthrough](learning/14-interface-code-walkthrough.md) | Trace prompt admission, lazy resume, durable follow streams, reconnect checks, and SDK ownership. |

Each chapter includes a source map, invariants to retain while reading, and exercises that require explaining the current code rather than memorizing terminology.

-----

<a id="implementation-labs"></a>
## Source implementation labs

Chapters 1–9 build the mental model. Chapters 10–14 are the code implementation track requested for line-by-line study. Each walkthrough starts with a real entry function, names the state read and written by each stage, identifies the point after which failure cannot roll the operation back, and ends with breakpoint-based exercises.

Use the implementation chapters in this order: boot constructs the runtime; Session defines recorded truth; the Agent loop drives requests; the tool runtime executes model actions; Web and SDK code expose the same core through different transports. Together they cover the primary path from process launch to user input, model request, tool result, durable history, and interface update.

-----

<a id="product"></a>
## 1. Understand the product

A model generates text and tool requests. Harness supplies the environment that turns those requests into useful work: context assembly, tool dispatch, permission handling, process management, conversation persistence, and user interfaces. For “read a file and explain its contents,” the model requests a read, Harness performs it, and the result enters the next model request.

```text
User input -> context assembly -> model request
                                   |
                                   v
Final response <- next request <- tool execution
```

Three ideas organize the repository: Cordis plugins compose the application; Session events supply reconstructable model history; capability consumers depend on service definitions so providers can be replaced. Read the [architecture overview](architecture.md) to recognize these relationships before studying their implementation.

| Location | Read it to understand |
|---|---|
| `apps/`, `packages/boot/`, `packages/bundle/` | Application entry points and configuration composition |
| `packages/core/`, `packages/llm/` | Sessions, agents, prompts, tools, and model calls |
| `packages/fs/`, `packages/shell/`, `packages/subprocess/`, `packages/sandbox/` | File and process execution |
| `packages/session/`, `packages/compaction/` | Durable history and context management |
| `packages/api/`, `packages/host/`, `packages/client/`, `packages/sdk/` | Human and programmatic access |
| `scripts/`, `snapshots/`, `benchmarks/` | Repository checks, recorded scenarios, and performance validation |

Use the [package map](../packages/README.md) to locate a capability family rather than memorizing every package. Source explains implementation; application configuration establishes whether a capability joins the running composition. Read both together.

<a id="composition"></a>
## 2. Learn plugins and application composition

Cordis supplies Context, service-dependent activation, events, and reversible effects. Plugins use services through properties such as `ctx.tools`, `ctx.llm`, and `ctx.fs`, and declare required services with `inject`. Registrations belong to a plugin lifetime and are removed when it ends. Start with the [Cordis primer](cordis-primer.md); framework internals can wait.

### Services, providers, and consumers

A service definition states what consumers can call; a provider implements the capability; a consumer uses it, often through a model-facing tool. For example, the file tool calls `ctx.fs`, while application composition selects the filesystem provider. These roles can share a package when they do not evolve independently. Locate all three roles when reading a new capability.

### Events and lifetime

Events let plugins cooperate without importing the default loop. `emit` notifies observers, `serial` awaits ordered work, and `parallel` awaits concurrent work. A waterfall listener receives `next()` and can delegate or short-circuit; its return value can itself be a Promise or async iterator, so timing depends on the event declaration and caller. Listeners that only observe or wrap an operation normally need to call `next()`.

Reversible registrations let configuration reload, plugin unload, and initialization rollback clean up contributions. When reading a `register()`, find its disposer and lifetime owner as well as the registry insertion.

### Profiles, bundles, and patches

A named profile selects a runtime composition, bundles provide plugin configuration and code, and patches customize configuration. Read [the CLI entry](../apps/cli/src/bin.ts), [profile boot](../apps/cli/src/profile-boot.ts), and [the base bundle](../packages/bundle/base/cordis.patch.yml) in that order. The [application architecture](architecture.md) defines how the shared base relates to product entry points; package existence does not establish product activation.

Checkpoint: find the `inject` declaration in [the file-tool entry](../packages/fs/tool-fs/src/index.ts), then locate its required services in the composition. If a capability is inactive, investigate configuration and service dependencies before its executor.

<a id="concepts"></a>
## 3. Separate runtime concepts

These concepts answer different questions. Distinguishing them makes retries, resume, and additional input easier to understand.

| Concept | Meaning |
|---|---|
| Session | Conversation identity and recorded events |
| Agent | Live object driving work for a Session |
| Turn | A work interval containing zero or more steps |
| Step | A logical model-request stage and the tools it produces |
| Attempt | One model attempt within a step; retry can add another |
| Scope | Visibility and lifetime of plugin contributions |

A stored Session need not have a live Agent. Resume connects live execution to existing history. The public Agent interface is separate from the default driver, so integrations use `ctx.agents`, while the default implementation lives in `agent-loop`.

Agent-scoped registrations can override inherited contributions without affecting siblings. Scope organizes trusted plugins; it is not an operating-system sandbox. See [scope](../packages/core/scope/README.md).

Checkpoint: describe “read a file, run a command, and answer” as several steps in one turn, then add a failed model attempt. A retry does not thereby become a new user turn.

<a id="request"></a>
## 4. Trace a request

Open [ReactLoopAgent](../packages/core/agent-loop/src/agent.ts). First follow the normal path through `send`, `wakeDriver`, `kick`, `turn`, `preStep`, and `step`; read cancellation and recovery on a second pass. The class name does not refer to a browser React component.

### Input admission

`followup()` queues waking input for the next turn; `steer()` targets the next step and wakes the driver; `inject()` targets the next step without waking it. These methods stage input instead of rewriting an already dispatched model request. [The inbox implementation](../packages/core/agent-loop/src/inbox.ts) connects queue mutations to the durable inbox projection.

A turn opens before claiming its input. `preStep()` assembles the prompt and tool schemas, projects runtime context, and asks `agent/pre-step` to accept, rewrite, or reject input. Rejected or empty initial admission can finish a turn without a model step.

### Request construction

After admission, the loop opens the step and resolves request configuration through `agent/request` and `llm.prepareCall()`. It then reconciles the system prompt, records admitted user messages, records request metadata as needed, and derives the immutable model request from the Session. Cancellation during asynchronous route preparation commits neither the pending system prompt nor admitted users.

The prepared call binds the effective adapter and its capabilities, connecting the effective configuration in the log to actual dispatch. Read `prepareRequest()` and `buildRequest()` beside [the LLM service](../packages/llm/llm/src/index.ts). Request freezing prevents later mutation of recorded input while cancellation remains live.

### Stream settlement and continuation

The loop consumes stream chunks and commits `assistant/message` on success, while failed attempts are recorded separately from model history. If the message contains tool calls, the scheduler executes them and records their results; another step normally lets the model consume those results. Turn-stopping listeners can contribute further work, so absence of tool calls alone does not establish that all work has ended.

Retry happens within the current step, reusing assembled content without admitting the same users again. The [agent-loop README](../packages/core/agent-loop/README.md) owns exact continuation, error, and retry semantics.

Checkpoint: locate the first `user/message` append and the call to `deriveMessages()`. Explain their order relative to route preparation and why retry must not append the users again.

<a id="session"></a>
## 5. Understand Sessions and model history

Start with [Session](../packages/core/session/src/index.ts) and [surface.ts](../packages/core/session/src/surface.ts). The log includes messages, request metadata, tool activity, and lifecycle markers; only selected events produce model messages. For example, `tool/result` contributes model input, while `turn/start` and failed `assistant/attempt` records do not become ordinary conversation messages.

### Three different views

The complete log, model-visible Surface, and human transcript answer different questions: what happened, what the next request sees, and what the user experienced. A recorded replacement can condense older model context while preserving original events. Rendering only the current model Surface would lose earlier conversation that the user already saw.

```text
Recorded events
  -> model Surface -> deriveMessages() -> next request
  -> human transcript -> conversation history
  -> state projections -> inbox and other durable state
```

### System prompts and projection

System prompts also participate in recorded history. [Prompt assembly](../packages/core/system-prompt/README.md) collects ordered contributions and visible tool schemas; [runtime-context.ts](../packages/core/agent-loop/src/runtime-context.ts) handles related projections. The effective route capability governs whether prompt updates can enter later history or require consolidation. Do not assume every model treats system messages identically.

### Persistence and resume

Memory commitment and disk durability are distinct. The persistence provider manages write handles and buffering, while a flush checkpoint awaits durability listeners. Resume reconstructs history rather than automatically repeating past external side effects. See [session persistence](subsystems/persistence.md) for storage ownership and [format status](session-format-status.md) for format versions.

When reading migration code, distinguish “reading older data into current logical records” from “publishing a successor version file for writing.” Format compatibility, physical file selection, and interrupted-turn repair have separate owners; treating all three as JSON deserialization hides that distinction.

Checkpoint: find the message-producing cases in `deriveEventMessage()`. Explain why a failed attempt remains diagnosable without becoming the next model input.

<a id="tools"></a>
## 6. Follow a real tool

Read [the read tool](../packages/fs/tool-fs/src/read.ts) from definition to executor. Identify input parameters, value checks, output schema, text rendering, presentation metadata, and concurrency declaration. The tool uses `ctx.fs`; its package owns model-facing behavior rather than a particular filesystem implementation.

### What a read includes

The implementation selects a bounded line window and streams large or size-unknown inputs. Model text contains the readable window, while persisted presentation metadata supplies structure for rebuilding a UI card. Reading also contributes file observations for relevant policies. This example shows how one execution serves the model, policy, and interface.

### The tool pipeline

A call passes through pre-execution policy, guards, execution middleware, the tool body, and result processing. Guards can deny without later guards reversing that denial. The [tool pipeline](tool-execution-pipeline.md) defines the exact stage order. Read [the tool registry](../packages/core/tools/src/index.ts) after the concrete read example makes those stages recognizable.

### Concurrency and commitment order

The [scheduler](../packages/core/agent-loop/src/tool-calls.ts) separates parallel-safe calls from exclusive calls, which form ordering barriers. Concurrent completion does not reorder committed results: results remain in model call order. Inspect the pool and commit cursor separately to distinguish execution concurrency from history order.

Checkpoint: consider two reads followed by an exclusive edit. Explain what may overlap, when the edit may start, and why the second read finishing first does not reorder history.

<a id="lifecycle"></a>
## 7. Inspect cancellation and resource ownership

Return to the loop's exceptional paths after understanding the normal path. An AbortController communicates cancellation to active work. Already displayed assistant content can settle as an interrupted message; a failed attempt without admitted message content remains separate. The scheduler stops starting work and drains started calls. See [the loop implementation guide](../packages/core/agent-loop/README.md) for skipped-call records and failure distinctions.

Agent creation and disposal coordinate several resources. Read the creation transaction in [agent-loop/index.ts](../packages/core/agent-loop/src/index.ts): setup and initialization complete before queued work is released. Teardown drains the driver before removing registrations and persistence resources needed for final records. A collection of independent cleanup callbacks would not establish this ordering.

Checkpoint: identify who owns the AgentHandle, scope, and persistence write handle. Before modifying these paths, read [defensive patterns](defensive-patterns.md), especially lifecycle, asynchronous work, and teardown rules.

<a id="systems"></a>
## 8. Explore supporting systems

Choose a branch according to the question you want to answer. The linked owners explain implementation and limits without requiring the whole repository to be read first.

| Question | Reading path |
|---|---|
| Where does a command execute? | [Shell](../packages/shell/README.md), [subprocess](../packages/subprocess/README.md), and [sandbox](../packages/sandbox/README.md): command execution, process lifetime, and confinement are different responsibilities. |
| How do remote files and commands agree? | [SSH](../packages/ssh/README.md): paired providers share an execution environment. |
| How does a long conversation continue? | [Compaction](../packages/compaction/compaction-basic/README.md): summarize eligible older history while retaining recent context. |
| How are large results handled? | [Spill](../packages/spill/README.md): external storage and model-facing result policy. |
| Can the model organize calls in a program? | [PTC runtime](../packages/ptc-runtime/ptc-runtime-node/README.md): Node execution, host bindings, limits, and sandbox policy. |
| How is work delegated? | [Subagents](../packages/subagent/README.md): provider-backed fresh or continuable children. |
| How are longer activities organized? | [Jobs](../packages/jobs/README.md), [workflow](../packages/workflow/README.md), [goals](../packages/goal/README.md), and [schedules](../packages/schedule/README.md): background execution, orchestration, objectives, and follow-ups. |
| How do external capabilities join? | [MCP](../packages/mcp/README.md) and [skills](../packages/skill/README.md): tool integration and instruction discovery. |

Within these branches, keep distinguishing interfaces from providers, model-visible content from internal state, and process isolation from plugin scopes. For example, a subagent need not be a separate operating-system process; direct Node operations in PTC must be understood under the actual sandbox policy.

<a id="interfaces"></a>
## 9. Connect product interfaces

For Web, trace input through the Client connection and Session Controller to Agent admission, then trace output in the reverse direction. Distinguish durable Session events from transient assistant-stream frames: the former supports history recovery, while the latter supplies live incremental presentation. Start with [API](../packages/api/README.md) and [Client](../packages/client/README.md), then follow the controller and UI package that owns your question.

The browser also uses plugins: modules load capabilities, slots define extension locations, and renderers turn contributions into UI. Tool presentation should recover from recorded events and metadata rather than depend on a live executor. Desktop hosts the Web application inside its packaged carrier; see [Desktop](../apps/desktop/README.md) for boot and process ownership.

The [TypeScript SDK](../packages/sdk/client/README.md) and [Python SDK](../python/README.md) drive a separate Harness runtime over JSON-RPC. Read the client's process ownership and receipt-to-idle collection before interpreting a returned final response. The runtime shares application composition and the loop, while SDK clients own transport and subprocess cleanup.

Checkpoint: explain which records reconstruct the interface after reconnecting, which frames only improve live presentation, and why SDK idle waiting does not mean one input exclusively owns the entire activity interval.

<a id="practice"></a>
## 10. Practice source navigation

Use “read a small file and explain its contents” as the first paper exercise; no model call is required. Write down each stage's owner and durable events, then compare your sequence with the loop and tool source.

1. Locate where input is queued and which method wakes execution.
2. Find prompt and tool-schema assembly, then the input-admission decision.
3. Find request route preparation and the first committed user message.
4. Find how the assistant message supplies a read call to the scheduler.
5. Follow the registry to the read executor and its filesystem provider.
6. Find the recorded tool result and the next derived model history.
7. Find the final assistant settlement and turn ending.
8. Repeat the trace with cancellation during model streaming and with a failed request attempt.

For executable practice, follow [development setup](development.md) and the relevant package's usage instructions. This page is a source-reading tutorial and supplies no validation result for a live model run. Credentials, installed dependencies, selected providers, and runtime configuration require an actual run to verify.

Use [testing policy](testing.md) to choose evidence: focused tests cover state and errors; recorded-session scenarios cover assembled model-visible behavior; real-provider tests cover actual model integration; built smokes cover published entry points. For a file-changing task, inspect the resulting file rather than accepting the assistant's claim that it changed.

When a trace diverges, classify the symptom before searching: missing capability points toward composition or scope; unexpected model input toward assembly and Session projection; tool denial toward policy; hanging shutdown toward resource ownership; missing UI history toward durable records and client projection. This narrows the search to the responsible module.

<a id="further"></a>
## Further Exploration

After the exercise, choose a concrete change and consult the [extension cookbook](cookbook/extension-cookbook.md). Adding a tool, provider, UI contribution, or durable event follows different extension paths. Read the owning package's tests and README before changing implementation; consult its subsystem reference when you need complete types.

<a id="dev-note"></a>
## Dev Note

None.
