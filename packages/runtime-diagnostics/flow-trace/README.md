---
description: "Opt-in chronological diagnostics for learning and debugging the DeepSeek Harness Agent, Session, model-request, streaming, and tool execution flow."
kind: "package-reference"
---

# @deepseek-ai/dsh-flow-trace

English | [中文](README.zh.md)

## Summary

`dsh-flow-trace` explains one running task as chronological Cordis log lines. It observes Agent lifecycle and policy waterfalls, committed Session events, assistant stream boundaries, and tool execution stages. The base profile mounts it disabled; enable it only while learning or diagnosing a flow. Trace lines contain correlation ids, turn and step numbers, event types, decisions, provider/model names, and failure codes. They deliberately omit prompts, message content, tool arguments, tool output, file contents, model text, and error messages.

## Table of Contents

- [Use this package](#use-this-package)
- [Read the trace](#read-the-trace)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Run a base-backed profile with the supplied overlay:

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/flow-trace.overlay.yml "trace one task"
```

The overlay enables the dormant `flow-trace` row and writes at `info`. To keep ordinary application output quieter, copy the overlay and select `debug`; the active log exporter must admit debug messages. Set `assistantChunks: true` only when stream ordering matters. Chunk lines report attempt id, revision, and index without reporting the chunk body.

```yaml
- id: flow-trace
  disabled: false
  config:
    level: info
    assistantChunks: false
```

| Field | Default | Meaning |
|---|---|---|
| `level` | `info` | Cordis level for all trace lines |
| `assistantChunks` | `false` | Include metadata-only assistant chunk lines |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive field reference.

<a id="read-the-trace"></a>
## Read the trace

Follow the shared ids and counters rather than treating every line as an independent message:

```text
agent id=<session> phase=inbox-claimed message=<message> turn=1
session id=<session> seq=3 event=step/start turn=1 step=1
agent id=<session> phase=request-exit turn=1 step=1 provider=... model=...
agent id=<session> stream phase=start attempt=... revision=1 turn=1 step=1
session id=<session> seq=7 event=tool/call turn=1 step=1 call=... tool=read_file
tool call=... name=read_file phase=pre-exit decision=allow
tool call=... name=read_file phase=result error=false concludesTurn=false
session id=<session> seq=8 event=tool/result turn=1 step=1 call=... error=false
session id=<session> seq=10 event=turn/end turn=1 reason=completed
```

`phase=*-enter` and `phase=*-exit` surround a waterfall extension point. The exit line shows the value selected after all downstream policies ran. `session ... event=...` is different: `session/event` fires after `Session.append()` commits, so that line names a durable fact available to replay and persistence observers. Stream lines are process-local and explain activity between durable settlements.

Tool execution has four useful views. `pre-*` reports allow/deny/ask/cancel policy; `dispatch-*` surrounds the selected implementation; `post-*` reports result policy; `phase=result` is the frozen final outcome. The later Session `tool/result` line confirms that AgentLoop committed the model-facing result.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin registers global observers because it is mounted at the profile root and must see every Agent scope. Each waterfall observer calls `next()`, awaits it, logs the selected decision or result, and returns the same value. That delegation is required for transparency: skipping `next()` would make the diagnostic plugin a policy owner and could block a step, model request, or tool call.

The Session observer runs on the post-commit `session/event` feed. Its event switch adds only safe routing metadata for a small set of core events; unknown plugin-owned events still receive the common session id, sequence, type, turn, and step fields when present. The trace never serializes an event, message, execution object, stream chunk, result, or thrown value. Error logs retain only stable codes or class names.

The plugin has no service and no mutable process resource. Cordis owns listener disposal with the plugin fiber, so HMR or profile shutdown removes every observer. No runtime invariant companion is published because the plugin derives diagnostic lines from authoritative events and owns no independent state relationship that could diverge.

<a id="further-exploration"></a>
## Further Exploration

Read the [turn-flow architecture](../../../docs/architecture.md#turn-flow) beside a trace, then use [Learning Guide chapter 9](../../../docs/learning/09-extension-and-debugging.md) to map each line to its source extension point. The event contracts live in `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, and `@deepseek-ai/dsh-tools`.

<a id="model-experience"></a>
## Model Experience

None, as the observer records runtime metadata without changing model requests or Session events.

#### KV Cache effect

Enabling the observer leaves model-visible messages and request headers unchanged, so it neither creates nor invalidates a provider cache prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Process-local history only.** The trace does not reconstruct events that occurred before the plugin was enabled and is not a durable audit log.
- **Concurrent output interleaves.** Use the Agent/session id to separate lines from concurrent Agents.
- **Metadata rather than payloads.** Read the persisted Session log when exact model-visible data is required.
- **Exporter-dependent visibility.** A deployment without a Cordis exporter may retain messages only in the logger ring buffer.

<a id="dev-note"></a>
### Dev Note

None.
