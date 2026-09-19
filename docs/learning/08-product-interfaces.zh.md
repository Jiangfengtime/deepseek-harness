# 8. Web、Desktop、SDK 与 ACP 入口

[English](08-product-interfaces.md) | 中文

## 概要

本章把共享 Agent 与 Session 运行时连接到各产品入口。你将跟踪 Web prompt 如何经过 Client、API、Host 和 Agent 层，区分持久事件与实时帧，并比较 Desktop、SDK 和 ACP 的进程所有权。

## 目录

- [Host 与 Client 分离](#split)
- [远程 API](#api)
- [Session 控制](#session)
- [Client 组合](#client)
- [实时与持久更新](#updates)
- [Desktop 载体](#desktop)
- [SDK](#sdk)
- [ACP 与其他集成](#acp)
- [练习](#exercises)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="split"></a>
## Host 与 Client 分离

Host 运行受信任 Node 能力：Agent 生命周期、持久化、文件系统与进程提供者、设置和 API 控制器。Client 在浏览器中运行：连接、可观察 store、本地化、slot、renderer 和 UI 功能插件。

这种分离是进程和信任边界。Client 代码不能导入 Host 服务并直接调用，而要使用类型化 Remote 方法、stream 或功能拥有的 fetch route。共享 Typert 定义生成面向协议的类型图，同时避免把 Host 与 Client 的 Cordis 服务声明合并到同一个 TypeScript program。

<a id="api"></a>
## 远程 API

`packages/api/` 提供类型化 Remote 层。控制器负责领域行为，gateway 负责调用传输。例如 Session Controller 负责 list、resume、prompt、cancel、page、follow、fork、rename 和附件访问，gateway 则通过应用连接映射调用与 stream。

这种分离避免传输逻辑进入领域控制器。控制器可以决定操作需要实时 Agent、持久化读取、投影快照还是授权证明。Gateway 验证并传递请求，但不发明 Session 策略。

不适合普通 Remote 调用的大字节流使用功能拥有的精确 connection fetch route，例如上传或下载。

<a id="session"></a>
## Session 控制

Web prompt 经过以下概念路径：

```text
composer
  -> Client Session remote
  -> Host Session Controller
  -> resolve workspace and Session identity
  -> create or resume Agent
  -> queue identified user message
  -> follow durable and live updates
```

Prompt 接受只确认 inbox 接纳，不声明存在与其因果配对的助手回答。在 Agent 空闲前，其他消息、steering、注入上下文、工具或 turn-stopping 工作都可能参与。

List 和 page 等冷读取应保持冷操作。Prompt、cancel 和待处理队列修改需要实时 Agent，并可能恢复它。附件读取还需要证明 Session 日志可以到达所引用内容。

<a id="client"></a>
## Client 组合

浏览器同样是 Cordis 插件应用。`client/modules` 加载声明的客户端模块，`connection` 管理 Host 通信，React-free store 暴露可观察状态，`ui-slots` 定义类型化扩展位置，`ui-renderer` 挂载组装后的 React 应用。

功能包贡献聚焦的 UI 行为：对话、chat node、工具、approval、侧边栏资源、目标、计划、job、调度、设置和工作区控制。功能通常通过 slot 注册数据与 renderer，而不是修改一个中心应用组件。

Client UI 文案属于类型化 locale dictionary。领域插件应把本地化值传给不依赖 Cordis 的 primitive，而不是在组件中硬编码产品文本。

<a id="updates"></a>
## 实时与持久更新

Session follow 从 cursor 提供完整 opening snapshot 和无间隙持久事件帧。Assistant-stream 帧是可选的无 cursor 实时增量。Client 协调两种来源：

- 持久事件在重连后重建状态，并定义已提交历史。
- 实时帧改善当前助手 attempt 运行期间的延迟。
- 结算事件用持久内容替换临时实时展示。
- 重连不会假设此前显示的临时 chunk 已经提交。

工具卡片从已记录 call、result、失败状态和元数据推导。页面重载后无需实时 ToolDefinition 或执行器即可重现展示。

<a id="desktop"></a>
## Desktop 载体

Electron 应用打包准确的生产运行时，并拥有保留的 Desktop profile。Electron 启动 Desktop Host，立即加载打包 Web 资源，并在 Client 插件激活前注入就绪和连接事实。

Web 继续负责 RPC 和 stream。Electron IPC 在载体与 Host 之间传递启动注入、就绪、致命错误和关闭。Desktop 与 CLI 共享产品数据，但分别保留可执行包、profile 激活选择和 lockfile。

<a id="sdk"></a>
## SDK

TypeScript 与 Python SDK 启动或连接 `dsh --profile sdk` 运行时，并通过 stdio JSON-RPC 通信。服务器 stdout 只包含协议帧，诊断写入 stderr。

`initialize` 等待 Loader 组合稳定、验证模型路由并保存运行时选项。Prompt 在队列接纳后返回 message id。通知报告 Session 事件和 Agent 状态。高层 TypeScript 客户端从持久 inbox 回执开始等待到下一次整个 Agent 空闲，并返回该区间内根 Session 最后提交的助手回答。

客户端负责进程启动与清理。其 shutdown 阶梯先请求协议关闭，再关闭 stdin，随后逐步升级终止，直到实际进程退出。运行时服务器在协议 shutdown 后负责销毁 root context，使 Agent 与持久化达到静止。

<a id="acp"></a>
## ACP 与其他集成

ACP 通过另一个随产品发布的 profile 暴露面向自动化的协议。它仍使用共享 Agent、Session、工具和提供者插件；协议适配器只负责外部映射与生命周期。

MCP 把外部服务器接入原生工具注册表。Hook 连接其他 coding-agent 协议。Webhook 验证外部 delivery、应用受信任规则并创建 Workspace Session。这些集成应把边界数据转换为现有 Harness 能力，而不是创建独立执行循环。

<a id="exercises"></a>
## 练习

1. 从本地化 composer 操作开始，把一个 Web prompt 跟踪到 inbox 事件。
2. 找出 Session follow 使用的 opening snapshot 与增量帧类型。
3. 选择一个工具卡片，找出哪些持久元数据使它在重载后仍能展示。
4. 比较 Web Host 进程、Desktop Host 进程和 SDK runtime 子进程的所有权。
5. 解释 SDK prompt 结果为什么不能承诺一个只由该 prompt 导致的助手回答。

当你能为一项产品交互找出领域所有者、传输、持久事实、临时更新和进程所有者时，本章学习完成。

<a id="further"></a>
## 进一步阅读

继续学习[扩展与调试](09-extension-and-debugging.zh.md)。包专属行为见 [API 组](../../packages/api/README.zh.md)、[Client 组](../../packages/client/README.zh.md)、[Desktop README](../../apps/desktop/README.zh.md)和 [SDK client](../../packages/sdk/client/README.zh.md)。

<a id="dev-note"></a>
## 开发备注

无。
