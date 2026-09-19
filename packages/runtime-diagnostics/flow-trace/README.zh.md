---
description: "用于学习和调试 DeepSeek Harness Agent、Session、模型请求、流式输出与工具执行流程的可选时序诊断。"
kind: "package-reference"
---

# @deepseek-ai/dsh-flow-trace

[English](README.md) | 中文

## 概述

`dsh-flow-trace` 把一个运行中任务解释为按时间排列的 Cordis 日志。它观察 Agent 生命周期与策略 waterfall、已提交的 Session 事件、assistant 流边界和工具执行阶段。基础 profile 默认挂载但禁用它；只在学习或诊断流程时启用。日志包含关联 id、turn 与 step 编号、事件类型、决策、provider/model 名称和失败代码。它有意省略提示词、消息正文、工具参数、工具输出、文件内容、模型文本和错误消息。

## 目录

- [使用此包](#use-this-package)
- [阅读追踪日志](#read-the-trace)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

使用提供的 overlay 运行基于 base 的 profile：

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/flow-trace.overlay.yml "trace one task"
```

该 overlay 启用休眠的 `flow-trace` 配置行，并使用 `info` 级别。若想减少普通应用输出，可复制 overlay 并选择 `debug`；此时活动日志 exporter 必须接收 debug 消息。只有分析流顺序时才设置 `assistantChunks: true`。Chunk 日志只报告 attempt id、revision 与 index，不报告 chunk 正文。

```yaml
- id: flow-trace
  disabled: false
  config:
    level: info
    assistantChunks: false
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `level` | `info` | 所有追踪日志使用的 Cordis 级别 |
| `assistantChunks` | `false` | 包含只有元数据的 assistant chunk 日志 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是完整字段参考。

<a id="read-the-trace"></a>
## 阅读追踪日志

沿共享 id 与计数器阅读，不要把每行当成互不相关的消息：

```text
agent id=<session> phase=inbox-claimed message=<message> turn=1
session id=<session> seq=3 event=step/start turn=1 step=1
agent id=<session> phase=request-exit turn=1 step=1 provider=... model=...
agent id=<session> stream phase=start attempt=... revision=1 turn=1 step=1
session id=<session> seq=7 event=tool/call turn=1 step=1 call=... tool=read_file
tool call=... name=read_file phase=pre-exit decision=allow
tool call=... name=read_file phase=result error=false concludesTurn=false
session id=<session> seq=8 event=tool/result turn=1 step=1 call=... error=false
session id=<session> seq=10 event=turn/end turn=1 reason=completed
```

`phase=*-enter` 与 `phase=*-exit` 包围一个 waterfall 扩展点。Exit 行展示所有下游策略运行后选定的值。`session ... event=...` 含义不同：`session/event` 在 `Session.append()` 提交后触发，因此该行表示可供回放和持久化观察器读取的持久事实。Stream 行是进程本地信息，解释两次持久结算之间的活动。

工具执行有四个有用视角。`pre-*` 报告 allow/deny/ask/cancel 策略；`dispatch-*` 包围选定实现；`post-*` 报告结果策略；`phase=result` 是冻结后的最终结果。之后的 Session `tool/result` 行确认 AgentLoop 已提交面向模型的结果。

<a id="understand-the-implementation"></a>
## 理解实现

插件注册全局观察器，因为它挂载在 profile 根部并且需要观察每个 Agent scope。每个 waterfall 观察器都调用并等待 `next()`、记录选定决策或结果，然后返回同一个值。这种委派是透明观察的必要条件：省略 `next()` 会让诊断插件成为策略所有者，并可能阻止 step、模型请求或工具调用。

Session 观察器运行在提交后的 `session/event` feed 上。它的事件 switch 只为少量核心事件增加安全的路由元数据；未知的插件自有事件仍会获得通用 session id、seq、type，以及存在时的 turn 和 step 字段。追踪从不序列化事件、消息、执行对象、stream chunk、结果或抛出值。错误日志只保留稳定代码或类名。

插件没有服务，也没有可变进程资源。Cordis 随插件 fiber 管理监听器销毁，因此 HMR 或 profile 关闭会移除所有观察器。不会发布运行时 invariant 配套入口，因为插件从权威事件派生诊断日志，并且不拥有可能发生分歧的独立状态关系。

<a id="further-exploration"></a>
## 进一步阅读

对照追踪日志阅读[轮次流程架构](../../../docs/architecture.zh.md#turn-flow)，再使用[学习指南第 9 章](../../../docs/learning/09-extension-and-debugging.zh.md)把每行映射到源扩展点。事件约定位于 `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session` 与 `@deepseek-ai/dsh-tools`。

<a id="model-experience"></a>
## 模型体验

无，因为观察器只记录运行时元数据，不改变模型请求或 Session 事件。

#### KV Cache 影响

启用观察器不会改变面向模型的消息与请求 header，因此既不会创建也不会使 provider cache 前缀失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只有进程本地历史。** 追踪不重建插件启用前发生的事件，也不是持久审计日志。
- **并发输出会交错。** 使用 Agent/session id 区分并发 Agent 的日志行。
- **报告元数据而非载荷。** 需要精确模型可见数据时读取持久 Session 日志。
- **可见性取决于 exporter。** 没有 Cordis exporter 的部署可能只把消息保留在 logger 环形缓冲区中。

<a id="dev-note"></a>
### 开发备注

无。
