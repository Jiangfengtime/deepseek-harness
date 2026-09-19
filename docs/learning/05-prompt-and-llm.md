# 5. Prompt assembly and LLM dispatch

English | [中文](05-prompt-and-llm.zh.md)

## Summary

This chapter explains how plugins contribute instructions and tool schemas, how the AgentLoop resolves a model route, how the LLM registry binds an adapter, and how a streamed response becomes one durable settlement. You will learn which facts belong in the request header, Session messages, and live stream.

## Table of Contents

- [Prompt assembly](#prompt)
- [Tool schemas and scope](#schemas)
- [Route preparation](#route)
- [System-message reconciliation](#system)
- [Request reconstruction](#request)
- [Streaming and assembly](#streaming)
- [Errors and retry](#retry)
- [Cache and token reasoning](#cache)
- [Exercises](#exercises)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="prompt"></a>
## Prompt assembly

[`dsh-system-prompt`](../../packages/core/system-prompt/README.md) collects ordered sections, variables, runtime-context sections, and tool-schema providers for each step. Contributions can be static text or functions over the active assembly context.

Section order is numeric, with names breaking equal-order ties. Repository-owned contributors use centrally allocated positions. Agent-scoped contributions shadow same-named ancestor entries. A `complete` contribution owns the entire resulting prompt; more than one effective complete contribution is invalid.

Variable interpolation runs during assembly. Missing variables and invalid complete-prompt combinations fail before a model request. Runtime-context suppression hides dynamic context contributions for the current scope without disabling the services that own those facts.

Prompt assembly produces structured sections and tool schemas. The loop separately renders context sections for input projection and renders the final system prompt. This separation prevents a runtime-context value from entering the request as unrecorded process memory.

<a id="schemas"></a>
## Tool schemas and scope

The tool registry automatically contributes schemas visible to the active Agent scope. Restrictions narrow inherited tools; scoped registrations can add or replace entries. Explicit tool order can position known names and one rest marker for all unlisted tools.

The loop compares assembled schemas with the current request header. A changed visible tool set starts a new request series because the model's callable interface changed. Schema data belongs in the request header, while tool implementation functions remain process-local.

Native mode exposes individual schemas. PTC mode exposes `run_code` and a generated SDK for visible tools. Both modes use the same underlying registry and execution pipeline, so presentation mode changes model input without creating another tool authority path.

<a id="route"></a>
## Route preparation

The loop first builds a proposal from Agent options and the latest request header. Adapter-derived defaults are removed before the next proposal so the selected route can resolve them again; explicit user or plugin settings remain.

`agent/request` is a waterfall over that proposal. It may route or adjust configuration, but the final value must contain both provider and model. `ctx.llm.prepareCall()` then resolves the registered adapter and asks it to validate provider-owned options, model existence, reasoning effort, output limits, and capabilities.

The resulting `PreparedLlmCall` binds:

- the effective provider and model configuration;
- which fields came from adapter defaults;
- retry policy;
- model context information;
- system-prompt update capability;
- the exact stream implementation used for dispatch.

Binding prevents a registry change between validation and dispatch from silently selecting another adapter.

<a id="system"></a>
## System-message reconciliation

The request carries no separate hidden `system` field. Effective prompt text travels through `system/message` nodes in Session history. [`runtime-context.ts`](../../packages/core/agent-loop/src/runtime-context.ts) computes the required append or replacement events after route preparation.

If a continuing request series supports in-history updates, a changed non-empty prompt can append a later system node. At a new series or on a route without that capability, the loop consolidates non-empty prompt text at the first system node and empties active later nodes through recorded replacements. An empty rendering clears every active non-empty system node so old instructions cannot remain model-visible.

Even an initially empty prompt reserves the system head node. This gives later reconciliation a stable location while an empty message produces no wire message.

<a id="request"></a>
## Request reconstruction

`buildRequest()` canonicalizes the effective header, records it when required, records changed request context, and calls `session.deriveMessages()`. It deep-freezes the fresh request envelope and each message identity not already proven frozen by this Agent.

`request/header` records configuration, visible tools, defaults, and request-series reasons. `request/context` records provider, model, context window, and system-prompt update mode when changed. System text remains in `system/message`, which lets the Session Surface determine its position among other messages.

The loop marks its requests so `llm/stream` middleware knows the input is log-derived and immutable. Middleware can wrap streaming, retry, replay, or observe it; it does not mutate a loop-built request.

<a id="streaming"></a>
## Streaming and assembly

The LLM adapter emits normalized stream chunks rather than provider-specific events. `AssistantStreamAttempt` records the compact timed stream, assembles content blocks, tracks usage and replay state, and publishes live frames.

```text
provider response
  -> adapter normalization
  -> llm/stream waterfall
  -> AssistantStreamAttempt
  -> live start/chunk/end frames
  -> durable assistant/message or assistant/attempt
```

The durable settlement happens before the committed terminal live frame. If final message assembly or append fails, the live attempt ends as aborted rather than claiming an unrecorded completion. A consumer reconnecting later reconstructs from the settlement event.

<a id="retry"></a>
## Errors and retry

Provider failures normalize into `LlmFailure` facts and `LlmError` for thrown control flow. Codes distinguish authentication, rate limits, context overflow, unavailable routes, and other provider-neutral classes while retaining safe provider facts such as status and retry delay.

An error finish settles the attempt, then enters `agent/request-error`. A listener that returns `{ kind: 'retry' }` short-circuits the default terminal action. Retry prepares the route again and can trigger compaction or backoff policy, but does not rerun prompt assembly, pre-step admission, or user-message append.

Errors before live stream start do not invent a stream start/end pair. Errors after start settle the collected attempt stream. Cancellation uses the turn signal and follows the interrupted-content rule described in the Agent-loop chapter.

<a id="cache"></a>
## Cache and token reasoning

Logging does not duplicate prompt text in a request: system messages in history are the prompt. Token cost comes from the rendered system content, retained messages, and tool schemas.

KV-cache reuse depends on prefix identity. Appending new history preserves the preceding prefix. Replacing the first system node changes the prefix from its first token. Changing tool schemas or request configuration can also move the first difference earlier. This is why system-update capability and request-series decisions are explicit rather than hidden adapter behavior.

<a id="exercises"></a>
## Exercises

1. Pick three prompt contributors and determine their order and scope.
2. Trace a provider/model change through proposal, `agent/request`, `prepareCall()`, header logging, and stream dispatch.
3. Compare prompt reconciliation for a continuing capable route and a new request series.
4. Trace one provider stream chunk type into normalized content and final assistant blocks.
5. Explain why request middleware may wrap streaming but must not mutate a marked loop request.

You have completed the chapter when you can reconstruct the exact model request from its Session prefix and explain which adapter instance will send it.

<a id="further"></a>
## Further Exploration

Continue with [Tools and execution](06-tools-and-execution.md). Use [LLM streaming](../subsystems/llm-streaming.md) for shared message and chunk types and the [system-prompt subsystem](../subsystems/system-prompt.md) for generated service contracts.

<a id="dev-note"></a>
## Dev Note

None.
