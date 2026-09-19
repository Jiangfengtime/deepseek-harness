# Agent 循环源码实现

[English](12-agent-loop-code-walkthrough.md) | 中文

## 概要

本章从 inbox 唤醒开始，沿 `ReactLoopAgent` 跟到一次 turn 完成，识别驱动状态机、事件提交顺序、请求重试边界、流结算规则，以及创建和销毁 Agent 的生命周期事务。

## 目录

- [源码地图](#source-map)
- [驱动状态](#driver)
- [从输入到 Turn](#input)
- [准备 Step](#pre-step)
- [构造请求](#request)
- [流式响应与重试](#streaming)
- [工具续跑与 Turn 完成](#completion)
- [创建与销毁](#lifecycle)
- [调试与练习](#debugging)

-----

<a id="source-map"></a>
## 源码地图

| 职责 | 实现位置 |
|---|---|
| 驱动、turn、step 与请求构造 | [`packages/core/agent-loop/src/agent.ts`](../../packages/core/agent-loop/src/agent.ts) |
| 工厂、发布、恢复与销毁 | [`packages/core/agent-loop/src/index.ts`](../../packages/core/agent-loop/src/index.ts) |
| Inbox 投影与修改 | [`packages/core/agent-loop/src/inbox.ts`](../../packages/core/agent-loop/src/inbox.ts) |
| 工具调用调度器 | [`packages/core/agent-loop/src/tool-calls.ts`](../../packages/core/agent-loop/src/tool-calls.ts) |
| 助手流累加器 | [`packages/core/agent-loop/src/assistant-stream.ts`](../../packages/core/agent-loop/src/assistant-stream.ts) |

驱动只有一个活动拥有者。公共方法负责排队或请求取消；`kick()` 和 `turn()` 串行修改运行阶段。

<a id="driver"></a>
## 驱动状态

`ReactLoopAgent.phase` 可以是 idle、running 或 maintenance。Running 状态携带当前 turn、step、`AbortController` 和 `wakeRequested` 锁存标志。`setPhase()` 发布状态变化，phase 对象本身承担内部同步状态。

`followup()`、`steer()` 和 `inject()` 的 inbox 目标与投递语义不同，随后都汇合到 inbox 修改和 `wakeDriver()`。`cancel()` 中止当前控制器，并可根据选项清除待处理 inbox 项。生命周期代码通过 `whenIdle()` 等待驱动静止。

已有循环运行时，`wakeDriver()` 不会启动第二个循环，而是设置唤醒锁存，使活动驱动在边界重新检查工作。从 idle 启动时，它会在调用 `kick()` 前先占用 running phase，防止两个调用方同时看到 idle 并成为驱动。

`kick()` 重复调用 `turn()`。它的 `finally` 把机器恢复为 idle；若最后一个边界有新工作到达，则立即再次唤醒。错误由 `throwError()` 报告，并在驱动边界被收容，避免失败 turn 成为未处理后台 rejection。

<a id="input"></a>
## 从输入到 Turn

`turn()` 先递增上一 turn 编号并追加 `turn/start`。只有该持久事件成功后才更新 `phase.turn`。局部 `turnEnds` 累积最终原因，且 `max-tokens` 具有粘性，后续 step 不能把它降级。

第一次循环以 `next-turn` 为目标，后续循环以 `next-step` 为目标。`preStep()` 领取相应 inbox 项，组装系统提示词，投影运行时上下文，再执行 `agent/pre-step` waterfall。监听器可以在记录任何 `step/start` 前拒绝 step 或替换已接纳消息。

初始空 decision 会在不调用模型的情况下完成 turn。否则 `turn()` 追加 `step/start`，更新 `phase.step`，调用 `step()`，并在 `finally` 中追加 `step/end`。因此凡是已经开始的 step，即使请求准备、流式响应或工具执行抛错，也有结束标记。

准备停止已完成 step 前，`agent/turn-stopping` 获得一次可等待的加工作机会。若 `next-step` 仍为空，turn 才退出。最外层 `finally` 总会追加 `turn/end`，原因可以是 completed、max-tokens、blocked、aborted 或结构化 error。

<a id="pre-step"></a>
## 准备 Step

提示词组装发生在输入接纳之前。`systemPrompt.assemble()` 收集贡献；`renderContextSections()` 和 `runtimeContext.project()` 可以产生额外用户上下文消息。Pre-step waterfall 接收已领取消息和取消信号。

领取与接纳不是同一步。Inbox 项在领取时离开待处理投影，但只有请求准备成功后，`step()` 才追加 `user/message` 事件。该顺序避免无法路由的请求把用户输入记录成已经被模型尝试接纳。

`PreparedStep` 还携带提示词 assembly，使 schema 与提示词贡献在本 step 中只计算一次。重试复用这次已接纳 step，不会再次领取 inbox 消息。

<a id="request"></a>
## 构造请求

`prepareRequest()` 从显式 `AgentOptions` 和折叠后的 request header 开始。只有保存的 reasoning effort 属于完全相同的 provider 与 model，且不是 adapter 默认值时才会沿用。`agent/request` waterfall 可在 adapter 解析前替换候选路由。

`llm.prepareCall()` 解析 adapter 默认值、上下文元数据、重试策略和绑定后的 stream 函数。`NO_ADAPTER` 错误会延后，因为中间件仍可能提供请求；其他准备错误立即失败。在此之前 provider 和 model 必须都非空。

回到 `step()` 后，`systemPrompt.project()` 决定需要提交哪些 system-message 事件。它会考虑 adapter 是否支持 history 内更新、是否开始新请求系列、Session Surface 是否变化，以及工具 schema 是否变化。

只有第一次 attempt 会追加 step 接纳的所有 `user/message`；重试跳过此处。随后 `buildRequest()` 针对 initial、resume、change 或新 series 追加 `request/header`，并在解析后的路由元数据改变时追加 `request/context`。

最后，`buildRequest()` 调用 `session.deriveMessages()`，冻结边界数组和此前未见的消息对象，返回带标记的不可变请求，其中包含路由字段、消息、可见工具、Session id 和取消信号。因此模型收到的恰好是该提交边界上已记录的 Session Surface。

<a id="streaming"></a>
## 流式响应与重试

每次 attempt 创建一个 `AssistantStreamAttempt`，使用唯一 attempt 编号和 revision 生成器。只有拿到 provider 迭代器并再次检查取消后才启动流。每个输入 chunk 更新累加器，并为实时界面发出临时 `agent/assistant-stream` 帧。

流开始后失败时，attempt 必须持久结算。取消且已有可见内容时记录中断的 `assistant/message`；取消但没有内容时记录 `assistant/attempt`；非取消流失败也记录 `assistant/attempt`。这些 attempt 事件保存诊断信息，但不进入模型 Surface。

Provider 返回 error 或 aborted finish 时，由 `agent/request-error` 决定是否重试。重试会继续内部 `while` 循环。系统提示词和 request header 可以重新考虑，但 `firstAttempt` 已为 false，因此不会再次追加用户消息。

成功结束会创建并追加一个 `assistant/message`，其中包含内容、provider/model 来源、可选 replay state、usage 和精确 stream。该 append 同时结算实时 attempt 并进入模型 Surface。Max-token finish 返回具有粘性的 max-token step 结果。

<a id="completion"></a>
## 工具续跑与 Turn 完成

若助手消息没有工具调用，`step()` 返回 completed；否则把工具调用块交给 `executeToolCalls()`。工具结果按模型顺序追加，所有 `additionalContexts` 通过 Agent 提供的回调插入 `next-step`。

若工具标记 `concludesTurn`，step 返回 completed；否则返回 `null`：当前 turn 继续，领取 `next-step` 上下文，再启动一个模型 step。工具输出通过已记录的 `tool/result` 消息进入下一次请求，不经过仅存在于内存的旁路。

取消通过 running phase 信号传播到提示词组装、请求准备、provider 流和工具派发。Turn 捕获已中止信号，记录 aborted 结束原因，再重新抛出，由驱动边界执行共同清理。

<a id="lifecycle"></a>
## 创建与销毁

`AgentLoop.prepare()` 在 owner Context effect 内构造机器，融合 caller、owner 和 factory 三方取消，并创建一个记忆化、逆序执行的 `dispose()` 事务。此时尚未发布到注册表。

`setupAndPublish()` 在 `runMaintenance()` 内执行调用方 setup，提交 setup 自有状态，把尚未发布的 Session 后缀刷入持久化，再调用 `prepared.publish()`。发布流程依次进入 Session 注册表、进入 Agent 注册表、宣布 Session，最后等待 Agent 宣布完成。失败会触发同一个记忆化回滚。

销毁流程中止 setup 或活动工作，等待正在进行的发布，取消机器，等待 idle，销毁 Agent scope，关闭持久化句柄，从两个注册表分离，最后释放归属记录。该顺序让最终 Session 事件在驱动静止前始终拥有可写路径。

Resume 在获得存储写所有权并重建 Session 后，复用同一准备和发布路径。共享最终事务可以防止 create 与 resume 形成不同清理规则。

<a id="debugging"></a>
## 调试与练习

在 `wakeDriver()`、`kick()`、`turn()`、`preStep()`、`step()`、`prepareRequest()` 和 `buildRequest()` 设置断点。观察 `phase`、两个 inbox 队列、`firstAttempt`、折叠 request header、surface generation 和发出的 Session 事件。

练习一：追踪 provider 失败后重试，列出哪些事件只出现一次、哪些每次 attempt 都出现。练习二：在三个可见 chunk 后取消，并与首个 chunk 前取消比较持久事件。练习三：解释为什么 `step/end` 属于 `finally`，而 `turn/end` 需要携带计算后的原因。
