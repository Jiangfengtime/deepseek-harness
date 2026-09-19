# 6. 工具与执行环境

[English](06-tools-and-execution.md) | 中文

## 概要

本章从 schema 公告开始，沿策略、执行、结果提交和 UI 展示跟踪一个模型工具调用。随后区分文件系统、shell、subprocess、terminal 和 sandbox 的职责，使你能够在正确的包中定位行为与安全决定。

## 目录

- [工具定义](#definition)
- [可见性与策略](#policy)
- [执行管线](#pipeline)
- [调度](#scheduling)
- [文件系统示例](#filesystem)
- [Shell 与 Subprocess](#process)
- [Sandbox 与 Approval](#sandbox)
- [展示与大输出](#presentation)
- [PTC 模式](#ptc)
- [练习](#exercises)
- [进一步阅读](#further)
- [开发备注](#dev-note)

-----

<a id="definition"></a>
## 工具定义

`defineTool()` 创建类型化定义，包含面向模型的名称、描述、参数 schema、输出 schema 与 renderer、执行函数、可选展示元数据和并发分类。注册表向提示词组装暴露 schema，把执行函数保留在 Host 进程中。

参数 schema 验证 JSON 结构。工具代码仍需验证 schema 无法表达的语义约束，例如正整数窗口、非空路径或选项间关系。无效模型参数成为普通错误结果，而不会使 Agent 循环崩溃。

输出有两种表示。执行函数返回声明的 lossless JSON 值，输出 renderer 把它转换为模型和 Session 日志使用的内容块。工具还可以持久化纯展示元数据，使 UI 无需解析渲染文本即可重建专用卡片。

<a id="policy"></a>
## 可见性与策略

Scope 和限制决定模型看到哪些 schema。`ctx.tools.restrict()` 把 allow 与 deny mask 同继承条目求交集。执行通过调用 Agent scope 解析定义，使公告与派发一致。

策略可以做三类决定：允许、拒绝或请求一次人工 approval。`tools/pre-execute` 是可扩展第一阶段。注册的同步 guard 随后运行，并且是单调的：一个拒绝不能被后续 guard 反转。Approval 服务缺失或无法回答时，ask 不能变成允许。

持续策略属于相关能力所有者，工具管线负责协调决定。文件系统新鲜度策略监听 filesystem 事件，sandbox mode 来自 sandbox policy，工具限制控制公告与派发。这些机制相互组合，而不是互相替代。

<a id="pipeline"></a>
## 执行管线

权威顺序记录在[工具执行管线](../tool-execution-pipeline.zh.md)：

```text
tool/call event
  -> tools/pre-execute
  -> monotonic guards and approval
  -> tools/execute around-middleware
  -> definition.execute()
  -> tools/post-execute
  -> outer normalization
  -> definition.finalizeContent
  -> tools/result notification
  -> tool/result event
```

普通工具错误结算为带 `isError` 的 `ToolExecutionResult`，不会穿透 Agent 循环抛出。管线基础设施失败仍可能抛出并结束 turn。`tools/post-execute` 可以替换内容或增加 next-step 上下文。`finalizeContent` 是定义自身最后的纯内容检查。`tools/result` 观察冻结的权威结果，不能再改写它。

`tool/call` 事件在执行前提交，让 pending UI 和回放知道请求了什么。结果引用其 call 序列。调度器失败保留已经记录的调用，不会为结果未知的工作虚构结果。

<a id="scheduling"></a>
## 调度

[`tool-calls.ts`](../../packages/core/agent-loop/src/tool-calls.ts) 在每个未启动调用能够开始时进行分类。并行安全调用进入有界滚动池。独占调用等待当前池排空、单独运行，并在后续调用前形成屏障。

完成与提交彼此独立。派发 Promise 可以乱序结算，但提交游标按模型顺序 finalization 连续 slot。附加上下文也按该顺序进入 inbox。

取消停止填充并发池，并等待已启动调用收敛。未启动调用获得合成 `ABORTED_BEFORE_DISPATCH` 结果。内部调度器失败会等待已启动派发，但不虚构恢复结果，随后抛出首个失败。

<a id="filesystem"></a>
## 文件系统示例

跟踪 [`tool-fs/src/read.ts`](../../packages/fs/tool-fs/src/read.ts)。它验证行窗口、解析普通文件目标、通过一次 stat 完成类型和大小路由、流式读取大文件或大小未知文件、构造有界窗口并返回结构化行数据。Renderer 生成带行号文本；展示元数据保留路径、语言、offset 和行，用于可回放 UI。

文件系统家族分离以下职责：

| 包角色 | 职责 |
|---|---|
| `fs` | 提供者无关的目标、读取、流式读取和带 guard 的原子修改 |
| `fs-local` 或 `fs-ssh` | 实际执行环境 I/O |
| `fs-sandbox` | 在提供者之上实施每次调用写限制 |
| `fs-observation-policy` | 读取后编辑观察和过期写入拒绝 |
| `tool-fs` | 模型 schema、验证、有界渲染和工具语义 |

读取后编辑策略记录观察到的文件存在性或版本，再在提供者锁中重新检查修改。并发写入会使修改以 stale 失败，并要求再次读取。该策略是插件；没有它时，基础提供者仍是无条件文件系统能力。

<a id="process"></a>
## Shell 与 Subprocess

Shell 服务定义命令请求、解析后的执行 spec、前台结果和后台 handle。Bash 或 PowerShell 提供者实现 shell 语义。面向模型的工具解析用户参数并展示结果。

Subprocess 服务负责更底层的进程创建、可执行文件查找、stdio、有界输出、进程范围终止和 terminal 分配。Shell、LSP、PTC、terminal 和进程外 subagent 使用它。使用者负责每个进程的含义、deadline 和结果展示。

文件系统与 subprocess 提供者构成一个执行环境。如果命令远程运行，而文件工具本地读取，模型可能检查一个项目却对另一个项目执行。SSH 因此提供成对提供者，而不是给每个工具增加远程分支。

<a id="sandbox"></a>
## Sandbox 与 Approval

Sandbox policy 解析每次调用模式，例如只读、workspace-write 或不受限。Sandbox 提供者把策略转换为平台专属进程限制。文件系统限制通过其提供者 wrapper 使用同一策略。

Sandbox、approval 和工具限制回答不同问题：

- Restriction：该 Agent 能否看到并派发这个具名工具？
- Approval：这一次请求操作能否执行或升级？
- Sandbox：结果进程或提供者操作能产生哪些文件系统影响？

请求受限执行时，如果后端无法提供声明的 enforcement，调用会失败。经过批准的一次性升级只改变该调用的解析策略，不会静默修改 Session 持续策略。

<a id="presentation"></a>
## 展示与大输出

Host presenter 是纯函数。Web Client 从原始事件、结果内容、失败状态和持久元数据推导工具卡片。这让回放不依赖实时执行器。

有界工具输出保护模型上下文和传输内存。Spill 策略可以存储超大的完整输出，只把日志与模型可见副本替换为预览和定位信息；调用工具的程序已经收到完整返回值。压缩随后可以裁剪符合条件的历史工具结果。

<a id="ptc"></a>
## PTC 模式

PTC 用生成的 SDK 与 `run_code` 代替或补充单独原生工具。Node 提供者在新的受管理进程中运行每个程序，并限制耗时、heap、消息、待处理调用和输出。宿主绑定通过同一工具注册表、策略、日志和 approval 路径派发嵌套调用。

程序能够过滤或组合中间值时，PTC 可以减少模型往返。它不会创建新的不受限工具通道。直接 Node API 仍受解析后的操作系统 sandbox 限制，因此隔离结论必须与所选后端一致。

<a id="exercises"></a>
## 练习

1. 从公告 schema 开始，沿结果事件和 UI 元数据跟踪一次 `read` 调用。
2. 为并行 read A、并行 read B、独占 edit C、并行 read D 写出纸面调度顺序。
3. 找出无效参数、普通执行错误、被拒绝调用和调度器失败分别在哪里成为结果或抛出失败。
4. 沿 tool、shell、sandbox、subprocess 和操作系统进程跟踪一条 Bash 命令。
5. 比较相同三个可见工具的 native 与 PTC 展示，找出变化部分和共享部分。

当你能把观察到的行为分别归属到工具定义、注册表策略、调度器、能力提供者、sandbox 或 presenter，而不混合这些层时，本章学习完成。

<a id="further"></a>
## 进一步阅读

继续学习[持久化与上下文管理](07-persistence-and-context.zh.md)。当前面向模型的清单见[工具目录](../tool-catalog.zh.md)，完整约定见 filesystem、shell、subprocess 和 sandbox 子系统页面。

<a id="dev-note"></a>
## 开发备注

无。
