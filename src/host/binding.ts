/**
 * What each action acts on.
 *
 * Every action that modifies, continues, stops, accepts or saves has to name its
 * target. Without this, "弱爆" would resolve to "whatever the newest message
 * happens to be", which is how a progress note gets mistaken for a finished
 * deliverable and how a revision lands on the wrong file.
 *
 * A binding therefore carries five things: the conversation, the specific answer
 * inside it, the artifact and its version, the action, and a unique id for this
 * one request. The last one is what makes a replayed message harmless.
 *
 * @module @local/dsh-quick-help/host/binding
 */

/** What kind of work the task is, which decides the revision checklist. */
export type TaskKind = 'code' | 'design' | 'writing' | 'paper' | 'ui' | 'general'

/** Where a target came from. */
export type BindingSource = 'explicit' | 'selected' | 'carried' | 'none'

/**
 * Everything one action needs to be unambiguous.
 *
 * `valid: false` is the important part. A binding can be recorded and then stop
 * being true — the session closed, the answer was superseded, the task was
 * deleted. The target is re-checked immediately before execution for exactly that
 * reason, and an invalid binding makes the action refuse rather than guess.
 */
export interface ActionBinding {
  /** The conversation this acts within. */
  readonly sessionId: string
  /** The specific answer being reacted to, not merely the latest message. */
  readonly answerId: string
  /** Durable sequence of the completed answer. */
  readonly answerSeq: number
  /** Token for the exact frozen answer and event-log head. */
  readonly versionToken: string
  /** Canonical assistant answer text, read from the DSH Session log. */
  readonly answerText: string
  /** Original user request in the same DSH Session. */
  readonly requirementText: string
  /** Human-readable name of the thing being acted on. */
  readonly artifactLabel: string
  /** Version marker, when the artifact has one. */
  readonly artifactVersion?: string
  /** Which task kind, which picks the revision checklist. */
  readonly kind: TaskKind
  /** Whether the target still exists and is still the one the user meant. */
  readonly valid: boolean
  /** Why it is not valid, phrased for the person who pressed the button. */
  readonly invalidReason?: string
}

/** How the binding was arrived at, which decides whether to re-check it. */
export interface BindingProvenance {
  readonly source: BindingSource
  /** When it was bound, so a stale binding can be aged out. */
  readonly at: number
  /** Candidates that existed but were not chosen, if there were several. */
  readonly candidates?: number
}

/** The task context an action is executed against. */
export interface ActionContext {
  readonly sessionId: string
  readonly answerId: string
  readonly answerSeq: number
  readonly versionToken: string
  readonly answerText: string
  readonly taskTitle: string
  readonly statusText: string
  readonly kind: TaskKind
  readonly artifactLabel: string
  readonly artifactVersion?: string
  /** The original request, as far as it can be recovered. */
  readonly requirement: string
  /** What the user selected or typed, when they supplied anything. */
  readonly text: string
}

/** One executed request, keyed so it cannot run twice. */
export interface ExecutionRecord {
  /** Unique per request. A repeat with this id is a replay and does nothing. */
  readonly requestId: string
  readonly action: string
  readonly sessionId: string
  readonly answerId: string
  readonly at: number
  /**
   * Monotonic counter, assigned at claim time.
   *
   * `at` is milliseconds, and two actions inside one millisecond is ordinary —
   * a user pressing a wheel slot twice in a burst. Sorting on `at` alone would
   * leave that case to the sort's stability, which happens to preserve insertion
   * order and therefore put the *older* record first. This counter is what makes
   * "newest first" true regardless of clock resolution.
   */
  readonly seq: number
  readonly outcome: 'accepted' | 'queued' | 'merged' | 'refused' | 'failed'
  readonly note?: string
}

/**
 * Tracks which target is bound and refuses stale ones.
 *
 * The wheel fixes a target when it opens and re-checks it before running. That is
 * the difference between "the user meant the answer they were looking at" and
 * "whatever finished writing in the meantime".
 */
export class BindingTracker {
  private current: { binding: ActionBinding; provenance: BindingProvenance } | undefined
  private readonly executed = new Map<string, ExecutionRecord>()
  /** Monotonic claim counter; see {@link ExecutionRecord.seq}. */
  private claimSeq = 0

  /**
   * Bind a target.
   *
   * @param binding - What the action will act on.
   * @param source - Why this target was chosen.
   */
  bind(binding: ActionBinding, source: BindingProvenance['source']): void {
    this.current = { binding, provenance: { source, at: Date.now() } }
  }

  /** The bound target, if any. */
  get bound(): ActionBinding | undefined {
    return this.current?.binding
  }

  /** How the current target was chosen. */
  get provenance(): BindingProvenance | undefined {
    return this.current?.provenance
  }

  /**
   * The target to execute against, re-checked now.
   *
   * @param action - The action about to run, for the refusal message.
   * @returns The context, or why there is none.
   */
  prepare(action: string, targetToken?: string, expectedSessionId?: string): { ok: true; context: ActionContext } | { ok: false; reason: string } {
    const held = this.current
    if (held === undefined) {
      return { ok: false, reason: `当前还没有可反馈的回答。请先在小窗提问并等待回答完成；评价桌面端的回答时，点该回答的「对这条使用轮盘」。` }
    }
    if (expectedSessionId !== undefined && expectedSessionId !== held.binding.sessionId) {
      return { ok: false, reason: '轮盘打开后绑定会话已变化，未对其他任务执行操作。请重新呼出轮盘。' }
    }
    if (!held.binding.valid) {
      return {
        ok: false,
        reason: held.binding.invalidReason ?? `「${action}」的目标已失效（${held.binding.artifactLabel}），请重新选择。`,
      }
    }
    const isStop = action === 'stop' || action === '危险' || action === '停止'
    if (targetToken !== undefined && targetToken !== held.binding.versionToken && !isStop) {
      return { ok: false, reason: '轮盘打开后目标回答已变化，请重新呼出并确认目标。' }
    }
    return {
      ok: true,
      context: {
        sessionId: held.binding.sessionId,
        answerId: held.binding.answerId,
        answerSeq: held.binding.answerSeq,
        versionToken: held.binding.versionToken,
        answerText: held.binding.answerText,
        taskTitle: held.binding.artifactLabel.split(' / ')[0] ?? held.binding.artifactLabel,
        statusText: held.binding.artifactLabel,
        kind: held.binding.kind,
        artifactLabel: held.binding.artifactLabel,
        ...held.binding.artifactVersion === undefined ? {} : { artifactVersion: held.binding.artifactVersion },
        requirement: held.binding.requirementText,
        text: held.binding.answerText,
      },
    }
  }

  /** Replace the canonical answer snapshot only when its identity still matches. */
  refresh(snapshot: Pick<ActionBinding, 'sessionId' | 'answerId' | 'answerSeq' | 'versionToken' | 'answerText' | 'requirementText'>): boolean {
    const held = this.current
    if (held === undefined || held.binding.sessionId !== snapshot.sessionId || held.binding.answerId !== snapshot.answerId) return false
    this.current = { ...held, binding: { ...held.binding, ...snapshot, valid: true, invalidReason: undefined } }
    return true
  }

  /** Follow the next completed answer in the same quick-help task. */
  advance(snapshot: Pick<ActionBinding, 'sessionId' | 'answerId' | 'answerSeq' | 'versionToken' | 'answerText' | 'requirementText'>): void {
    const held = this.current
    if (held !== undefined && held.binding.sessionId !== snapshot.sessionId) return
    const base: ActionBinding = held?.binding ?? {
      ...snapshot,
      artifactLabel: '当前小窗的上一条回答',
      kind: 'general',
      valid: true,
    }
    this.current = {
      binding: { ...base, ...snapshot, valid: true, invalidReason: undefined },
      provenance: { source: held?.provenance.source ?? 'carried', at: Date.now() },
    }
  }

  /** Mark the selected answer invalid without silently changing its identity. */
  invalidate(reason: string): void {
    const held = this.current
    if (held !== undefined) this.current = { ...held, binding: { ...held.binding, valid: false, invalidReason: reason } }
  }

  /** Fill in what {@link prepare} could not know on its own. */
  context(detail: Partial<ActionContext>): ActionContext {
    const base = this.current?.binding
    if (base === undefined) throw new Error('quick help: no binding to build a context from')
    return {
      sessionId: base.sessionId,
      answerId: detail.answerId ?? base.answerId,
      answerSeq: detail.answerSeq ?? base.answerSeq,
      versionToken: detail.versionToken ?? base.versionToken,
      answerText: detail.answerText ?? base.answerText,
      taskTitle: detail.taskTitle ?? base.artifactLabel,
      statusText: detail.statusText ?? '进行中',
      kind: detail.kind ?? base.kind,
      artifactLabel: detail.artifactLabel ?? base.artifactLabel,
      ...detail.artifactVersion === undefined && base.artifactVersion === undefined
        ? {}
        : { artifactVersion: detail.artifactVersion ?? base.artifactVersion },
      requirement: detail.requirement ?? base.requirementText,
      text: detail.text ?? base.answerText,
    }
  }

  /**
   * Claim a request id.
   *
   * The `set` is bounded because it only needs to outlive a history replay or a
   * reconnect, not the whole session; an hour-old message is never re-sent by
   * anything this plugin does.
   */
  claim(requestId: string, action: string, outcome: ExecutionRecord['outcome'], note?: string): boolean {
    if (this.executed.has(requestId)) return false
    this.claimSeq += 1
    this.executed.set(requestId, {
      requestId, action, outcome, note,
      sessionId: this.current?.binding.sessionId ?? '',
      answerId: this.current?.binding.answerId ?? '',
      at: Date.now(),
      seq: this.claimSeq,
    })
    if (this.executed.size > 200) {
      const oldest = [...this.executed.values()].sort((a, b) => a.seq - b.seq)[0]
      if (oldest !== undefined) this.executed.delete(oldest.requestId)
    }
    return true
  }

  /** Whether a request id has already run. */
  seen(requestId: string): boolean {
    return this.executed.has(requestId)
  }

  /** Recent executions, newest first, for the panel. */
  history(limit = 20): ExecutionRecord[] {
    // Sorted on the claim counter, not the timestamp: see {@link ExecutionRecord.seq}.
    return [...this.executed.values()].sort((a, b) => b.seq - a.seq).slice(0, limit)
  }

  /** Forget the bound target, without forgetting what already ran. */
  clear(): void {
    this.current = undefined
  }
}
