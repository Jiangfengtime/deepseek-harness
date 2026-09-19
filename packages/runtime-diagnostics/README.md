---
description: "The runtime-diagnostics group map: package-owned runtime invariant checks for live compositions, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/runtime-diagnostics

English | [中文](README.zh.md)

## Summary

The runtime-diagnostics group provides two complementary views of a live DeepSeek Harness composition. `invariants` runs package-owned checks that verify durable event and data relationships. `flow-trace` emits an opt-in chronological explanation of Agent, Session, model-request, stream, and tool stages without logging payload content. Use invariants to detect invalid state and flow trace to learn or diagnose how one task reached its state.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`invariants`](invariants/README.md) | Runs package-owned runtime checks and reports each failure by owning package | registers on `ctx.invariants` |
| [`flow-trace`](flow-trace/README.md) | Emits privacy-safe chronological metadata for the core execution flow | none; observes events |

-----

<a id="related-documentation"></a>
## Related documentation

- [Runtime invariants subsystem](../../docs/subsystems/invariants.md) — the generated service reference: selection, installer, and companion contract.
- [Invariant runtime contracts Agent Note](../../.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.md) — what a runtime invariant may assert and the mechanical gate enforcing companion wiring.
- [Package conventions](../AGENTS.md) — the `./invariant` companion rule every package follows.
- [Learning Guide: extension and debugging](../../docs/learning/09-extension-and-debugging.md) — enable the trace and map its lines to core extension points.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
