# 9. 扩展与调试工作流

[English](09-extension-and-debugging.md) | 中文

## 概要

本章把架构知识转化为贡献者工作流。你将分类需求、选择负责能力和扩展点、实现全部必要角色、保留可观察历史与 UI 展示，并选择聚焦证据。调试部分把常见症状映射到负责它的层。

## 目录

- [分类改动](#classify)
- [选择扩展点](#extension)
- [设计完整能力](#capability)
- [按仓库顺序实现](#implementation)
- [保留可观察行为](#observable)
- [追踪一个完整任务](#flow-trace)
- [选择测试](#tests)
- [按症状调试](#debug)
- [首次贡献练习](#exercises)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="classify"></a>
## 分类改动

编辑代码前，用一句话说明用户可见行为和负责模块，再分类改动：

| 改动 | 首先检查的归属 |
|---|---|
| 新模型提供者 | `llm` 适配器注册表和提供者包 |
| 新面向模型操作 | 能力服务与工具使用者 |
| 一个 Agent 使用不同能力 | Preset 和 Agent scope |
| 请求、turn 或工具策略 | 现有 waterfall 或能力事件 |
| 新持久事实 | `SessionEventMap` 及每个投影和使用者 |
| 新 Web 展示 | 原始持久数据、Client slot 和 renderer |
| 新外部协议 | 现有控制器与生命周期上的适配器 |
| 新执行位置 | 成对 filesystem、subprocess 和 sandbox 提供者 |

优先使用现有扩展点，而不是修改 AgentLoop。循环负责通用的“请求模型、执行工具、继续”顺序；功能策略属于事件和服务。循环改动还需要更新架构地图，以及两个 SDK 投影所需证据。

<a id="extension"></a>
## 选择扩展点

调用方直接请求能力时使用服务方法。插件需要观察、包装、决定或贡献，而不选择具体提供者时使用事件。事实必须跨重载保存或被分离读取者使用时，使用 Session 事件。

常见路径包括：

- 在 `ctx.llm` 注册模型适配器。
- 在 `ctx.tools` 注册工具；其 schema 自动进入提示词组装。
- 在 `ctx.systemPrompt` 注册提示词 section、变量或上下文贡献者。
- 监听 `agent/pre-step`、`agent/request`、`agent/request-error` 或 `agent/turn-stopping` 实现实时循环策略。
- 监听 `tools/*` 或能力事件实现执行策略。
- 上下文需要进入下一次已接纳请求时调用 `agent.inject()`。
- 持久事件需要重建功能状态时添加投影。
- 浏览器展示添加 Client slot 贡献和 renderer。

编写监听器前先阅读事件精确模式。协作 waterfall 中遗漏 `next()` 会改变行为，不是样式问题。

<a id="capability"></a>
## 设计完整能力

可替换能力通常需要：

1. 带提供者无关类型和错误的服务定义。
2. 至少一个实现能力并负责资源的提供者。
3. 产生用户或模型价值的使用者。
4. 选择提供者和使用者的组合配置行。
5. 生命周期清理和可选运行时 invariant 检查。
6. 说明配置、失败、限制和扩展点的文档。
7. 与行为匹配的单元、真实组合和模型可见证据。

默认值放在实现拥有的 `resolve(request): Spec` 阶段。操作运行显式解析后的 spec，不在 `run()` 中隐藏部署选择。随部署变化的值属于经过验证的插件配置，而不是常量或仅测试 hook。

跨包 opaque id 使用 branded type。在 parser、文件、worker、进程、wire、队列和模型/工具 JSON 边界验证不可信或持久数据。在类型化同进程调用点信任 TypeScript，不为静态接口不允许的值重复运行时检查。

<a id="implementation"></a>
## 按仓库顺序实现

使用以下顺序减少不完整设计：

1. 阅读根与子树指令、架构、包 README 和相关防御性模式。
2. 定义用户可见行为、失败、取消、资源归属和持久化需要。
3. 添加或更新提供者无关类型与事件。
4. 实现提供者和使用者路径。
5. 连接组合和必需依赖清单。
6. 在新数据发送给模型或可回放 UI 前，添加 Session 事件和投影。
7. 从记录数据添加纯 Host/Client 展示。
8. 更新 README、子系统参考、生成目录和当前状态的依据归属。
9. 运行覆盖最终 diff 的最小检查集合。

所有公开 API 都处于预稳定阶段，因此要一起更新仓库内每个使用者。修改已发布 Session 数据前，持久类型需要遵循仓库的显式确认和版本规则。

<a id="observable"></a>
## 保留可观察行为

对任何产品可见改动，回答以下问题：

- 模型可见输入能否从日志重建？
- 人类 transcript 是否保留用户已经看到的内容？
- Web 展示能否在重载后脱离实时执行器重建？
- 取消是否结算已显示的部分工作？
- 销毁是否等待拥有的异步资源？
- 一个 Agent 的 scoped 改动是否对同级保持不可见？
- 冷读取能否在不唤醒 Agent 的情况下运行？
- 提供者替换是否保留使用者约定？

新 Session 事件必须有稳定载荷和全部必要读取者。新工具同时需要模型渲染与持久 UI 展示设计。新进程使用者需要取消与终止资源归属，而不只是成功 spawn。

<a id="flow-trace"></a>
## 追踪一个完整任务

基础 profile 包含默认禁用的学习与诊断观察器 `@deepseek-ai/dsh-flow-trace`。使用提供的 patch 为一次运行启用它：

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/flow-trace.overlay.yml "trace one task"
```

把输出作为三个交错层次阅读。`agent ... phase=...` 行展示进程本地循环与策略活动。`tool ... phase=...` 行展示执行前策略、实现派发、执行后策略和冻结结果。`session ... event=...` 行展示 `Session.append()` 提交后的事实。匹配 `id`、`turn`、`step`、`call` 和 `attempt` 字段即可跟踪一条路径。

普通工具 step 通常按此顺序出现：inbox claim、`turn/start`、pre-step 接纳、`step/start`、请求选择、assistant stream 开始/结束、`tool/call`、工具 pre/dispatch/post/result、Session `tool/result`、`step/end`，然后进入下一 step 或 `turn/end`。有些路径按设计省略阶段：被拒绝的 pre-step 没有 step；被拒绝的工具不派发实现；请求错误可能重试；取消可能提交被中断的 assistant 前缀。

追踪省略提示词文本、消息正文、工具参数与输出、文件内容、模型 chunk 和错误消息。先用它定位第一个分歧阶段，再检查所属包和持久 Session 事件中的精确数据。每类日志与配置字段见 [`flow-trace` 包参考](../../packages/runtime-diagnostics/flow-trace/README.zh.md)。

<a id="tests"></a>
## 选择测试

使用能够观察受影响层的证据：

| 证据 | 能说明什么 |
|---|---|
| 聚焦单元测试 | 状态转换、顺序、失败、取消和销毁 |
| Loader 组合测试 | 插件导出、依赖激活和真实配置路径 |
| 录制 Session 快照 | 模型可见请求、transcript、持久事件和回放 |
| Web 浏览器场景 | 来自记录或实时数据的实际渲染与交互 |
| 真实提供者 e2e | 外部 API 上的模型适配器和模型行为 |
| 构建产物冒烟测试 | 发布导出、普通 Node 解析、worker 和 bin |
| 性能 gate | 代表性合成数据上的时间、heap 和扩展性 |

不要把 Agent 的文本声明作为外部效果证据。重新读取文件、再次运行命令、检查已存储事件或从外部查询 API。发布分支前使用 [pre-push 检查](../../.agents/skills/dsh-pre-push-checks/SKILL.md)。

<a id="debug"></a>
## 按症状调试

| 症状 | 起点 | 问题 |
|---|---|---|
| 插件缺失 | 有效 profile 和 `inject` | 配置行是否被选择、替换、禁用或等待服务？ |
| 工具未公告 | Agent scope 和限制 | 提示词组装使用的同一 scope 是否可见该定义？ |
| 工具已公告但解析失败 | 执行 scope 和注册表生命周期 | 重载是否在 step 间销毁或替换定义？ |
| 模型输入错误 | 提示词组装和 Session Surface | 哪些已提交事件和投影产生 `deriveMessages()`？ |
| 重试后用户消息重复 | Agent step 接纳 | 代码是否重复首次 attempt 提交？ |
| 重连后 UI 丢失内容 | 持久结算和元数据 | UI 是否依赖临时帧或实时 presenter？ |
| 关闭挂起 | 资源归属和取消 | 哪个进程、迭代器、writer 或监听器尚未静止？ |
| Session 实时打开正常但冷查询不同 | 投影注册 | 实时与分离读取者是否使用同一组定义？ |
| 并行测试不稳定 | 共享资源和销毁 | Port、路径、全局状态、时钟或子进程是否隔离并等待？ |

优先完成一条纵向追踪，而不是广泛搜索：入口或输入、所有者、事件、提供者、结算和观察结果。找到第一个分歧后，只在该包及其测试中继续搜索。

<a id="exercises"></a>
## 首次贡献练习

1. 在仅测试组合中添加本地提示词 section，验证其 Session system 消息，再销毁 scope 并验证移除。
2. 基于现有服务实现一个小型只读工具，覆盖无效模型输入、成功渲染、结果元数据和注册销毁。
3. 添加一个委派 `next()` 的工具执行观察器，证明它观察成功和普通错误结果且不修改它们。
4. 为测试事件编写冷投影，并比较增量状态与回放状态。
5. 修改 UI 前，先从 Session 事件跟踪一个现有 Web 工具卡片到 Client renderer。

这些练习有意小于完整新能力。它们让你在负责提供者生命周期或已发布持久数据之前，学习仓库的注册、日志、展示和测试路径。

<a id="further"></a>
## 进一步阅读

使用[扩展指南](../cookbook/extension-cookbook.zh.md)选择包、工具、适配器、设置或事件的具体操作指南。实现生产改动前，阅读[测试策略](../testing.zh.md)、[防御性模式](../defensive-patterns.zh.md)和所属包测试。

返回[学习指南](../learning-guide.zh.md)，完成其中的端到端文件读取追踪。现在你已经具备解释该路径中每一层所需的概念。

<a id="dev-note"></a>
## 开发备注

无。
