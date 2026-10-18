/**
 * 全局轮盘与快捷求助 — host half.
 *
 * One activation owns six things and unwinds all six: the asset catalogue, the
 * settings, the action registry, the target bindings, the quick-ask sessions, and
 * the HTTP surface that serves the settings panel plus the three overlay pages.
 *
 * The split that matters here is between this file and the Electron main process.
 * The desktop side contributes exactly three capabilities — a floating window, a
 * global hotkey, and the native input helper — because a plugin in the Host
 * process has no way to obtain any of them. Everything with a decision in it
 * lives here: which actions exist, what an action does, what it acts on, and what
 * the user is told afterwards.
 *
 * @module @local/dsh-quick-help
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, NodeRequest, NodeResponse, WebServer } from './dsh.ts'
import { AssetResolver, assetType } from './asset-resolver.ts'
import { FeedbackSlot } from './feedback.ts'
import type { PendingMedia } from './feedback.ts'
import { ActionScheduler, ACTION_INPUT, ACTION_LABELS } from './scheduler.ts'
import type { AgentDriver } from './scheduler.ts'
import { BindingTracker } from './binding.ts'
import { currentTarget } from './current-target.ts'
import type { ActionBinding, TaskKind } from './binding.ts'
import { PROMPTS } from './prompts.ts'
import { SessionManager } from './sessions.ts'
import { SettingsStore, homeDir, normalizeSettings, SIZE_CHOICES } from './settings-store.ts'
import { MediaStatus } from './media-status.ts'
import { registerRoutes } from './routes.ts'
import { ALL_SLOTS, DEFAULT_SLOTS, HOVER_SOUND, SECTOR_COUNT } from '../shared/assets.ts'
import type { AssetSlot } from '../shared/assets.ts'
import { describeChord, parseAccelerator } from '../shared/hotkey.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import type { QuickHelpSettings, QuickHelpStatus } from '../shared/types.ts'

/**
 * Services this plugin calls.
 *
 * `storageDomain` is absent from the list on purpose. Nothing here is worth
 * persisting in a backup or an export: the settings are one small JSON file in
 * the plugin's own directory, and the conversations already live in DSH's own
 * sessions. A domain would be a second copy of state that could disagree.
 */
export const inject = ['agentDefaultModel', 'agents', 'sessionController', 'workspaceRegistry', 'attachments', 'messageFeedback', 'webServer']

/** Plugin display name, used in diagnostics. */
export const name = 'quick-help'

/** Every action this plugin ships, in wheel order. */
const BUILTIN_ACTIONS = DEFAULT_SLOTS.map(slot => slot.id)

/** Asset identifiers a settings file may reference. */
const KNOWN_SLOTS = ALL_SLOTS.map(slot => slot.id)

/** Task kinds a binding may declare. Anything else falls back to `general`. */
const TASK_KINDS: readonly TaskKind[] = ['code', 'design', 'writing', 'paper', 'ui', 'general']

/** Helper states the desktop layer may report. */
const HELPER_STATUSES: readonly QuickHelpStatus['helper'][] = ['stopped', 'starting', 'running', 'no-access', 'crashed', 'unsupported']

/** Read a string field, falling back when it is absent or the wrong shape. */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Mount point shared with the overlay pages and the settings panel. */
const API_BASE = '/quick-help'

/** Where the plugin's own files sit, relative to the built bundle. */
function pluginRoot(): string {
  // The built artifact is lib/index.js, so the package root is one level up. The
  // assets are addressed from there rather than from the current directory,
  // which is wherever the Host happened to be started.
  const here = fileURLToPath(import.meta.url)
  return join(here, '..', '..')
}

/** Describe an unknown thrown value for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Activate the plugin.
 *
 * @param ctx - Host context carrying the injected services.
 * @returns the disposer Cordis runs on unload, HMR replacement, and recomposition.
 */
export function apply(ctx: Context): () => void {
  const log = (level: 'info' | 'warn', message: string): void => {
    if (level === 'info') ctx.logger?.info(`dsh-quick-help: ${message}`)
    else ctx.logger?.warn(`dsh-quick-help: ${message}`)
  }

  const root = pluginRoot()
  const assets = new AssetResolver(join(root, 'assets'))
  const store = new SettingsStore(join(homeDir(), 'quick-help'))
  const sessions = new SessionManager(ctx)
  const playback = new MediaStatus(join(homeDir(), 'quick-help', 'media-status.json'))
  const bindings = new BindingTracker()

  let settings: QuickHelpSettings = store.read(KNOWN_SLOTS)
  /** What the desktop layer reported about the machine and the helper. */
  let runtime: { status: QuickHelpStatus['helper']; detail?: string; boundHotkey: string } = {
    status: 'stopped',
    boundHotkey: '',
  }
  /** The overlay window's reported state, kept so the panel can show it. */
  let feedback: { action: string; at: number; outcome: string } | undefined
  /**
   * Media handed to the next window that outlives the gesture.
   *
   * The wheel closes the moment a slice is released, so anything started there is
   * hidden before its first frame paints. See `FeedbackSlot` for the drain rule.
   */
  const media = new FeedbackSlot()

  const scheduler = new ActionScheduler({
    bindings,
    adoptAnswer: answer => sessions.adoptAnswer(answer),
    stoppedState: { has: id => sessions.isStopped(id), set: (id, stopped) => sessions.setStopped(id, stopped) },
    prompts: PROMPTS,
    driver: makeDriver(sessions, bindings, log, () => settings),
    // Only 「求救」 may run with nothing bound: opening a fresh question is the one
    // thing that legitimately has no target. Every other action must name one.
    allowUnbound: action => action === 'ask',
  })

  /**
   * Recompute settings after a change and persist them.
   *
   * The plugin owns the preferences; the desktop layer is told what to bind from
   * the overlay page, which is the only place that can observe whether the hotkey
   * was actually accepted by the OS.
   */
  const refresh = (next: QuickHelpSettings): void => {
    settings = next
    store.write(next)
    log('info', `设置已更新：快捷键 ${next.hotkey}，模式 ${next.mode === 'hold' ? '按住' : '按键'}，${next.paused ? '已暂停' : '运行中'}。`)
  }

  /**
   * Bind the target the wheel will act on.
   *
   * The five fields are all required. An action that acts on "the newest message"
   * is exactly the failure this prevents: a progress note read as a finished
   * deliverable, or a revision landing on the wrong file.
   */
  const bindTarget = async (raw: unknown): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const sessionId = str(input.sessionId, '')
    const answerId = str(input.answerId, '')
    const artifactLabel = str(input.artifactLabel, '')
    if (sessionId === '' || answerId === '' || artifactLabel === '') {
      return { ok: false, reason: '绑定目标需要会话标识、回答标识和结果名称。请在 DSH 里选中一个具体回答后再绑定。' }
    }
    let snapshot: Awaited<ReturnType<SessionManager['context']>>
    try {
      snapshot = await sessions.context(sessionId, answerId)
    } catch (error) {
      return { ok: false, reason: describe(error) }
    }
    const kind = str(input.kind, 'general') as TaskKind
    bindings.bind({
      ...snapshot,
      artifactLabel,
      ...str(input.artifactVersion, '') === '' ? {} : { artifactVersion: str(input.artifactVersion, '') },
      kind: TASK_KINDS.includes(kind) ? kind : 'general',
      valid: true,
    }, str(input.source, 'explicit') === 'carried' ? 'carried' : 'explicit')
    return { ok: true }
  }

  /** Refresh the canonical bound-answer version just before the wheel opens. */
  const refreshTarget = async (): Promise<ActionBinding | undefined> => {
    return currentTarget(sessions, bindings)
  }
  const advanceTarget = async (sessionId: string, answerId: string): Promise<void> => {
    const snapshot = await sessions.context(sessionId, answerId)
    bindings.bind({ ...snapshot, artifactLabel: '当前小窗的上一条回答', kind: 'general', valid: true }, 'carried')
  }

  const view = {
    settings: (): QuickHelpSettings => settings,
    slots: (): readonly AssetSlot[] => settings.actions
      .map(id => ALL_SLOTS.find(slot => slot.id === id))
      .filter((slot): slot is AssetSlot => slot !== undefined),
    catalogue: (): readonly AssetSlot[] => ALL_SLOTS,
    status: (): QuickHelpStatus => ({
      supported: process.platform === 'darwin',
      accessibility: runtime.status !== 'no-access',
      helper: runtime.status,
      ...runtime.detail === undefined ? {} : { helperDetail: runtime.detail },
      boundHotkey: runtime.boundHotkey,
      defaultModelRoute: sessions.defaultRoute(),
      modelAvailable: sessions.modelAvailable(),
      ...sessions.last() === undefined ? {} : { lastSession: sessions.last() },
    }),
    feedback: () => feedback,
    media: playback,
    // Parsed once here and handed to the page, so the virtual-key table exists in
    // exactly one place. A page-side copy that drifted would mean the helper
    // watched one key while the UI claimed another.
    trigger: (): { code: number; mask: number; label: string; key: string } | undefined => {
      const parsed = parseAccelerator(settings.hotkey)
      if (parsed === undefined) return undefined
      return { code: parsed.code, mask: parsed.mask, label: describeChord(parsed.accelerator), key: parsed.key }
    },
    // See `FeedbackSlot` for why reading drains rather than peeking.
    takeFeedback: (): PendingMedia | undefined => media.take(),
    queueFeedback: (animation: string, sound: string): void => media.queue(animation, sound),
    /** The target the wheel would act on right now, for the centre label. */
    target: (): ActionBinding | undefined => bindings.bound,
    refreshTarget,
    advanceTarget,
    sizes: SIZE_CHOICES,
    labels: ACTION_LABELS,
    inputs: ACTION_INPUT,
    tick: HOVER_SOUND,
    bindTarget,
    setSettings: (raw: unknown): QuickHelpSettings => {
      refresh(normalizeSettings(raw, KNOWN_SLOTS))
      return settings
    },
    reportRuntime: (raw: unknown): void => {
      const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
      const status = str(input.helper, runtime.status)
      runtime = {
        status: (HELPER_STATUSES as readonly string[]).includes(status)
          ? status as QuickHelpStatus['helper']
          : runtime.status,
        ...str(input.detail, '') === '' ? {} : { detail: str(input.detail, '') },
        boundHotkey: str(input.boundHotkey, runtime.boundHotkey),
      }
    },
    reportFeedback: (action: string, outcome: string): void => { feedback = { action, outcome, at: Date.now() } },
    // Handed to the routes so a handler can resolve assets and drive a session
    // without this module re-exporting them under a narrower type.
    assets,
    sessions,
    bindings,
    scheduler,
  }

  const unmount = { dispose: () => {} }
  unmount.dispose = registerRoutes({ webServer: ctx.webServer, log, ...view })

  log('info', `已就绪：${BUILTIN_ACTIONS.length} 个动作，${SECTOR_COUNT} 格轮盘，快捷键 ${settings.hotkey}。`)

  return ctx.effect(() => async () => {
    // Order matters. Routes go first so a late request cannot reach a scheduler
    // that is about to be torn down, then every session still streaming is asked
    // to stop — an agent left mid-turn while its handle is disposed would report
    // a failure the user never caused — and only then are the agents released.
    unmount.dispose()
    await stopEverySession(sessions)
    await sessions.dispose()
    bindings.clear()
    log('info', '已卸载，输入捕获已释放。')
  }, 'quick-help.lifecycle()')
}

/**
 * Ask every streaming session to stop.
 *
 * One failure must not prevent the others from stopping, so each is settled
 * individually and the first problem is only logged.
 */
async function stopEverySession(sessions: SessionManager): Promise<void> {
  for (const { sessionId } of sessions.list()) {
    try {
      await sessions.cancel(sessionId, '插件已卸载')
    } catch {
      // Disposing the handle below is the real guarantee; this is politeness.
    }
  }
}

/**
 * Adapt the session manager to what the scheduler drives.
 *
 * The scheduler asks three questions — send, cancel, is it busy — and this is
 * where they are answered against real sessions.
 */
function makeDriver(
  sessions: SessionManager,
  bindings: BindingTracker,
  log: (level: 'info' | 'warn', message: string) => void,
  settings: () => QuickHelpSettings,
): AgentDriver {
  return {
    async send(sessionId, prompt, meta) {
      if (sessionId === 'new') {
        // 「求救」 with nothing bound opens a fresh conversation rather than
        // failing. The text becomes the first user turn.
        const fresh = sessions.reset()
        const answerId = await sessions.send(fresh, prompt, { timeoutMs: settings().timeoutMs, modelRoute: settings().modelRoute })
        bindings.advance(await sessions.context(fresh, answerId))
        return
      }
      const answerId = await sessions.send(sessionId, prompt, { timeoutMs: settings().timeoutMs, modelRoute: settings().modelRoute, feedback: meta?.feedback })
      bindings.advance(await sessions.context(sessionId, answerId))
    },
    async cancel(sessionId, reason) {
      if (sessionId === 'new') return 'idle'
      try {
        return await sessions.cancel(sessionId, reason)
      } catch (error) {
        log('warn', `停止失败：${describe(error)}`)
        return 'idle'
      }
    },
    busy(sessionId) {
      return sessionId !== 'new' && sessions.busy(sessionId)
    },
  }
}

export type { QuickHelpSettings, QuickHelpStatus }
export { DEFAULT_SLOTS, ALL_SLOTS }
