/**
 * Agent 循环插件入口：创建带独立作用域的 ReactLoopAgent，把它发布到 Agent 与
 * Session 注册表，并负责有序销毁。
 *
 * 本文件管理生命周期，`agent.ts` 管理 turn/step 执行。新建或恢复 Agent 时，
 * 这里先准备 Session、持久化写句柄、Agent scope 和统一取消信号；setup 完成后
 * 才把 Session 与 Agent 一起发布。任一阶段失败都会进入同一个记忆化 dispose
 * 事务，确保并发的调用方、owner fiber 与插件卸载都等待同一静止边界。
 *
 * 建议按 `AgentLoop` 构造函数 -> `createAgent()`/`resume()` ->
 * `setupAndPublish()` -> `prepare()` -> `publish()` -> `dispose()` 阅读。
 *
 * @module @deepseek-ai/dsh-agent-loop
 */

import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
  TurnBoundaryProjection,
} from '@deepseek-ai/dsh-agent'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { interruptedTurnClosers, SessionLogOffset, SessionPreparation, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ReactLoopAgent } from './agent.ts'
import { inboxProjectionDefinition } from './inbox.ts'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './constants.ts'

/** 已不能创建或持有新 Agent 生命周期的 Fiber 状态。 */
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

const turnBoundaryProjectionSchema: zod.ZodType<TurnBoundaryProjection> = zod.object({
  openTurnStartSeq: zod.number().int().nonnegative().transform(SessionSeq).nullable(),
  lastStepStartSeq: zod.number().int().nonnegative().transform(SessionSeq).nullable(),
  lastStepBoundary: zod.object({
    kind: zod.union([zod.literal('start'), zod.literal('end')]),
    seq: zod.number().int().nonnegative().transform(SessionSeq),
  }).nullable(),
  lastTurn: zod.number().int().nonnegative(),
})

/** 从 Session 事件折叠出的 Host 端 turn/step 边界投影。 */
export const turnBoundaryProjectionDefinition = {
  key: 'turnBoundary',
  stateVersion: 2,
  stateSchema: turnBoundaryProjectionSchema,
  init: () => ({
    openTurnStartSeq: null,
    lastStepStartSeq: null,
    lastStepBoundary: null,
    lastTurn: 0,
  }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return {
          ...state,
          openTurnStartSeq: event.seq,
          lastTurn: event.data.turn,
        }
      case 'turn/end':
        return {
          ...state,
          openTurnStartSeq: null,
        }
      case 'step/start':
        return {
          ...state,
          lastStepStartSeq: event.seq,
          lastStepBoundary: { kind: 'start', seq: event.seq },
        }
      case 'step/end':
        return {
          ...state,
          lastStepBoundary: { kind: 'end', seq: event.seq },
        }
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<'turnBoundary', TurnBoundaryProjection>

/** Factory 级所有权：统一跟踪活动 Agent 的 teardown 与配置启动任务。 */
class FactoryOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly inactive = Promise.withResolvers<void>()
  private readonly liveAgents = new Set<() => Promise<void>>()
  private startupTasks = new Set<Promise<void>>()

  constructor(private readonly fiber: Context['fiber']) {}

  /** factory teardown 开始时中止，reason 为 agent loop is not active 错误。 */
  get signal(): AbortSignal {
    return this.teardown.signal
  }

  isActive(): boolean {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
  }

  /** 跟踪一个活动 Agent 的共享 teardown，直到它真正执行完成。 */
  track(dispose: () => Promise<void>): () => void {
    this.liveAgents.add(dispose)
    return () => { this.liveAgents.delete(dispose) }
  }

  /** 跟踪在 Agent 实例产生前就开始的配置启动任务。 */
  trackStartup(job: Promise<void>): void {
    this.startupTasks.add(job)
    const forget = () => { this.startupTasks.delete(job) }
    void job.then(forget, forget)
  }

  /** 跟踪一次公开 create/resume；factory dispose 会等待它结算。 */
  trackWrapper(job: Promise<unknown>): void {
    this.trackStartup(job.then(() => undefined, () => undefined))
  }

  /** 等待 task 完成；若 factory teardown 开始，则停止等待。 */
  async waitWhileActive(job: Promise<void>): Promise<void> {
    await Promise.race([job, this.inactive.promise])
  }

  async dispose(): Promise<void> {
    this.accepting = false
    this.teardown.abort(new Error('agent loop is not active'))
    this.inactive.resolve()
    await Promise.all([
      ...[...this.liveAgents].map(dispose => dispose()),
      ...this.startupTasks,
    ])
  }
}

/** 等待 operation；signal 一旦中止就立即抛出其 reason。 */
async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  const toAbortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  if (signal.aborted) throw toAbortError()
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => { aborted.reject(toAbortError()) }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/** 启动可取消操作；若值在取消后才到达，则调用 releaseAbandoned 释放它。 */
async function raceAbortCall<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
  releaseAbandoned?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  }
  const pending = Promise.resolve().then(operation)
  try {
    return await raceAbort(pending, signal, id)
  } catch (error: unknown) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while the operation is awaited.
    if (signal.aborted && releaseAbandoned !== undefined) {
      void pending.then(releaseAbandoned, () => undefined)
    }
    throw error
  }
}

/** 在配置所有者边界解析并校验部署级工具并发上限。 */
function resolveMaxParallelToolCalls(value: number | undefined): number {
  const maxParallelToolCalls = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS
  if (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1) {
    throw new Error('maxParallelToolCalls must be a positive integer')
  }
  return maxParallelToolCalls
}

/** 拒绝无法在请求 wire 上精确表示的输出 token 上限。 */
function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

/** 一个 Session 独占的写句柄，以及已经通过它保存的事件数量。 */
interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

/** 已准备但尚未发布的 Agent 资源；它们共享一个记忆化 teardown。 */
interface PreparedAgent {
  agent: ReactLoopAgent
  /** factory 卸载、调用方取消或 teardown 开始时中止，用于结束 setup await。 */
  signal: AbortSignal
  /** 进入两个注册表并等待创建监听器完成。 */
  publish(source: SessionStartSource): Promise<AgentHandle>
  /** 记忆化逆序 teardown：停止驱动器、注销对象、撤销 scope。 */
  dispose(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
    /**
     * Launcher-owned exact session identities for configured agents, keyed by
     * the agent's config `id` and set with `ctx.provide()` before any Loader
     * entry mounts (see {@link CONFIGURED_AGENT_IDENTITIES_KEY}). A launcher
     * owns identity because only it knows whether the session already exists,
     * while the `cordis.yml` row keeps the model route as ordinary patchable
     * config. An entry with no matching key keeps its configured identity.
     */
    configuredAgentIdentities?: ConfiguredAgentIdentities
  }
  interface Events {
    /**
     * A declarative agent entry failed before it could publish a live agent.
     * Consumers that buffer work for the configured identity use this
     * transient signal to reject that work instead of waiting forever. Normal
     * factory teardown suppresses failures from the cancelled startup attempt.
     * @param payload.sessionId - exact shared agent/session identity that failed startup.
     * @param payload.error - persistence, setup, or publication failure.
     * @mode emit
     */
    'agent-loop/config-start-failed'(payload: { sessionId: SessionId; error: unknown }): void
  }
}

export { DEFAULT_MAX_PARALLEL_TOOL_CALLS }

/**
 * One launcher-selected session identity for a configured agent. `resume`
 * distinguishes rehydrating existing persisted history from creating the
 * session fresh under that exact id, which the two config keys express as
 * `resumeSessionId` and `sessionId`.
 */
export interface LauncherAgentIdentity {
  /** Exact session id to create fresh or resume. */
  id: SessionId
  /** Resume existing persisted history instead of creating the session fresh. */
  resume: boolean
}

/** Launcher-selected identities keyed by the configured agent's `id`. */
export interface ConfiguredAgentIdentities extends Readonly<Record<string, LauncherAgentIdentity>> {}

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, identities)`) to fix
 * configured agents' session identities without a config key, so an overlay
 * repointing the row's model route cannot drop them.
 */
export const CONFIGURED_AGENT_IDENTITIES_KEY = 'configuredAgentIdentities'

/**
 * Apply launcher-owned identities over the configured agents, replacing both
 * identity keys for every entry the launcher named so a config-supplied
 * identity can never survive alongside a launcher-supplied one.
 * @param agents - the configured agent entries.
 * @param identities - launcher identities keyed by configured agent `id`, or `undefined`.
 * @returns the entries with launcher-owned identities applied.
 */
function applyLauncherIdentities(
  agents: Config['agents'],
  identities: ConfiguredAgentIdentities | undefined,
): Config['agents'] {
  if (identities === undefined) return agents
  return agents.map((agent) => {
    const identity = identities[agent.id]
    if (identity === undefined) return agent
    const { sessionId: _sessionId, resumeSessionId: _resumeSessionId, ...rest } = agent
    return identity.resume
      ? { ...rest, resumeSessionId: identity.id }
      : { ...rest, sessionId: identity.id }
  })
}

/** Settings namespace carrying the tool-call parallelism a user owns. */
export const AGENT_LOOP_SETTINGS_NAMESPACE = 'agent-loop'

/**
 * The agent-loop fields a user owns. Deliberately a strict subset of
 * {@link Config}: `agents` is a boot-time composition array consumed once when
 * the service starts, so a stored change could only look like it had an effect.
 */
export interface AgentLoopSettings {
  /** Maximum parallel-safe calls in flight per agent step. */
  maxParallelToolCalls: number
}

/** Schema of the agent-loop settings section. */
export const AGENT_LOOP_SETTINGS_SCHEMA: z<AgentLoopSettings> = z.object({
  maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
})

/** Agent-loop plugin configuration. */
export interface Config {
  /**
   * Maximum parallel-safe calls in flight per agent step. `1` is serial;
   * omission defaults to {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}.
   */
  maxParallelToolCalls?: number
  /** Agents created or resumed at plugin startup. */
  agents: (AgentOptions & {
    /** Stable config label used in logs and as the fresh combined-id prefix. */
    id: string
    /** Optional stable identity; remounts resume its materialized history, while first use creates it fresh. */
    sessionId?: SessionId
    /** Optional workspace for a fresh session. */
    cwd?: string
    /** Persisted session to resume instead of creating a fresh session. */
    resumeSessionId?: SessionId
  })[]
}

/** Agent-loop configuration after defaults and load-time validation. */
type ResolvedConfig = Config & { maxParallelToolCalls: number }

/** 在任何配置 Agent 启动前拒绝可在本地判定的身份冲突。 */
function validateConfiguredAgents(agents: Config['agents']): void {
  const exactIdentities = new Map<SessionId, string>()
  for (const { id, sessionId, resumeSessionId } of agents) {
    const hasResumeId = resumeSessionId !== undefined && resumeSessionId !== ''
    if (sessionId !== undefined && hasResumeId) {
      throw new Error(`agent "${id}": sessionId and resumeSessionId are mutually exclusive`)
    }
    const exactIdentity = hasResumeId ? resumeSessionId : sessionId
    if (exactIdentity === undefined) continue
    const firstId = exactIdentities.get(exactIdentity)
    if (firstId !== undefined) {
      throw new Error(`agents "${firstId}" and "${id}" use duplicate exact session identity "${exactIdentity}"`)
    }
    exactIdentities.set(exactIdentity, id)
  }
}

/** Concrete agent factory and driver service. */
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

  /** Runtime schema for declarative agents. */
  static Config = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
    agents: z.array(z.object({
      id: z.string().required(),
      sessionId: z.string().min(1),
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
      maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      cwd: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
  }) as z<Config>

  /** Validated configuration owned by the agent-loop service. */
  readonly config: ResolvedConfig
  private readonly ownership: FactoryOwnership
  /** 普通 holder 防止 Cordis 通过调用方 shadow 重建 factory 的依赖 Context。 */
  private readonly runtime: { ctx: Context }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentLoop')

    const entry: AgentLoopSettings = {
      maxParallelToolCalls: resolveMaxParallelToolCalls(config.maxParallelToolCalls),
    }
    let source: () => AgentLoopSettings = () => entry
    this.config = {
      ...config,
      agents: applyLauncherIdentities(config.agents, ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY)),
      // 每次调度决策都重新读取。tool-calls.ts 在每个 group 开头取值，因此已提交
      // 的设置变更会限制下一个 group，但不会扰动正在执行的 group。
      get maxParallelToolCalls() {
        return source().maxParallelToolCalls
      },
    }
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, AGENT_LOOP_SETTINGS_NAMESPACE, AGENT_LOOP_SETTINGS_SCHEMA, entry, {
        // schema 接受任意正整数，完整规则由 resolveMaxParallelToolCalls 负责。
        // 在设置提交处拒绝无效值，使运行中的调度器继续使用上一个有效上限，
        // 而不是等到下一个工具 group 才失败。
        validate: value => void resolveMaxParallelToolCalls(value.maxParallelToolCalls),
        setSource: (current) => {
          source = current
        },
        // 没有其他状态从该上限派生；上面的 getter 是唯一读取入口。
        onChange: () => {},
      })
    })
    validateConfiguredAgents(this.config.agents)
    // 所有配置校验通过后才注册投影，保证构造函数被拒绝时不留下投影单元。
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    ctx.sessionProjections.register(inboxProjectionDefinition)
    this.ownership = new FactoryOwnership(ctx.fiber)
    this.runtime = { ctx }
    ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)

    for (const { id, sessionId, cwd, resumeSessionId, ...options } of this.config.agents) {
      const meta = cwd === undefined ? {} : { cwd }
      if (resumeSessionId === undefined || resumeSessionId === '') {
        const configuredId = sessionId ?? brandString<SessionId>(`${id}-session-${randomUUID()}`)
        const persistence = sessionId === undefined ? undefined : ctx.get('sessionPersistence')
        if (persistence === undefined) {
          const startup = this.create(configuredId, options, meta).then(() => undefined, (error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          this.ownership.trackStartup(startup)
        } else {
          const startup = this.restoreOrCreateConfigured(ctx, persistence, configuredId, options, meta).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          this.ownership.trackStartup(startup)
        }
        continue
      }
      ctx.effect(() => {
        const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
          void this.resumeWith(ctx, childCtx.sessionPersistence, {
            resumeSessionId,
            agentOptions: options,
          }).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'resume', resumeSessionId, error)
          })
        })
        return fiber.dispose
      }, `agentLoop.resume(${id})`)
    }
  }

  /** 向绑定该身份的消费者报告一次已收敛的声明式启动失败。 */
  private reportConfiguredStartupFailure(
    configId: string,
    action: 'restore' | 'resume',
    sessionId: SessionId,
    error: unknown,
  ): void {
    if (!this.ownership.isActive()) return
    this.ctx.logger.warn(`agent "${configId}": config-driven ${action} of "${sessionId}" failed: ${errorChain(error)}`)
    const args: unknown[] = ['agent-loop/config-start-failed', { sessionId, error }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((listenerError: unknown) => {
          this.ctx.logger.warn(`agent "${configId}": config-start-failed listener rejected: ${errorChain(listenerError)}`)
        })
      } catch (listenerError: unknown) {
        this.ctx.logger.warn(`agent "${configId}": config-start-failed listener threw: ${errorChain(listenerError)}`)
      }
    }
  }

  /** 重新挂载时恢复已实体化的精确配置身份；首次使用时则创建。 */
  private async restoreOrCreateConfigured(
    ownerCtx: Context,
    persistence: SessionPersistence,
    sessionId: SessionId,
    agentOptions: AgentOptions,
    meta: Pick<SessionHeader, 'cwd'>,
  ): Promise<void> {
    await this.waitForDrainingConfiguredIdentity(ownerCtx, sessionId)
    if (!this.ownership.isActive()) return
    try {
      await this.resumeWith(ownerCtx, persistence, { resumeSessionId: sessionId, agentOptions })
      return
    } catch (error: unknown) {
      if (!this.ownership.isActive()) return
      // 只有持久 Session 确实不存在时才回退到首次创建；数据损坏、写所有权冲突
      // 与后端失败必须继续抛出。
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
    }
    await this.create(sessionId, agentOptions, meta)
  }

  /** 等待同 id 的旧生命周期完成注册表 teardown。 */
  private async waitForDrainingConfiguredIdentity(ownerCtx: Context, sessionId: SessionId): Promise<void> {
    // 只有仍占用注册表的 id 需要等待。若占用者仍健康存活，后续 create/resume
    // 会把它作为身份冲突正常报告。
    if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) return

    const released = Promise.withResolvers<void>()
    const checkReleased = (): void => {
      if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) {
        released.resolve()
      }
    }
    const disposeAgentListener = ownerCtx.on('agent/disposed', () => { checkReleased() })
    const disposeSessionListener = ownerCtx.on('session/disposed', checkReleased)
    try {
      checkReleased()
      await this.ownership.waitWhileActive(released.promise)
    } finally {
      disposeAgentListener()
      disposeSessionListener()
    }
  }

  /**
   * 为新 Agent 构造驱动器、scope 与一个记忆化的逆序 teardown。发布前就把
   * teardown 注册到 factory 和 owner fiber，因此 setup 中途发生卸载也能回滚
   * 全部资源；signal 融合调用方取消与生命周期 teardown，用于中止 setup await。
   */
  private prepare(
    ownerCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    callerSignal?: AbortSignal,
    handle?: SessionHandle,
    parentAgent?: Agent,
  ): PreparedAgent {
    assertAgentOptions(options)
    ownerCtx.fiber.assertActive()
    // 调用方要么从已要求 factory fiber 存活的服务方法同步进入 prepare()，要么
    // 像 resume 加载边界一样，在 await 后重新检查所有权。
    /* v8 ignore next -- unreachable backstop, see above */
    if (!this.ownership.isActive()) throw new Error('agent loop is not active')
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason })
    }
    const loopCtx = this.runtime.ctx

    // deactivation 融合三个所有者及各自 reason：调用方取消、owner fiber 卸载和
    // factory teardown。它在任何资源产生前就注册，并闭包引用后续填充的可变
    // slot，因此即使 scope 尚在创建时发生卸载，也能找到有效 disposer。
    const abort = new AbortController()
    const onCallerAbort = (): void => {
      abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }))
    }
    const onFactoryTeardown = (): void => { abort.abort(this.ownership.signal.reason) }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true })

    let machine: ReactLoopAgent | undefined
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    let publication: ReturnType<typeof Promise.withResolvers<void>> | undefined
    const machineReady = Promise.withResolvers<void>()
    // 逆序 teardown 被记忆化，使所有并发所有者等待同一个静止点：停止驱动器，
    // 排空并关闭 Session 写路径，退出注册表，撤销 scope，释放跟踪记录。
    const dispose = (ownerTriggered = false): Promise<void> => (disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`))
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      // teardown 失败会被收集而非吞掉：注册表、scope 与 ownership 清理始终运行到
      // 静止，随后记忆化 disposal 以收集到的失败拒绝，使所有并发所有者都能观察。
      const failures: unknown[] = []
      try {
        // 创建监听器在 await 期间仍持有 Session 与 scope，销毁必须先等发布结束。
        if (publication !== undefined) await publication.promise
        // disposal 的定义就是以 disposed 原因取消，再等待完全静止。到达此处后
        // 注册表即将移除 Agent，继续发送新工作属于发送方的生命周期错误。
        /* v8 ignore next -- Cordis effect teardown waits for synchronous setup before observing the machine slot. */
        if (machine === undefined) await machineReady.promise
        /* v8 ignore next -- setup failure untracks this disposer before resolving without a machine. */
        if (machine !== undefined) {
          machine.cancel({ kind: 'disposed' })
          await machine.whenIdle()
          await machine.scope.dispose()
        }
      } catch (error: unknown) {
        failures.push(error)
      }
      // 上面的循环已把结束事件同步提交到 Session；handle.close 在释放写路径前
      // 将它们持久排空。close 可能是首次暴露持久化失败的操作，因此错误必须
      // 保留并返回，不能只写日志后忽略。
      try {
        await handle?.close()
      } catch (error: unknown) {
        failures.push(error)
      }
      try {
        detachAgent?.()
        detachSession?.()
      } finally {
        untrack()
        if (!ownerTriggered) await unfollowOwner()
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, `agent "${id}" disposal failed`)
      }
    })())
    const untrack = this.ownership.track(dispose)
    let unfollowOwner: () => Promise<void> | void
    try {
      unfollowOwner = ownerCtx.effect(function* () {
        machine = new ReactLoopAgent(loopCtx, id, options, session)
        machineReady.resolve()
        yield machine.scope.rawDispose
        yield () => {
          // owner disposal 负责同一个静止边界。由 owner effect 自身触发 teardown
          // 时，不能再从该 effect 内部注销正在运行的自己。
          if (disposing !== undefined) return
          abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
          return dispose(true)
        }
      }, `agentLoop.lifecycle(${id})`)
      /* v8 ignore start -- ctx.effect throws only on an inactive fiber, which assertActive() above already rejected */
    } catch (error: unknown) {
      machineReady.resolve()
      untrack()
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      throw error
    }
    /* v8 ignore stop */

    const assertLive = (): void => {
      if (!abort.signal.aborted) return
      // 每个融合后的中止源都携带 Error：onCallerAbort 与 raceAbort 会包装非 Error
      // 的调用方 reason，factory/lifecycle 所有者也使用构造好的 Error。
      /* v8 ignore next -- unreachable String() arm, see above */
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))
    }
    try {
      /* v8 ignore next -- a synchronous effect exhausts the generator before returning */
      if (machine === undefined) throw new Error(`agent "${id}" lifecycle did not construct its driver`)
      const agent = machine
      assertLive()

      return {
        agent,
        signal: abort.signal,
        publish: async (source) => {
          publication = Promise.withResolvers<void>()
          try {
            assertLive()
            detachSession = agent.ctx.sessions.enter(session)
            // 已挂载后端按 Session id 把发布后的实时事件路由到活动写句柄；循环
            // 只持有句柄本身，不在这里手工复制事件。
            detachAgent = loopCtx.agents.enter(agent, parentAgent)
            agent.ctx.sessions.announce(session)
            assertLive()
            await loopCtx.agents.announce(agent, source, abort.signal)
            assertLive()
            return { agent, dispose }
          } finally {
            publication.resolve()
            publication = undefined
          }
        },
        dispose,
      }
    } catch (error: unknown) {
      machineReady.resolve()
      // 回滚期间忽略 disposal rejection；原始 setup 失败是应返回给调用方的主错误。
      void dispose().catch(() => {})
      throw error
    }
  }

  /**
   * Create an agent and session under one caller-supplied identity, owned by
   * the accessing fiber. Constructor-driven config calls mint a fresh combined
   * id before entering this boundary. When a persistence backend is mounted,
   * the session's durable identity and any seed are stored before publication.
   * @param id - shared agent/session identity.
   * @param options - concrete loop options.
   * @param meta - optional fresh-session workspace metadata.
   * @returns the published running agent.
   */
  async create(id: SessionId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): Promise<Agent> {
    using preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, { meta }))
    const stored = await this.createStoredSession(preparation.session)
    let prepared: PreparedAgent
    try {
      prepared = this.prepare(this.ctx, id, options, preparation.session, undefined, stored?.handle)
    } catch (error: unknown) {
      await stored?.handle.close().catch(() => {})
      throw error
    }
    return (await this.initializeAgent(prepared, async () => {
      await this.appendUnstoredSuffix(stored, preparation.session)
      return await prepared.publish('startup')
    })).agent
  }

  /**
   * 已配置持久化时取得新 Session 的写所有权。这里不追加事件：构造 seed 不会
   * 通过 session/event 重新发出，发布提交点由 appendUnstoredSuffix 显式保存。
   * 因此校验或 setup 失败/取消时，只需关闭尚未实体化的 handle，不会留下存储
   * 残留，同一个 id 仍可再次创建。
   * @param session - 要保存、但尚未发布的 Session。
   * @param signal - 可选取消信号，传递给后端 create。
   * @returns 独占写句柄与已存 cursor；没有后端时返回 undefined。
   */
  private async createStoredSession(session: Session, signal?: AbortSignal): Promise<StoredSession | undefined> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    return { handle, storedCount: 0 }
  }

  /**
   * 持久保存上一个存储 cursor 之后追加的 Session 事件。发布前 append 的事件
   * 不会再次通过 session/event 发出，因此必须在实时事件开始路由到 handle 前，
   * 由发布流程显式 flush 这些构造 seed 标记或 setup 阶段事件。
   * @param stored - Session 的独占 handle 与已存 cursor；可不存在。
   * @param session - 需要保存后缀、尚未发布的 Session。
   */
  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session): Promise<void> {
    if (stored === undefined) return
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    // cursor 只前进本次实际保存的数量，不能直接跳到 session.seq；await 期间新
    // 追加的事件必须留给下一次 flush。
    stored.storedCount += suffix.length
  }

  /**
   * Create an owned agent on a caller-supplied session id.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, optional live parent, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    const published = (async () => {
      let stored: StoredSession | undefined
      try {
        // raceAbortCall 统一处理调用前已取消和 create 中途取消，并关闭在调用方
        // 放弃之后才完成创建的 handle。
        stored = options.signal === undefined
          ? await this.createStoredSession(preparation.session)
          : await raceAbortCall(
            () => this.createStoredSession(preparation.session, options.signal),
            options.signal,
            options.sessionId,
            (abandoned) => { void abandoned?.handle.close().catch(() => {}) },
          )
      } catch (error: unknown) {
        preparation[Symbol.dispose]()
        throw error
      }
      return this.setupAndPublish(
        ownerCtx,
        options.sessionId,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        'startup',
        stored,
        options.parentAgent,
      )
    })()
    this.ownership.trackWrapper(published)
    return published
  }

  /** 围绕已取得的 Session 准备 Agent，执行 setup，再作为一个事务发布。 */
  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    preparation: SessionPreparation,
    agentOptions: AgentOptions,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: SessionStartSource,
    stored?: StoredSession,
    parentAgent?: Agent,
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    const session = ownedPreparation.session
    let prepared: PreparedAgent
    try {
      prepared = this.prepare(ownerCtx, id, agentOptions, session, signal, stored?.handle, parentAgent)
    } catch (error: unknown) {
      await stored?.handle.close().catch(() => {})
      throw error
    }
    return await this.initializeAgent(prepared, async () => {
      const setupCommit = await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id)
      setupCommit?.commit()
      await this.appendUnstoredSuffix(stored, session)
      return await prepared.publish(source)
    })
  }

  private async initializeAgent(prepared: PreparedAgent, initialize: () => Promise<AgentHandle>): Promise<AgentHandle> {
    try {
      return await prepared.agent.runMaintenance(async () => {
        try {
          return await initialize()
        } catch (error: unknown) {
          // teardown 负责清理 Inbox，此时可能已经移除了对应投影，因此保留 Inbox。
          prepared.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
          throw error
        }
      })
    } catch (error: unknown) {
      // 回滚忽略 disposal rejection（例如最终 handle.close 失败）；调用方应首先
      // 看到导致初始化失败的原始 setup 错误。
      await prepared.dispose().catch(() => {})
      throw error
    }
  }

  /**
   * Resume an owned agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, optional live parent, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    return this.resumeWith(ownerCtx, persistence, options)
  }

  /** 通过显式持久化服务恢复；声明式配置的延迟启动路径也复用此方法。 */
  private resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const id = options.resumeSessionId
    const published = (async () => {
      // open/read 可能比 owner 活得更久，因此同时监听调用方取消、owner fiber
      // 卸载与 factory teardown，避免永不结算的后端永久占用该身份。
      const ownerAbort = new AbortController()
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      }, `agentLoop.resume-load(${id})`)
      const fused = AbortSignal.any([
        ...options.signal === undefined ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal,
      ])
      let handle: SessionHandle | undefined
      let stored: StoredSession | undefined
      let preparation: SessionPreparation | undefined
      try {
        try {
          // 首先取得写所有权，从而排除同一 id 的并发 resume；本进程中活动 Agent
          // 的 handle 会持续持有这份写 claim。
          handle = await raceAbortCall(
            () => persistence.open(id, 'write', { signal: fused }),
            fused,
            id,
            (abandoned) => { void abandoned.close() },
          )
          // 语义级崩溃修复由 Agent 层负责。持久化层只返回物理有效日志；若最后
          // 一个 turn 被中断，则生成缺失工具错误、step/end、turn/end 等 closer，
          // 并像普通批次一样通过同一 handle 追加。
          const coldRead = await handle.read(0, undefined, { signal: fused })
          fused.throwIfAborted()
          const persisted = coldRead.events
          const closers = interruptedTurnClosers(persisted)
          if (closers.length > 0) await handle.append(closers)
          preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
            seed: [...persisted, ...closers],
            meta: structuredClone(handle.header),
            inheritedEventCount: handle.inheritedEventCount,
            eventState: coldRead.eventState,
          }))
          stored = { handle, storedCount: persisted.length + closers.length }
          await this.appendUnstoredSuffix(stored, preparation.session)
        } finally {
          await unfollowOwner()
        }
        ownerCtx.fiber.assertActive()
        if (!this.ownership.isActive()) throw new Error('agent loop is not active')
        const owned = stored
        handle = undefined // 所有权已移交给 setupAndPublish/prepare。
        return await this.setupAndPublish(
          ownerCtx,
          id,
          preparation,
          options.agentOptions ?? {},
          options.setup,
          options.signal,
          'resume',
          owned,
          options.parentAgent,
        )
      } finally {
        preparation?.[Symbol.dispose]()
        await handle?.close().catch(() => {})
      }
    })()
    this.ownership.trackWrapper(published)
    return published
  }
}

export default AgentLoop
