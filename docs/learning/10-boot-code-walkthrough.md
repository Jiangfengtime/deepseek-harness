# Boot implementation walkthrough

English | [中文](10-boot-code-walkthrough.zh.md)

## Summary

This chapter follows one `dsh --profile headless "task"` launch from the CLI into the mounted Cordis tree. It explains the concrete functions, intermediate values, commit points, and cleanup order. Read [Architecture and composition](01-architecture-and-composition.md) first if profiles, bundles, or Cordis contexts are unfamiliar.

## Table of Contents

- [Source map](#source-map)
- [The complete call path](#call-path)
- [Phase 1: freeze launch inputs](#launch-inputs)
- [Phase 2: compose the profile](#compose)
- [Phase 3: prepare the host](#host)
- [Phase 4: mount and audit plugins](#mount)
- [Phase 5: publish readiness](#ready)
- [Failure and shutdown paths](#failure)
- [Debugging the implementation](#debugging)
- [Reading exercise](#exercise)

-----

<a id="source-map"></a>
## Source map

| Concern | Implementation |
|---|---|
| CLI argument parsing and launch selection | [`apps/cli/src/bin.ts`](../../apps/cli/src/bin.ts) |
| Profile preparation and end-to-end launch | [`apps/cli/src/profile-boot.ts`](../../apps/cli/src/profile-boot.ts) |
| Generic Cordis boot transaction | [`packages/boot/app-boot/src/index.ts`](../../packages/boot/app-boot/src/index.ts) |
| Profile templates and module resolution | [`packages/boot/app-boot/src/profile.ts`](../../packages/boot/app-boot/src/profile.ts) |
| Profile patch layers | [`packages/boot/app-boot/src/profile-context.ts`](../../packages/boot/app-boot/src/profile-context.ts) |
| Bundle composition | [`packages/bundle/`](../../packages/bundle/) |

Keep two objects separate while reading. A `Profile` describes directories, bundle layers, and patch paths. A Cordis `Context` is the live runtime into which plugins and services are mounted.

<a id="call-path"></a>
## The complete call path

```text
CLI main
  -> loadLayeredEnv()
  -> runProfile(options)
       -> installProxyFromEnvironment()
       -> composeProfile()
            -> prepareProfile()
            -> createProfileResolutionGeneration()
            -> loadOverlayPatches()
       -> boot(rootConfig, patches, prepare)
            -> new Context()
            -> ctx.plugin(Loader)
            -> prepare(ctx)
            -> mountRootInclude()
            -> ctx.loader.await()
            -> auditStartupEntries()
       -> appReady.commit()
```

The sequence has two transactions. `composeProfile()` resolves an immutable description of this invocation. `boot()` turns that description into a live plugin tree and disposes the partial tree if any required stage fails.

<a id="launch-inputs"></a>
## Phase 1: freeze launch inputs

`loadLayeredEnv()` in app-boot reads the inherited environment, the invoking directory `.env`, and the Harness-home `.env`. It parses both files before applying either, so rejecting one file cannot leave a half-applied environment. Bootstrap-sensitive variables are accepted only from their permitted source. The function returns a `LaunchEnvironmentSnapshot`; later plugins receive this same snapshot instead of reading a moving `process.env` view.

`runProfile()` receives the profile name, `--patch` files, inner application arguments, package-manager integration, and that environment snapshot. Its first operation installs proxy behavior from the snapshot. This happens before a plugin can issue a request.

The local `dispose()` closure is memoized in `disposal`. Every shutdown path therefore awaits the same teardown promise. It disposes the current Cordis root and then the proxy installation, collects both failures, and reports an `AggregateError` when necessary.

<a id="compose"></a>
## Phase 2: compose the profile

`composeProfile()` first selects a prepared profile. A normal CLI launch calls `prepareProfile()`; an application-owned runtime may pass `resolvedProfile` and bypass named-profile initialization. `resolveProfileDir()` rejects empty, path-like, dot, and reserved names before constructing a directory under the Harness home.

The profile contains ordered bundle layers. `createProfileResolutionGeneration()` calculates where every bare plugin package will resolve from for this launch. The result is a generation object rather than a mutable global search path. `PluginPackages` later installs this generation into the host context.

Command-line overlays are loaded in argv order by `loadOverlayPatches()`. Bundle, profile, home, command-line, and telemetry layers are combined by `readProfilePatches()` when `runProfile()` invokes `boot()`. Later layers have higher precedence because the Include plugin receives the final ordered patch list.

The returned `ComposedProfile` has three pieces: the selected `profile`, the module-resolution `generation`, and parsed command-line `overlays`. No plugin has mounted yet, so failures here leave no application tree to unwind.

<a id="host"></a>
## Phase 3: prepare the host

`runProfile()` constructs `ProfileContext` from the resolved profile, working directory, Harness home, bundle names, patch paths, package manager, and environment-derived telemetry switch. This object records launch facts used by plugins; it is not the Cordis root itself.

The callback passed to `boot()` runs after Loader installation and before configuration entries mount. It performs three operations in order:

1. `hostCtx.provide('profileContext', profileContext)` publishes launch metadata.
2. `hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)` publishes the frozen environment.
3. `hostCtx.plugin(PluginPackages, ...)` installs the computed package-resolution generation.

`provideCmdline()` then exposes the inner argv, bounded exit function, and readiness service. A plugin can consume command arguments without importing the CLI package, and a one-shot surface can request shutdown through the supplied controller.

<a id="mount"></a>
## Phase 4: mount and audit plugins

`boot()` creates a fresh root `Context`, sets its `baseUrl` beside the root config, provides the Harness-home path resolver, and mounts the Cordis `Loader`. It also creates a separate diagnostics context that collects startup warnings and errors even if the application root is disposed during startup.

After the caller's host preparation finishes, `mountRootInclude()` mounts the root `cordis.yml` through the Include plugin with the complete patch list. Include turns configuration rows into plugin fibers. Service injection controls when each plugin becomes active; source import order alone does not define activation order.

`ctx.get('loader')?.await()` waits for initial entries to settle. The optional access is deliberate: a one-shot application can finish and dispose the Loader while startup is still settling. If Loader remains present, `auditStartupEntries()` rejects inactive required entries and reports their diagnostics together.

This is the activation commit point: a returned context has completed host preparation, entry settlement, and required-entry audit. Individual plugins may still own background work through their fibers.

<a id="ready"></a>
## Phase 5: publish readiness

Back in `runProfile()`, `app.current` is updated with the returned root. Readiness commits only when the signal controller is not aborted, the root fiber is still active, and Loader still exists. This prevents an application that already stopped during startup from publishing a false ready state.

The return value contains the root `ctx` and `shutdown` controller. Process lifetime is then owned by mounted plugins or by a one-shot runner in the composition. `runProfile()` does not keep an unrelated timer alive.

<a id="failure"></a>
## Failure and shutdown paths

`boot()` distinguishes failure before configuration mounting as `host preparation failed` and failure after that boundary as `plugin tree failed to load`. In either case it first disposes the root fiber, then wraps the original cause with the stage and deepest useful stack. A `StartupError` additionally receives captured startup log records.

`runProfile()` installs `SIGTERM` and `SIGINT` handlers before `boot()` settles. Both abort startup work and enter the same shutdown controller; the exit codes differ because supervisor termination and user interruption have different process meanings. Fail-loud handlers dispose the current tree before reporting an uncaught failure.

The order matters: network setup exists before plugins, host services exist before configuration rows, readiness exists after the activation audit, and root disposal precedes proxy cleanup. Moving any one of these operations changes which partially initialized resources another plugin can observe.

<a id="debugging"></a>
## Debugging the implementation

Set breakpoints at `runProfile()`, `composeProfile()`, the `prepare` callback inside `runProfile()`, `boot()`, `mountRootInclude()`, and `auditStartupEntries()`. Inspect `composed.profile.layers`, `composed.overlays`, `profileContext`, `ctx.loader.entries()`, and each entry fiber state.

For a plugin that never activates, answer these questions in order: is its row present after patches, can its module resolve through the generation, are its injected services present, and did its fiber fail? For a configuration surprise, compare the ordered patch layers before stepping into plugin code.

<a id="exercise"></a>
## Reading exercise

Trace the `headless` profile without running a model. Starting from `PROFILE_TEMPLATES`, identify its bundles, find their patch files, locate the headless application row, and list the injected services that must activate first. Then explain which cleanup runs if the last required plugin fails during activation and why readiness does not commit.
