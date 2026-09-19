---
description: "runtime-diagnostics 组地图：针对运行中组合的包自有运行时不变式检查，供浏览本组的用户与维护者参考。"
kind: "package-group"
---

# packages/runtime-diagnostics

[English](README.md) | 中文

## 概述

runtime-diagnostics 组为运行中的 DeepSeek Harness 组合提供两个互补视角。`invariants` 运行包自有检查，验证持久事件与数据关系。`flow-trace` 按时间输出 Agent、Session、模型请求、stream 与工具阶段的可选说明，同时不记录载荷正文。使用 invariants 发现无效状态，使用 flow trace 学习或诊断一个任务如何到达当前状态。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`invariants`](invariants/README.zh.md) | 运行包自有运行时检查，并按所属包报告每次失败 | 注册到 `ctx.invariants` |
| [`flow-trace`](flow-trace/README.zh.md) | 为核心执行流程输出保护正文的时序元数据 | 无；观察事件 |

-----

<a id="related-documentation"></a>
## 相关文档

- [运行时不变式子系统](../../docs/subsystems/invariants.zh.md)——生成的服务参考：选择、installer 与配套入口约定。
- [不变式运行时约定 Agent Note](../../.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.zh.md)——运行时不变式可以断言什么，以及强制配套入口接线的机械门禁。
- [包约定](../AGENTS.md)——每个包都必须遵循的 `./invariant` 配套入口规则。
- [学习指南：扩展与调试](../../docs/learning/09-extension-and-debugging.zh.md)——启用追踪并把日志行映射到核心扩展点。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
