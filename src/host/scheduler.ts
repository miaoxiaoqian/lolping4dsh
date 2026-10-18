/**
 * Runs one action at a time against one target, and merges the repeats.
 *
 * Two rules drive this file:
 *
 *  - A second 「弱爆」 while a revision is in flight must not start a second
 *    writer. Two agents editing one file is not a slower revision, it is a
 *    corrupted one. So repeats merge into the pending round and the user is told
 *    they merged.
 *  - 「危险」 must actually stop things. It cancels the turn in flight, discards
 *    every queued request that has not started, and then says what it did — not
 *    what it hopes will happen. Cancelling is not undoing: files already written
 *    stay written.
 *
 * @module @local/dsh-quick-help/host/scheduler
 */
import type { ActionContext } from './binding.ts'
import type { BindingTracker } from './binding.ts'
import { feedbackSummary, type WheelFeedback } from './wheel-feedback.ts'

/** Builds the instruction for one action from its target context. */
type Builder = (ctx: ActionContext) => string

/** What the scheduler does with one accepted request. */
export type DispatchOutcome =
  /** Started now. */
  | { readonly kind: 'started' }
  /** A round was already running; this was folded into it. */
  | { readonly kind: 'merged'; readonly running: string }
  /** Nothing to do — the task is idle and complete, or already in the target state. */
  | { readonly kind: 'noop'; readonly reason: string; readonly feedback?: boolean }
  /** Refused, with a reason the user can act on. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** Started, but it ended badly. */
  | { readonly kind: 'failed'; readonly reason: string }

/** State the scheduler needs to know about the agent it drives. */
export interface AgentDriver {
  /** Send one user turn into the conversation. */
  send(sessionId: string, prompt: string, meta?: { readonly feedback?: WheelFeedback }): Promise<void>
  /** Ask the agent to stop whatever it is doing. */
  cancel(sessionId: string, reason: string): Promise<'cancelled' | 'idle'>
  /** Whether a turn is currently running in this session. */
  busy(sessionId: string): boolean
}

/** One request waiting for its turn. */
interface PendingRequest {
  readonly requestId: string
  readonly action: string
  readonly sessionId: string
  readonly prompt: string
  readonly feedback?: WheelFeedback
  readonly at: number
}

/** Options for one dispatch. */
export interface DispatchOptions {
  readonly action: string
  readonly requestId: string
  readonly text?: string
  /** Snapshot token recorded when the wheel opened. */
  readonly targetToken?: string
  /** Frozen session identity from the wheel, required for stop as well. */
  readonly targetSessionId?: string
}

/** Construction parameters. */
export interface SchedulerOptions {
  readonly driver: AgentDriver
  readonly bindings: BindingTracker
  /** Persist an exact user adoption without asking the model to assess it. */
  readonly adoptAnswer: (answer: ActionContext) => void | Promise<void>
  readonly stoppedState?: { has(sessionId: string): boolean; set(sessionId: string, stopped: boolean): void }
  /** Prompt builder per action; an action with no builder sends the raw text. */
  readonly prompts: Readonly<Record<string, Builder>>
  /**
   * Whether an action may run without a bound target.
   *
   * Only 「求救」 qualifies: opening a fresh question is the one thing that
   * legitimately has nothing to act on. Every other action must name a target,
   * and inventing a context-free task would be worse than refusing.
   */
  readonly allowUnbound?: (action: string) => boolean
}

/**
 * Serialises actions per session.
 *
 * One queue per session rather than one globally: a revision on one task must not
 * block an unrelated stop request on another.
 */
export class ActionScheduler {
  private readonly running = new Map<string, { action: string; sessionId: string }>()
  private readonly queues = new Map<string, PendingRequest[]>()
  private readonly stopped = new Set<string>()
  private readonly failures = new Map<string, string>()

  /** Failure of the latest accepted operation, also visible after its HTTP acknowledgement. */
  lastError(sessionId: string): string | undefined { return this.failures.get(sessionId) }

  /** @param options - The agent driver, the binding tracker, and the unbound policy. */
  constructor(private readonly options: SchedulerOptions) {}

  /** Whether anything is running for this session. */
  isBusy(sessionId: string): boolean {
    const local = this.running.get(sessionId)
    if (local !== undefined) return true
    return (this.queues.get(sessionId) ?? []).length > 0
  }

  /** How many requests are waiting, for the status line. */
  queued(sessionId: string): number {
    return (this.queues.get(sessionId) ?? []).length
  }

  /** What is currently running, for the status line. */
  runningNow(sessionId: string): string | undefined {
    return this.running.get(sessionId)?.action
  }

  /**
   * Stop a session's work.
   *
   * The order is deliberate: cancel the turn first so the agent stops writing,
   * then drop the queue so nothing restarts it, then clear the stop marker only
   * after both are done. A queued 「弱爆」 that survived would resume the moment
   * the agent went idle, which is the exact opposite of what was asked for.
   *
   * @returns what actually happened, so the UI can say "stopping" versus "stopped".
   */
  async stop(sessionId: string, reason: string): Promise<'stopping' | 'stopped' | 'idle'> {
    const hadQueue = (this.queues.get(sessionId) ?? []).length > 0
    const wasRunning = this.running.get(sessionId) !== undefined || this.options.driver.busy(sessionId)
    if (wasRunning || hadQueue) { this.stopped.add(sessionId); this.options.stoppedState?.set(sessionId, true) }
    this.queues.delete(sessionId)
    this.running.delete(sessionId)
    if (!wasRunning) return hadQueue ? 'stopped' : 'idle'
    const result = await this.options.driver.cancel(sessionId, reason)
    // The marker stays until the next explicit 「继续」: a task that was stopped
    // must not resume because something else happened to the agent.
    return result === 'cancelled' ? 'stopping' : 'stopped'
  }

  /** Clear the stop marker, which only an explicit continue does. */
  resume(sessionId: string): void {
    this.stopped.delete(sessionId)
    this.options.stoppedState?.set(sessionId, false)
  }

  /** Whether this session was stopped and not yet resumed. */
  isStopped(sessionId: string): boolean {
    return this.options.stoppedState ? this.options.stoppedState.has(sessionId) : this.stopped.has(sessionId)
  }

  /**
   * Run one action.
   *
   * @param action - The action identifier.
   * @param options - The request id, and any text the user supplied.
   * @returns What happened, in terms the window can show verbatim.
   */
  async dispatch(action: string, options: DispatchOptions): Promise<DispatchOutcome> {
    const { bindings } = this.options

    // A replayed or re-delivered request must not act twice. This is checked
    // before anything else, so even a refused request is not retried forever.
    if (bindings.seen(options.requestId)) {
      return { kind: 'noop', reason: '这个请求已经执行过了，没有重复执行。' }
    }

    const prepared = this.buildPrompt(action, options)
    if (!('ok' in prepared)) {
      bindings.claim(options.requestId, action, 'refused', prepared.reason)
      return { kind: 'refused', reason: prepared.reason }
    }
    const { sessionId, prompt } = prepared
    const answer = bindings.bound
    const feedback: WheelFeedback | undefined = action !== 'ask' && answer ? {
      action, requestId: options.requestId, answerId: answer.answerId, answerSeq: answer.answerSeq,
      versionToken: answer.versionToken, summary: feedbackSummary(action),
    } : undefined

    // Danger is an actual cancellation, never a prompt sent to the agent. It
    // bypasses the per-session queue so it can stop a busy turn immediately.
    if (action === 'stop') {
      bindings.claim(options.requestId, action, 'accepted')
      const result = await this.stop(sessionId, '用户从轮盘请求停止当前任务')
      return { kind: 'noop', feedback: result !== 'idle', reason: result === 'stopping' ? '已请求停止，正在等待当前操作结束。' : result === 'stopped' ? '已停止，并已清除排队中的请求。' : '当前没有正在执行的任务。' }
    }

    if (action === 'accept') {
      try {
        await this.options.adoptAnswer(bindings.context({}))
        bindings.claim(options.requestId, action, 'accepted')
        return { kind: 'noop', feedback: true, reason: '已采纳这条回答；这表示你的选择，不代表已验证。' }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        bindings.claim(options.requestId, action, 'failed', reason)
        return { kind: 'failed', reason }
      }
    }

    if (action === 'continue' && !this.isStopped(sessionId)) {
      const reason = '当前任务没有被停止，无需继续。'
      bindings.claim(options.requestId, action, 'accepted', reason)
      return { kind: 'noop', reason }
    }

    if (this.isStopped(sessionId) && action !== 'continue' && action !== 'ask') {
      const reason = '这个任务已被停止。请先用「正在路上」继续，再执行其他动作。'
      bindings.claim(options.requestId, action, 'refused', reason)
      return { kind: 'refused', reason }
    }
    if (action === 'continue') this.resume(sessionId)

    const merging = action === 'revise' && this.isBusy(sessionId)
    if (merging) {
      // Merged, not queued behind a second writer. The running revision will pick
      // this up when it reports; the queue holds one marker per session action.
      const queue = this.queues.get(sessionId) ?? []
      const existing = queue.find(item => item.action === action)
      if (existing === undefined) {
        queue.push({ requestId: options.requestId, action, sessionId, prompt, feedback, at: Date.now() })
        this.queues.set(sessionId, queue)
      }
      bindings.claim(options.requestId, action, 'merged')
      return { kind: 'merged', running: this.runningNow(sessionId) ?? '正在进行的动作' }
    }

    if (this.isBusy(sessionId)) {
      const queue = this.queues.get(sessionId) ?? []
      queue.push({ requestId: options.requestId, action, sessionId, prompt, feedback, at: Date.now() })
      this.queues.set(sessionId, queue)
      bindings.claim(options.requestId, action, 'queued')
      return { kind: 'noop', reason: `当前任务正在处理中，${this.actionLabel(action)}已排队。` }
    }

    bindings.claim(options.requestId, action, 'accepted')
    this.failures.delete(sessionId)
    void this.execute(sessionId, action, prompt, feedback)
    return { kind: 'started' }
  }

  /** Build the prompt, refusing when there is no valid target. */
  private buildPrompt(
    action: string,
    options: DispatchOptions,
  ): { ok: true; sessionId: string; prompt: string } | { reason: string } {
    const { bindings } = this.options
    const prepared = bindings.prepare(this.actionLabel(action), options.targetToken, options.targetSessionId)
    if (!prepared.ok) {
      if ((this.options.allowUnbound?.(action) ?? false) === false) return { reason: prepared.reason }
      return { ok: true, sessionId: 'new', prompt: options.text ?? '' }
    }
    const detail = bindings.context({ text: options.text ?? '' })
    const build = this.options.prompts[action]
    const prompt = build === undefined ? String(options.text ?? '') : build(detail)
    return { ok: true, sessionId: detail.sessionId, prompt }
  }

  /**
   * Send one prompt and drain whatever the queue holds.
   *
   * The drain loop is what makes a merged 「弱爆」 real: the follow-up round only
   * starts after the previous one reports, never alongside it.
   */
  private async execute(sessionId: string, action: string, prompt: string, feedback?: WheelFeedback): Promise<DispatchOutcome> {
    const running = { action, sessionId }
    this.running.set(sessionId, running)
    try {
      await this.options.driver.send(sessionId, prompt, { feedback })
      await this.waitIdle(sessionId)
      return { kind: 'started' }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // The failure is cleared from `running` in the `finally` below too; doing it
      // here as well is harmless and keeps the map honest if `waitIdle` throws.
      this.failures.set(sessionId, reason)
      this.queues.delete(sessionId)
      this.options.bindings.claim(`failed:${sessionId}:${Date.now()}`, action, 'failed', reason)
      return { kind: 'failed', reason }
    } finally {
      if (this.running.get(sessionId) === running) {
        this.running.delete(sessionId)
        if (!this.isStopped(sessionId)) this.drain(sessionId)
      }
    }
  }

  /** Start whatever was queued, one at a time. */
  private drain(sessionId: string): void {
    const queue = this.queues.get(sessionId)
    if (queue === undefined || queue.length === 0) return
    const [next, ...rest] = queue
    if (next === undefined) return
    if (rest.length === 0) this.queues.delete(sessionId)
    else this.queues.set(sessionId, rest)
    void this.execute(sessionId, next.action, next.prompt, next.feedback)
  }

  /** Resolve when the agent has nothing running. */
  private async waitIdle(sessionId: string): Promise<void> {
    // Bounded so a wedged agent cannot hold the queue open forever; the user can
    // always stop it explicitly, and a stuck turn is visible in the window.
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (!this.options.driver.busy(sessionId)) return
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    throw new Error('任务长时间没有返回空闲状态，请停止后检查会话。')
  }

  /** Chinese label for an action, used in refusal and queue messages. */
  actionLabel(action: string): string {
    return ACTION_LABELS[action] ?? action
  }
}

/** Chinese labels, kept beside the scheduler that emits them. */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  ask: '求救',
  revise: '弱爆',
  explain: '一脸问号',
  verify: '需要视野',
  stop: '危险',
  continue: '正在路上',
  save: 'GG',
  accept: '超赞的',
  hide: '溜了溜了',
}

/** Input each action needs before it can run. */
export const ACTION_INPUT: Readonly<Record<string, 'none' | 'ask' | 'selection'>> = {
  ask: 'ask',
  revise: 'selection',
  explain: 'selection',
  verify: 'none',
  stop: 'none',
  continue: 'none',
  save: 'none',
  accept: 'none',
  hide: 'none',
}
