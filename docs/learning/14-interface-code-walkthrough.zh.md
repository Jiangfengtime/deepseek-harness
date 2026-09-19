# Web 与 SDK 源码实现

[English](14-interface-code-walkthrough.md) | 中文

## 概要

本章沿用户输入穿过 Host Remote API 和 SDK JSON-RPC server，解释命令校验、Agent 延迟恢复、提示词接纳、持久事件跟随、临时助手帧、重连连续性和 SDK 自有生命周期。

## 目录

- [源码地图](#source-map)
- [Host 服务结构](#host)
- [Web Prompt 路径](#web-prompt)
- [跟随历史与实时输出](#follow)
- [Client 连续性校验](#client)
- [SDK 初始化与 Prompt 路径](#sdk)
- [归属模型对比](#comparison)
- [端到端调用链](#traces)
- [调试与练习](#debugging)

-----

<a id="source-map"></a>
## 源码地图

| 职责 | 实现位置 |
|---|---|
| Remote Session 命名空间门面 | [`packages/api/session-controller/src/index.ts`](../../packages/api/session-controller/src/index.ts) |
| 创建、prompt、fork 与队列命令 | [`packages/api/session-controller/src/commands.ts`](../../packages/api/session-controller/src/commands.ts) |
| 活动 Agent 解析与恢复 | [`packages/api/session-controller/src/agent.ts`](../../packages/api/session-controller/src/agent.ts) |
| 分页与 follow stream | [`packages/api/session-controller/src/history.ts`](../../packages/api/session-controller/src/history.ts) |
| Client 事件流适配器 | [`packages/api/session-controller/src/client/transport.ts`](../../packages/api/session-controller/src/client/transport.ts) |
| SDK JSON-RPC Server | [`packages/sdk/server/src/server.ts`](../../packages/sdk/server/src/server.ts) |

两个产品入口最终使用同一 Agent 循环、Session、LLM 和工具服务。它们的差异是传输协议、谁负责发现 Session，以及活动 Agent 保留多久。

<a id="host"></a>
## Host 服务结构

`SessionController` 继承 `TypertRemoteService` 并使用 `session` 命名空间。带装饰器的方法定义 wire 操作，但门面把业务行为委托给四个专职对象：`ApiSessionAgentController`、`SessionCommandController`、`SessionHistoryController` 和 `SessionControlController`。

构造器注册文件上传的 Agent 查找、Session 文件/媒体/skill 引用插件，以及 added、removed、status、error、模型选择和 activity 的事件桥。这些桥把领域事件投影成 Host 通知，但不会替代 Session 事件日志。

`ApiSessionAgentController.resolveAgent()` 先检查活动注册表。若不存在，就在 `resumes` Map 中去重并发恢复请求。所有等待者共享一次持久化加载和发布事务。恢复后还会再次检查归属，因为等待期间其他路径可能已经接管 Session。

Create 使用对应的 `creations` Map。`ensureSession()` 创建或接管请求 identity，校验 preset 和工作目录兼容性，并返回精确活动 Agent。Identity 冲突和写所有权占用会变成稳定 Remote 错误码。

<a id="web-prompt"></a>
## Web Prompt 路径

Wire 调用进入 `SessionController.prompt()`，它检查调用方取消后委托给 `SessionCommandController.prompt()`。Command 在解析 Agent 前拒绝空内容和无效客户端时区。

`requestId` 提供幂等性。`hasPromptRequest()` 检查现有 Agent 状态；重复的已接纳请求直接返回成功，不会再次排队消息。Command 还会在处理附件前确认当前所选 provider 有可用路由。

文件 receipt 按目标 Agent 解析，`attachments.admitPromptContent()` 把输入引用转换成持久内容块。图像 prompt 还会解析当前模型元数据，并拒绝不支持图像的模型。由于模型选择可能并发变化，图像接纳按 Agent 串行执行。

异步接纳结束后，Command 验证注册表中仍是同一个 Agent 实例。随后创建 `UserMessage`，source 中包含用户类型、RPC id 和可选规范时区，并把上传 receipt 绑定到本次请求。

`mode === 'steer'` 时调用 `agent.steer(message)`，其他 prompt 调用 `agent.followup(message)`。只有 Agent 接受消息后才提交上传绑定。返回的 `{ accepted: true }` 只确认队列接纳，不表示 turn 已完成。

<a id="follow"></a>
## 跟随历史与实时输出

`SessionHistoryController.follow()` 在获取开场 observation 前先安装监听器。读取存储期间产生的新 `session/event` 会进入缓冲区，从而补上 snapshot 与实时订阅之间的空隙。`session/created` 监听器还会恢复构造种子后缀，因为构造事件从未发布到实时 firehose。

第一个输出帧永远是 `snapshot`：header、持久 cursor、有界 records、分页标志、projection baseline 和可选 assistant-stream baseline。对于冷的普通 Session，控制器可在 snapshot 安全发送后保留 observation，并把它提升为活动 Agent。

之后，只有 `event.seq` 等于下一预期序号时，持久事件才离开缓冲区。较旧重复项被忽略；向前缺口会抛出内部 Remote 错误。该规则会暴露重连 bug，而不是把不完整历史伪装成完整历史。

Assistant stream frame 是可选且无 cursor 的。监听器在 stream start 旁记录最后持久 cursor，并分配进程内 ordinal。Snapshot 切点之前已经由开场 baseline 表示的帧会被跳过。

取消或销毁时，`finally` 移除所有监听器和 follower 注册。Stream 仅在 Remote carrier 生命周期内拥有这些订阅。

<a id="client"></a>
## Client 连续性校验

`SessionEventStream` 把 Remote frame 适配到通用 journal stream。Snapshot 变成 `opened` frame，持久事件变成有序 entry，助手 chunk 变成 notification。

Client 校验每个 wire 事件，并要求已选择的开场 assistant baseline 存在。它保存 baseline revision，并要求后续每个助手 frame 精确递增一。若 revision 跳过，就抛出 `RemoteStreamCarrierError`，让外围重连机制从持久状态重新打开，而不是渲染损坏的部分 stream。

因此 UI 可以从持久事件重建已结算内容，仅用助手 frame 展示进行中状态。`assistant/message` 提交后，持久 entry 成为权威来源，临时 attempt 可以消失。

<a id="sdk"></a>
## SDK 初始化与 Prompt 路径

SDK Server 通过 `handleRequest()` 接收 JSON-RPC 方法。它派发 `initialize`、`session/prompt` 和 `shutdown`；未知方法抛错，并在传输层转换为 JSON-RPC 错误响应。

`initialize()` 校验 reasoning effort 和 max tokens，解析工作目录并确保 adapter 存在。只有请求 official provider 且当前无人提供时才挂载 DeepSeek adapter，随后调用 `llm.resolveCallConfig()`，在把 Server 标记为 initialized 前拒绝不可用路由。

`prompt()` 通过 `getOrCreateSession()` 获取记录。`sessionCreations` Map 对同一 SDK Session id 的并发创建去重。`createSession()` 使用 SDK 自有 cwd 和模型选项调用 `ctx.agents.create()`，再保存返回 handle。

在持久附件转换前后，`assertLiveAgent()` 都会验证保存的 handle 仍指向注册表中的当前 Agent。随后创建用户消息并调用 `followup()`。返回 message id 识别已接纳内容，但不声明后续 Agent 活动只属于本次 RPC。

`shutdown()` 把 Server 标记为 closing，等待进行中的创建，移除订阅，销毁所有 Agent handle 和动态挂载的 adapter，并汇总销毁失败。外围 Cordis 根继续运行，因为 SDK Server 只拥有这些资源。

<a id="comparison"></a>
## 归属模型对比

| 问题 | Web/Host 路径 | SDK Server 路径 |
|---|---|---|
| Session 发现 | 活动注册表加持久查询/恢复 | Server 局部记录 Map |
| 重复创建 | 共享 `creations`/`resumes` Promise | 共享 `sessionCreations` Promise |
| 输入协议 | Typed Remote 命名空间 | JSON-RPC 方法 |
| 历史交付 | Snapshot、持久 entry、实时 frame | SDK notification 与客户端收集 |
| Agent 生命周期 | Host Session 生命周期与 promotion | SDK Server 显式持有 handle |
| 关闭 | Remote carrier 关闭订阅 | Server 销毁记录和可选 adapter |

共同规则是：输入通过 Agent API 进入，已结算的模型可见输出通过 Session 事件进入。传输确认与临时 frame 都不会取代该历史。

<a id="traces"></a>
## 端到端调用链

Web Prompt：

```text
Client Remote call
  -> SessionController.prompt()
  -> SessionCommandController.prompt()
  -> ApiSessionAgentController.resolveAgent()
  -> attachment admission
  -> agent.followup()/steer()
  -> Agent inbox -> turn -> Session events
  -> SessionHistoryController.follow()
  -> SessionEventStream -> UI state
```

SDK Prompt：

```text
JSON-RPC session/prompt
  -> Server.handleRequest()
  -> Server.prompt()
  -> getOrCreateSession()
  -> ctx.agents.create() when absent
  -> durablePromptContent()
  -> agent.followup()
  -> Agent loop and Session events
  -> SDK notifications / final collection
```

<a id="debugging"></a>
## 调试与练习

对于 Web，在 `SessionController.prompt()`、`SessionCommandController.prompt()`、`ApiSessionAgentController.resolve()`、`SessionHistoryController.follow()` 和 `SessionEventStream.follow()` 设置断点。观察 request id、Agent 对象 identity、snapshot cursor、缓冲事件序号和 assistant revision。

对于 SDK，在 `handleRequest()`、`initialize()`、`getOrCreateSession()`、`createSession()`、`prompt()` 和 `performShutdown()` 停下。练习一：解释为什么 prompt acknowledgement 早于 turn 完成。练习二：追踪助手 stream 活动期间的重连。练习三：在纸上同时发出同一 SDK id 的两个首个 prompt，并说明为什么只创建一个 Agent。
