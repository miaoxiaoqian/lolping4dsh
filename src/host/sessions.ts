/**
 * Drives the agent behind the quick ask.
 *
 * The formal Session Controller creates the Agent with the deployment's preset,
 * model selection, tools, and permissions. This plugin only observes its turns.
 *
 * A quick ask is an ordinary session. That is deliberate — the requirement is
 * that the small window and the main window show the same conversation, and the
 * only way to get that is for both to be looking at one session id.
 *
 * @module @local/dsh-quick-help/host/sessions
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Agent, Context, ModelSelection, UserMessage, Workspace, SessionInspection, ImageAttachmentRef, ImageUpload } from './dsh.ts'
import type { AskTurn } from '../shared/types.ts'
import type { ActionContext } from './binding.ts'
import { QuickHelpRecords } from './records.ts'
import { homeDir } from './settings-store.ts'
import type { WheelFeedback } from './wheel-feedback.ts'

/** One turn in a quick-ask conversation, as this module tracks it. */
interface Tracked {
  readonly id: string
  readonly role: 'user' | 'assistant'
  text: string
  readonly at: number
  streaming?: boolean
  error?: string
  seq?: number
  images?: readonly ImageAttachmentRef[]
  feedback?: { action: string }
}

/** The active assistant projection and its optional SSE observer. */
interface ActiveAnswer {
  readonly id: string
  readonly onUpdate?: (turn: AskTurn) => void
}

interface SendOptions {
  readonly feedback?: WheelFeedback
  readonly clearDraft?: boolean
  readonly images?: readonly ImageUpload[]
  readonly title?: string
  readonly timeoutMs?: number
  readonly modelRoute?: string
  readonly onUpdate?: (turn: AskTurn) => void
}

/** What a caller may set on a session. */
export interface SessionInit {
  /** Whether the user pinned the window, which survives a hide. */
  pinned?: boolean
}

/**
 * Manages quick-ask sessions.
 *
 * One conversation is reused across openings so a draft and its answers survive
 * Escape and re-invocation; a new one starts only when the user asks for it.
 */
export class SessionManager {
  /** The conversation the small window shows. */
  private currentId: string | undefined
  private readonly turns = new Map<string, Tracked[]>()
  private readonly drafts = new Map<string, string>()
  private readonly pinned = new Set<string>()
  private readonly stopped = new Set<string>()
  private readonly agents = new Map<string, Agent>()
  private readonly agentSubscriptions = new Map<string, () => void>()
  private readonly activeAnswers = new Map<string, ActiveAnswer>()
  private readonly titles = new Map<string, string>()
  private readonly sending = new Set<string>()
  /** Which session most recently had activity, for the panel's "last ask" row. */
  private lastTouched: { sessionId: string; at: number } | undefined
  private readonly owned = new Set<string>()
  private readonly persisted = new Set<string>()
  private readonly records: QuickHelpRecords
  private workspace: Promise<Workspace> | undefined
  private readonly creating = new Map<string, Promise<Agent>>()
  private readonly exportedHeads = new Map<string, number>()
  private disposed = false
  private readonly hydrations = new Map<string, Promise<boolean>>()

  /** @param ctx - The host context, for the agent registry and the default model. */
  constructor(private readonly ctx: Context, options: { stateDir?: string; workspacePath?: string } = {}) {
    this.records = new QuickHelpRecords(options.stateDir ?? join(homeDir(), 'quick-help'), options.workspacePath ?? join(homedir(), 'Documents', 'DSH快捷求助'))
    const state = this.records.read()
    this.currentId = state.currentId
    for (const item of state.records) {
      if (item.owned) this.owned.add(item.id)
      if (item.persisted) this.persisted.add(item.id)
      this.drafts.set(item.id, item.draft)
      this.titles.set(item.id, item.title)
      this.turns.set(item.id, [])
      if (item.pinned) this.pinned.add(item.id)
      if (item.stopped) this.stopped.add(item.id)
      if (!this.lastTouched || item.at > this.lastTouched.at) this.lastTouched = { sessionId: item.id, at: item.at }
    }
  }

  /** Register the dedicated directory once, reusing its durable workspace identity. */
  async ensureWorkspace(): Promise<Workspace> {
    if (!this.workspace) {
      mkdirSync(this.records.workspacePath, { recursive: true, mode: 0o700 })
      const task = this.ctx.workspaceRegistry.create(this.records.workspacePath, 'DSH快捷求助')
      this.workspace = task
      void task.catch(() => { if (this.workspace === task) this.workspace = undefined })
    }
    return this.workspace
  }

  /** Storage location shown in the settings and main-window handoff. */
  async storageInfo(): Promise<{ workspaceId: string; workspacePath: string; recordsPath: string }> {
    const workspace = await this.ensureWorkspace()
    return { workspaceId: workspace.id, workspacePath: workspace.path, recordsPath: this.records.recordsPath }
  }

  /** Update the export destination; formal DSH sessions stay in their workspace. */
  setRecordsPath(path: string): void { this.records.setRecordsPath(path); this.exportedHeads.clear() }

  isAdopted(sessionId: string, answerId: string): boolean { return this.records.isAdopted(sessionId, answerId) }

  /** Restore only this explicitly named conversation from DSH's official log. */
  async hydrate(sessionId: string): Promise<boolean> {
    if (this.disposed) return false
    const previous = this.hydrations.get(sessionId)
    const task = (previous ?? Promise.resolve(true)).catch(() => false)
      .then(() => this.hydrateOne(sessionId))
    this.hydrations.set(sessionId, task)
    const release = (): void => { if (this.hydrations.get(sessionId) === task) this.hydrations.delete(sessionId) }
    void task.then(release, release)
    return task
  }

  /** Read and export one completed log revision under the per-Session queue. */
  private async hydrateOne(sessionId: string): Promise<boolean> {
    if (this.disposed || (this.owned.has(sessionId) && !this.persisted.has(sessionId))) return false
    const inspection = await this.ctx.sessionController.inspect(sessionId)
    if (this.disposed) return false
    const ended = inspection.events.findLast(event => event.type === 'turn/end')
    const aborted = inspection.events.findLast(event => event.type === 'turn/end' && event.data.reason?.kind === 'aborted')
    const human = inspection.events.findLast(event => event.type === 'user/message' && event.data.source?.kind === 'user')
    if (this.isStopped(sessionId) && ended?.data.reason?.kind === 'completed' && aborted && human && human.seq > aborted.seq) this.setStopped(sessionId, false)
    this.persisted.add(sessionId)
    if (!this.activeAnswers.has(sessionId)) this.turns.set(sessionId, canonicalTurns(inspection))
    const title = firstUserLine(this.turns.get(sessionId) ?? [])
    if (title) this.titles.set(sessionId, title)
    const head = inspection.events.at(-1)?.seq ?? -1
    if (this.owned.has(sessionId) && !this.busy(sessionId) && this.exportedHeads.get(sessionId) !== head) {
      await this.exportImages(sessionId)
      this.records.export(sessionId, this.titles.get(sessionId) ?? '快捷问答', this.view(sessionId))
      this.exportedHeads.set(sessionId, head)
    }
    return true
  }

  /** Authoritative answer identity and user request for a frozen wheel target. */
  async context(sessionId: string, answerId?: string): Promise<{ sessionId: string; answerId: string; answerSeq: number; answerText: string; requirementText: string; versionToken: string }> {
    const inspection = await this.ctx.sessionController.inspect(sessionId)
    const end = inspection.events.findLast(event => event.type === 'turn/end')
    const turns = canonicalTurns(inspection)
    const answer = answerId ? turns.find(turn => turn.role === 'assistant' && turn.id === answerId) : turns.findLast(turn => turn.role === 'assistant' && !turn.error && turn.seq !== undefined && end !== undefined && turn.seq < end.seq)
    if (!answer || answer.seq === undefined || answer.error) throw new Error('没有找到可操作的正式回答，请先等待回答完成并重新绑定。')
    if (!end || answer.seq > end.seq) throw new Error('这段回答尚未完成，请等待后再绑定。')
    const requirement = turns.find(turn => turn.role === 'user')?.text ?? ''
    const head = inspection.events.at(-1)?.seq ?? -1
    const hash = createHash('sha256').update(answer.text).digest('hex').slice(0, 16)
    return { sessionId, answerId: answer.id, answerSeq: answer.seq, answerText: answer.text, requirementText: requirement, versionToken: `${head}:${answer.seq}:${hash}` }
  }

  /** The session the window is showing, creating one on first use. */
  current(): string {
    if (!this.currentId) {
      this.currentId = this.freshId()
      this.lastTouched = { sessionId: this.currentId, at: Date.now() }
      this.saveWindowState()
    }
    return this.currentId
  }

  /** Prepare the selected ordinary DSH Session before the compact client opens it. */
  async ensureConversation(): Promise<string> {
    const sessionId = this.current()
    await this.ensureAgent(sessionId)
    return sessionId
  }

  /** Only conversations created in the quick-help workspace belong in its picker. */
  ownedConversations(): { sessionId: string; title: string; at: number }[] {
    return this.list().filter(item => this.owned.has(item.sessionId))
  }

  /** Prepare a formal Session, then change the current conversation at the commit point. */
  async navigateConversation(expected: string, requested?: string): Promise<string> {
    if (this.current() !== expected) throw new Error('当前会话已变化，请重新选择。')
    if (requested !== undefined && !this.owned.has(requested)) throw new Error('只能切换快捷求助工作区中的会话。')
    const next = requested ?? this.freshId()
    await this.ensureAgent(next)
    if (requested !== undefined) await this.hydrate(next)
    if (this.current() !== expected) throw new Error('当前会话已变化，请重新选择。')
    this.adopt(next)
    return next
  }

  /** Start a new conversation, keeping the old one reachable from the panel. */
  reset(): string {
    this.currentId = this.freshId()
    this.lastTouched = { sessionId: this.currentId, at: Date.now() }
    this.saveWindowState()
    return this.currentId
  }

  /** Adopt an existing session, for "go to the main window" and reconnection. */
  adopt(sessionId: string): void {
    this.currentId = sessionId
    if (!this.owned.has(sessionId)) this.persisted.add(sessionId)
    this.turns.set(sessionId, this.turns.get(sessionId) ?? [])
    this.saveWindowState()
  }

  /** Record the user's choice of this exact answer; this makes no model call. */
  async adoptAnswer(answer: ActionContext): Promise<void> {
    const listed = await this.ctx.messageFeedback.list({ sessionId: answer.sessionId })
    if (!listed.ok) throw new Error(`无法读取正式会话反馈：${listed.error?.code ?? 'unknown'}`)
    const item = listed.value?.items.find(value => value.messageId === answer.answerId)
    const result = await this.ctx.messageFeedback.put({ sessionId: answer.sessionId, messageId: answer.answerId, rating: 'positive', note: '通过轮盘采纳这条回答；采纳不代表验证通过。', ifVersion: item?.version ?? null })
    if (!result.ok) throw new Error(`采纳尚未写入正式会话：${result.error?.code ?? 'unknown'}`)
    this.records.adopt({
      sessionId: answer.sessionId,
      answerId: answer.answerId,
      answerSeq: answer.answerSeq,
      versionToken: answer.versionToken,
      answerText: answer.answerText,
      adoptedAt: Date.now(),
    })
  }

  /** Whether this session exists here. */
  has(sessionId: string): boolean {
    return this.turns.has(sessionId)
  }

  /** Persist an explicit stop so restarting the UI cannot resume work implicitly. */
  setStopped(sessionId: string, stopped: boolean): void {
    if (stopped) this.stopped.add(sessionId); else this.stopped.delete(sessionId)
    this.saveWindowState()
  }

  isStopped(sessionId: string): boolean { return this.stopped.has(sessionId) }

  /** Every session this plugin has touched, newest first. */
  list(): { sessionId: string; title: string; at: number }[] {
    return [...this.turns.entries()]
      .map(([sessionId, turns]) => ({
        sessionId,
        title: this.titles.get(sessionId) ?? firstUserLine(turns) ?? '快捷问答',
        at: Math.max(...turns.map(turn => turn.at), 0),
      }))
      .sort((a, b) => b.at - a.at)
  }

  /** The most recent session, for the panel. */
  last(): { sessionId: string; title: string; at: number } | undefined {
    const held = this.lastTouched
    if (held === undefined) return undefined
    return { sessionId: held.sessionId, title: this.titles.get(held.sessionId) ?? '快捷问答', at: held.at }
  }

  /** The conversation so far. */
  view(sessionId: string): AskTurn[] {
    return (this.turns.get(sessionId) ?? []).map(turn => ({
      id: turn.id,
      role: turn.role,
      ...turn.feedback ? { feedback: turn.feedback } : {},
      text: turn.text,
      at: turn.at,
      ...turn.images?.length ? { images: turn.images.map(ref => ({ ...ref, url: `/quick-help/api/image?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(ref.attachmentId)}` })) } : {},
      ...turn.streaming === undefined ? {} : { streaming: turn.streaming },
      ...turn.error === undefined ? {} : { error: turn.error },
    }))
  }

  /** Read only an attachment referenced by a conversation already opened by this feature. */
  async readImage(sessionId: string, attachmentId: string): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }> {
    if (!this.has(sessionId)) throw new Error('该会话未在快捷求助中打开。')
    const inspection = await this.ctx.sessionController.inspect(sessionId)
    const ref = canonicalTurns(inspection).flatMap(turn => turn.images ?? []).find(image => image.attachmentId === attachmentId)
    if (!ref) throw new Error('这张图片不属于所选会话。')
    return this.ctx.attachments.readImage(ref)
  }

  private async exportImages(sessionId: string): Promise<void> {
    for (const ref of (this.turns.get(sessionId) ?? []).flatMap(turn => turn.images ?? [])) {
      const stored = await this.ctx.attachments.readImage(ref)
      this.records.image(ref, stored.data)
    }
  }

  /** The saved draft for a session. */
  draft(sessionId: string): string {
    return this.drafts.get(sessionId) ?? ''
  }

  /** Save a draft. It survives hiding, Escape and a window reload. */
  setDraft(sessionId: string, text: string): void {
    if (text === '') this.drafts.delete(sessionId)
    else this.drafts.set(sessionId, text)
    this.saveWindowState()
  }

  /** Whether the window is pinned for this session. */
  isPinned(sessionId: string): boolean {
    return this.pinned.has(sessionId)
  }

  /** Set the pinned state. */
  setPinned(sessionId: string, value: boolean): void {
    if (value) this.pinned.add(sessionId)
    else this.pinned.delete(sessionId)
    this.saveWindowState()
  }

  /** Whether a turn is streaming in this session. */
  busy(sessionId: string): boolean {
    return this.sending.has(sessionId) || this.activeAnswers.has(sessionId) || this.ctx.agents.get(sessionId)?.status === 'running'
  }

  /** Reserve one sender before asynchronous restoration can yield. */
  async send(sessionId: string, text: string, options: SendOptions = {}): Promise<string> {
    if (this.busy(sessionId)) throw new Error('当前会话正在回答，请等待或先停止。')
    this.sending.add(sessionId)
    try { return await this.performSend(sessionId, text, options) } finally { this.sending.delete(sessionId) }
  }

  /**
   * Send one instruction into the conversation.
   *
   * The user turn is recorded before the agent is asked, so a turn that fails to
   * start still leaves what the user typed visible — losing their words because
   * the model was unavailable would be its own kind of data loss.
   *
   * @param sessionId - Which conversation.
   * @param text - The instruction, already composed by an action or typed by the user.
   * @param options - Whether to title the session from this text, and a timeout.
   * @returns the assistant turn's id, for streaming updates.
   */
  private async performSend(
    sessionId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<string> {
    const trimmed = text.trim()
    if (trimmed === '') throw new Error('内容为空，没有发送。')
    if (options.images?.length && options.feedback) {
      const llm = this.ctx.get?.('llm') as { resolveModelInfo?(provider: string, model: string, signal: AbortSignal): Promise<{ inputModalities?: readonly string[] }> } | undefined
      const route = options.modelRoute || this.defaultRoute()
      const separator = route.indexOf('/')
      if (llm?.resolveModelInfo && separator > 0) {
        const model = await llm.resolveModelInfo(route.slice(0, separator), route.slice(separator + 1), AbortSignal.timeout(5_000))
        if (model.inputModalities && !model.inputModalities.includes('image')) throw new Error('当前模型不支持图片输入。截图已保留，请在 DSH 设置中切换支持图片的模型后再发送。')
      }
    }
    const content = options.feedback && options.images?.length
      ? await this.ctx.attachments.admitPromptContent([{ type: 'text', text: trimmed }, ...options.images])
      : [{ type: 'text' as const, text: trimmed }]
    const images = content.flatMap(block => block.type === 'image' ? [block.attachment] : [])
    const agent = await this.ensureAgent(sessionId)
    await this.hydrate(sessionId)
    if (options.feedback?.action === 'revise') {
      const listed = await this.ctx.messageFeedback.list({ sessionId })
      if (!listed.ok) throw new Error('无法读取回答反馈，本次改进尚未开始。')
      const current = listed.value?.items.find(item => item.messageId === options.feedback!.answerId)
      const result = await this.ctx.messageFeedback.put({ sessionId, messageId: options.feedback.answerId, rating: 'negative', note: '不满意，请改进一轮', ifVersion: current?.version ?? null })
      if (!result.ok) throw new Error(`不满意反馈尚未保存，本次改进未开始：${result.error?.code ?? 'unknown'}`)
    }
    const list = this.turns.get(sessionId) ?? []
    this.turns.set(sessionId, list)
    if (options.clearDraft) this.drafts.delete(sessionId)
    this.lastTouched = { sessionId, at: Date.now() }
    if (options.title !== undefined) this.titles.set(sessionId, options.title)
    else if (this.titles.get(sessionId) === undefined) this.titles.set(sessionId, trimmed.split('\n')[0]!.slice(0, 40))

    this.push(list, { id: this.nextId('u'), role: 'user', text: options.feedback?.summary ?? trimmed, at: Date.now(), ...(options.feedback ? { feedback: { action: options.feedback.action } } : {}), ...(images.length ? { images } : {}) })
    const answerId = this.push(list, { id: this.nextId('a'), role: 'assistant', text: '', at: Date.now(), streaming: true })
    const active: ActiveAnswer = {
      id: answerId,
      ...options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate },
    }
    this.activeAnswers.set(sessionId, active)

    const message: UserMessage = {
      id: this.nextId('m'),
      role: 'user',
      content,
      source: options.feedback ? { kind: 'quick-help-feedback', form: 'notice', ...options.feedback } : { kind: 'user' },
    }

    const timeoutMs = options.timeoutMs ?? 120_000
    const selection = options.modelRoute ? this.route(options.modelRoute) : undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (selection) await this.ctx.sessionController.selectModel({ sessionId, ...selection })
      if (options.feedback) agent.followup(message)
      else await this.ctx.sessionController.prompt({
        sessionId, requestId: this.nextId('request'), mode: 'queue',
        content: [{ type: 'text', text: trimmed }, ...(options.images ?? [])],
      }, new AbortController().signal)
      // Start the answer deadline after prompt admission; admission may validate
      // image bytes asynchronously and must not race cancellation of the turn.
      const expiry = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => {
          agent.cancel({ kind: 'hook', reason: `快捷问答等待超过 ${Math.round(timeoutMs / 1000)} 秒` })
          resolve('timeout')
        }, timeoutMs)
      })
      const settled = await Promise.race([agent.whenIdle().then(() => 'idle' as const), expiry])
      if (settled === 'timeout') {
        const turn = list.find(item => item.id === answerId)
        if (turn !== undefined && turn.streaming === true) {
          turn.streaming = false
          turn.error = `等待超过 ${Math.round(timeoutMs / 1000)} 秒，已请求停止。`
        }
        this.publish(sessionId, active)
        this.clearActive(sessionId, active)
        await this.exportImages(sessionId)
        this.records.export(sessionId, this.titles.get(sessionId) ?? '快捷问答', this.view(sessionId))
        this.saveWindowState()
        throw new Error(`等待超过 ${Math.round(timeoutMs / 1000)} 秒，已请求停止。`)
      }
    } catch (error) {
      const turn = list.find(item => item.id === answerId)
      if (turn !== undefined) {
        turn.streaming = false
        turn.error = error instanceof Error ? error.message : String(error)
      }
      this.publish(sessionId, active)
      this.clearActive(sessionId, active)
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    const turn = list.find(item => item.id === answerId)
    if (turn !== undefined) turn.streaming = false
    const streamFailure = turn?.error
    this.publish(sessionId, active)
    this.clearActive(sessionId, active)
    await this.hydrate(sessionId)
    if (streamFailure && !this.turns.get(sessionId)?.some(item => item.error)) {
      this.turns.get(sessionId)?.push({ id: `error-${randomUUID()}`, role: 'assistant', text: '', at: Date.now(), error: streamFailure })
    }
    await this.exportImages(sessionId)
    this.records.export(sessionId, this.titles.get(sessionId) ?? '快捷问答', this.view(sessionId))
    this.saveWindowState()
    const failure = this.turns.get(sessionId)?.findLast(item => item.role === 'assistant')?.error
    if (failure) throw new Error(failure)
    const completed = this.turns.get(sessionId)?.findLast(item => item.role === 'assistant' && !item.error)
    if (!completed) throw new Error('本轮没有可展示的正式回答，请检查 DSH 任务状态。')
    return completed.id
  }

  /**
   * Stop the turn in flight.
   *
   * This requests cancellation; it does not claim the agent has already stopped.
   * The caller decides what to tell the user based on the return value.
   */
  async cancel(sessionId: string, reason: string): Promise<'cancelled' | 'idle'> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined || !this.busy(sessionId)) return 'idle'
    agent.cancel({ kind: 'hook', reason })
    const list = this.turns.get(sessionId) ?? []
    for (const turn of list) {
      if (turn.streaming === true) {
        turn.streaming = false
        turn.error = '已请求停止。'
      }
    }
    return 'cancelled'
  }

  /** Whether the deployment has a model this plugin could use. */
  modelAvailable(): boolean {
    try {
      const selection = this.ctx.agentDefaultModel?.currentSelection()
      return selection !== undefined && selection.provider !== '' && selection.model !== ''
    } catch {
      return false
    }
  }

  /** The deployment's current model route, for display and for the override. */
  defaultRoute(): string {
    try {
      const selection = this.ctx.agentDefaultModel?.currentSelection()
      if (selection === undefined) return ''
      return `${selection.provider}/${selection.model}`
    } catch {
      return ''
    }
  }

  /** The route to use, honouring an override without changing the global default. */
  private route(override: string): ModelSelection | undefined {
    if (override === '') {
      try {
        return this.ctx.agentDefaultModel?.currentSelection()
      } catch {
        return undefined
      }
    }
    // Only `provider/model` is accepted, so a crafted settings file cannot point
    // the agent at an arbitrary endpoint.
    const slash = override.indexOf('/')
    if (slash <= 0 || slash === override.length - 1) return undefined
    const provider = override.slice(0, slash)
    const model = override.slice(slash + 1)
    if (!/^[\w.-]+$/.test(provider) || !/^[\w./:-]+$/.test(model)) return undefined
    return { provider, model }
  }

  /** Resolve a formally composed Agent, creating only conversations owned here. */
  private async ensureAgent(sessionId: string): Promise<Agent> {
    const pending = this.creating.get(sessionId)
    if (pending) return pending
    const task = this.createOrResume(sessionId)
    this.creating.set(sessionId, task)
    try { return await task } finally { if (this.creating.get(sessionId) === task) this.creating.delete(sessionId) }
  }

  private async createOrResume(sessionId: string): Promise<Agent> {
    if (this.owned.has(sessionId)) {
      const workspace = await this.ensureWorkspace()
      await this.ctx.sessionController.create({ sessionId, workspaceId: workspace.id })
    }
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const agent = resolved.agent
    if (this.agents.get(sessionId) !== agent) {
      this.agentSubscriptions.get(sessionId)?.()
      this.agentSubscriptions.delete(sessionId)
    }
    this.agents.set(sessionId, agent)
    this.watch(sessionId, agent)
    this.turns.set(sessionId, this.turns.get(sessionId) ?? [])
    this.persisted.add(sessionId)
    this.saveWindowState()
    return agent
  }

  /** The live agent, if one was created. */
  private agentFor(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId) ?? this.ctx.agents.get(sessionId)
  }

  /** Subscribe to the official transient stream events from this Agent. */
  private watch(sessionId: string, agent: Agent): void {
    if (this.agentSubscriptions.has(sessionId)) return
    const dispose = agent.ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return
      const active = this.activeAnswers.get(sessionId)
      if (active === undefined) return
      const turn = (this.turns.get(sessionId) ?? []).find(item => item.id === active.id)
      const fragment = frame.chunk.text
      if (turn === undefined || fragment === undefined) return
      turn.text += fragment
      this.publish(sessionId, active)
    })
    const stopErrors = agent.ctx.on('agent/error', ({ error }) => {
      const active = this.activeAnswers.get(sessionId)
      const turn = (this.turns.get(sessionId) ?? []).find(item => item.id === active?.id)
      if (turn) { turn.error = error instanceof Error ? error.message : String(error); if (active) this.publish(sessionId, active) }
    })
    const stopInput = agent.ctx.on('agent/inbox/inserted', ({ message }) => {
      const source = message.source
      if (source && typeof source === 'object' && 'kind' in source && source.kind === 'user' && this.isStopped(sessionId)) this.setStopped(sessionId, false)
    })
    const stopStatus = agent.ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || !this.owned.has(sessionId) || this.sending.has(sessionId)) return
      void this.hydrate(sessionId).catch(error => {
        const message = `快捷会话 ${sessionId} 的记录导出失败：${error instanceof Error ? error.message : String(error)}`
        if (this.ctx.logger) this.ctx.logger.error(message)
        else console.error(message)
      })
    })
    this.agentSubscriptions.set(sessionId, () => { dispose(); stopErrors(); stopStatus(); stopInput() })
  }

  /** Publish the current projection to the request that owns this turn. */
  private publish(sessionId: string, active: ActiveAnswer): void {
    const turn = (this.turns.get(sessionId) ?? []).find(item => item.id === active.id)
    if (turn === undefined) return
    active.onUpdate?.({
      role: turn.role,
      ...turn.feedback ? { feedback: turn.feedback } : {},
      text: turn.text,
      at: turn.at,
      ...turn.streaming === undefined ? {} : { streaming: turn.streaming },
      ...turn.error === undefined ? {} : { error: turn.error },
    })
  }

  /** Retire only the answer record this send installed. */
  private clearActive(sessionId: string, active: ActiveAnswer): void {
    if (this.activeAnswers.get(sessionId) === active) this.activeAnswers.delete(sessionId)
  }

  /** Release only this plugin's observers; the Session Controller owns Agents. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.saveWindowState()
    await Promise.allSettled(this.hydrations.values())
    this.agents.clear()
    for (const dispose of this.agentSubscriptions.values()) dispose()
    this.agentSubscriptions.clear()
    this.activeAnswers.clear()
    this.turns.clear()
    this.drafts.clear()
    this.pinned.clear()
  }

  /** Append a turn and return its id. */
  private push(list: Tracked[], turn: Tracked): string {
    list.push(turn)
    return turn.id
  }

  /** A short, collision-resistant id. */
  private nextId(prefix: string): string {
    return `${prefix}-${randomUUID()}`
  }

  /** A fresh conversation id. */
  private freshId(): string {
    const id = `quick-${randomUUID()}`
    this.owned.add(id)
    this.turns.set(id, [])
    return id
  }

  private saveWindowState(): void {
    const ids = new Set([...this.turns.keys(), ...this.drafts.keys(), ...this.owned, ...this.persisted])
    this.records.write({ currentId: this.currentId, records: [...ids].map(id => ({ id, owned: this.owned.has(id), persisted: this.persisted.has(id), draft: this.draft(id), pinned: this.isPinned(id), stopped: this.isStopped(id), title: this.titles.get(id) ?? '快捷问答', at: this.lastTouched?.sessionId === id ? this.lastTouched.at : Math.max(0, ...(this.turns.get(id) ?? []).map(turn => turn.at)) })) })
  }
}

/** Apply surface replacement before projecting user/assistant messages. */
function canonicalTurns(inspection: SessionInspection): Tracked[] {
  const surface: SessionInspection['events'][number][] = []
  for (const event of inspection.events) {
    if (!event.surfaceOp) continue
    if (event.surfaceOp !== 'append') {
      const { startSeq, endSeq } = event.surfaceOp
      const start = surface.findIndex(item => item.seq === startSeq)
      const end = surface.findIndex(item => item.seq === endSeq)
      if (start < 0 || end < start) throw new Error('会话替换记录不完整，不能可靠恢复对话。')
      surface.splice(start, end - start + 1, event)
    } else surface.push(event)
  }
  const turns: Tracked[] = []
  for (const event of surface) {
    const feedback = event.type === 'user/message' && event.data.source?.kind === 'quick-help-feedback' ? event.data.source : undefined
    const message = event.type === 'user/message' && (event.data.source?.kind === 'user' || feedback) ? event.data : event.type === 'assistant/message' ? event.data.message : undefined
    if (!message || !message.id || !message.content) continue
    const text = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    if (!text && event.type === 'assistant/message') continue
    const images = message.content.flatMap(block => block.type === 'image' && block.attachment ? [block.attachment] : [])
    turns.push({ id: message.id, seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text: feedback ? feedback.summary ?? '轮盘反馈' : text, at: event.time, ...(feedback ? { feedback: { action: feedback.action ?? '' } } : {}), ...(images.length ? { images } : {}), ...event.data.interrupted ? { error: '回答已中断。' } : {} })
  }
  const last = inspection.events.findLast(event => event.type === 'turn/end')
  if (last?.data.reason?.kind === 'error') {
    turns.push({ id: `error-${last.seq}`, role: 'assistant', text: '', at: last.time, error: last.data.reason.error?.message ?? '模型回答失败，请检查 DSH 模型状态后重试。' })
  } else if (last?.data.reason?.kind === 'aborted' || last?.data.reason?.kind === 'blocked') {
    turns.push({ id: `stopped-${last.seq}`, role: 'assistant', text: '', at: last.time, error: last.data.reason.kind === 'aborted' ? '本轮回答已停止。' : '本轮回答遇到阻断，请查看 DSH 任务状态。' })
  }
  return turns
}

/** The first thing the user said, used as a title. */
function firstUserLine(turns: readonly Tracked[]): string | undefined {
  const first = turns.find(turn => turn.role === 'user')
  if (first === undefined) return undefined
  const line = first.text.split('\n')[0]?.trim() ?? ''
  return line === '' ? undefined : line.length > 40 ? `${line.slice(0, 40)}…` : line
}
