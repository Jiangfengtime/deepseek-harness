# 工具运行时与调度器源码实现

[English](13-tool-runtime-code-walkthrough.md) | 中文

## 概要

本章沿一个模型工具调用，依次跟踪注册表查找、策略、并发调度、函数体派发、结果终结和 Session 记录，并解释为什么执行可以重叠，而持久结果仍保持模型顺序。

## 目录

- [源码地图](#source-map)
- [定义与查找](#registry)
- [规划调用](#planning)
- [并行池与独占屏障](#scheduler)
- [分阶段运行管线](#pipeline)
- [取消行为](#cancellation)
- [持久结果](#durable)
- [调度示例](#worked-schedule)
- [调试与练习](#debugging)

-----

<a id="source-map"></a>
## 源码地图

| 职责 | 实现位置 |
|---|---|
| 注册表、策略、派发与结果终结 | [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts) |
| 模型调用调度器与 Session 事件 | [`packages/core/agent-loop/src/tool-calls.ts`](../../packages/core/agent-loop/src/tool-calls.ts) |
| 精确阶段顺序参考 | [工具执行管线](../tool-execution-pipeline.zh.md) |
| 具体文件读取工具 | [`packages/fs/tool-fs/src/read.ts`](../../packages/fs/tool-fs/src/read.ts) |

这里有两个协作层。`ToolRuntime` 决定单个调用是否以及如何执行；`executeToolCalls()` 协调一条助手消息发出的调用列表，并按模型顺序提交结果。

<a id="registry"></a>
## 定义与查找

`register()` 安装 `ToolDefinition`，并通过 Cordis effect 生命周期返回 disposer。定义包含面向模型的 schema、执行函数、可选并发分类、可选展示元数据和可选最终内容转换。

`view(scope)` 计算某个 Agent scope 可见的注册表。Scoped 定义遮蔽全局定义，restriction 可以移除全局工具。`get(name, scope)` 读取该视图。`schemas(scope)` 只投影名称、描述和分离后的参数，因此执行回调永远不会进入模型请求。

`resolveExecution()` 应用额外执行规则。在 PTC 展示模式下，模型直接调用只能指定 `run_code`；来自 PTC bridge 的嵌套调用可以解析普通可见工具。因此展示查找和执行查找彼此相关，但有意保持区别。

`executionMode(exec)` 采用失败关闭策略。只有定义的 `isConcurrencySafe(arguments)` 精确返回 `true` 才是 parallel；分类器缺失、工具隐藏、输入无效、定义不存在或分类器抛错都得到 exclusive。

<a id="planning"></a>
## 规划调用

`executeToolCalls()` 先把每个 `ToolCallBlock` 映射为 `PlannedCall`。`parseArguments()` 解析有效 JSON，把空字符串映射为 `{}`，并把无效 JSON 保留成原始文本，使注册表能够产生结构化无效参数结果，而不是让调度器提前抛错。

外层循环分类下一个未消费调用。若首个调用为 parallel，则把剩余后缀交给 `runGroup()`；若为 exclusive，只交给它自身。每组提交后都重新分类，因为已完成工具可能改变后续调用的注册表可见性或策略。

每个计划执行都携带 call id、名称、解析参数、发起 Agent 和 turn 取消信号。工具 wrapper 后续可以替换 `exec.signal`，所以调度器在 ToolRuntime 内独立保留调用方信号。

<a id="scheduler"></a>
## 并行池与独占屏障

`runGroup()` 维护四个游标：`nextToStart`、`started`、`committed` 和 `inFlight` Map。`slots` 数组按原始模型位置保存已完成结果；`callSeqs` 保存持久 `tool/call` 序号，用于结果来源关联。

`fillPool()` 持续启动工作，直到达到 `maxParallelToolCalls`、观察到取消、到达末尾，或发现后续调用重新分类为 exclusive。每个函数体启动前，`startCall()` 先追加 `tool/call`，执行有序 preparation，再派发函数体或保存已经最终确定的结果。

只有 dispatch Promise 可以重叠；pre-execute 工作和最终提交保持有序。这可以避免审批提示、guard、结果事件和附加上下文出现依赖完成时间的重排。

`Promise.race(inFlight.values())` 等待任意函数体完成。完成结果填入对应索引的 slot，但 `commitReady()` 只有在 `slots[committed]` 存在时才推进。若调用 1 先于调用 0 完成，它的结果会在 slot 1 等待 slot 0 提交。

Exclusive 调用形成屏障，因为外层循环只会在当前并行池排空并提交后，才单独分类该调用。下一并行组也必须等独占调用完全终结后才能开始。

<a id="pipeline"></a>
## 分阶段运行管线

ToolRuntime 为调度器暴露 `prepare`、`dispatch`、`finalize` 和 `finish` 操作；公共 `execute()` 便利方法使用相同阶段。

`createExecution()` 分配关联 token、根 call id、延迟上下文缓冲和取消状态，以无损 JSON 快照参数，并在调用开始时捕获工具的 `finalizeContent` 回调。PTC collapse 拒绝会在可扩展策略监听器运行前直接返回最终结果。

`prepareExecution()` 执行 `tools/pre-execute`，通过 Approval 服务解析 `ask`，应用单调 guard，再次检查调用方取消。返回值是封闭联合：`dispatch`、`post-result` 或 `final-result`。策略拒绝仍需 post-processing；setup 失败已经是最终结果。

`dispatchScheduledExecution()` 执行 `tools/execute` around-waterfall。终端回调 `dispatchToolBody()` 解析当前定义，融合调用方和 wrapper 信号，标记 `bodyInvoked`，调用 `tool.execute(arguments, exec)`，并把抛出值转换为错误结果。已启动函数体总会被等待至静止。

Dispatch 阶段还会附加通过 `exec.deferContext()` 收集的上下文。若成功函数体之后到达调用方取消，候选结果会在 post-processing 前转换为相应 aborted 结果。

`finalizeScheduledExecution()` 等待 `tools/post-execute` 并应用 post 阶段取消。`finishScheduledExecution()` 物化无损冻结结果，应用定义自有内容 finalizer，再次物化，并调用 `notifyResult()`。观察者失败会被记录，不能修改或拒绝权威结果。

<a id="cancellation"></a>
## 取消行为

函数体调用前取消产生 `ABORTED_BEFORE_DISPATCH`；调用后取消产生 `ABORTED`，但运行时仍会等待函数体。该规则防止已经取消的进程或文件操作脱离生命周期归属继续运行。

调度器观察到 abort 后停止启动新调用，排空所有已启动 dispatch，并按顺序提交结果。随后为派发前跳过的调用追加合成 call/result 对。因此即使取消，助手的完整调用列表也有对应结果序列。

调度器基础设施失败与工具错误不同。调度器会排空已启动 Promise，但不会虚构恢复结果，然后把错误抛给 Agent 循环。普通工具和策略失败会物化为 `ToolExecutionResult`，继续作为模型可见历史。

<a id="durable"></a>
## 持久结果

`appendToolCall()` 记录名称、模型原始参数、turn、step 和 call id。运行时执行解析并快照后的参数，但事件保留模型实际请求的原始内容。

`appendToolResult()` 创建与 provider 无关的工具结果消息，并用 `surfaceOp: 'append'` 和 `sourceEventSeqs: [callSeq]` 追加 `tool/result`。可选私有 `meta` 会持久化展示数据，使回放 UI 无需活动工具实例也能重建结果卡片。

`additionalContexts` 不进入当前结果消息。调度器把它们传给 Agent 回调，由回调插入 `next-step`；下一 step 在正常接纳边界把它们记录为用户消息。

`concludesTurn` 在已提交结果之间累积。它只在结果持久化后影响控制流，所以不能让较早调用从历史中消失。

<a id="worked-schedule"></a>
## 调度示例

假设模型依次发出 `read(A)`、`read(B)`、`edit(C)` 和 `read(D)`。两个 read 分类为 parallel，edit 分类为 exclusive。

```text
start read(A) ----- finishes second ---- commit result A
start read(B) -- finishes first -- wait - commit result B
                                            |
                                            v
                                      start edit(C)
                                      commit edit(C)
                                            |
                                            v
                                      start read(D)
```

前两个函数体重叠执行。因为提交游标从零开始，结果 B 等待结果 A。Edit 只有在两项结果都提交后才开始，read D 又要等 edit 完成终结。因此无论完成时间如何，Session 历史都与助手调用顺序一致。

<a id="debugging"></a>
## 调试与练习

在 `executionMode()`、`runGroup()`、`fillPool()`、`startCall()`、`commitReady()`、`prepareExecution()`、`dispatchToolBody()` 和 `finishScheduledExecution()` 设置断点。观察游标值、slot 占用、execution token、`bodyInvoked` 及 call/result 事件序号。

练习一：在纸上让调用 1 早于调用 0 完成，并指出它在哪里等待。练习二：分别在审批期间、函数体调用前和函数体调用后注入取消，再写出各自结果码。练习三：解释为什么每个已提交 group 之后都要重新进行注册表分类。
