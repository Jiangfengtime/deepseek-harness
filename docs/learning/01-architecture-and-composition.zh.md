# 1. 架构与应用组合

[English](01-architecture-and-composition.md) | 中文

## 概要

本章解释一条 `dsh` 命令如何变成正在运行的 Cordis 插件树。你将了解 profile、bundle、patch、包清单和服务依赖分别在哪个阶段参与，并判断仓库中的代码是否在某个产品中实际激活。应先完成本章再跟踪 Agent 循环，因为循环只能使用组合所选择的能力。

## 目录

- [起始模型](#starting-model)
- [跟踪 CLI](#cli)
- [解析 Profile](#profile)
- [应用配置层](#layers)
- [激活插件](#activation)
- [阅读包依赖图](#packages)
- [练习](#exercises)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="starting-model"></a>
## 起始模型

DeepSeek Harness 是一个通过配置组装的插件应用。仓库包含许多包，但运行进程只包含 profile 选中的插件，以及通过服务依赖成功激活的插件。

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

受支持的 Node 应用入口都是具名 profile。`web`、`headless`、`sdk` 和 `acp` 使用共享基础 bundle；`sdk-minimal` 拥有较小的显式插件树。Desktop 携带自己的运行时和保留 profile，但仍进入同一应用架构。当前入口规则以[架构总览](../architecture.zh.md)为准。

<a id="cli"></a>
## 跟踪 CLI

从 [`apps/cli/src/bin.ts`](../../apps/cli/src/bin.ts) 开始。`runCli()` 解析参数，然后选择三种模式之一：

| 模式 | 下一归属 | 用途 |
|---|---|---|
| `profile` | `profile-boot.ts` | 启动具名应用组合。 |
| `plugin` | `plugin.ts` | 管理 profile 依赖和激活。 |
| `dump-config` | `dump-config.ts` | 解析并输出有效配置。 |

这段分发不包含 Agent 逻辑。它延迟加载所选操作的负责模块，在应用边界报告启动失败，并把插件行为交给解析后的插件树。

结合入口阅读 [`apps/cli/src/args.ts`](../../apps/cli/src/args.ts)。识别 `dsh web` 等别名如何变成 profile 选择、`--profile` 如何消除歧义，以及有序 `--patch` 参数如何进入启动过程。参数解析属于产品边界：这个层级验证前，输入值都不可信。

<a id="profile"></a>
## 解析 Profile

[`apps/cli/src/profile-boot.ts`](../../apps/cli/src/profile-boot.ts) 把 CLI 连接到 [`dsh-app-boot`](../../packages/boot/app-boot/README.zh.md)。启动包解析 Harness home、所选 profile、已安装包、bundle 元数据、patch 文件和就绪生命周期。

Profile 是用户拥有的具名组合数据。其包元数据列出有序 bundle、安装在仓库外的插件和自己的 patch。Bundle 是通过包的 `dsh.bundle` 元数据声明的可分发配置层。普通插件即使已经安装，也不会自动激活。

阅读 profile 解析时，持续回答以下问题：

1. 哪个路径属于用户数据，哪个路径属于已安装包？
2. 哪个包清单声明了 bundle patch？
3. 哪个 profile 层选择了该 bundle？
4. 哪个后续 patch 可以替换该配置行？
5. 哪个组件负责监视和重载？

<a id="layers"></a>
## 应用配置层

各层按下面的顺序应用到初始为空的配置行列表：

1. Profile 声明顺序中的每个 bundle。
2. Profile 自己的 `cordis.patch.yml`。
3. Harness home 级 patch。
4. 每个命令行 `--patch` overlay。

Patch 通过 id 定位配置行。替换一行的 `config` 时，会替换完整值，而不是递归合并部分字段。后续层修改一个选项时，应检查是否需要重述该行其余配置。

把 [`packages/bundle/base/cordis.patch.yml`](../../packages/bundle/base/cordis.patch.yml) 当作共享产品能力地图，再对照一个产品 bundle，例如 [`packages/bundle/headless/cordis.patch.yml`](../../packages/bundle/headless/cordis.patch.yml)。基础层选择公共服务，产品 bundle 提供入口行为和模式专属配置行。

配置行顺序便于阅读，但不定义服务激活顺序。Loader 等待声明的服务依赖。使用配置行 id 跟踪 patch 替换，使用 `inject` 理解激活。

<a id="activation"></a>
## 激活插件

插件通常导出 `apply` 函数或 Service 实现，并通过 `inject` 声明必需服务。只有这些服务出现在其 Context 中，Cordis 才激活插件。需要可选能力的工作由已激活插件内部的 `ctx.inject()` 管理。

把 [`packages/fs/tool-fs/src/index.ts`](../../packages/fs/tool-fs/src/index.ts) 作为简洁示例。它的静态依赖要求 tools、filesystem 和 system-prompt 服务。只有 attachments 存在时，才挂载 `read_image` 贡献；没有这一可选服务时，其他文件工具仍可使用。

激活与可见性是两个问题。全局激活的工具插件可以注册一个条目，Agent scope 限制随后把它隐藏。Scoped preset 也可以只为一个 Agent 增加能力，不影响同级 Agent。组合决定什么可以存在；scope 决定特定 Agent 继承或覆盖什么。

热重载依赖可撤销注册。插件插入工具或监听器却不提供 disposer，会在重载后留下过期贡献。这就是注册表方法和 `ctx.on()` 返回清理行为，以及仓库把注册视为 effect 的原因。

<a id="packages"></a>
## 阅读包依赖图

先用 [`packages/README.md`](../../packages/README.zh.md) 找到能力家族，再阅读该组 README、所选包 README 和入口模块。除非你已经知道正在跟踪哪个能力，否则不要从生成的模块图开始；依赖边说明导入关系，不说明产品意图。

先分类包，再判断用户如何使用它：

| 包形式 | 证据 | 参与方式 |
|---|---|---|
| Bundle | `package.json` 声明 `dsh.bundle` | Profile 可以应用其 patch 层。 |
| 插件或服务 | 入口导出插件行为 | 配置行挂载它。 |
| Library | 入口导出普通 API | 由其他包导入，没有挂载路径。 |
| 产品应用 | 受支持的 profile 选择它 | 它负责应用入口行为。 |

跨包使用者依赖服务定义，而不依赖具体提供者。组合包可以依赖提供者，因为它的职责是选择完整产品插件树。这种区分让提供者替换只发生在组合层。

<a id="exercises"></a>
## 练习

1. 从 `bin.ts` 开始跟踪 `pnpm dsh --profile headless`，写出 CLI 解析结束、插件加载开始的位置。
2. 对比基础 patch 与 headless patch，找出三个从基础层继承的服务，以及让 headless 成为一次性应用的配置行。
3. 选择 `read` 工具，找到其插件行、必需服务、文件系统提供者和 system-prompt 贡献。
4. 选择一个已安装但不在所选 profile 中的包，解释为什么仓库中存在且依赖已安装并不代表它已激活。
5. 找到一个被后续 bundle 或 profile 替换的配置行，验证它是否重述完整 `config`。

当你能用 profile、配置层、配置行、插件和满足的依赖链回答“为什么这个服务存在于该进程中”时，本章学习完成。

<a id="further"></a>
## 进一步阅读

继续学习 [Cordis 运行时](02-cordis-runtime.zh.md)，理解配置行激活后发生什么。使用[配置目录](../config-catalog.zh.md)查询允许字段，使用[模块图](../module-graph.zh.md)查询生成的导入关系。

<a id="dev-note"></a>
## 开发备注

无。
