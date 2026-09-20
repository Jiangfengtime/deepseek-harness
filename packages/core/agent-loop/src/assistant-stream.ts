/**
 * 把一个 provider 流转换为 Agent 消费者需要的两种表示。
 *
 * 实时 `agent/assistant-stream` frame 让 UI 可以立即渲染 chunk，但进程退出后
 * 这些 frame 就会消失。保存在 `assistant/message` 或 `assistant/attempt` 中的
 * 紧凑计时流是持久数据，可用于回放。本类让每个 chunk 只处理一次并同时进入
 * 两种表示；只有对应 Session 事件提交成功后，才发送实时终止 frame。
 */

import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  type AssistantStreamRecord,
  type ContentBlock,
  type FinishReason,
  type ReplayEnvelope,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/**
 * 把一次模型 attempt 折叠为组装后的内容、紧凑回放流与有序临时 frame。每个
 * 实例只代表一次 provider attempt；请求重试会在同一 step 内创建新实例。
 */
export class AssistantStreamAttempt {
  /** 最终嵌入持久事件的无损紧凑记录。 */
  private readonly accumulator = new AssistantStreamAccumulator()
  /** 从同一批 chunk 派生的语义内容、usage 与 finish 状态。 */
  private readonly assembler = new BlockAssembler()
  /** 临时 frame 中使用的从零开始的 chunk 下标。 */
  private index = 0
  /** 防止调用方发布第二个终止 frame。 */
  private terminal = false
  /** 在当前 Agent 生命周期内唯一的 attempt 标识。 */
  readonly attemptId: LlmAttemptId

  /** 已开始的 attempt 是否已经发出终止 frame。 */
  get ended(): boolean { return this.terminal }

  /**
   * @param sessionId - 只嵌入 Agent 生命周期本地 attempt id 的 Session 标识。
   * @param attempt - 当前挂接 Session 内的 attempt 计数。
   * @param nextRevision - 分配下一个 frame 修订号。
   * @param turn - 拥有本次请求的持久 turn。
   * @param step - 拥有本次请求的持久 step。
   * @param emit - Agent scope 内的通知发布函数。
   */
  constructor(
    sessionId: SessionId,
    attempt: number,
    private readonly nextRevision: () => number,
    readonly turn: number,
    readonly step: number,
    private readonly emit: (frame: AssistantStreamFrame) => void,
  ) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`)
  }

  /**
   * 在首个 chunk 交付前发布开始标记。驱动器只会在请求构建完成并通过最后一次
   * 取消检查后调用它，因此 setup 失败不会产生虚假的实时 attempt。
   */
  start(): void {
    this.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      turn: this.turn,
      step: this.step,
    })
  }

  /**
   * 只为一个 chunk 生成一次快照，再依次送入持久压缩、语义组装与实时发布。
   * 持久记录中的时间戳与实时 frame 暴露的时间戳完全相同。
   */
  push(chunk: StreamChunk): void {
    const timed = this.accumulator.push({ time: Date.now(), chunk })
    this.assembler.push(timed.chunk)
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  /**
   * 先提交匹配的持久事件，再发布实时终止结算。若 append 失败，`abandon()` 会
   * 告知实时观察者不存在可回放事件；原始 append 错误仍继续抛给驱动器。
   * @param eventType - 持久结算事件类型。
   * @param append - 同步追加持久事件并返回已提交 seq 的函数。
   */
  settle(
    eventType: 'assistant/message' | 'assistant/attempt',
    append: () => SessionSeq,
  ): void {
    let seq: SessionSeq
    try {
      seq = append()
    } catch (error: unknown) {
      this.abandon()
      throw error
    }
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'committed', eventType, seq },
    })
  }

  /**
   * 无法提交持久 attempt 事件时发布 abandoned。abandoned end frame 没有
   * Session seq，不能在回放时当作已完成的 assistant attempt。
   */
  abandon(): void {
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'abandoned' },
    })
  }

  /** 写入最终持久事件的精确紧凑流；调用方得到数组副本。 */
  get stream(): SessionEventMap['assistant/attempt']['stream'] {
    return [...this.accumulator.snapshot()] as AssistantStreamRecord[]
  }

  /** 从同一批 chunk 组装出的规范 completed-message block。 */
  blocks(): ContentBlock[] {
    return this.assembler.blocks()
  }

  /**
   * attempt 被取消打断时可安全保留的可见前缀。不完整的协议 block 会被排除，
   * 避免后续模型收到残缺 tool call 或尚未组装完成的结构化内容。
   */
  interruptedBlocks(): ContentBlock[] {
    return this.assembler.interruptedBlocks()
  }

  /** 流中 adapter 最后一次报告的 token usage。 */
  get usage(): TokenUsage | undefined {
    return this.assembler.usage
  }

  /** 终止原因；若流未给出，则默认按 stop 处理。 */
  get finish(): FinishReason {
    return this.assembler.finish
  }

  /** 终止 finish 记录携带的回放状态。 */
  get replayState(): ReplayEnvelope | undefined {
    return this.assembler.replayState
  }
}
