# 2. Cordis 运行时与扩展机制

[English](02-cordis-runtime.md) | 中文

## 概要

本章解释所有 Harness 能力共享的运行机制：Context 服务查找、依赖激活、事件派发、可撤销 effect、scoped 注册和销毁。你将使用这些机制区分直接能力调用与拦截点，并分析重载、回滚和每 Agent 隔离。

## 目录

- [Context 与服务](#context)
- [依赖激活](#dependencies)
- [事件](#events)
- [Effect 与销毁](#effects)
- [Scope](#scopes)
- [一次注册流程](#walkthrough)
- [常见失败模式](#failures)
- [练习](#exercises)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="context"></a>
## Context 与服务

Cordis Context 表示插件可见的服务和当前生命周期。Harness 服务通过声明合并把稳定属性加入 `Context`，例如 `ctx.sessions`、`ctx.agents`、`ctx.llm`、`ctx.tools` 和 `ctx.fs`。使用者通过属性调用接口，不导入提供者实现。

这种分离形成三个有用角色：

| 角色 | 问题 | 示例 |
|---|---|---|
| 服务定义 | 调用方能做什么？ | `ctx.fs` 文件操作 |
| 提供者 | 当前组合如何实现？ | 本地或 SSH 文件系统 |
| 使用者 | 为什么使用该能力？ | 面向模型的 `read` 工具 |

只有这些角色形成从调用方到实现的实际路径，能力 seam 才完整。没有提供者的接口，或没有使用者的提供者，都不是完整产品能力。

服务访问跟随插件 Context。把 Agent scoped Context 交给 setup 代码，会同时交出 scoped 注册表视图，以及创建该 scope 的插件所拥有的服务解析链。因此 scope 是受信任同进程插件的组织和资源归属机制，不是权限隔离。

<a id="dependencies"></a>
## 依赖激活

静态 `inject` 声明插件激活前必需的服务。Cordis 观察服务可用性，并在满足要求时挂载插件。因此，配置行顺序不是激活顺序。

可选集成放在 `ctx.inject([...], callback)` 中。可选服务存在时回调激活，服务消失时回调贡献销毁。插件在缺少可选能力时仍有有效行为，才使用这种模式；不要削弱真正必需的依赖，再静默跳过全部工作。

区分以下失败情况：

- 必需服务始终未出现：插件不会激活，Loader 诊断指出依赖。
- 配置无需外部信息即可判断无效：插件加载时失败。
- 只有操作开始时才能解析引用对象：在最早操作点失败。
- 可选服务消失：只撤销其 injection 回调拥有的贡献。

<a id="events"></a>
## 事件

事件让插件无需导入生产者实现即可观察或拦截行为。派发模式是每个事件公开行为的一部分。

| 模式 | 行为 | 常见用途 |
|---|---|---|
| `emit` | 调用观察者，但不等待其返回的 Promise。 | 状态与提交后通知 |
| `parallel` | 运行监听器并等待全部结算。 | 持久化检查点 |
| `serial` | 按注册顺序等待监听器。 | 初始化与有序停止 hook |
| `bail` | 监听器返回决定后停止。 | 选择一个提供者或处理器 |
| `waterfall` | 通过 `next()` 组合 around-middleware。 | 请求、工具和策略拦截 |

Waterfall（瀑布式事件）监听器接收事件参数和最后的 `next`。调用 `next()` 会委派给剩余监听器和基础操作，不调用则短路。只记录指标、修改允许字段或包装结果的监听器必须继续委派；拥有最终拒绝决定的策略监听器可以有意停止调用链。

应同时阅读生产者派发位置和声明合并后的事件定义。定义给出模式和参数；派发位置说明返回的 Promise 或异步迭代器是否会被继续等待或消费。

Harness 使用三个主要事件领域。Session 事件是持久事实；Agent 事件携带实时 Agent，描述进行中的工作；能力事件属于 tools 或 filesystem 等服务，允许策略与适配器接入而不耦合循环。

<a id="effects"></a>
## Effect 与销毁

注册就是 effect：每个已注册工具、适配器、提示词 section、事件监听器或提供者都有所有者和 disposer。插件卸载时，Cordis 撤销其拥有的 effect。这既支持热重载，也避免激活失败留下半安装状态。

相关资源的销毁顺序有要求时，应放在同一个 effect 中。彼此独立的同级 effect 可能按不安全顺序销毁复合资源。Agent factory 使用有序生命周期，因为驱动必须先写结束事件，随后才能移除 Session 发布与持久化资源。

销毁还需要身份安全。为一个注册值创建的 disposer 必须删除该确切值，不能删除后来使用相同 id 替换的对象。阅读注册表时，检查移除操作比较注册对象，还是仅按名称删除。

观察者失败策略由事件所有者定义。提交后的 Session 通知会包含监听器失败，因为事件已经存在；同步创建公告可以否决发布并触发回滚。不能只根据事件名称推断失败行为。

<a id="scopes"></a>
## Scope

[`dsh-scope`](../../packages/core/scope/README.zh.md) 为注册增加分层可见性和生命周期。子 scope 看见祖先贡献，同名贡献以最近一层为准。同级 scope 不能看见彼此的条目。销毁 scope 会移除它拥有的全部内容。

事件过滤沿同一层级反向工作：祖先 scope 的监听器可以观察后代活动。未标记的全局监听器看到全部符合条件的派发。Opaque scoped event carrier 保留路由信息，不替换事件的实际主体。

```text
global registrations
  -> preset scope
       -> agent A scope
       -> agent B scope
```

Agent A 和 B 继承全局与 preset 条目。A 中的覆盖只影响 A。注册在 preset scope 的监听器可以观察两个后代。这构成每 Agent 工具、提示词 section、限制和生命周期监听器的基础。

<a id="walkthrough"></a>
## 一次注册流程

沿以下位置跟踪 `read` 工具注册：

1. `tool-fs` 在 [`src/index.ts`](../../packages/fs/tool-fs/src/index.ts) 声明必需服务。
2. `applyReadTool()` 注册提示词 section 和工具定义。
3. `ctx.tools.register()` 把定义存入与注册 Context 对应的层。
4. 提示词组装从工具注册表获取当前 Agent scope 可见的 schema。
5. AgentLoop 把这些 schema 放入请求头。
6. 工具调度器执行时再次解析定义。
7. 卸载贡献插件时，提示词与工具注册一同销毁。

这条路径说明 schema 可见性和执行查找为什么必须使用同一 scope。如果从一种视图宣传工具，却从另一种视图执行，模型可见能力会与运行时能力不一致。

<a id="failures"></a>
## 常见失败模式

插件重载后行为出现两次，先检查 effect 归属是否缺失。服务始终不激活，检查 `inject` 和有效配置。一个 Agent 看见另一个 Agent 的工具，检查注册时使用的 Context。Waterfall 意外停止，检查哪些监听器没有调用 `next()` 就返回。

生命周期属于 Context 时，不要使用进程全局单例。测试会并发执行多个文件，热重载会创建新的插件实例；全局可变状态可能在两种场景中泄漏。根据所需生命周期选择服务、scoped 注册表或 effect 拥有的值。

<a id="exercises"></a>
## 练习

1. 在 core 包中分别找到一个 `emit`、`serial` 和 waterfall 事件。对每个事件写出生产者、使用者、失败行为，以及是否等待返回的异步工作。
2. 分别跟踪一个全局 Context 和一个 Agent Context 中的工具注册，描述该 Agent 及其同级 Agent 的可见集合。
3. 找到一个 `ctx.inject()` 回调，解释缺少可选服务时哪些行为仍然激活。
4. 找到一个注册表 HMR 安全测试：它销毁贡献 fiber 并验证清理。
5. 解释 scope 过滤为什么不能阻止受信任插件调用其 Context 上的其他服务。

当你能查看一项注册并说明谁拥有它、哪里可见、何时激活、怎样拦截工作以及由什么移除时，本章学习完成。

<a id="further"></a>
## 进一步阅读

继续学习 [Session 与投影](03-sessions-and-projections.zh.md)。动手练习 Cordis 时使用 [Cordis 教程](../cordis-tutorial/index.zh.md)；查询生成的服务和事件声明时使用[子系统索引](../subsystems/README.zh.md)。

<a id="dev-note"></a>
## 开发备注

无。
