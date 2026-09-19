# 7. 持久化与上下文管理

[English](07-persistence-and-context.md) | 中文

## 概要

本章解释持久 Session 代际文件如何选择、打开、迁移、写入和关闭，再把该存储模型连接到压缩、附件、spill 和冷查询。你将了解哪个组件负责物理文件，哪个组件负责对话语义。

## 目录

- [持久化角色](#roles)
- [写入所有权](#writing)
- [代际文件与迁移](#generations)
- [恢复](#recovery)
- [压缩](#compaction)
- [附件与 Spill](#attachments)
- [冷访问与搜索](#query)
- [练习](#exercises)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="roles"></a>
## 持久化角色

Core Session 负责事件语义和内存追加。持久化服务定义对已存储 Session 的 create、open、stat、list 和 export。后端负责物理 framing、压缩、代际文件选择、独占发布、缓冲和写句柄生命周期。

Agent 层负责语义修复，因为只有它理解 turn 边界。格式迁移包负责一个相邻逻辑转换。分离这些角色，可以避免存储代码发明 Agent 行为，也避免 Agent 循环依赖 JSONL 细节。

<a id="writing"></a>
## 写入所有权

生产 Agent 创建在发布前取得写句柄。恢复会话在构造实时 Agent 前以写模式打开 Session，从而排除另一 writer。发布后追加的事件通过 scoped Session 通知到达句柄。

写句柄可以缓冲事件。`session.flush()` 是显式持久化检查点；close 排空剩余缓冲并释放所有权。销毁过程在循环记录最终事件之后、Session 离开存储之前关闭 writer。

此生命周期之外创建 Session 不会自动持久化。这条有意规则避免无关 SessionStore 使用者获得隐藏文件系统所有权。

<a id="generations"></a>
## 代际文件与迁移

已存储 Session 文件使用带版本名称的代际文件。只读 header 的 stat 与 list 操作选择数值最高的规范代际文件，并在不加载完整日志的情况下转换支持的历史 header。

Open 选择同一代际文件、拒绝未来版本，并组合静态相邻迁移链得到当前逻辑事件。只读 open 把迁移结果保留在内存。写 open 在接受新写入前编码、验证并独占发布最终后继文件，同时保留原始文件不变。

已提交代际文件永不重命名、替换或删除。每个相邻迁移包只负责一个 `vN -> vN+1` 步骤。解释文件名或修改持久类型前，先阅读[格式状态](../session-format-status.zh.md)。

<a id="recovery"></a>
## 恢复

JSONL 提供者负责物理尾部验证，以及区分已封口字节和中断字节。未封口尾部的普通修复属于句柄使用者。恢复历史证明存在有界中断 turn 时，Agent 层可以追加支持的缺失 `turn/end`。

恢复记录事实，不重复外部副作用。没有权威结果的已恢复 `tool/call` 是诊断证据，不是重新执行工具的许可。使用者从验证后的前缀推导当前状态。

<a id="compaction"></a>
## 压缩

压缩通过记录 Surface 替换来改变未来模型历史。基础提供者根据路由模型 context window 衡量压力，可以先裁剪符合条件的大工具结果，再选择最早的平衡区间、请求模型生成摘要，并保留近期尾部。

自动压缩可以在请求达到阈值前运行，也可以在确认 context overflow 失败后运行。手动 `/compact` 在 Agent 可用于 maintenance 时使用同一能力。Maintenance 期间收到的 prompt 继续排队，等待后续工作。

压缩不能减小系统提示词或工具 schema，也不能拆分单个不可分历史单元。没有可压缩平衡区间时，它不会修改日志。原始事件仍可供 transcript 与审计读取者使用。

<a id="attachments"></a>
## 附件与 Spill

附件为二进制数据提供持久内容寻址身份。Session 事件存储引用，而不嵌入无限字节。读取附件的授权来自证明指定 Session 日志能够到达该引用。

Spill 处理超大工具输出。存储后端保留完整数据，策略把模型可见的日志结果替换为有界预览与定位内容。执行程序得到的值仍然完整。这些不同视图让程序能够处理数据，而无需把全部数据放入模型上下文或 UI 传输。

Image offload 是模型历史决定，不是普通附件删除。它根据路由能力和上下文压力替换选中的历史图片出现位置，同时保留持久附件身份。

<a id="query"></a>
## 冷访问与搜索

Session-query 在已存储 Session 上建立逻辑语料。Page、谱系、过滤和全文搜索无需恢复每个 Agent。冷投影和消息定义必须与实时定义一致，使查询结果反映相同逻辑历史。

产品层的 list、page、follow、fork、prompt 和 cancel 操作使用 API Session Controller。控制器决定何时冷操作足够，何时必须恢复实时 Agent。存储后端不应吸收这类产品策略。

<a id="exercises"></a>
## 练习

1. 从持久化 `create()` 开始，沿首次事件追加、flush 和 close 跟踪新 Agent。
2. 对比旧代际文件的只读 open 与写 open 行为。
3. 选择一条 context overflow 路径，找出原始 attempt、压缩替换、重试和结果消息历史。
4. 从上传字节开始，沿附件引用、Session 事件、模型请求和授权读取跟踪一张图片。
5. 解释 stat 和 list 为什么不应加载或迁移每个事件 body。

当你能区分物理有效性、逻辑迁移、语义修复、派生历史替换和产品层恢复时，本章学习完成。

<a id="further"></a>
## 进一步阅读

继续学习[产品入口](08-product-interfaces.zh.md)。修改存储类型或迁移行为前，阅读[持久化目录](../persistence-catalog.zh.md)、[Session 格式状态](../session-format-status.zh.md)和相关包 README。

<a id="dev-note"></a>
## 开发备注

无。
