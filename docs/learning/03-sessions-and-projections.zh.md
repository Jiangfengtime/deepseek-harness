# 3. Session、事件与投影

[English](03-sessions-and-projections.md) | 中文

## 概要

本章解释一个仅追加的 Session 事件日志如何同时支持模型请求、对话渲染、恢复、分叉、搜索和持久功能状态。你将区分记录事实与派生视图，跟踪一次追加如何进入发布和投影，并理解为什么模型可见数据必须能够从日志重建。

## 目录

- [Session 身份](#identity)
- [追加与发布](#append)
- [事件家族](#families)
- [模型 Surface](#surface)
- [状态投影](#state)
- [Transcript 与实时流](#transcript)
- [分叉与恢复](#fork)
- [关键规则](#invariants)
- [练习](#exercises)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="identity"></a>
## Session 身份

Session 拥有不可变 header 和有序事件序列。Header 记录身份以及工作目录、谱系等创建元数据。每个事件在类型化载荷之外获得序列号和时间戳 envelope。

[`SessionStore`](../../packages/core/session/src/index.ts) 是实时内存注册表。它可以构造但不发布 Session，把它加入存储，再公告创建。分离这些步骤，让 Agent factory 能把 Session 发布纳入更大的回滚事务。

实时存储不是持久化。若没有其他所有者连接写入路径，在生产 Agent 生命周期之外创建的 Session 只存在于内存。应分别回答以下问题：

- Session 是否存在于当前进程？
- 是否有 writer 缓冲其事件？
- 持久化检查点是否完成？
- 进程退出后，冷读取者能否打开它？

<a id="append"></a>
## 追加与发布

`Session.append()` 验证事件、分配 envelope、提交到内存日志、更新已注册投影，再发布提交后的 `session/event` 通知。Append 返回时，投影状态已经更新。通知监听器观察已经提交的事件，因此监听器失败被包含，不会反转历史。

这个顺序让实时 inbox 投影和其他状态读取者同步观察追加。持久化监听发布，并可能缓冲物理写入。需要明确持久点的调用方使用 `ctx.sessions.flush(session)`，它通过存储捕获的 carrier 派发并等待 `session/flush` 监听器。

使用者不应直接派发原始 `session/flush` 事件。存储负责入口和 Session scope carrier。绕过它可能丢失正确路由，并破坏持久化单一所有者模型。

<a id="families"></a>
## 事件家族

事件服务于不同读取者。精确联合类型位于 [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts) 和插件声明合并中。

| 家族 | 示例 | 主要用途 |
|---|---|---|
| 边界 | `turn/start`、`step/end`、`turn/end` | 重建生命周期和停止结果。 |
| 消息 | `system/message`、`user/message`、`assistant/message`、`tool/result` | 产生或更新模型历史。 |
| 尝试 | `assistant/attempt` | 保留失败、重试或空的中断流，不加入历史。 |
| 请求事实 | `request/header`、`request/context` | 重建路由、工具、默认值和模型能力上下文。 |
| 工具事实 | `tool/call`、`tool/result` | 配对所请求外部工作与权威结果。 |
| 功能状态 | `agent/inbox/spliced` 和插件事件 | 重建某个功能拥有的持久状态。 |

Session 事件联合类型可通过声明合并扩展。插件可以增加持久事实，但也必须提供使用者所需的每种解释。新的模型可见事实需要消息投影或产生消息的事件；新的 UI 事实需要可回放展示；冷读取者需要的新状态事实需要投影。

<a id="surface"></a>
## 模型 Surface

模型 Surface 是当前产生消息的有序事件节点集合。[`surface.ts`](../../packages/core/session/src/surface.ts) 折叠追加和替换操作，随后 `deriveMessages()` 返回下一次请求的消息。

四种内置消息事件是 system、user、assistant 和 tool result。空 system 与 assistant 消息可以保留节点或 usage 记录而不产生 wire 消息。生命周期、请求元数据和失败尝试保留在日志中，但不变成模型消息。

替换操作遮蔽模型可见区间，而不删除其源事件。因此，压缩可以用摘要替换未来模型请求中的旧对话，同时保留审计、transcript 渲染和谱系所需事件。

改变现有消息内容的插件需要注册纯消息投影。分离读取者必须获得同样的定义；否则实时进程和冷读取者会从同一日志推导出不同模型历史。

核心规则是：

> 进入模型请求的任何内容，都必须能从已提交 Session 事件和已注册纯投影重建。

该规则排除隐藏进程内存直接进入模型输入。运行时上下文必须先成为已记录的 user 或 system 消息，随后才能构建请求。

<a id="state"></a>
## 状态投影

并非所有功能状态都是模型消息。`dsh-session-projection` 注册类型化投影单元，增量折叠已提交事件。Host 可以通过 `stateOf()` 读取当前类型化状态，并通过 `snapshot()` 生成裁剪后的客户端快照。

Inbox 体现了这种区别。`agent/inbox/spliced` 记录结构化队列变化，inbox 投影重建待处理消息。Claim 与 discard 通知帮助实时使用者响应，但冷读取者使用持久 splice 事件。

需要投影服务的 Host 读取者在服务或 key 缺失时明确失败。静默回退为空值，会让插件缺失和合法空状态无法区分。

<a id="transcript"></a>
## Transcript 与实时流

面向用户的 transcript 和模型 Surface 使用不同的删除语义。从未来模型上下文移除旧内容的替换操作，不能擦除用户已经看到的消息。因此，transcript 读取者从 append-origin 消息事件开始，并应用适合人类对话的展示规则。

助手流式响应有实时与持久两种形式：

```text
adapter chunks
  -> process-local agent/assistant-stream frames
  -> complete assistant/message or assistant/attempt event
```

Web follow 路径使用临时帧进行增量展示。完整紧凑流嵌入其结算事件。结算前进程硬退出可能不留下持久 attempt 流，因此重连逻辑必须以已提交事件为准，而不是依赖此前看到的临时帧。

<a id="fork"></a>
## 分叉与恢复

分叉复制一个结束于开放 turn 之外的稳定 Session 前缀，并在子 Session header 中记录谱系。它复制事实，不重新执行副作用。子 Session 使用种子事件和已注册投影定义推导自己的当前视图。

恢复会话会打开持久事件、从验证后的当前逻辑记录构造 Session、在 Agent 层修复支持的中断 turn 情况，并连接新的实时 Agent。恢复的消息身份保持稳定，让请求冻结证据和投影能够安全复用。

Stat、list、page 和 search 等冷操作不应要求活跃 Agent。它们的所有者直接读取持久化与投影。只有必须改变实时执行的行为，例如 steering 或取消，才使用活跃 Agent。

<a id="invariants"></a>
## 关键规则

阅读或修改 Session 代码时，保持以下规则：

- 序列顺序是规范顺序；异步观察者不能重排已提交历史。
- 事件在持久边界必须是 lossless JSON。
- 模型可见内容来自已记录事实。
- 替换改变派生历史；已提交代际文件和源事件不被覆盖。
- 投影定义是纯函数，并且所有解释日志的位置都必须获得它们。
- 状态需要跨重载保存时，实时通知不能替代持久事件。
- Append 完成说明内存提交和投影更新完成，不一定说明磁盘持久化完成。

<a id="exercises"></a>
## 练习

1. 从 `Session.append()` 开始，按顺序列出验证、envelope 分配、日志修改、投影更新和事件发布。
2. 对一次成功工具调用，找出进入日志的每个事件，以及其中哪些变成模型消息。
3. 对比 `assistant/message` 与 `assistant/attempt`，解释它们分别如何影响 transcript、模型历史和诊断。
4. 找到 inbox 投影定义，并手工回放三个 splice 事件。
5. 选择一个压缩 fixture，找出源事件、替换事件、结果 Surface 和人类 transcript 来源。

当你能从一个事件前缀推导下一次模型消息列表和当前持久功能状态，并且不查阅实时对象时，本章学习完成。

<a id="further"></a>
## 进一步阅读

继续学习 [Agent 循环](04-agent-loop.zh.md)，它是 Session 生命周期和消息事件的主要生产者。公开类型见 [Session 子系统](../subsystems/session.zh.md)，存储约定见[持久化](../subsystems/persistence.zh.md)。

<a id="dev-note"></a>
## 开发备注

无。
