# 4. Agent 循环生命周期

[English](04-agent-loop.md) | 中文

## 概要

本章从创建开始，沿 inbox 接纳、turn、step、模型 attempt、工具继续执行、取消和有序销毁，跟踪默认 Agent 实现。重点是让实时执行与 Session 日志保持一致的状态转换和提交点。

## 目录

- [公开接口与实现](#interface)
- [创建事务](#creation)
- [Inbox 与唤醒](#inbox)
- [Turn 状态机](#turn)
- [Step 与 Attempt](#step)
- [工具继续执行](#tools)
- [取消与失败](#cancellation)
- [销毁](#teardown)
- [追踪清单](#trace)
- [练习](#exercises)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="interface"></a>
## 公开接口与实现

`dsh-agent` 定义 Agent 约定、实时注册表、handle、事件和输入术语。`dsh-agent-loop` 提供默认实现。使用者调用 `ctx.agents`，不会把 `ReactLoopAgent` 作为产品依赖直接导入。

具体驱动维护一个小型 phase 状态机：

```text
idle -> running -> idle
  \-> maintenance -> idle
```

`running` 拥有一个 AbortController，以及当前 turn 和 step 编号。`maintenance` 为独占的非 turn 工作保留 Agent。`activityDone` 是不断更新的静止 Promise；`whenIdle()` 会重新检查它，避免第一个活动结算前发生的唤醒启动新活动，却返回错误的空闲结果。

打开 [`packages/core/agent-loop/src/agent.ts`](../../packages/core/agent-loop/src/agent.ts)，同时参考 [`README.md`](../../packages/core/agent-loop/README.zh.md)。README 负责公开行为，源码展示这些行为如何排序。

<a id="creation"></a>
## 创建事务

[`agent-loop/src/index.ts`](../../packages/core/agent-loop/src/index.ts) 实现 Agent factory。创建过程是一个受回滚保护的事务：

1. 解析身份，创建或打开持久化写句柄。
2. 构造未发布 Session。
3. 构造具体 Agent 和 scope。
4. 运行调用方 setup，安装 scoped 贡献。
5. 加入 Session 和 Agent 注册表。
6. 公告 `session/created`。
7. 等待串行 `agent/created` 初始化。
8. 把排队输入释放给驱动。

监听器不应观察到半发布 Agent。Setup 或初始化失败会撤销已加入资源。输入会等待初始化完成，因此监听器可以在首次请求前安装工具、限制或提示词上下文。

恢复会话先取得独占写入所有权，读取并验证持久历史，追加支持的中断 turn 结束事件，再进入相同发布事务。同一 Session 的并发恢复无法取得同一个写入所有权。

<a id="inbox"></a>
## Inbox 与唤醒

Agent 暴露三种输入意图：

| 方法 | 队列目标 | 是否唤醒空闲工作？ | 用途 |
|---|---|---|---|
| `followup()` | 下一 turn | 是 | 后续用户请求 |
| `steer()` | 下一 step | 是 | Turn 中途纠正或引导 |
| `inject()` | 下一 step | 否 | 等待其他输入唤醒循环后消费的上下文 |

[`inbox.ts`](../../packages/core/agent-loop/src/inbox.ts) 把变更记录为规范化 `agent/inbox/spliced` 事件，并使用共享投影作为待处理状态来源。Message id 在两个队列中保持唯一。

`wakeDriver()` 只从 idle 启动一个驱动。实时 running 阶段发生的唤醒通常不需要第二个驱动，因为当前循环会领取待处理工作。Maintenance 期间或已中止活动后的唤醒被锁存，在收敛时重放。销毁不会锁存下一轮。

<a id="turn"></a>
## Turn 状态机

只要仍有待处理工作，`kick()` 就重复调用 `turn()`。Turn 先记录 `turn/start`，再领取首次输入。后续 step 只领取 next-step 输入。

`preStep()` 执行能够影响接纳的工作：

```text
claim inbox input
  -> assemble prompt and tool schemas
  -> project runtime context
  -> agent/pre-step waterfall
  -> reject or enter(messages, startsRequestSeries?)
```

Reject 决定让 turn 以 blocked 结束。首次接纳为空时，记录一个没有 step 的已完成 turn。后续接纳为空时，已经完成的 step 可以正常结束。

对于已接纳批次，循环记录 `step/start`、运行 `step()`，并在 `finally` 中记录 `step/end`。Step 产生终止原因且没有 next-step 输入时，串行 `agent/turn-stopping` 监听器有一次补充工作的机会。循环为每种退出记录 `turn/end`，包括取消和错误。

<a id="step"></a>
## Step 与 Attempt

一次 step 可以包含多次模型 attempt，因为请求错误可能重试。提示词和工具组装、运行时上下文投影、`agent/pre-step` 在该 step 中只运行一次。每次 attempt 执行以下操作：

1. `agent/request` 提议路由和显式选项。
2. `llm.prepareCall()` 解析适配器拥有的默认值和能力。
3. 循环针对该路由协调渲染后的系统提示词。
4. 首次 attempt 记录已接纳用户；重试不再记录。
5. 循环按需记录变化后的请求 header 或 context。
6. `deriveMessages()` 从日志重建历史。
7. 循环冻结请求，同时保留可用的中止信号。
8. Prepared call 把流式块送入 `AssistantStreamAttempt`。

路由准备发生在待处理提示词和用户消息提交之前。在两个异步准备阶段取消，都不会提交这些内容。接纳后，请求构建同步执行，使记录前缀和冻结请求保持一致。

成功流结算为一个 `assistant/message`，包含紧凑流与组装内容。失败或重试流结算为 `assistant/attempt`；它保留诊断信息但不加入普通模型历史。取消时已经交付内容的流结算为中断助手消息，使未来历史包含用户看到的内容。

<a id="tools"></a>
## 工具继续执行

助手消息成功后，循环选择其中的 tool-call 块。没有调用时 step 完成；存在调用时，[`tool-calls.ts`](../../packages/core/agent-loop/src/tool-calls.ts) 调度它们并记录结果。

工具结果先进入 Session，下一 step 随后推导历史。`additionalContexts` 在其所属结果提交后进入 next-step inbox。结果可以标记 `concludesTurn`，使当前工作在有序结果 finalization 后停止；否则 step 不返回终止原因，turn 继续。

执行可以重叠，但结果事件按模型调用顺序提交。独占调用形成屏障，并行安全组使用有界滚动池。执行章节会详细解释调度器。

<a id="cancellation"></a>
## 取消与失败

`cancel()` 可以先清空待处理 inbox 工作，再中止当前 controller。取消是协作式的：模型适配器、工具执行和进程使用者收到信号，并在各自支持的位置响应。

失败分类决定恢复方式：

- 适配器选择、派发和流式失败成为请求失败，可以进入 `agent/request-error` 重试策略。
- 已处理请求错误在同一 step 内重试。
- 工具、中间件、结果处理和其他插件失败使 turn 以错误结束。
- 取消使 turn 以 aborted 原因结束。
- 持久 turn 位置之外的失败发出实时 `agent/error`，并在驱动边界被包含。

取消留下未派发的模型工具调用时，调度器为跳过的调用记录合成 call/result 对。已启动调用会在组结束前收敛。这样既保持回放结构有效，也不会假装未启动的工具函数执行过。

<a id="teardown"></a>
## 销毁

AgentHandle 负责销毁。其记忆化 disposal 执行有序收敛：

```text
request driver stop
  -> await driver quiescence
  -> unwind agent scope
  -> close and drain persistence writer
  -> detach Agent
  -> detach Session
```

精确顺序避免在发布或持久化监听器消失后继续发出最终事件。Detach disposer 绑定确切对象，因此旧 handle 不能移除后来使用同一 id 的替换对象。

<a id="trace"></a>
## 追踪清单

诊断一个 turn 时，按顺序收集以下事实：

1. 哪个 inbox 事件插入输入，哪个方法唤醒 Agent？
2. 哪个 scope 组装提示词 section 和工具 schema？
3. `agent/pre-step` 接纳了什么？
4. `agent/request` 和 `prepareCall()` 解析了哪条路由？
5. 继承或记录了哪个 header 与 context？
6. 哪个事件前缀产生 `deriveMessages()`？
7. 助手流如何结算？
8. 哪些工具调用和结果已提交？
9. 下一 step 为什么开始，或 turn 为什么停止？
10. 最终记录了什么 `turn/end` 原因？

<a id="exercises"></a>
## 练习

1. 分别为 idle 时 follow-up、running 时 steer、maintenance 时 follow-up 绘制 phase 转换。
2. 跟踪一个首个 chunk 前失败并成功重试的请求，找出哪些工作只运行一次，哪些重复运行。
3. 跟踪已经显示三个文本 chunk、但流完成前发生的取消，找出实时帧与持久结算。
4. 定位创建回滚路径，列出失败发生时哪些公告可能已经被观察到。
5. 解释销毁为什么不能在驱动停止前移除 Session。

当你能把一个 turn 中的每个 Session 事件解释为对应循环转换时，本章学习完成。

<a id="further"></a>
## 进一步阅读

继续学习 [Prompt 与 LLM](05-prompt-and-llm.zh.md)，理解请求内容和适配器行为，再阅读[工具与执行](06-tools-and-execution.zh.md)，理解助手消息产生的调用。[Agent 生命周期图](../agent-lifecycle.zh.md)提供跨包时序视图。

<a id="dev-note"></a>
## 开发备注

无。
