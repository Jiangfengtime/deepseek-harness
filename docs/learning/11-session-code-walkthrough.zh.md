# Session 源码实现

[English](11-session-code-walkthrough.md) | 中文

## 概要

本章把 `Session` 实现理解为追加事务与增量投影的组合，说明事件如何成为不可变历史、`SurfaceManager` 如何确定模型可见顺序、`deriveMessages()` 如何缓存工作，以及持久化在生命周期的哪个位置接入。

## 目录

- [源码地图](#source-map)
- [核心状态](#state)
- [构造与恢复](#construction)
- [Append 事务](#append)
- [Surface 规划](#surface)
- [消息推导](#messages)
- [持久化接入](#persistence)
- [完整事件示例](#worked-sequence)
- [调试与练习](#debugging)

-----

<a id="source-map"></a>
## 源码地图

| 职责 | 实现位置 |
|---|---|
| Session 事件类型、类与存储 | [`packages/core/session/src/index.ts`](../../packages/core/session/src/index.ts) |
| Surface 校验与折叠 | [`packages/core/session/src/surface.ts`](../../packages/core/session/src/surface.ts) |
| 请求头投影 | [`packages/core/session/src/request-header.ts`](../../packages/core/session/src/request-header.ts) |
| Agent 创建与持久化交接 | [`packages/core/agent-loop/src/index.ts`](../../packages/core/agent-loop/src/index.ts) |
| 持久化提供者 | [`packages/session/`](../../packages/session/) |

原始日志回答“记录了什么”；`Session.surface.nodes` 回答“哪些事件序号当前构成模型历史”；`deriveMessages()` 再把这些节点转换为与提供者无关的 `Message` 对象。

<a id="state"></a>
## 核心状态

`Session.log` 是私有追加式数组。`seq` 永远等于 `log.length`，所以下一个事件位置也就是预期序号。`header` 在事件日志之外保存持久创建元数据。`inheritedEventCount` 标记 fork 继承前缀，`firstLiveSeq` 标记本进程中的构造种子边界；恢复之后，这两个偏移回答不同问题。

`surfaceManager` 是 surface 接纳和投影状态唯一的增量维护者。Session 不会同时维护第二份模型消息列表；消息缓存只保存推导结果，并通过 surface generation 计数器失效。

另外三个 fold 避免每个 step 都扫描完整日志：`requestHeader()` 推进 `headerFoldSeq`，`requestContext()` 推进 `contextFoldSeq`，`deriveMessages()` 推进 `derivedNodes`。除非内容变更操作要求重建，否则它们只读取未处理事件。

<a id="construction"></a>
## 构造与恢复

`Session.create()` 使用 snapshot 模式。它校验并深拷贝借入的种子事件，防止调用方后续修改历史。`Session.fromRestore()` 接收存储层独立拥有或已经冻结的事件，避免再次复制，但仍会校验事件 envelope、序号连续性和 surface 转换。

构造器逐个处理种子事件。对每个事件先执行无损 JSON 校验，再检查 `event.seq === index`，随后调用 `surfaceManager.validateNext()` 规划转换，最后才压入数组。失败事件不会造成 surface 领先日志或日志领先 surface。

种子接纳结束后，构造器固定 `firstLiveSeq`，校验 header 与继承元数据，并在需要时记录 `session/end-seed`。新 fork 在继承切点正好拥有一个标记；恢复 Session 保留已存标记，仅当加载历史末尾没有标记时才追加。

<a id="append"></a>
## Append 事务

`append(type, data, opts)` 是中心提交边界，执行顺序如下：

1. 通过 `snapshotJsonValue()` 复制 `data` 和 surface 元数据。
2. 使用 `seq = log.length` 与 `time = Date.now()` 构造候选事件。
3. 深度冻结候选事件，并校验事件专属规则。
4. 调用 `surfaceManager.validateNext(candidate)`，但不修改已提交 surface 状态。
5. 收集当前 `session/event` 观察者。
6. 把事件压入 `log`，清除完整日志快照缓存。
7. 通知观察者，并隔离每个观察者的失败。

步骤 1–4 是拒绝区间：错误发生时日志保持不变。步骤 6 是提交点。压入数组后的观察者失败不能回滚已接纳历史，因此持久化监听器和 UI 监听器看到的是同一个稳定事件对象。

`appending` 标志禁止在当前 append 的观察者执行期间重入追加。否则某个观察者可能在后续观察者收到原事件前插入新事件，破坏共同的顺序假设。

产生 Surface 的事件类型必须提供 `surfaceOp`。`sourceEventSeqs` 记录工具结果和替换等转换使用的早期事件序号。`turn/start`、`step/end`、`assistant/attempt` 等仅日志事件不能悄悄进入模型历史。

<a id="surface"></a>
## Surface 规划

`planSurfaceEvent()` 校验下一序号并返回三种计划之一。`append` 计划把候选序号加到末尾；`replace` 计划识别连续 surface 区间，校验来源引用和特殊重写规则，再用新序号替换该区间；`project` 计划应用插件拥有的消息投影，不改变节点成员。

`SurfaceManager.validateNext()` 把候选事件和已准备计划保存在 `_pendingPlan`。`Session.append()` 压入完全相同的候选对象后，下一次 `_processDelta()` 会识别它，直接调用 `applySurfacePlan()`，无需重复可能带状态的投影工作。若事件来自其他来源，`_processDelta()` 会按正常路径重新校验。

`replaceGeneration` 只在位置替换时变化。`contentGeneration` 在替换和消息投影时都会变化，因为两者都可能改变先前推导的模型内容。`deriveMessages()` 使用覆盖面更广的 `contentGeneration` 判断缓存失效。

替换有两个重要限制。位置零的节点只能由一个 `system/message` 精确替换该节点；工具结果重写必须保持与所代表工具调用的有效关联。这些校验阻止通用压缩机制生成结构无效的模型历史。

<a id="messages"></a>
## 消息推导

`deriveMessages()` 读取 `surface.nodes`，比较 `surface.contentGeneration` 与 `derivedGeneration`，仅在旧内容可能变化时重置缓存；随后只推导 `derivedNodes` 之后的节点。每次调用返回新数组，其中的消息对象则被共享并深度冻结。

`SurfaceManager.deriveEventMessage()` 使用纯事件到消息映射及已提交插件投影。Surface 节点仍可能推导为 `null`，主要例子是仅携带 usage 的空助手消息。因此 Surface 节点数与输出数组长度相关，但不必相等。

该缓存设计使纯追加流量只需 O(新节点数) 工作。压缩替换或投影会重建缓存，因为先前消息可能已经变化。调用方无法通过返回消息修改持久日志。

<a id="persistence"></a>
## 持久化接入

持久化由生命周期代码接入，而不是 `Session.append()` 自己处理。创建 Agent 时，`createStoredSession()` 向已配置后端申请写句柄。发布前的 setup 可能追加事件，因此 `appendUnstoredSuffix()` 会先显式写入构造和 setup 后缀，再由 `prepared.publish()` 暴露活动 Session。

发布后，存储层拥有的 `session/event` 监听器把已接纳事件路由到活动句柄。`append()` 保持同步，不等待磁盘 I/O；写句柄负责缓冲，`close()` 或 flush 边界负责建立持久性。

销毁时先取消并排空 Agent，再关闭持久化句柄，最后从 Agent 和 Session 注册表分离。该顺序保证循环的最终事件仍能到达尚未释放的写入路径。

<a id="worked-sequence"></a>
## 完整事件示例

考虑一次读取文件的请求。简化日志可以包含：

```text
0 system/message   surface append
1 turn/start       log only
2 step/start       log only
3 user/message     surface append
4 request/header   log only
5 assistant/message surface append; contains tool-call
6 tool/call        log only
7 tool/result      surface append; sourceEventSeqs=[6]
8 step/end         log only
9 step/start       log only
10 assistant/message surface append; final answer
11 step/end        log only
12 turn/end        log only
```

原始日志有十三个事件，模型 Surface 包含事件 0、3、5、7 和 10。工具结果之后的下一次请求看到节点 0、3、5 和 7；生命周期标记保留用于诊断，但不会成为对话消息。

<a id="debugging"></a>
## 调试与练习

在 Session 构造器、`append()`、`planSurfaceEvent()`、`applySurfacePlan()`、`_processDelta()` 和 `deriveMessages()` 设置断点。观察一次追加和一次替换前后的 `log.length`、`_pendingPlan`、`nodes`、`contentGeneration` 与 `derivedNodes`。

练习一：解释为什么校验必须早于 `log.push()`，而观察者派发必须晚于它。练习二：在纸上构造一次 Surface 替换，并说明哪些缓存重置。练习三：对于存储日志已经包含子 Session 自有事件的已恢复 fork，比较 `firstLiveSeq` 与 `inheritedEventCount`。
