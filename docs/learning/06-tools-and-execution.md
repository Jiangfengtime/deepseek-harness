# 6. Tools and the execution world

English | [中文](06-tools-and-execution.zh.md)

## Summary

This chapter follows a model tool call from schema advertisement through policy, execution, result commitment, and UI presentation. It then separates filesystem, shell, subprocess, terminal, and sandbox responsibilities so you can locate behavior and security decisions in the correct package.

## Table of Contents

- [Tool definition](#definition)
- [Visibility and policy](#policy)
- [Execution pipeline](#pipeline)
- [Scheduling](#scheduling)
- [Filesystem example](#filesystem)
- [Shell and subprocess](#process)
- [Sandbox and approval](#sandbox)
- [Presentation and large output](#presentation)
- [PTC mode](#ptc)
- [Exercises](#exercises)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="definition"></a>
## Tool definition

`defineTool()` creates a typed definition with a model-facing name, description, parameter schema, output schema and renderer, execution body, optional presentation metadata, and concurrency classification. The registry exposes schemas to prompt assembly and keeps executor functions inside the Host process.

Parameter schema validation handles JSON structure. Tool code still validates semantic constraints that the schema cannot express, such as positive integer windows, non-empty paths, or relationships between options. Invalid model arguments become normal error results rather than crashing the Agent loop.

Output has two representations. The executor returns the declared lossless-JSON value. The output renderer converts it into content blocks for the model and Session log. A tool can additionally persist pure presentation metadata that lets UI reconstruct a specialized card without parsing rendered prose.

<a id="policy"></a>
## Visibility and policy

Scope and restrictions decide which schemas the model sees. `ctx.tools.restrict()` intersects allow and deny masks with inherited entries. Execution resolves the definition through the calling Agent scope, matching advertisement and dispatch.

Policy can make three broad decisions: allow, deny, or ask for one human approval. `tools/pre-execute` is the extensible first stage. Registered synchronous guards run afterward and are monotonic: one denial cannot be reversed by another guard. An absent or unusable approval service cannot turn an ask into permission.

Standing policy belongs to the relevant capability owner, while the tool pipeline coordinates the decision. Filesystem freshness policy listens to filesystem events; sandbox mode comes from sandbox policy; tool restrictions control advertisement and dispatch. These mechanisms compose rather than replace one another.

<a id="pipeline"></a>
## Execution pipeline

The authoritative order is documented in the [tool execution pipeline](../tool-execution-pipeline.md):

```text
tool/call event
  -> tools/pre-execute
  -> monotonic guards and approval
  -> tools/execute around-middleware
  -> definition.execute()
  -> tools/post-execute
  -> outer normalization
  -> definition.finalizeContent
  -> tools/result notification
  -> tool/result event
```

Ordinary tool errors settle as `ToolExecutionResult` with `isError`; they do not throw through the Agent loop. Pipeline infrastructure failures can still throw and end the turn. `tools/post-execute` may replace content or add next-step contexts. `finalizeContent` is the definition's last content-only check. `tools/result` observes the frozen authoritative result and cannot rewrite it.

The `tool/call` event commits before execution so pending UI and replay know what was requested. The result cites its call sequence. A scheduler failure preserves already recorded calls instead of fabricating results for work whose outcome is unknown.

<a id="scheduling"></a>
## Scheduling

[`tool-calls.ts`](../../packages/core/agent-loop/src/tool-calls.ts) classifies each unstarted call at the moment it can begin. Parallel-safe calls enter a bounded rolling pool. An exclusive call waits for the current pool to drain, runs alone, and forms a barrier before following calls.

Completion and commitment are separate. Dispatch promises may settle out of order, but a commit cursor finalizes contiguous slots in model order. Additional contexts also enter the inbox in that order.

Cancellation stops replenishing the pool and drains started calls. Unstarted calls receive synthetic `ABORTED_BEFORE_DISPATCH` results. An internal scheduler failure drains started dispatches but does not invent recovery results, then throws the first failure.

<a id="filesystem"></a>
## Filesystem example

Follow [`tool-fs/src/read.ts`](../../packages/fs/tool-fs/src/read.ts). It validates its line window, resolves a regular-file target, obtains one stat for type and size routing, streams large or size-unknown files, builds a bounded window, and returns structured line data. Its renderer produces line-numbered text; presentation metadata retains path, language, offsets, and lines for replayable UI.

The filesystem family separates responsibilities:

| Package role | Responsibility |
|---|---|
| `fs` | Provider-neutral targets, reads, streams, and guarded atomic mutations |
| `fs-local` or `fs-ssh` | Actual execution-world I/O |
| `fs-sandbox` | Per-call write confinement over a provider |
| `fs-observation-policy` | Read-before-edit observations and stale-write rejection |
| `tool-fs` | Model schemas, validation, bounded rendering, and tool semantics |

Read-before-edit policy records observed file presence or version, then rechecks mutations in the provider's lock. A concurrent write makes the mutation fail stale and requires another read. The policy is a plugin; without it, the base provider remains an unconditional filesystem capability.

<a id="process"></a>
## Shell and subprocess

The shell service defines command requests, resolved execution specs, foreground results, and background handles. Bash or PowerShell providers implement shell semantics. Model-facing tools parse user arguments and present results.

The subprocess service owns lower-level process creation, executable lookup, stdio, bounded output, process-range termination, and terminal allocation. Shell, LSP, PTC, terminals, and out-of-process subagents consume it. Consumers own the meaning, deadline, and result presentation of each process.

Filesystem and subprocess providers form one execution world. If commands run remotely while file tools read locally, a model can inspect one project and execute against another. SSH therefore supplies paired providers instead of adding remote branches to every tool.

<a id="sandbox"></a>
## Sandbox and approval

Sandbox policy resolves a per-call mode such as read-only, workspace-write, or unrestricted. A sandbox provider converts that policy into platform-specific process confinement. Filesystem confinement uses the same policy through its provider wrapper.

Sandboxing, approval, and tool restrictions answer different questions:

- Restriction: may this Agent see and dispatch this named tool?
- Approval: may this one requested action proceed or escalate?
- Sandbox: what filesystem effects can the resulting process or provider operation perform?

Requested restricted execution fails when the backend cannot supply its declared enforcement. A one-time approved escalation changes that call's resolved policy; it does not silently change standing Session policy.

<a id="presentation"></a>
## Presentation and large output

Host presenters are pure. The Web Client derives tool cards from raw events, result content, failure state, and persisted metadata. This keeps replay independent from the live executor.

Bounded tool output protects model context and transport memory. Spill policy can store oversized complete output and replace only the logged/model-facing copy with a preview and locator; the program that called the tool already received its full return value. Compaction can later prune eligible historical tool results.

<a id="ptc"></a>
## PTC mode

PTC presents a generated SDK and `run_code` instead of, or beside, individual native tools. The Node provider runs each program in a fresh managed process with elapsed, heap, message, pending-call, and output limits. Host bindings dispatch nested calls through the same tool registry, policy, logging, and approval path.

PTC reduces model round trips when a program can filter or combine intermediate values. It does not create a new unrestricted tool channel. Direct Node APIs remain subject to the resolved operating-system sandbox, so isolation claims must match the selected backend.

<a id="exercises"></a>
## Exercises

1. Trace one `read` call from advertised schema through result event and UI metadata.
2. Create a paper schedule for parallel read A, parallel read B, exclusive edit C, and parallel read D.
3. Identify where invalid arguments, an ordinary executor error, a denied call, and a scheduler failure each become results or thrown failures.
4. Trace a Bash command through tool, shell, sandbox, subprocess, and operating-system process layers.
5. Compare native and PTC presentation for the same three visible tools; identify what changes and what remains shared.

You have completed the chapter when you can assign each observed behavior to tool definition, registry policy, scheduler, capability provider, sandbox, or presenter without collapsing those layers.

<a id="further"></a>
## Further Exploration

Continue with [Persistence and context management](07-persistence-and-context.md). Use the [tool catalog](../tool-catalog.md) for the current model-facing inventory and the filesystem, shell, subprocess, and sandbox subsystem pages for their full contracts.

<a id="dev-note"></a>
## Dev Note

None.
