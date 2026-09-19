# DeepSeek Harness 源码学习指南

[English](learning-guide.md) | 中文

## 概要

本教程沿“读取一个文件并解释内容”这项任务，理解应用组合、模型请求、工具执行、持久历史和产品入口。读者需要基本 TypeScript、异步编程和 HTTP 知识，无需预先了解 Cordis，也不需要模型 API key。完成阅读后，你应能找到某项行为的实现归属、追踪其记录事件，并选择适当的扩展点。完整配置和行为以链接的架构参考及各包 README 为准。

## 目录

- [学习路线](#learning-path)
- [源码实现篇](#implementation-labs)
- [1. 理解产品职责](#product)
- [2. 理解插件与应用组合](#composition)
- [3. 区分运行概念](#concepts)
- [4. 追踪一次请求](#request)
- [5. 理解 Session 与模型历史](#session)
- [6. 跟踪真实工具](#tools)
- [7. 检查取消与资源归属](#lifecycle)
- [8. 深入辅助系统](#systems)
- [9. 连接产品入口](#interfaces)
- [10. 练习源码导航](#practice)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="learning-path"></a>
## 学习路线

本页是地图和第一遍导读。下面的章节构成详细课程；完整学习时按顺序阅读，也可以直接进入负责当前问题的章节。

| 章节 | 学习结果 |
|---|---|
| [1. 架构与组合](learning/01-architecture-and-composition.zh.md) | 从 CLI 选择一路追踪 profile、bundle、patch 和 Cordis 激活。 |
| [2. Cordis 运行时](learning/02-cordis-runtime.zh.md) | 理解 Context、服务、事件、effect、scope 和支持重载的资源归属。 |
| [3. Session 与投影](learning/03-sessions-and-projections.zh.md) | 区分事件日志、模型历史、transcript 和持久状态投影。 |
| [4. Agent 循环](learning/04-agent-loop.zh.md) | 跟踪 inbox 接纳、turn、step、attempt、工具、取消和销毁。 |
| [5. Prompt 与 LLM](learning/05-prompt-and-llm.zh.md) | 跟踪提示词组装、路由准备、不可变请求、流式响应和重试。 |
| [6. 工具与执行](learning/06-tools-and-execution.zh.md) | 沿 schema、策略、调度、文件系统、子进程和沙箱追踪一个工具。 |
| [7. 持久化与上下文](learning/07-persistence-and-context.zh.md) | 理解写入归属、代际文件、恢复、压缩、spill 和附件。 |
| [8. 产品入口](learning/08-product-interfaces.zh.md) | 连接 Host、API、Client、Desktop、SDK、ACP，以及实时与持久更新。 |
| [9. 扩展与调试](learning/09-extension-and-debugging.zh.md) | 选择扩展点、实现改动，并为诊断和评审选择证据。 |
| [10. 启动流程源码实现](learning/10-boot-code-walkthrough.zh.md) | 按函数追踪环境快照、profile 组合、Loader 挂载、就绪发布和失败回滚。 |
| [11. Session 源码实现](learning/11-session-code-walkthrough.zh.md) | 按代码顺序阅读构造校验、append 事务、Surface 计划、缓存和持久化交接。 |
| [12. Agent 循环源码实现](learning/12-agent-loop-code-walkthrough.zh.md) | 追踪驱动状态机、请求提交边界、流式 attempt、重试和生命周期销毁。 |
| [13. 工具运行时与调度器源码实现](learning/13-tool-runtime-code-walkthrough.zh.md) | 跟踪注册表解析、策略阶段、并行池、独占屏障、取消和有序提交。 |
| [14. Web 与 SDK 源码实现](learning/14-interface-code-walkthrough.zh.md) | 追踪 prompt 接纳、延迟恢复、持久 follow stream、重连校验和 SDK 归属。 |

每章都包含源码地图、阅读时需要保持的关键规则，以及要求解释当前代码而非背诵术语的练习。

-----

<a id="implementation-labs"></a>
## 源码实现篇

第 1–9 章建立整体理解，第 10–14 章是面向逐行学习的代码实现路线。每篇实现解析都从真实入口函数开始，说明各阶段读取和写入的状态，标出失败无法再回滚操作的提交点，并提供基于断点的练习。

建议按以下顺序学习实现篇：启动流程构造运行时；Session 定义记录事实；Agent 循环驱动请求；工具运行时执行模型动作；Web 与 SDK 通过不同传输暴露同一核心。五章共同覆盖从进程启动到用户输入、模型请求、工具结果、持久历史和界面更新的主路径。

-----

<a id="product"></a>
## 1. 理解产品职责

模型生成文本和工具请求。Harness 提供让这些请求完成实际工作的环境：上下文组装、工具派发、权限处理、进程管理、会话持久化和用户界面。对于“读取一个文件并解释内容”，模型决定请求读取，Harness 执行读取，再把结果提供给下一次模型请求。

```text
User input -> context assembly -> model request
                                   |
                                   v
Final response <- next request <- tool execution
```

仓库围绕三个设计组织：Cordis 插件组合应用；Session 事件提供可重建的模型历史；能力使用者依赖服务定义，使提供者可以替换。先通过[架构总览](architecture.zh.md)认识这些关系，再进入具体实现。

| 位置 | 用于理解 |
|---|---|
| `apps/`、`packages/boot/`、`packages/bundle/` | 应用入口与配置组合 |
| `packages/core/`、`packages/llm/` | 会话、Agent、提示词、工具和模型调用 |
| `packages/fs/`、`packages/shell/`、`packages/subprocess/`、`packages/sandbox/` | 文件和进程执行 |
| `packages/session/`、`packages/compaction/` | 持久历史和上下文管理 |
| `packages/api/`、`packages/host/`、`packages/client/`、`packages/sdk/` | 人机交互和程序接入 |
| `scripts/`、`snapshots/`、`benchmarks/` | 仓库检查、录制场景和性能验证 |

通过[包地图](../packages/README.zh.md)定位能力家族，无需记住每个包。源码说明能力如何实现，应用配置说明能力是否进入实际运行组合；二者需要一起阅读。

<a id="composition"></a>
## 2. 理解插件与应用组合

Cordis 提供 Context、服务依赖激活、事件和可撤销 effect。插件通过 `ctx.tools`、`ctx.llm`、`ctx.fs` 等属性使用服务，通过 `inject` 声明必需服务。注册项归属于插件生命周期，并在生命周期结束时撤销。先阅读 [Cordis 入门](cordis-primer.zh.md)，不必立即深入框架内部实现。

### 服务、提供者与使用者

服务定义声明使用者可以调用什么；提供者实现能力；使用者使用能力，常见形式是面向模型的工具。例如文件工具调用 `ctx.fs`，文件系统提供者由应用组合选择。若这些角色不独立演进，可以位于同一个包。阅读新能力时，先分别找到这三个角色。

### 事件与生命周期

事件让插件无需导入默认循环即可协作。`emit` 通知观察者，`serial` 等待顺序工作，`parallel` 等待并发工作。waterfall（瀑布式事件）监听器接收 `next()`，可以委派或短路；返回值本身可以是 Promise 或异步迭代器，因此时序要看具体事件声明和调用方。只观察或包装操作的监听器通常需要继续调用 `next()`。

可撤销注册使配置重载、插件卸载和初始化回滚能够清理贡献。阅读一个 `register()` 时，应同时寻找其 disposer 和生命周期归属，而不只看注册表如何插入数据。

### Profile、Bundle 与 Patch

具名 profile 选择运行组合，bundle 提供插件配置和代码，patch 定制配置。依次阅读 [CLI 入口](../apps/cli/src/bin.ts)、[profile 启动](../apps/cli/src/profile-boot.ts)和[基础 bundle](../packages/bundle/base/cordis.patch.yml)。共享基础组合与各产品入口的关系由[应用启动架构](architecture.zh.md)定义；不要因为某个包存在就假定产品已启用它。

检查点：在[文件工具入口](../packages/fs/tool-fs/src/index.ts)找到 `inject` 声明，再在组合中定位它需要的服务。若能力未激活，先检查配置与服务依赖，再检查执行函数。

<a id="concepts"></a>
## 3. 区分运行概念

下面这些概念回答不同问题。区分它们后，重试、恢复和插入新输入就更容易理解。

| 概念 | 含义 |
|---|---|
| Session | 对话身份及记录事件 |
| Agent | 驱动 Session 工作的实时对象 |
| Turn | 包含零个或多个 step 的工作区间 |
| Step | 一次逻辑模型请求阶段及其产生的工具执行 |
| Attempt | step 内的一次模型尝试；重试可以增加尝试 |
| Scope | 插件贡献的可见性与生命周期 |

已存储的 Session 不一定有活跃 Agent。恢复会话会让实时执行连接到已有历史。公共 Agent 接口与默认驱动分离，因此集成方使用 `ctx.agents`，默认实现位于 `agent-loop` 包。

Agent 作用域内的注册可以覆盖继承贡献而不影响同级 Agent。Scope 用于组织受信任插件，不是操作系统沙箱；详见 [scope](../packages/core/scope/README.zh.md)。

检查点：把“读取文件、运行命令、给出回答”描述为一个 turn 中的多个 step，再加入一次失败模型尝试。重试并不因此成为新的用户 turn。

<a id="request"></a>
## 4. 追踪一次请求

打开 [ReactLoopAgent](../packages/core/agent-loop/src/agent.ts)。第一遍沿 `send`、`wakeDriver`、`kick`、`turn`、`preStep`、`step` 阅读正常路径，第二遍再看取消和恢复。这个类名不表示浏览器 React 组件。

### 输入接纳

`followup()` 为下一轮排入可唤醒输入；`steer()` 指向下一步并唤醒驱动；`inject()` 指向下一步但不唤醒驱动。这些方法暂存输入，不改写已经派发的模型请求。[Inbox 实现](../packages/core/agent-loop/src/inbox.ts)把队列变更连接到持久 inbox 投影。

Turn 在领取输入之前开启。`preStep()` 组装提示词与工具 schema、投影运行时上下文，并通过 `agent/pre-step` 接受、改写或拒绝输入。首次接纳被拒绝或变为空时，可以在没有模型 step 的情况下结束 turn。

### 请求构建

接纳后，循环开启 step，通过 `agent/request` 和 `llm.prepareCall()` 解析请求配置。随后协调系统提示词、记录已接纳用户消息、按需记录请求元数据，并从 Session 推导不可变模型请求。在异步路由准备期间取消，不会提交待处理系统提示词或已接纳用户消息。

准备好的调用绑定实际适配器及其能力，使日志中的有效配置与实际派发保持对应。结合 [LLM 服务](../packages/llm/llm/src/index.ts)阅读 `prepareRequest()` 和 `buildRequest()`。请求冻结避免已记录输入被后续改写，同时取消信号仍然有效。

### 流结算与继续执行

循环消费流块，成功时提交 `assistant/message`，失败尝试则与模型历史分开记录。如果消息包含工具调用，调度器执行并记录结果；通常还需要下一步让模型使用这些结果。Turn 停止监听器可以补充后续工作，因此不能只通过“没有工具调用”推断所有工作已结束。

重试发生在当前 step 内，复用已组装内容，不重复接纳同一批用户输入。精确的继续执行、错误和重试语义以 [agent-loop README](../packages/core/agent-loop/README.zh.md)为准。

检查点：找到首次追加 `user/message` 的位置和 `deriveMessages()` 调用，解释它们与路由准备的先后关系，以及为什么重试不能再次追加用户消息。

<a id="session"></a>
## 5. 理解 Session 与模型历史

先阅读 [Session](../packages/core/session/src/index.ts) 和 [surface.ts](../packages/core/session/src/surface.ts)。日志包含消息、请求元数据、工具活动和生命周期标记，只有特定事件产生模型消息。例如 `tool/result` 贡献模型输入，而 `turn/start` 和失败的 `assistant/attempt` 不会变成普通对话消息。

### 三种不同视图

完整日志、模型可见 Surface 和面向用户的 transcript（文本记录）分别回答：发生过什么、下一次请求看到什么、用户经历过什么。记录中的替换操作可以压缩旧模型上下文，同时保留原始事件。如果只渲染当前模型 Surface，就会丢失用户已经看过的早期对话。

```text
Recorded events
  -> model Surface -> deriveMessages() -> next request
  -> human transcript -> conversation history
  -> state projections -> inbox and other durable state
```

### 系统提示词与投影

系统提示词也参与记录历史。[提示词组装](../packages/core/system-prompt/README.zh.md)收集有序贡献和可见工具 schema；[runtime-context.ts](../packages/core/agent-loop/src/runtime-context.ts)处理相关投影。实际路由能力决定提示词更新能否进入后续历史，或是否需要归并。不要假设所有模型对系统消息的处理一致。

### 持久化与恢复

内存提交与磁盘持久性不同。持久化提供者管理写句柄和缓冲，flush 检查点等待持久化监听器。恢复会话重建历史，不会自动重复过去的外部副作用。存储归属见[会话持久化](subsystems/persistence.zh.md)，格式版本以[格式状态](session-format-status.zh.md)为准。

阅读迁移实现时，区分“读取旧数据得到当前逻辑记录”和“为写入发布后继版本文件”。格式兼容、物理文件选择和中断 turn 修复各有归属，不能把它们统称为 JSON 反序列化。

检查点：找到 `deriveEventMessage()` 中产生消息的事件分支，解释失败尝试为什么既可保留诊断信息，又不成为下一次模型输入。

<a id="tools"></a>
## 6. 跟踪真实工具

从定义到执行函数阅读 [read 工具](../packages/fs/tool-fs/src/read.ts)。识别输入参数、值校验、输出 schema、文本渲染、展示元数据和并发声明。工具使用 `ctx.fs`；其包负责面向模型的行为，不绑定某种文件系统实现。

### 一次读取包含什么

实现选择有界行窗口，对大文件或大小未知输入采用流式读取。模型文本包含可读窗口，持久化展示元数据提供重建 UI 卡片所需结构。读取还与文件观察记录相关，供相关策略使用。这个例子说明同一次执行如何同时服务模型、策略和界面。

### 工具管线

调用经过执行前策略、guard、执行中间件、工具函数和结果处理。Guard 可以拒绝，后续 guard 不能反转这一拒绝。[工具管线](tool-execution-pipeline.zh.md)定义精确阶段顺序。先用读取例子认识这些阶段，再阅读[工具注册表](../packages/core/tools/src/index.ts)。

### 并发与提交顺序

[调度器](../packages/core/agent-loop/src/tool-calls.ts)区分并行安全调用和独占调用，独占调用形成顺序屏障。并发完成不会重排已提交结果：结果仍保持模型调用顺序。分别观察并发池和提交游标，区分执行并发与历史顺序。

检查点：考虑两个读取后接一个独占编辑，解释哪些调用可以重叠、编辑何时能启动，以及第二个读取先完成为什么不会改变历史顺序。

<a id="lifecycle"></a>
## 7. 检查取消与资源归属

理解正常路径后，再返回循环检查异常路径。AbortController 向活动工作传递取消。已经展示的助手内容可以结算为被中断消息，没有已接纳消息内容的失败尝试保持独立。调度器停止启动工作，并等待已启动调用收敛。跳过调用的记录方式和错误分类见[循环实现指南](../packages/core/agent-loop/README.zh.md)。

Agent 创建与销毁需要协调多个资源。阅读 [agent-loop/index.ts](../packages/core/agent-loop/src/index.ts) 中的创建事务：setup 和初始化完成后，才释放排队工作。销毁先等待驱动收敛，再移除写入最后记录所需的注册和持久化资源。一组彼此独立的清理回调无法建立这一顺序。

检查点：识别 AgentHandle、scope 和持久化写句柄分别由谁负责。修改这些路径前，阅读[防御性模式](defensive-patterns.zh.md)，尤其是生命周期、异步工作和销毁规则。

<a id="systems"></a>
## 8. 深入辅助系统

根据要回答的问题选择一个分支。链接指向的归属文档解释实现和限制，无需先读完整个仓库。

| 问题 | 阅读路径 |
|---|---|
| 命令在哪里执行？ | [Shell](../packages/shell/README.zh.md)、[subprocess](../packages/subprocess/README.zh.md)和[沙箱](../packages/sandbox/README.zh.md)：命令执行、进程生命周期和限制属于不同职责。 |
| 远程文件和命令如何保持一致？ | [SSH](../packages/ssh/README.zh.md)：成对提供者共享执行环境。 |
| 长对话如何继续？ | [压缩](../packages/compaction/compaction-basic/README.zh.md)：总结可处理的早期历史，同时保留近期上下文。 |
| 大结果如何处理？ | [Spill](../packages/spill/README.zh.md)：外部存储与面向模型的结果策略。 |
| 模型能否用程序组织调用？ | [PTC 运行时](../packages/ptc-runtime/ptc-runtime-node/README.zh.md)：Node 执行、宿主绑定、限制和沙箱策略。 |
| 如何委派工作？ | [Subagent](../packages/subagent/README.zh.md)：由提供者支持的新建或可继续子 Agent。 |
| 如何组织长期活动？ | [Jobs](../packages/jobs/README.zh.md)、[workflow](../packages/workflow/README.zh.md)、[目标](../packages/goal/README.zh.md)和[调度](../packages/schedule/README.zh.md)：后台执行、编排、目标和后续跟进。 |
| 外部能力如何接入？ | [MCP](../packages/mcp/README.zh.md) 和 [skill](../packages/skill/README.zh.md)：工具集成和指令发现。 |

研究这些分支时，继续区分接口与提供者、模型可见内容与内部状态，以及进程隔离与插件作用域。例如 subagent 不一定是独立操作系统进程；PTC 的直接 Node 操作则需要按实际沙箱策略理解其限制。

<a id="interfaces"></a>
## 9. 连接产品入口

对于 Web，沿 Client 连接、Session Controller 追踪输入如何进入 Agent，再反向追踪输出。区分持久 Session 事件与临时 assistant-stream 帧：前者支持历史恢复，后者提供实时增量展示。先读 [API](../packages/api/README.zh.md) 和 [Client](../packages/client/README.zh.md)，再跟进负责具体问题的控制器和 UI 包。

浏览器同样使用插件：模块加载能力，slot 定义扩展位置，renderer 把贡献渲染成 UI。工具展示应从记录事件和元数据恢复，而不是依赖活动执行器。Desktop 在打包载体中承载 Web 应用；启动与进程归属见 [Desktop](../apps/desktop/README.zh.md)。

[TypeScript SDK](../packages/sdk/client/README.zh.md) 和 [Python SDK](../python/README.zh.md) 通过 JSON-RPC 驱动独立 Harness 运行时。解释返回的最终回答之前，先阅读客户端的进程归属和从输入回执到空闲的收集语义。运行时共享应用组合与循环，SDK 客户端负责传输和子进程清理。

检查点：解释重新连接后哪些记录可以重建界面，哪些帧只用于改善实时展示，以及 SDK 等待空闲为什么不等于一条输入独占了整个活动区间。

<a id="practice"></a>
## 10. 练习源码导航

第一个纸面练习采用“读取一个小文件并解释内容”，无需调用模型。写下每个阶段的实现归属和持久事件，再与循环和工具源码比较。

1. 定位输入排队处，以及唤醒执行的方法。
2. 找到提示词和工具 schema 组装，再找到输入接纳决定。
3. 找到请求路由准备和首次提交的用户消息。
4. 找到助手消息如何把读取调用交给调度器。
5. 沿注册表追踪读取执行函数及其文件系统提供者。
6. 找到记录的工具结果和下一次推导的模型历史。
7. 找到最终助手结算和 turn 结束。
8. 分别加入模型流期间取消、请求尝试失败，重新追踪。

若要实际运行练习，按[开发环境设置](development.zh.md)和相关包使用说明操作。本页是源码阅读教程，不提供实际模型运行的验证结果。凭据、已安装依赖、所选提供者和运行时配置需要通过实际运行检验。

按[测试策略](testing.zh.md)选择证据：聚焦测试覆盖状态与错误，录制会话场景覆盖组装后的模型可见行为，真实提供者测试覆盖实际模型集成，构建产物冒烟测试覆盖发布入口。对修改文件的任务，应检查最终文件，而不是仅接受助手“已修改”的声明。

追踪结果不符预期时，先分类再搜索：能力缺失先查组合或作用域；模型输入异常先查组装与 Session 投影；工具被拒绝先查策略；退出挂起先查资源归属；UI 历史缺失先查持久记录与客户端投影。这样可以把搜索缩小到负责模块。

<a id="further"></a>
## 进一步阅读

完成练习后，选择一项具体修改，并查阅[扩展指南](cookbook/extension-cookbook.zh.md)。新增工具、提供者、UI 贡献或持久事件使用不同扩展路径。修改实现之前，阅读所属包的测试和 README；需要理解完整类型时，再查对应子系统参考。

<a id="dev-note"></a>
## 开发备注

无。
