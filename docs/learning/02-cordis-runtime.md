# 2. Cordis runtime and extension mechanics

English | [中文](02-cordis-runtime.zh.md)

## Summary

This chapter explains the runtime mechanics shared by every Harness capability: Context service lookup, dependency activation, event dispatch, reversible effects, scoped registrations, and disposal. You will use these mechanics to tell direct capability calls from interception points and to reason about reload, rollback, and per-agent isolation.

## Table of Contents

- [Context and services](#context)
- [Dependency activation](#dependencies)
- [Events](#events)
- [Effects and disposal](#effects)
- [Scopes](#scopes)
- [A registration walkthrough](#walkthrough)
- [Failure patterns](#failures)
- [Exercises](#exercises)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="context"></a>
## Context and services

A Cordis Context is the plugin's view of available services and its current lifecycle. Harness services declaration-merge stable keys onto `Context`, such as `ctx.sessions`, `ctx.agents`, `ctx.llm`, `ctx.tools`, and `ctx.fs`. A consumer calls the interface through that key instead of importing a provider implementation.

This separation creates three useful roles:

| Role | Question | Example |
|---|---|---|
| Service definition | What can callers do? | `ctx.fs` file operations |
| Provider | How is it done in this composition? | Local or SSH filesystem |
| Consumer | Why is the capability used? | Model-facing `read` tool |

A capability seam is complete only when these roles provide an actual path from caller to implementation. An interface with no provider or a provider with no consumer is not a complete product capability.

Service access follows the plugin's context. Passing an agent-scoped context to setup code gives that code the scoped registry view and the service-resolution chain of the plugin that minted it. Scope is therefore an organization and ownership mechanism for trusted same-process plugins, not an authority barrier.

<a id="dependencies"></a>
## Dependency activation

Static `inject` declares services required before plugin activation. Cordis observes service availability and mounts the plugin when the requirements are satisfied. This makes activation resilient to configuration row order.

Optional integration belongs inside `ctx.inject([...], callback)`. The callback activates while the optional services exist and disposes when they disappear. Use this pattern when a plugin has useful behavior without the optional capability; do not weaken a truly required dependency and silently skip all work.

Distinguish these failure cases:

- A required service never appears: the plugin does not become active, and loader diagnostics identify the dependency.
- Configuration is invalid without external information: fail during plugin load.
- A referent can only be resolved when an operation begins: fail at the earliest operation point.
- An optional service disappears: only the contribution owned by its injection callback unwinds.

<a id="events"></a>
## Events

Events let plugins observe or intercept behavior without importing the producer implementation. The dispatch mode is part of each event's public behavior.

| Mode | Behavior | Typical use |
|---|---|---|
| `emit` | Invoke observers without awaiting their returned promises. | Status and post-commit notification |
| `parallel` | Run listeners and await all settlements. | Durability checkpoints |
| `serial` | Await listeners in registration order. | Initialization and ordered stopping hooks |
| `bail` | Stop when a listener returns a decision. | Selecting one provider or handler |
| `waterfall` | Compose around-middleware through `next()`. | Requests, tools, and policy interception |

A waterfall listener receives arguments followed by `next`. Calling `next()` delegates to the remaining listeners and base operation. Returning without it short-circuits. A listener that only records metrics, changes an allowed field, or wraps a result must delegate; a policy listener that owns a final rejection may intentionally stop the chain.

Read the producer's dispatch site together with the merged event declaration. The declaration supplies mode and payload; the dispatch site reveals whether the returned Promise or async iterator is subsequently awaited or consumed.

Harness uses three broad event domains. Session events are durable facts. Agent events carry a live Agent and describe in-flight work. Capability events belong to a service such as tools or filesystem and allow policy or adapters without coupling to the loop.

<a id="effects"></a>
## Effects and disposal

Registrations are effects: every registered tool, adapter, prompt section, event listener, or provider has an owner and a disposer. Cordis unwinds owned effects when a plugin unloads. This supports hot reload and also prevents failed activation from leaving half-installed state.

Use one effect when teardown order among related resources matters. Independent sibling effects can dispose in an order that is unsafe for a composite resource. The Agent factory uses an ordered lifecycle because the driver must write closing events before session publication and persistence disappear.

Disposal needs identity safety. A disposer created for one registry value must remove that exact value, not a later replacement using the same id. When reading a registry, check whether removal compares the registered object or merely deletes by name.

Observer failure policy belongs to the event owner. A post-commit Session notification contains listener failures because the event already exists. A synchronous creation announcement can veto publication and trigger rollback. Do not infer failure behavior only from the event name.

<a id="scopes"></a>
## Scopes

[`dsh-scope`](../../packages/core/scope/README.md) adds hierarchical visibility and lifetime to registrations. A child scope sees ancestor contributions, with the nearest named contribution taking precedence. A sibling cannot see another sibling's entries. Disposal removes everything owned by the scope.

Event filtering uses the same hierarchy in the other direction: an ancestor-scoped listener can observe descendant activity. Untagged global listeners see all eligible dispatches. The opaque scoped event carrier preserves routing without replacing the event's real subject.

```text
global registrations
  -> preset scope
       -> agent A scope
       -> agent B scope
```

Agent A and B inherit global and preset entries. An override in A affects only A. A listener registered at the preset scope can observe both descendants. This is the basis for per-agent tools, prompt sections, restrictions, and lifecycle listeners.

<a id="walkthrough"></a>
## A registration walkthrough

Follow the `read` tool registration through these points:

1. `tool-fs` declares required services in [`src/index.ts`](../../packages/fs/tool-fs/src/index.ts).
2. `applyReadTool()` registers a prompt section and a tool definition.
3. `ctx.tools.register()` stores the definition in the layer associated with the registering context.
4. Prompt assembly asks the tool registry for schemas visible to the active agent scope.
5. The AgentLoop sends those schemas in the request header.
6. The tool scheduler resolves the definition again for execution.
7. Unloading the contributing plugin disposes both prompt and tool registrations.

This path shows why schema visibility and execution lookup must use the same scope. Advertising a tool from one view and executing it from another would make model-visible capability differ from runtime capability.

<a id="failures"></a>
## Failure patterns

When plugin behavior appears twice after reload, first inspect missing effect ownership. When a service never activates, inspect `inject` and the effective configuration. When one Agent sees another Agent's tool, inspect the context used to register it. When a waterfall stops unexpectedly, inspect listeners that return without `next()`.

Avoid using a process-global singleton when lifecycle belongs to a Context. Tests run files concurrently and hot reload creates new plugin instances; global mutable state can leak across both. Use a service, scoped registry, or effect-owned value according to the required lifetime.

<a id="exercises"></a>
## Exercises

1. Find one `emit`, one `serial`, and one waterfall event in core packages. For each, name the producer, consumers, failure behavior, and whether returned async work is awaited.
2. Follow one tool registration from a global context and one from an agent context. Describe the visible set for the agent and its sibling.
3. Find a `ctx.inject()` callback. Explain what remains active when the optional service is absent.
4. Find a registry HMR-safety test that disposes the contributing fiber and verifies cleanup.
5. Explain why scope filtering does not prevent a trusted plugin from calling other services available on its Context.

You have completed the chapter when you can look at a registration and state who owns it, where it is visible, when it activates, how it intercepts work, and what removes it.

<a id="further"></a>
## Further Exploration

Continue with [Sessions and projections](03-sessions-and-projections.md). For hands-on Cordis practice, use the [Cordis tutorial](../cordis-tutorial/index.md); for generated service and event declarations, use the [subsystem index](../subsystems/README.md).

<a id="dev-note"></a>
## Dev Note

None.
