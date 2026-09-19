# 5. Prompt 组装与 LLM 派发

[English](05-prompt-and-llm.md) | 中文

## 概要

本章解释插件如何贡献指令和工具 schema、AgentLoop 如何解析模型路由、LLM 注册表如何绑定适配器，以及流式响应如何形成一个持久结算。你将了解哪些事实属于请求 header、Session 消息和实时流。

## 目录

- [Prompt 组装](#prompt)
- [工具 Schema 与 Scope](#schemas)
- [路由准备](#route)
- [系统消息协调](#system)
- [请求重建](#request)
- [流式响应与组装](#streaming)
- [错误与重试](#retry)
- [缓存与 Token 分析](#cache)
- [练习](#exercises)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="prompt"></a>
## Prompt 组装

[`dsh-system-prompt`](../../packages/core/system-prompt/README.zh.md) 为每个 step 收集有序 section、变量、运行时上下文 section 和工具 schema 提供者。贡献可以是静态文本，也可以是依赖当前组装上下文的函数。

Section 顺序由数值决定，相同顺序再按名称排序。仓库拥有的贡献者使用集中分配的位置。Agent scoped 贡献遮蔽祖先中的同名条目。`complete` 贡献拥有完整结果提示词；同时存在多个有效 complete 贡献属于无效组合。

变量插值在组装期间运行。变量缺失和无效 complete 组合会在模型请求前失败。运行时上下文 suppression 隐藏当前 scope 的动态上下文贡献，但不会禁用拥有这些事实的服务。

Prompt 组装产生结构化 section 和工具 schema。循环分别渲染用于输入投影的上下文 section 和最终系统提示词。这种分离避免运行时上下文值以未记录的进程内存形式进入请求。

<a id="schemas"></a>
## 工具 Schema 与 Scope

工具注册表自动贡献当前 Agent scope 可见的 schema。限制会缩小继承工具集合，scoped 注册可以增加或替换条目。显式工具顺序可以排列已知名称，并使用一个 rest 标记容纳全部未列出工具。

循环比较组装后的 schema 与当前请求 header。可见工具集合变化会开始新的请求序列，因为模型可调用接口发生变化。Schema 数据属于请求 header，工具实现函数仍只存在于进程中。

Native 模式暴露单独 schema。PTC 模式暴露 `run_code` 和为可见工具生成的 SDK。两种模式使用相同底层注册表与执行管线，因此展示模式改变模型输入，但不会创建另一条工具权限路径。

<a id="route"></a>
## 路由准备

循环先从 Agent 选项和最新请求 header 构造提议。下一次提议前会移除适配器推导默认值，让所选路由重新解析它们；用户或插件显式设置继续保留。

`agent/request` 是作用于该提议的 waterfall。它可以调整路由或配置，但最终值必须同时包含 provider 和 model。`ctx.llm.prepareCall()` 随后解析已注册适配器，并让它验证提供者拥有的选项、模型是否存在、reasoning effort、输出限制和能力。

结果 `PreparedLlmCall` 绑定：

- 实际 provider 和 model 配置；
- 哪些字段来自适配器默认值；
- 重试策略；
- 模型上下文信息；
- 系统提示词更新能力；
- 实际派发使用的精确 stream 实现。

绑定可以避免验证和派发之间注册表发生变化，却静默选择另一适配器。

<a id="system"></a>
## 系统消息协调

请求不携带另一份隐藏 `system` 字段。有效提示词文本通过 Session 历史中的 `system/message` 节点传递。[`runtime-context.ts`](../../packages/core/agent-loop/src/runtime-context.ts) 在路由准备后计算需要的追加或替换事件。

继续中的请求序列若支持 in-history 更新，非空提示词变化可以追加后续 system 节点。在新序列或不支持该能力的路由上，循环把非空提示词归并到首个 system 节点，并通过记录替换清空活跃的后续节点。渲染结果为空时会清除全部活跃非空 system 节点，避免旧指令仍对模型可见。

即使初始提示词为空，也会保留 system head 节点。这为以后协调提供稳定位置，而空消息不会产生 wire 消息。

<a id="request"></a>
## 请求重建

`buildRequest()` 规范化实际 header、按需记录它、记录变化后的请求 context，再调用 `session.deriveMessages()`。它深度冻结新的请求 envelope，以及当前 Agent 尚未证明已冻结的每个消息身份。

`request/header` 记录配置、可见工具、默认值和请求序列原因。`request/context` 在发生变化时记录 provider、model、context window 和系统提示词更新模式。系统文本保留在 `system/message` 中，让 Session Surface 决定其在其他消息间的位置。

循环为自己的请求加标记，使 `llm/stream` 中间件知道输入由日志推导且不可变。中间件可以包装流式响应、重试、回放或观察请求，但不能修改循环构造的请求。

<a id="streaming"></a>
## 流式响应与组装

LLM 适配器发出规范化流式 chunk，而不是提供者专属事件。`AssistantStreamAttempt` 记录紧凑定时流、组装内容块、跟踪 usage 与 replay state，并发布实时帧。

```text
provider response
  -> adapter normalization
  -> llm/stream waterfall
  -> AssistantStreamAttempt
  -> live start/chunk/end frames
  -> durable assistant/message or assistant/attempt
```

持久结算发生在 committed 终端实时帧之前。最终消息组装或追加失败时，实时 attempt 以 aborted 结束，而不会声称未记录的完成。稍后重新连接的使用者从结算事件重建。

<a id="retry"></a>
## 错误与重试

提供者失败规范化为 `LlmFailure` 事实，并使用 `LlmError` 进行抛出控制流。Code 区分认证、速率限制、上下文溢出、路由不可用和其他提供者无关类别，同时保留 status、重试延迟等安全提供者事实。

错误 finish 先结算 attempt，再进入 `agent/request-error`。返回 `{ kind: 'retry' }` 的监听器短路默认终止行为。重试重新准备路由，并可以触发压缩或退避策略，但不会重新运行提示词组装、pre-step 接纳或用户消息追加。

实时流开始前的错误不会虚构 start/end 帧。开始后的错误结算已经收集的 attempt 流。取消使用 turn signal，并遵循 Agent 循环章节描述的中断内容规则。

<a id="cache"></a>
## 缓存与 Token 分析

日志不会在请求中复制提示词文本：历史中的 system 消息就是提示词。Token 成本来自渲染后的系统内容、保留消息和工具 schema。

KV cache 复用取决于前缀身份。追加新历史保留前面的前缀。替换首个 system 节点从第一个 token 起改变前缀。修改工具 schema 或请求配置也可能让第一个差异提前。这就是系统更新能力和请求序列决定必须显式存在，而不能隐藏在适配器行为中的原因。

<a id="exercises"></a>
## 练习

1. 选择三个提示词贡献者，确定它们的顺序和 scope。
2. 沿提议、`agent/request`、`prepareCall()`、header 记录和流派发跟踪一次 provider/model 变化。
3. 对比继续中的支持路由和新请求序列如何协调提示词。
4. 跟踪一种提供者流事件如何变成规范化内容和最终助手块。
5. 解释请求中间件为什么可以包装流式响应，但不能修改带标记的循环请求。

当你能从 Session 前缀重建准确模型请求，并说明哪个适配器实例会发送它时，本章学习完成。

<a id="further"></a>
## 进一步阅读

继续学习[工具与执行](06-tools-and-execution.zh.md)。共享消息和 chunk 类型见 [LLM 流式子系统](../subsystems/llm-streaming.zh.md)，生成的服务约定见 [system-prompt 子系统](../subsystems/system-prompt.zh.md)。

<a id="dev-note"></a>
## 开发备注

无。
