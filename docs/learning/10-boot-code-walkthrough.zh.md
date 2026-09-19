# 启动流程源码实现

[English](10-boot-code-walkthrough.md) | 中文

## 概要

本章沿一次 `dsh --profile headless "task"` 启动，从 CLI 跟到完成挂载的 Cordis 树，解释实际函数、中间值、提交点和清理顺序。若尚不熟悉 profile、bundle 或 Cordis Context，请先阅读[架构与组合](01-architecture-and-composition.zh.md)。

## 目录

- [源码地图](#source-map)
- [完整调用路径](#call-path)
- [阶段一：冻结启动输入](#launch-inputs)
- [阶段二：组合 Profile](#compose)
- [阶段三：准备宿主](#host)
- [阶段四：挂载并审计插件](#mount)
- [阶段五：发布就绪状态](#ready)
- [失败与关闭路径](#failure)
- [调试实现](#debugging)
- [阅读练习](#exercise)

-----

<a id="source-map"></a>
## 源码地图

| 职责 | 实现位置 |
|---|---|
| CLI 参数解析与启动选择 | [`apps/cli/src/bin.ts`](../../apps/cli/src/bin.ts) |
| Profile 准备与端到端启动 | [`apps/cli/src/profile-boot.ts`](../../apps/cli/src/profile-boot.ts) |
| 通用 Cordis 启动事务 | [`packages/boot/app-boot/src/index.ts`](../../packages/boot/app-boot/src/index.ts) |
| Profile 模板与模块解析 | [`packages/boot/app-boot/src/profile.ts`](../../packages/boot/app-boot/src/profile.ts) |
| Profile Patch 层 | [`packages/boot/app-boot/src/profile-context.ts`](../../packages/boot/app-boot/src/profile-context.ts) |
| Bundle 组合 | [`packages/bundle/`](../../packages/bundle/) |

阅读时始终区分两个对象。`Profile` 描述目录、bundle 层和 patch 路径；Cordis `Context` 是实际挂载插件和服务的运行时。

<a id="call-path"></a>
## 完整调用路径

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

这条路径包含两个事务。`composeProfile()` 解析本次调用的不可变描述，`boot()` 把描述变成活动插件树；任何必需阶段失败时，它都会销毁部分创建的树。

<a id="launch-inputs"></a>
## 阶段一：冻结启动输入

app-boot 中的 `loadLayeredEnv()` 读取继承环境、调用目录 `.env` 和 Harness Home `.env`。它先解析两个文件，再应用任何一层，因此拒绝某个文件时不会留下半应用环境。影响启动安全的变量只允许来自指定来源。函数返回 `LaunchEnvironmentSnapshot`；后续插件接收同一快照，不读取持续变化的 `process.env` 视图。

`runProfile()` 接收 profile 名、`--patch` 文件、应用内部参数、包管理集成和环境快照。它首先依据快照安装代理行为，保证插件发出请求前网络设置已经生效。

局部 `dispose()` 闭包通过 `disposal` 记忆化，所以每条关闭路径等待同一个清理 Promise。它先销毁当前 Cordis 根，再清理代理安装；两者都失败时用 `AggregateError` 汇总。

<a id="compose"></a>
## 阶段二：组合 Profile

`composeProfile()` 首先选定已准备的 profile。普通 CLI 启动调用 `prepareProfile()`；应用自有运行时可以传入 `resolvedProfile`，跳过具名 profile 初始化。`resolveProfileDir()` 会拒绝空名称、路径式名称、点名称和保留名称，然后才在 Harness Home 下构造目录。

Profile 包含有序 bundle 层。`createProfileResolutionGeneration()` 计算本次启动中每个裸插件包的解析位置，结果是 generation 对象，而不是修改全局搜索路径。随后由 `PluginPackages` 把该 generation 安装到宿主 Context。

命令行 overlay 由 `loadOverlayPatches()` 按 argv 顺序载入。`runProfile()` 调用 `boot()` 时，`readProfilePatches()` 组合 bundle、profile、home、命令行和 telemetry 层。Include 插件接收最终有序 patch 列表，因此后面的层具有更高优先级。

返回的 `ComposedProfile` 包含选定的 `profile`、模块解析 `generation` 和已解析的命令行 `overlays`。此时尚未挂载插件，所以这里失败不需要回滚应用树。

<a id="host"></a>
## 阶段三：准备宿主

`runProfile()` 根据已解析 profile、工作目录、Harness Home、bundle 名、patch 路径、包管理器和环境中的 telemetry 开关构造 `ProfileContext`。该对象记录插件需要的启动事实，并不是 Cordis 根对象。

传给 `boot()` 的回调在 Loader 安装后、配置条目挂载前执行，按顺序完成三个操作：

1. `hostCtx.provide('profileContext', profileContext)` 发布启动元数据。
2. `hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)` 发布冻结环境。
3. `hostCtx.plugin(PluginPackages, ...)` 安装计算出的包解析 generation。

随后 `provideCmdline()` 暴露内部 argv、受控退出函数和就绪服务。插件无需导入 CLI 包即可使用命令参数，一次性界面也可以通过该控制器请求关闭。

<a id="mount"></a>
## 阶段四：挂载并审计插件

`boot()` 创建全新根 `Context`，把 `baseUrl` 设为根配置旁的目录，提供 Harness Home 路径解析器，并挂载 Cordis `Loader`。它还创建独立 diagnostics Context；即使应用根在启动中销毁，该 Context 仍可收集启动警告和错误。

调用方的宿主准备完成后，`mountRootInclude()` 通过 Include 插件挂载根 `cordis.yml` 及完整 patch 列表。Include 把配置行转换为插件 fiber。服务注入决定各插件何时进入活动状态；源码 import 顺序并不能单独确定激活顺序。

`ctx.get('loader')?.await()` 等待初始条目收敛。这里使用可选访问是有意的：一次性应用可能在启动尚未完全收敛时完成并销毁 Loader。如果 Loader 仍存在，`auditStartupEntries()` 会拒绝未激活的必需条目，并集中报告诊断。

这里是激活提交点：成功返回的 Context 已完成宿主准备、条目收敛和必需条目审计。各插件仍可通过自己的 fiber 持有后台工作。

<a id="ready"></a>
## 阶段五：发布就绪状态

回到 `runProfile()` 后，`app.current` 更新为返回的根对象。只有信号控制器未中止、根 fiber 仍为活动状态且 Loader 仍存在时，才执行 `appReady.commit()`。这样，启动期间已经停止的应用不会错误地发布就绪状态。

返回值包含根 `ctx` 和 `shutdown` 控制器。之后的进程寿命由已挂载插件或组合中的一次性 runner 负责；`runProfile()` 不会用无关定时器强行保持进程存活。

<a id="failure"></a>
## 失败与关闭路径

`boot()` 把配置挂载前的失败标记为 `host preparation failed`，把该边界之后的失败标记为 `plugin tree failed to load`。两种情况都会先销毁根 fiber，再用阶段信息和最深层有效堆栈包装原始错误。若错误是 `StartupError`，还会附加已收集的启动日志。

`runProfile()` 在 `boot()` 收敛前就安装 `SIGTERM` 和 `SIGINT` 处理器。两者都会中止启动工作并进入同一个 shutdown 控制器；退出码不同，因为监督进程终止和用户中断具有不同语义。Fail-loud 处理器会先销毁当前插件树，再报告未捕获失败。

顺序决定行为：网络设置先于插件，宿主服务先于配置行，就绪发布晚于激活审计，根销毁先于代理清理。移动任何一步都会改变其他插件能观察到的部分初始化资源。

<a id="debugging"></a>
## 调试实现

在 `runProfile()`、`composeProfile()`、`runProfile()` 内的 `prepare` 回调、`boot()`、`mountRootInclude()` 和 `auditStartupEntries()` 设置断点。检查 `composed.profile.layers`、`composed.overlays`、`profileContext`、`ctx.loader.entries()` 及各条目的 fiber 状态。

若插件没有激活，依次回答：应用 patch 后是否仍有它的配置行、generation 能否解析模块、注入服务是否存在、fiber 是否失败。若配置结果不符合预期，应先比较有序 patch 层，再进入插件代码。

<a id="exercise"></a>
## 阅读练习

在不运行模型的情况下追踪 `headless` profile。从 `PROFILE_TEMPLATES` 开始，列出它的 bundle，找到对应 patch 文件，定位 headless 应用行，并列出必须先激活的注入服务。然后解释最后一个必需插件激活失败时执行哪些清理，以及为什么不会发布就绪状态。
