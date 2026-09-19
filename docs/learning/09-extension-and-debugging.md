# 9. Extension and debugging workflow

English | [中文](09-extension-and-debugging.zh.md)

## Summary

This chapter turns the architecture into a contributor workflow. You will classify a requested change, select its owning capability and extension point, implement all required roles, preserve observable history and UI presentation, and choose focused evidence. The debugging section maps common symptoms to the layer that owns them.

## Table of Contents

- [Classify the change](#classify)
- [Choose the extension point](#extension)
- [Design the complete capability](#capability)
- [Implement in repository order](#implementation)
- [Preserve observable behavior](#observable)
- [Trace one complete task](#flow-trace)
- [Select tests](#tests)
- [Debug by symptom](#debug)
- [First contribution exercises](#exercises)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="classify"></a>
## Classify the change

Before editing code, write one sentence naming the user-visible behavior and its owner. Then classify the change:

| Change | First owner to inspect |
|---|---|
| New model provider | `llm` adapter registry and provider package |
| New model-facing operation | Capability service plus tool consumer |
| Different capability for one Agent | Preset and agent scope |
| Request, turn, or tool policy | Existing waterfall or capability event |
| New durable fact | `SessionEventMap` plus every projection and consumer |
| New Web display | Raw durable data, Client slot, and renderer |
| New external protocol | Adapter over existing controllers and lifecycle |
| New execution location | Paired filesystem, subprocess, and sandbox providers |

Prefer an existing extension point to an AgentLoop edit. The loop owns generic “request model, execute tools, continue” sequencing; feature policy belongs on events and services. A loop change also requires updating the architecture map and the evidence for both SDK projections.

<a id="extension"></a>
## Choose the extension point

Use a service method when a caller requests a capability directly. Use an event when plugins need to observe, wrap, decide, or contribute without choosing a concrete provider. Use a Session event when the fact must survive reload or reach detached readers.

Choose among common paths:

- Register a model adapter on `ctx.llm`.
- Register a tool on `ctx.tools`; its schema enters prompt assembly automatically.
- Register a prompt section, variable, or context contributor on `ctx.systemPrompt`.
- Listen to `agent/pre-step`, `agent/request`, `agent/request-error`, or `agent/turn-stopping` for live loop policy.
- Listen to `tools/*` or capability events for execution policy.
- Call `agent.inject()` when context should enter the next admitted request.
- Add a projection when durable events reconstruct feature state.
- Add a Client slot contribution and renderer for browser presentation.

Read the event's exact mode before writing a listener. A missing `next()` in a cooperative waterfall is a behavior change, not a stylistic omission.

<a id="capability"></a>
## Design the complete capability

A replaceable capability normally needs:

1. A service definition with provider-neutral types and errors.
2. At least one provider that implements it and owns its resources.
3. A consumer that produces user or model value.
4. Composition rows that select the provider and consumer.
5. Lifecycle cleanup and optional runtime invariant checks.
6. Documentation for configuration, failures, limitations, and extension points.
7. Unit, real-composition, and model-visible evidence appropriate to the behavior.

Keep defaults in a `resolve(request): Spec` stage owned by the implementation. The operation runs an explicit resolved spec and does not hide deployment choices in `run()`. Deployment-varying values belong in validated plugin config rather than constants or test-only hooks.

Cross-package opaque ids use branded types. Validate hostile or durable data at parser, file, worker, process, wire, queued, and model/tool JSON boundaries. Trust TypeScript at typed same-process call sites rather than duplicating runtime checks for impossible values.

<a id="implementation"></a>
## Implement in repository order

Use this order to reduce partial designs:

1. Read root and subtree instructions, architecture, package README, and relevant defensive patterns.
2. Define user-visible behavior, failure, cancellation, ownership, and persistence needs.
3. Add or update provider-neutral types and events.
4. Implement provider and consumer paths.
5. Wire the composition and required dependency manifests.
6. Add Session events and projections before sending new data to a model or replayable UI.
7. Add pure Host/Client presentation from recorded data.
8. Update README, subsystem reference, generated catalogs, and current-state rationale owner.
9. Run the smallest checks that cover the final diff.

Every public API is pre-stable, so update every in-repository consumer together. Persistence types need the repository's explicit acknowledgement and version rules before changing released Session data.

<a id="observable"></a>
## Preserve observable behavior

Ask these questions for any product-visible change:

- Can the model-visible input be reconstructed from the log?
- Does the human transcript preserve content the user saw?
- Can the Web presentation rebuild after reload without live executors?
- Does cancellation settle visible partial work?
- Does teardown wait for owned async resources?
- Does one Agent's scoped change remain invisible to siblings?
- Can cold reads operate without waking an Agent?
- Does a provider swap preserve the consumer contract?

A new Session event must have a stable payload and all required readers. A new tool needs both model rendering and durable UI presentation design. A new process consumer needs cancellation and termination ownership, not only successful spawn.

<a id="flow-trace"></a>
## Trace one complete task

The base profile includes `@deepseek-ai/dsh-flow-trace` as a disabled learning and diagnostic observer. Enable it for one run with the supplied patch:

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/flow-trace.overlay.yml "trace one task"
```

Read the output as three interleaved layers. `agent ... phase=...` lines show process-local loop and policy activity. `tool ... phase=...` lines show pre-dispatch policy, implementation dispatch, post-dispatch policy, and the frozen result. `session ... event=...` lines show facts after `Session.append()` committed them. Match `id`, `turn`, `step`, `call`, and `attempt` fields to follow a single path.

A normal tool step can be followed in this order: inbox claim, `turn/start`, pre-step admission, `step/start`, request selection, assistant stream start/end, `tool/call`, tool pre/dispatch/post/result, Session `tool/result`, `step/end`, and either another step or `turn/end`. Some paths omit stages by design: a rejected pre-step has no step; a denied tool has no implementation dispatch; a request error may retry; cancellation may commit an interrupted assistant prefix.

The trace omits prompt text, message bodies, tool arguments and output, file contents, model chunks, and error messages. Use it to locate the first divergent stage, then inspect the owning package and the persisted Session events for exact data. See the [`flow-trace` package reference](../../packages/runtime-diagnostics/flow-trace/README.md) for every line family and configuration field.

<a id="tests"></a>
## Select tests

Use evidence that observes the affected layer:

| Evidence | What it establishes |
|---|---|
| Focused unit tests | State transitions, ordering, failure, cancellation, and disposal |
| Loader composition test | Plugin exports, dependency activation, and real configuration path |
| Recorded Session snapshot | Model-visible request, transcript, durable events, and replay |
| Web browser scenario | Actual rendering and interaction from recorded or live data |
| Real-provider e2e | Model adapter and model behavior against the external API |
| Built-artifact smoke | Published exports, plain Node resolution, workers, and bins |
| Performance gate | Time, heap, and scaling on representative synthetic data |

Do not use the Agent's textual claim as evidence of an external effect. Re-read the file, rerun the command, inspect the stored events, or query the API from the outside. Use [pre-push checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md) before publishing a branch.

<a id="debug"></a>
## Debug by symptom

| Symptom | Start here | Questions |
|---|---|---|
| Plugin absent | Effective profile and `inject` | Was the row selected, replaced, disabled, or waiting for a service? |
| Tool not advertised | Agent scope and restrictions | Is the definition visible from the same scope used by prompt assembly? |
| Tool advertised but fails to resolve | Execution scope and registry lifetime | Did reload dispose or replace the definition between steps? |
| Wrong model input | Prompt assembly and Session Surface | Which committed events and projections produced `deriveMessages()`? |
| Duplicate user message after retry | Agent step admission | Did code repeat first-attempt commitment? |
| UI loses content after reconnect | Durable settlement and metadata | Was the UI relying on transient frames or live presenters? |
| Shutdown hangs | Resource ownership and cancellation | Which process, iterator, writer, or listener has not reached quiescence? |
| Session opens live but cold query differs | Projection registration | Do live and detached readers use the same definitions? |
| Parallel tests flake | Shared resources and teardown | Are ports, paths, globals, clocks, or children isolated and awaited? |

Prefer one vertical trace over broad searches: entry or input, owner, event, provider, settlement, and observed result. Once the first divergence is known, search within that package and its tests.

<a id="exercises"></a>
## First contribution exercises

1. Add a local prompt section in a test-only composition, verify its Session system message, then dispose its scope and verify removal.
2. Implement a small read-only tool over an existing service. Cover invalid model input, successful rendering, result metadata, and registration disposal.
3. Add a tool execution observer that delegates with `next()`. Prove it observes success and ordinary error results without changing them.
4. Write a cold projection for a test event and compare incremental state with replayed state.
5. Trace one existing Web tool card from Session events to its Client renderer before changing UI code.

These exercises are intentionally smaller than a new capability. They teach the repository's registration, logging, presentation, and test paths before you own provider lifecycle or released persistence data.

<a id="further"></a>
## Further Exploration

Use the [extension cookbook](../cookbook/extension-cookbook.md) to select the concrete guide for packages, tools, adapters, settings, or events. Read [testing policy](../testing.md), [defensive patterns](../defensive-patterns.md), and the owning package tests before implementing production changes.

Return to the [learning guide](../learning-guide.md) and complete its end-to-end file-read trace. You now have the concepts needed to explain every layer in that path.

<a id="dev-note"></a>
## Dev Note

None.
