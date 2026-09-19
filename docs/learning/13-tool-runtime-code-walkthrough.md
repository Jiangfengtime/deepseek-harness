# Tool runtime and scheduler implementation

English | [中文](13-tool-runtime-code-walkthrough.zh.md)

## Summary

This chapter follows a model tool call through registry lookup, policy, concurrency scheduling, body dispatch, result finalization, and Session recording. It explains why execution may overlap while durable results remain in model order.

## Table of Contents

- [Source map](#source-map)
- [Definition and lookup](#registry)
- [Planning calls](#planning)
- [Parallel pools and exclusive barriers](#scheduler)
- [The staged runtime pipeline](#pipeline)
- [Cancellation behavior](#cancellation)
- [Durable results](#durable)
- [Worked schedule](#worked-schedule)
- [Debugging and exercises](#debugging)

-----

<a id="source-map"></a>
## Source map

| Concern | Implementation |
|---|---|
| Registry, policy, dispatch, and result finalization | [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts) |
| Model-call scheduler and Session events | [`packages/core/agent-loop/src/tool-calls.ts`](../../packages/core/agent-loop/src/tool-calls.ts) |
| Exact phase ordering reference | [Tool execution pipeline](../tool-execution-pipeline.md) |
| Concrete file-read tool | [`packages/fs/tool-fs/src/read.ts`](../../packages/fs/tool-fs/src/read.ts) |

There are two cooperating layers. `ToolRuntime` decides whether and how one call executes. `executeToolCalls()` coordinates a list emitted by one assistant message and commits its results in model order.

<a id="registry"></a>
## Definition and lookup

`register()` installs a `ToolDefinition` and returns a disposer through the Cordis effect lifetime. A definition contains model-facing schema, the body function, optional concurrency classification, optional presentation metadata, and optional final content transformation.

`view(scope)` computes the visible registry for an Agent scope. Scoped definitions shadow global definitions, and restrictions can remove a global tool. `get(name, scope)` reads that view. `schemas(scope)` projects only name, description, and detached parameters, so execution callbacks never enter the model request.

`resolveExecution()` applies an additional execution rule. In PTC presentation mode, a model-direct call may name only `run_code`; nested calls from the PTC bridge can resolve ordinary visible tools. Lookup for display and lookup for execution are therefore related but deliberately distinct.

`executionMode(exec)` is fail-closed. Only a definition whose `isConcurrencySafe(arguments)` returns exactly `true` is parallel. Missing, hidden, invalid, absent, or throwing classifiers produce exclusive mode.

<a id="planning"></a>
## Planning calls

`executeToolCalls()` first maps each `ToolCallBlock` to a `PlannedCall`. `parseArguments()` parses valid JSON, maps an empty string to `{}`, and preserves invalid JSON as raw text so the registry can materialize a structured invalid-argument result instead of the scheduler throwing early.

The outer loop classifies the next unconsumed call. A parallel first call offers the remaining suffix to `runGroup()`; an exclusive first call offers only itself. After each group commits, the loop classifies again because a completed tool can change registry visibility or policy for later calls.

Every planned execution carries call id, name, parsed arguments, initiating Agent, and the turn cancellation signal. Tool wrappers may later replace `exec.signal`, so the scheduler retains the caller signal independently inside ToolRuntime.

<a id="scheduler"></a>
## Parallel pools and exclusive barriers

`runGroup()` owns four cursors: `nextToStart`, `started`, `committed`, and the `inFlight` map. The `slots` array stores completed outcomes at their original model positions; `callSeqs` stores the durable `tool/call` sequence for result provenance.

`fillPool()` starts work until it reaches `maxParallelToolCalls`, sees cancellation, reaches the end, or reclassifies a later call as exclusive. Before each body starts, `startCall()` appends `tool/call`, runs ordered preparation, and then either dispatches the body or stores an already-final result.

Only dispatch promises overlap. Pre-execute work and final commit remain ordered. This protects approval prompts, guards, result events, and additional context from timing-dependent reordering.

`Promise.race(inFlight.values())` waits for any body to settle. Completion fills its indexed slot, but `commitReady()` advances only while `slots[committed]` exists. If call 1 finishes before call 0, its result waits in slot 1 until slot 0 can commit.

An exclusive call forms a barrier because the current parallel pool drains and commits before the outer loop classifies that call alone. The next parallel group cannot start until the exclusive call has fully finalized.

<a id="pipeline"></a>
## The staged runtime pipeline

ToolRuntime exposes scheduler-only `prepare`, `dispatch`, `finalize`, and `finish` operations around the same phases used by the public `execute()` convenience method.

`createExecution()` allocates a correlation token, root call id, deferred-context buffer, and cancellation state. It snapshots arguments as lossless JSON and captures the tool's `finalizeContent` callback at call start. A PTC-collapsed call returns a final denial before extensible policy listeners run.

`prepareExecution()` runs `tools/pre-execute`, resolves an `ask` through the Approval service, applies monotonic guards, and rechecks caller cancellation. Its result is a closed union: `dispatch`, `post-result`, or `final-result`. Policy denial needs post-processing; setup failure is already final.

`dispatchScheduledExecution()` runs the `tools/execute` around-waterfall. Its terminal callback `dispatchToolBody()` resolves the current definition, fuses caller and wrapper signals, marks `bodyInvoked`, calls `tool.execute(arguments, exec)`, and converts thrown values to error results. Started bodies always drain to quiescence.

The dispatch stage also attaches contexts collected through `exec.deferContext()`. If caller cancellation arrived after a successful body, the candidate becomes the appropriate aborted result before post-processing.

`finalizeScheduledExecution()` awaits `tools/post-execute` and applies post-stage cancellation. `finishScheduledExecution()` materializes a lossless frozen result, applies the definition-owned content finalizer, materializes again, and calls `notifyResult()`. Observer failures are logged and cannot mutate or reject the authoritative result.

<a id="cancellation"></a>
## Cancellation behavior

Cancellation before body invocation produces `ABORTED_BEFORE_DISPATCH`. Cancellation after invocation produces `ABORTED`, but the runtime still awaits the body. This rule prevents a supposedly cancelled process or file operation from continuing outside lifecycle ownership.

The scheduler stops starting new calls after observing abort, drains every already-started dispatch, and commits their results in order. It then appends synthetic call/result pairs for calls skipped before dispatch. The assistant's complete call list therefore has a corresponding result sequence even on cancellation.

A scheduler infrastructure failure is different from a tool error. The scheduler drains started promises but does not invent recovery results, then throws to the Agent loop. Ordinary tool and policy failures are materialized as `ToolExecutionResult` and remain part of model-visible history.

<a id="durable"></a>
## Durable results

`appendToolCall()` records name, raw model arguments, turn, step, and call id. The runtime executes parsed and snapshotted arguments, but the event preserves exactly what the model requested.

`appendToolResult()` creates a provider-independent tool-result message and appends `tool/result` with `surfaceOp: 'append'` and `sourceEventSeqs: [callSeq]`. Optional private `meta` persists presentation data so a replayed UI can rebuild the result card without the live tool instance.

`additionalContexts` do not enter the current result message. The scheduler passes them to the Agent callback, which inserts them into `next-step`; the next step records them as user messages at its normal admission boundary.

`concludesTurn` accumulates across committed results. It affects control flow after results are durable, so it cannot make earlier calls disappear from history.

<a id="worked-schedule"></a>
## Worked schedule

Suppose the model emits `read(A)`, `read(B)`, `edit(C)`, and `read(D)`. Both reads classify parallel and `edit` classifies exclusive.

```text
start read(A) ----- finishes second ---- commit result A
start read(B) -- finishes first -- wait - commit result B
                                            |
                                            v
                                      start edit(C)
                                      commit edit(C)
                                            |
                                            v
                                      start read(D)
```

The first two bodies overlap. Result B waits for result A because the commit cursor starts at zero. The edit begins only after both results commit, and read D begins only after the edit finalizes. Session history therefore matches the assistant's call order regardless of completion timing.

<a id="debugging"></a>
## Debugging and exercises

Set breakpoints at `executionMode()`, `runGroup()`, `fillPool()`, `startCall()`, `commitReady()`, `prepareExecution()`, `dispatchToolBody()`, and `finishScheduledExecution()`. Watch cursor values, slot occupancy, the execution token, `bodyInvoked`, and call/result event sequences.

Exercise one: make call 1 finish before call 0 on paper and identify where it waits. Exercise two: inject cancellation during approval, before body invocation, and after body invocation, then name each result code. Exercise three: explain why registry classification is repeated after every committed group.
