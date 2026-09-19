# 7. Persistence and context management

English | [中文](07-persistence-and-context.zh.md)

## Summary

This chapter explains how durable Session generations are selected, opened, migrated, written, and closed, then connects that storage model to compaction, attachments, spill, and cold queries. You will learn which component owns physical files and which component owns conversation meaning.

## Table of Contents

- [Persistence roles](#roles)
- [Write ownership](#writing)
- [Generations and migration](#generations)
- [Recovery](#recovery)
- [Compaction](#compaction)
- [Attachments and spill](#attachments)
- [Cold access and search](#query)
- [Exercises](#exercises)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="roles"></a>
## Persistence roles

Core Session owns event semantics and in-memory append. The persistence service defines create, open, stat, list, and export over stored Sessions. A backend owns physical framing, compression, generation selection, exclusive publication, buffering, and write-handle lifecycle.

The Agent layer owns semantic repair because only it understands turn boundaries. A format-migration package owns one adjacent logical transformation. Keeping these roles separate prevents storage code from inventing Agent behavior and prevents the Agent loop from depending on JSONL details.

<a id="writing"></a>
## Write ownership

Production Agent creation acquires a write handle before publication. Resume opens the Session in write mode before constructing the live Agent, excluding another writer. Events appended after publication reach the handle through scoped Session notifications.

A write handle can buffer events. `session.flush()` is the explicit durability checkpoint; close drains the remaining buffer and releases ownership. Teardown closes the writer after the loop records its final events and before the Session leaves the store.

Session creation outside this lifecycle does not automatically persist. This deliberate rule prevents unrelated SessionStore users from acquiring hidden filesystem ownership.

<a id="generations"></a>
## Generations and migration

Stored Session files use version-named generations. Header-only stat and list operations select the numerically highest canonical generation and translate a supported historical header without loading the complete log.

Open selects the same generation, rejects a future version, and composes the static adjacent migration chain into current logical events. Read open keeps the migrated result in memory. Write open encodes, verifies, and exclusively publishes the final successor beside the unchanged source before accepting new writes.

Committed generations are never renamed, replaced, or deleted. Every adjacent migration package owns exactly one `vN -> vN+1` step. See [format status](../session-format-status.md) before interpreting filenames or changing durable types.

<a id="recovery"></a>
## Recovery

The JSONL provider owns physical tail validation and the distinction between sealed and interrupted bytes. Ordinary repair of an unsealed tail belongs to the handle consumer. The Agent layer can append a supported missing `turn/end` when restored history proves a bounded interrupted turn.

Recovery records facts; it does not repeat external effects. A restored `tool/call` without an authoritative result is diagnostic evidence, not permission to execute the tool again. Consumers derive current state from the validated prefix.

<a id="compaction"></a>
## Compaction

Compaction changes future model history by recording Surface replacements. The basic provider measures pressure against the routed model context window, optionally prunes eligible large tool results, selects an oldest balanced range, asks a model for a summary, and preserves a recent tail.

Automatic compaction can run before a request reaches its threshold or after a confirmed context-overflow failure. Manual `/compact` uses the same capability while the Agent is available for maintenance. Prompts received during maintenance remain queued for later work.

Compaction cannot reduce system prompt or tool-schema size and cannot split one indivisible history unit. If no balanced range can be compacted, it leaves the log unchanged. The original events remain available to transcript and audit readers.

<a id="attachments"></a>
## Attachments and spill

Attachments give binary data durable content-addressed identity. Session events store references rather than embedding unbounded bytes. Authorization to read an attachment comes from proving that the addressed Session log reaches the reference.

Spill handles oversized tool output. A storage backend retains complete data; policy replaces the model-facing logged result with bounded preview and locator content. The executor's program value remains complete. These different views let programs operate on data without forcing all of it into model context or UI transport.

Image offload is a model-history decision, not generic attachment deletion. It responds to route capability and context pressure by replacing selected historical image occurrences while retaining durable attachment identity.

<a id="query"></a>
## Cold access and search

Session-query builds a logical corpus over stored Sessions. Page, lineage, filtering, and full-text search operate without resuming every Agent. Cold projections and message definitions must match live definitions so query results reflect the same logical history.

Use the API Session Controller for product operations such as list, page, follow, fork, prompt, and cancel. The controller decides when a cold operation is sufficient and when it must resume a live Agent. Storage backends should not absorb this product policy.

<a id="exercises"></a>
## Exercises

1. Trace a new Agent from persistence `create()` through first event append, flush, and close.
2. Compare read-open and write-open behavior for an older generation.
3. Choose a context-overflow path and identify the original attempt, compaction replacement, retry, and resulting message history.
4. Follow an image from upload bytes to attachment reference, Session event, model request, and authorized retrieval.
5. Explain why stat and list should not load or migrate every event body.

You have completed the chapter when you can distinguish physical validity, logical migration, semantic repair, derived history replacement, and product-level resume.

<a id="further"></a>
## Further Exploration

Continue with [Product interfaces](08-product-interfaces.md). Read the [persistence catalog](../persistence-catalog.md), [Session format status](../session-format-status.md), and package READMEs before changing stored types or migration behavior.

<a id="dev-note"></a>
## Dev Note

None.
