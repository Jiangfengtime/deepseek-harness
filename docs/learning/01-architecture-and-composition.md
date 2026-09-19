# 1. Architecture and application composition

English | [中文](01-architecture-and-composition.zh.md)

## Summary

This chapter explains how a `dsh` command becomes one running Cordis plugin tree. You will learn where profiles, bundles, patches, package manifests, and service dependencies participate, and how to determine whether code in the repository is active in a product. Complete this chapter before tracing the agent loop because the loop can only use capabilities selected by the composition.

## Table of Contents

- [Starting model](#starting-model)
- [Follow the CLI](#cli)
- [Resolve a profile](#profile)
- [Apply configuration layers](#layers)
- [Activate plugins](#activation)
- [Read the package graph](#packages)
- [Exercises](#exercises)
- [Further Exploration](#further)
- [Dev Note](#dev-note)

-----

<a id="starting-model"></a>
## Starting model

DeepSeek Harness is a configured plugin application. The repository contains many packages, but a running process contains only the plugins selected by its profile and successfully activated through service dependencies.

```text
dsh invocation
  -> CLI argument parsing
  -> profile selection
  -> bundle patches
  -> profile, home, and command-line patches
  -> Loader configuration rows
  -> Cordis plugin tree
  -> product entry capability
```

The supported Node application entry points are named profiles. `web`, `headless`, `sdk`, and `acp` use the shared base bundle; `sdk-minimal` owns a smaller explicit tree. Desktop carries its runtime and reserved profile but enters the same application architecture. The [architecture overview](../architecture.md) owns the current entry-point rules.

<a id="cli"></a>
## Follow the CLI

Start at [`apps/cli/src/bin.ts`](../../apps/cli/src/bin.ts). `runCli()` parses arguments, then selects one of three modes:

| Mode | Next owner | Purpose |
|---|---|---|
| `profile` | `profile-boot.ts` | Start a named application composition. |
| `plugin` | `plugin.ts` | Manage profile dependencies and activation. |
| `dump-config` | `dump-config.ts` | Resolve and print the effective configuration. |

This dispatch contains no agent logic. It loads the owner of the selected operation lazily, reports startup failures at the application boundary, and leaves plugin behavior to the resolved tree.

Read [`apps/cli/src/args.ts`](../../apps/cli/src/args.ts) beside the entry. Identify how aliases such as `dsh web` become profile selection, how `--profile` resolves ambiguity, and how ordered `--patch` values reach boot. Treat argument parsing as a product boundary: values are untrusted until this layer validates them.

<a id="profile"></a>
## Resolve a profile

[`apps/cli/src/profile-boot.ts`](../../apps/cli/src/profile-boot.ts) connects the CLI to [`dsh-app-boot`](../../packages/boot/app-boot/README.md). The boot package resolves the Harness home, selected profile, installed packages, bundle metadata, patch files, and readiness lifecycle.

A profile is user-owned named composition data. Its package metadata lists ordered bundles, installed out-of-tree plugins, and its own patch. A bundle is a distributable configuration layer declared through the package's `dsh.bundle` metadata. A plain plugin package does not become active merely because it is installed.

Use these questions while reading profile resolution:

1. Which path is user data and which path belongs to an installed package?
2. Which package manifest declares a bundle patch?
3. Which profile layer selected that bundle?
4. Which later patch can replace the row?
5. Which component owns watching and reload?

<a id="layers"></a>
## Apply configuration layers

Layers apply to an initially empty entry list in this order:

1. Each bundle in the profile's declared order.
2. The profile's `cordis.patch.yml`.
3. The Harness-home patch.
4. Each command-line `--patch` overlay.

A patch targets configuration rows by id. Replacing a row's `config` replaces that complete value rather than recursively merging selected fields. When a later layer changes one option, inspect whether it must restate the rest of the row's configuration.

Read [`packages/bundle/base/cordis.patch.yml`](../../packages/bundle/base/cordis.patch.yml) as a map of shared product capabilities. Then compare one product bundle, such as [`packages/bundle/headless/cordis.patch.yml`](../../packages/bundle/headless/cordis.patch.yml). The base chooses common services; the product bundle contributes its entry behavior and mode-specific rows.

Configuration row order helps readers but does not define service activation order. Loader waits for declared service dependencies. Use row ids to track patch replacement and `inject` to understand activation.

<a id="activation"></a>
## Activate plugins

A plugin normally exports an `apply` function or a Service implementation and declares required services through `inject`. Cordis activates the plugin only when those services exist in its context. Optional capability-dependent work uses `ctx.inject()` inside an active plugin.

Use [`packages/fs/tool-fs/src/index.ts`](../../packages/fs/tool-fs/src/index.ts) as a compact example. Its static dependencies require tools, filesystem, and system-prompt services. Its `read_image` contribution is mounted only while attachments are present. The other file tools remain available without that optional service.

Activation and visibility are separate questions. A globally active tool plugin can register an entry that agent scope restrictions later hide. A scoped preset can also add a capability for one agent without changing sibling agents. Composition determines what can exist; scope determines what a particular agent inherits or overrides.

Hot reload depends on reversible registration. A plugin that inserts a tool or listener without a disposer leaves stale contributions after reload. This is why registry methods and `ctx.on()` return cleanup behavior and why the repository treats registrations as effects.

<a id="packages"></a>
## Read the package graph

Use [`packages/README.md`](../../packages/README.md) to find a capability family, then read the group's README, the selected package README, and its entry module. Do not begin with the generated module graph unless you already know the capability you are tracing; dependency edges show imports, not product intent.

Classify a package before assuming how users consume it:

| Package form | Evidence | How it participates |
|---|---|---|
| Bundle | `package.json` declares `dsh.bundle` | A profile can apply its patch layer. |
| Plugin or service | Entry exports plugin behavior | A configuration row mounts it. |
| Library | Entry exports plain APIs | Another package imports it; it has no mount path. |
| Product app | Supported profile selects it | It owns an application entry behavior. |

At package boundaries, consumers depend on service definitions rather than concrete providers. Composition packages may depend on providers because their purpose is to select a complete product tree. This distinction keeps a provider swap local to composition.

<a id="exercises"></a>
## Exercises

1. Trace `pnpm dsh --profile headless` from `bin.ts` to the profile runner. Write down the point where CLI parsing ends and plugin loading begins.
2. Compare the base and headless patches. Identify three services inherited from base and the row that makes headless a one-shot application.
3. Select the `read` tool. Find its plugin row, required services, filesystem provider, and system-prompt contribution.
4. Choose one installed package that is not in a selected profile. Explain why repository presence and dependency installation do not make it active.
5. Find a configuration row replaced by a later bundle or profile. Verify that its complete `config` is restated.

You have completed the chapter when you can answer “why is this service present in this process?” with a profile, layer, row, plugin, and satisfied dependency chain.

<a id="further"></a>
## Further Exploration

Continue with [Cordis runtime](02-cordis-runtime.md) to understand what happens after a row activates. Use the [configuration catalog](../config-catalog.md) for accepted fields and the [module graph](../module-graph.md) for generated import relationships.

<a id="dev-note"></a>
## Dev Note

None.
