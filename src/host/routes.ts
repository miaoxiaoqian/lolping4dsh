/**
 * Every HTTP route this plugin serves.
 *
 * Three audiences share one surface, which is why everything is namespaced under
 * `/quick-help` and nothing else:
 *
 *  - The settings panel in the main window reads and writes configuration.
 *  - The three overlay pages read the wheel, run an action, and stream answers.
 *  - Asset files are served by a guarded prefix route, so no directory listing
 *    exists and nothing outside the catalogue is reachable.
 *
 * Streaming is the reason some responses are written by hand. The quick ask
 * renders tokens as they arrive, and buffering a whole answer before sending
 * would make the small window feel broken for the entire duration of the turn.
 *
 * @module @local/dsh-quick-help/host/routes
 */
import { readFileSync } from 'node:fs'
import type { NodeRequest, NodeResponse, WebServer, ImageUpload } from './dsh.ts'
import type { ActionBinding } from './binding.ts'
import type { AssetSlot } from '../shared/assets.ts'
import { describeChord, parseAccelerator, reservedCollision } from '../shared/hotkey.ts'
import type { QuickHelpSettings, QuickHelpStatus } from '../shared/types.ts'
import { assetType } from './asset-resolver.ts'
import type { AssetResolver, ResolvedAsset, SlotAssets } from './asset-resolver.ts'
import type { SessionManager } from './sessions.ts'
import type { MediaStatus } from './media-status.ts'
import type { ActionScheduler, DispatchOutcome } from './scheduler.ts'
import type { BindingTracker } from './binding.ts'
import { SLOTS, PAGES } from './pages.ts'

/** Mount point, matching the overlay's paths. */
const API_BASE = '/quick-help'

/** What the routes need from the host. */
export interface RouteDeps {
  webServer: WebServer
  log: (level: 'info' | 'warn', message: string) => void
  assets: AssetResolver
  sessions: SessionManager
  media: MediaStatus
  bindings: BindingTracker
  scheduler: ActionScheduler
  settings(): QuickHelpSettings
  setSettings(raw: unknown): QuickHelpSettings
  status(): QuickHelpStatus
  /** The slots the current wheel uses, in sector order. */
  slots(): readonly AssetSlot[]
  /**
   * The trigger chord the helper must watch, or a reason there is none.
   *
   * Parsed by the host so the page never has to know a virtual key table, and so
   * the accelerator is validated exactly once.
   */
  trigger(): { readonly code: number; readonly mask: number; readonly label: string; readonly key: string } | undefined
  /** Every slot a settings file may reference, including the optional pool. */
  catalogue(): readonly AssetSlot[]
  feedback(): { action: string; at: number; outcome: string } | undefined
  /** Hand the chosen media to the window that will outlive the gesture. */
  queueFeedback(animation: string, sound: string): void
  /** Take the pending media, clearing it so a later open does not replay it. */
  takeFeedback(): { animation?: string; sound?: string } | undefined
  target(): ActionBinding | undefined
  bindTarget(raw: unknown): Promise<{ ok: true } | { ok: false; reason: string }>
  reportRuntime(raw: unknown): void
  reportFeedback(action: string, outcome: string): void
  sizes: readonly number[]
  labels: Readonly<Record<string, string>>
  inputs: Readonly<Record<string, string>>
  tick: string
  /** Re-inspect the bound DSH Session and refresh the exact answer snapshot. */
  refreshTarget(): Promise<ActionBinding | undefined>
  /** Bind the exact assistant answer returned by a completed ask. */
  advanceTarget(sessionId: string, answerId: string): Promise<void>
}

/** An HTTP failure the caller renders as-is. */
class HttpError extends Error {  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

/** One request handler. */
type Handler = (
  req: NodeRequest,
  res: NodeResponse,
  parts: string[],
  query: URLSearchParams,
) => void | Promise<void>

/** HTTP methods a route may answer to. */
type Method = 'GET' | 'POST' | 'PUT'

/** The handlers one path answers to, keyed by method. */
type MethodTable = { readonly [K in Method]?: Handler }

/**
 * Register every route.
 *
 * Each path is registered exactly once and the verb is branched inside the
 * handler. That is not a style choice: the web server judges duplicates by
 * `(kind, path)` alone, so a second registration for a path that already exists
 * throws and takes the whole activation down with it. A `GET` and a `PUT` on one
 * resource are therefore one route with two arms, not two routes.
 *
 * A failure part-way through is not left half-mounted either. Registering twenty
 * paths one at a time and throwing on the tenth would otherwise leave the first
 * ten answering requests for a plugin the host believes failed to load, so every
 * disposer collected so far runs before the error propagates.
 *
 * @param deps - Everything the handlers read.
 * @returns The disposer removing all of them.
 */
export function registerRoutes(deps: RouteDeps): () => void {
  const disposers: (() => void)[] = []

  /**
   * Mount one path, with one arm per method it answers.
   *
   * Registration goes straight to `webServer` rather than through a module-level
   * dispatcher: a shared mutable registrar would let a second activation of this
   * module silently steal the first one's routes.
   *
   * @param path - Path below the mount point.
   * @param arms - Handlers by method; a method with no arm answers 405.
   * @returns Nothing; the disposer joins the set removed on unload.
   */
  const route = (path: string, arms: MethodTable): void => {
    const full = `${API_BASE}${path}`
    disposers.push(deps.webServer.register({
      kind: 'exact',
      path: full,
      handler: (req, res) => { void guard(deps, req, res, full, arms) },
    }))
  }

  /**
   * Mount one path prefix, for the two file families whose names are not known
   * until the settings are read.
   *
   * The web server's `prefix` kind matches the prefix itself and anything below
   * it, longest prefix first. It does not capture segments — there is no
   * `:name` syntax anywhere in it, and a path containing `:name` is simply a
   * literal string that no real URL will ever equal. So the subtree is dispatched
   * here instead, against an explicit allow-list, and anything unrecognised is a
   * 404 rather than a read.
   *
   * @param path - Prefix below the mount point, without a trailing slash.
   * @param arms - Handlers by method.
   * @returns Nothing; the disposer joins the set removed on unload.
   */
  const subtree = (path: string, arms: MethodTable): void => {
    const full = `${API_BASE}${path}`
    disposers.push(deps.webServer.register({
      kind: 'prefix',
      path: full,
      handler: (req, res) => { void guard(deps, req, res, full, arms) },
    }))
  }

  /** GET is the common case, so it gets the shorter spelling. */
  const get = (path: string, handler: Handler): void => { route(path, { GET: handler }) }
  const post = (path: string, handler: Handler): void => { route(path, { POST: handler }) }

  try {
    // ── Overlay pages ──────────────────────────────────────────────────────
    // Served by this plugin rather than from the application bundle so the wheel,
    // the ask window and the settings page ship with the feature that owns them.

    get('/wheel', (_req, res) => page(res, 'wheel'))
    get('/ask', (_req, res) => page(res, 'ask'))
    get('/api/image', async (_req, res, _parts, query) => {
      const stored = await deps.sessions.readImage(query.get('sessionId') ?? '', query.get('id') ?? '')
      res.setHeader('cache-control', 'private, no-store')
      send(res, 200, stored.ref.mediaType, stored.data)
    })
    get('/feedback', (_req, res) => page(res, 'feedback'))
    get('/settings', (_req, res) => page(res, 'settings'))

    // ── Wheel state ─────────────────────────────────────────────────────────

    /**
     * Exactly the message the native input helper needs, and nothing else.
     *
     * The desktop layer pulls this at startup. Without it the helper would only be
     * configured when the settings page happened to be opened, so the wheel would
     * respond to nothing until the user went looking for the settings — a first-run
     * experience that reads as a broken feature rather than as an unconfigured one.
     *
     * Numbers throughout, because the helper reads this with a positional `sscanf`
     * and `%d`; see `QuickHelpHelperConfig` for why the flags are `0 | 1`.
     */
    get('/api/helper-config', (_req, res) => {
      const settings = deps.settings()
      const parsed = parseAccelerator(settings.hotkey)
      ok(res, {
        triggerVk: parsed === undefined ? 0 : parsed.code,
        modifierMask: parsed === undefined ? 0 : parsed.mask,
        holdMode: settings.mode === 'hold' ? 1 : 0,
        dragThreshold: 12,
        watchdogMs: 12_000,
        enabled: settings.paused || (settings.hotkey.trim().toLowerCase() === 'space' && !settings.spaceGestureEnabled) ? 0 : 1,
      })
    })

    /** Current machine state without restoring a Session or changing the wheel target. */
    get('/api/status', (_req, res) => { ok(res, { status: deps.status() }) })

    /** Everything the wheel page needs to draw itself. */
    get('/api/wheel', async (_req, res) => {
      const settings = deps.settings()
      const tick = deps.assets.resolveSound(deps.tick)
      const target = await deps.refreshTarget()
      ok(res, {
        slots: deps.slots().map(slot => describeSlot(deps.assets.resolve(slot))),
        sessionId: deps.sessions.current(),
        size: settings.iconSize,
        mode: settings.mode,
        paused: settings.paused,
        placement: settings.placement,
        // The trigger chord, parsed once here and handed to the page. The page used to
        // parse the accelerator itself, which meant two copies of the virtual-key table
        // that could disagree — and a disagreement about which key is the trigger is a
        // dead hotkey or a swallowed keyboard.
        trigger: deps.trigger(),
        labels: deps.labels,
        inputs: deps.inputs,
        soundEnabled: settings.soundEnabled,
        soundVolume: settings.soundVolume,
        tick: tick?.url ?? null,
        target: targetView(target, true),
        status: deps.status(),
      })
    })

    /**
     * Hand the chosen slot's media to whichever window outlives the gesture.
     *
     * The wheel closes the instant a slice is released, so media started there would
     * be hidden before its first frame paints. The page posts the slot's animation
     * and sound here on the way out, and the ask window — which stays up — plays it.
     */
    post('/api/feedback', async (req, res) => {
      const body = await readJson(req)
      deps.queueFeedback(str(body.animation, ''), str(body.sound, ''))
      ok(res, { queued: true })
    })

    // ── Actions ─────────────────────────────────────────────────────────────

    /** Run one action. */
    post('/api/action', async (req, res) => {
      const body = await readJson(req)
      const action = str(body.action, 'unknown')
      const requestId = str(body.requestId, '')
      // The id is what makes a replayed or re-delivered message harmless, so a
      // request without one is refused rather than run once and forgotten.
      if (requestId === '') throw new HttpError(400, 'no_request_id', '缺少请求标识，无法防止重复执行。')

      const target = await deps.refreshTarget()
      const targetToken = str(body.targetToken, '')
      const targetSessionId = str(body.sessionId, '')
      if (action === 'stop' && target === undefined) {
        if (targetSessionId !== deps.sessions.current()) throw new HttpError(409, 'stale_session', '当前小窗会话已变化，请重新呼出轮盘。')
        const state = await deps.scheduler.stop(targetSessionId, '用户从轮盘请求停止当前任务')
        ok(res, { action, kind: 'noop', feedback: state !== 'idle', message: state === 'idle' ? '当前没有正在执行的任务。' : '已请求停止，并清除排队请求。', sessionId: targetSessionId })
        return
      }
      if (target !== undefined) {
        if (targetSessionId !== target.sessionId) {
          throw new HttpError(409, 'stale_session', '轮盘打开后绑定会话已变化，未对其他任务执行操作。请重新呼出轮盘。')
        }
        if (action !== 'stop' && targetToken !== target.versionToken) {
          throw new HttpError(409, 'stale_target', '轮盘打开后目标回答已变化，请重新呼出并确认目标。')
        }
        deps.sessions.adopt(target.sessionId)
      }
      const outcome = await deps.scheduler.dispatch(action, { action, requestId, text: str(body.text, ''), targetToken, targetSessionId })
      deps.reportFeedback(action, describeOutcome(outcome))
      ok(res, {
        action,
        ...outcome,
        message: describeOutcome(outcome),
        sessionId: deps.sessions.current(),
        target: targetView(deps.target()),
      })
    })

    /** Stop a session, cancelling the turn and dropping everything queued. */
    post('/api/stop', async (req, res) => {
      const body = await readJson(req)
      const sessionId = str(body.sessionId, deps.sessions.current())
      const state = await deps.scheduler.stop(sessionId, '用户按下了「危险」')
      ok(res, {
        sessionId,
        state,
        // The distinction is the point: a request was sent, which is not the same
        // claim as "it has stopped".
        message: state === 'stopping'
          ? '已请求停止，正在等待当前操作结束。'
          : state === 'stopped'
            ? '已停止，并已清除排队中的请求。已经完成的修改保留，不会回滚。'
            : '当前没有正在执行的任务。',
      })
    })

    // ── Ask window ───────────────────────────────────────────────────────────

    /** Ensure the same preset-composed Session used by the full desktop Client. */
    get('/api/compact-session', async (_req, res) => {
      ok(res, { sessionId: await deps.sessions.ensureConversation() })
    })

    route('/api/compact-conversations', {
      GET: async (_req, res) => {
        ok(res, { sessions: deps.sessions.ownedConversations() })
      },
      POST: async (req, res) => {
      const body = await readJson(req)
      if (typeof body.expectedSessionId !== 'string' || !body.expectedSessionId
        || (body.mode !== 'new' && body.mode !== 'select')
        || (body.mode === 'select' && (typeof body.sessionId !== 'string' || !body.sessionId))) {
        throw new HttpError(400, 'invalid_navigation', '请选择要打开的会话。')
      }
      const sessionId = await deps.sessions.navigateConversation(body.expectedSessionId, body.mode === 'select' ? String(body.sessionId) : undefined)
      deps.bindings.clear()
      ok(res, { sessionId })
      },
    })
    /** Compact action status without copying or rehydrating the transcript. */
    get('/api/action-status', (_req, res) => {
      const sessionId = deps.sessions.current()
      ok(res, { sessionId, running: deps.scheduler.runningNow(sessionId), actionError: deps.scheduler.lastError(sessionId), mediaError: deps.media.error(sessionId) })
    })

    route('/api/media-status', {
      GET: (_req, res) => { ok(res, { playback: deps.media.latest(deps.sessions.current()) }) },
      POST: async (req, res) => {
        if (!deps.media.report(await readJson(req))) throw new HttpError(400, 'invalid_media_report', '无效的播放状态。')
        ok(res, { ok: true })
      },
    })

    /** The conversation, for the window to render. */
    get('/api/ask', async (_req, res) => {
      const sessionId = deps.sessions.current()
      if (deps.sessions.has(sessionId)) await deps.sessions.hydrate(sessionId)
      const storage = await deps.sessions.storageInfo()
      const media = deps.takeFeedback()
      const settings = deps.settings()
      const target = await deps.refreshTarget()
      ok(res, {
        sessionId,
        turns: deps.sessions.view(sessionId),
        busy: deps.sessions.busy(sessionId),
        draft: deps.sessions.draft(sessionId),
        pinned: deps.sessions.isPinned(sessionId),
        placement: settings.placement,
        keepFocus: settings.keepFocus,
        stopped: deps.scheduler.isStopped(sessionId),
        queued: deps.scheduler.queued(sessionId),
        running: deps.scheduler.runningNow(sessionId),
        actionError: deps.scheduler.lastError?.(sessionId),
        target: targetView(target),
        adopted: !!target && deps.sessions.isAdopted(target.sessionId, target.answerId),
        storage,
        soundEnabled: settings.soundEnabled,
        soundVolume: settings.soundVolume,
        modelRoute: settings.modelRoute === '' ? deps.sessions.defaultRoute() : settings.modelRoute,
        ...deps.sessions.modelAvailable() ? {} : { modelUnavailable: '当前没有可用的模型配置。请在 DSH 里配置模型后再提问。' },
        // Drained on read: see `takeFeedback` in the host entry.
        ...media === undefined ? {} : { feedback: media },
      })
    })

    /** Save a draft without sending it. */
    post('/api/draft', async (req, res) => {
      const body = await readJson(req)
      const sessionId = str(body.sessionId, '')
      if (sessionId === '') throw new HttpError(400, 'no_session_id', '保存草稿需要明确的会话标识。')
      deps.sessions.setDraft(sessionId, str(body.draft, ''))
      ok(res, { saved: true })
    })

    /** Pin or unpin the window. */
    post('/api/pin', async (req, res) => {
      const body = await readJson(req)
      const sessionId = str(body.sessionId, deps.sessions.current())
      deps.sessions.setPinned(sessionId, body.pinned === true)
      ok(res, { pinned: deps.sessions.isPinned(sessionId) })
    })

    /** Start a new conversation, keeping the old one in the list. */
    post('/api/new', (_req, res) => {
      const sessionId = deps.sessions.reset()
      deps.bindings.clear()
      ok(res, { sessionId, turns: [], draft: '', pinned: false })
    })

    /**
     * Send the typed text and stream the answer.
     *
     * Server-sent events, because the answer arrives in pieces and the window
     * should show them as they land. A failed turn is reported as an `error` event
     * rather than a status code, so a model failure mid-stream does not look like
     * the page itself failed.
     */
    post('/api/send', async (req, res) => {
      const body = await readJson(req)
      const images = readImages(body.images)
      const text = str(body.text, '').trim() || (images.length ? '请根据这张截图解释我看到的内容，指出关键问题；看不清的地方请明确说明。' : '')
      if (text === '') throw new HttpError(400, 'empty', '没有输入内容。')
      if (!deps.sessions.modelAvailable()) {
        throw new HttpError(503, 'no_model', '当前没有可用的模型配置。请在 DSH 里配置模型后再提问。')
      }
      const sessionId = deps.sessions.current()
      const requestedSessionId = str(body.sessionId, '')
      if (requestedSessionId !== sessionId) {
        throw new HttpError(409, 'stale_session', '小窗口会话已变化，请刷新后重试；内容没有写入其他会话。')
      }
      const settings = deps.settings()

      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('connection', 'keep-alive')

      // Closing the small window detaches this stream observer; it does not stop
      // the real session. Only an explicit stop action cancels model work.
      let disconnected = false
      res.on('close', () => { disconnected = true })

      try {
        const answerId = await deps.sessions.send(sessionId, text, {
          images,
          clearDraft: true,
          timeoutMs: settings.timeoutMs,
          modelRoute: settings.modelRoute,
          onUpdate: turn => {
            if (disconnected) return
            write(res, 'event: update\n')
            write(res, `data: ${JSON.stringify({ turn })}\n\n`)
          },
        })
        await deps.advanceTarget(sessionId, answerId)
        if (disconnected) return
        const turns = deps.sessions.view(sessionId)
        write(res, 'event: done\n')
        write(res, `data: ${JSON.stringify({ turns, target: targetView(deps.target()) })}\n\n`)
      } catch (error) {
        if (disconnected) return
        const message = error instanceof Error ? error.message : String(error)
        deps.log('warn', `提问失败：${message}`)
        write(res, 'event: error\n')
        write(res, `data: ${JSON.stringify({ message })}\n\n`)
      } finally {
        if (!disconnected && res.writableEnded !== true) res.end()
      }
    })

    // ── Settings ─────────────────────────────────────────────────────────────

    /**
     * Read and write the configuration.
     *
     * One path, two verbs. Registering these separately throws on the second call
     * — the server's duplicate check has no method dimension — which took the whole
     * plugin down at load rather than merely losing the write.
     */
    route('/api/settings', {
      GET: async (_req, res) => {
        const settings = deps.settings()
        ok(res, {
          settings,
          storage: await deps.sessions.storageInfo(),
          sizes: deps.sizes,
          status: deps.status(),
          trigger: deps.trigger(),
          hotkeyProblem: describeHotkeyProblem(settings.hotkey),
          wheel: deps.slots().map(slot => describeSlot(deps.assets.resolve(slot))),
          catalogue: deps.catalogue().map(slot => describeSlot(deps.assets.resolve(slot))),
        })
      },
      PUT: async (req, res) => {
        const body = await readJson(req)
        if (typeof body.recordsPath === 'string') deps.sessions.setRecordsPath(body.recordsPath.trim())
        const settings = deps.setSettings(body)
        // The stored chord may differ from the requested one — an unparseable chord
        // falls back to the default — so the answer carries what was actually kept.
        ok(res, { settings, trigger: deps.trigger(), hotkeyProblem: describeHotkeyProblem(settings.hotkey) })
      },
    })

    /**
     * Bind a target so the wheel has something to act on, or release it.
     *
     * Releasing is a POST with a flag rather than a second verb: an unbound target
     * is a normal state the panel needs to reach, not a different operation on the
     * same resource, and one registration is one thing to keep in step.
     */
    post('/api/target', async (req, res) => {
      const body = await readJson(req)
      if (body.unbind === true) {
        deps.bindings.clear()
        ok(res, { target: null })
        return
      }
      const result = await deps.bindTarget(body)
      if (!result.ok) throw new HttpError(409, 'no_target', result.reason)
      ok(res, { target: targetView(deps.target()) })
    })

    /** Report what the desktop layer observed, so the panel can show it. */
    post('/api/runtime', async (req, res) => {
      deps.reportRuntime(await readJson(req))
      ok(res, { status: deps.status() })
    })

    /** Sessions this plugin has touched, for the panel. */
    get('/api/sessions', (_req, res) => {
      ok(res, {
        sessions: deps.sessions.list(),
        history: deps.bindings.history(),
      })
    })

    // ── Static files ─────────────────────────────────────────────────────────
    // Both families sit behind a guarded prefix rather than one exact route per
    // file: the overlay's own files are known at build time, but the asset set
    // depends on the user's settings and on which files exist on disk, so it
    // cannot be enumerated when the routes are mounted.

    /** The overlay's own CSS and JS, by exact name from the generated table. */
    subtree('/overlay', {
      GET: (_req, res, parts) => {
        const name = parts[0]
        if (parts.length !== 1 || name === undefined) {
          throw new HttpError(404, 'not_found', '没有这个文件。')
        }
        const body = PAGES.asset(name)
        if (body === undefined) throw new HttpError(404, 'not_found', `没有这个文件：${name}`)
        res.setHeader('cache-control', 'no-store')
        send(res, 200, body.type, body.content)
      },
    })

    /**
     * One asset file, by `<kind>/<name>`.
     *
     * A prefix route would otherwise expose every file under `assets/`, including
     * the ~30 the current wheel never loads, so `lookup` decides from the
     * catalogue rather than from the path.
     */
    subtree('/asset', {
      GET: (_req, res, parts) => {
        if (parts.length !== 2) throw new HttpError(404, 'not_found', '素材不存在。')
        const asset = lookup(deps, parts[0], parts[1])
        if (asset === undefined) throw new HttpError(404, 'not_found', '素材不存在。')
        res.setHeader('cache-control', 'public, max-age=86400')
        send(res, 200, assetType(asset.absolutePath), readFileSync(asset.absolutePath))
      },
    })
  } catch (error) {
    // Unwind everything mounted before the failure. Leaving a partial surface
    // behind would answer requests for a plugin the host has already given up on,
    // and the next activation would then fail on a duplicate it cannot explain.
    for (const dispose of disposers.reverse()) dispose()
    disposers.length = 0
    deps.log('warn', `注册路由失败，已撤销本次挂载：${error instanceof Error ? error.message : String(error)}`)
    throw error
  }

  return () => {
    for (const dispose of disposers) dispose()
    disposers.length = 0
  }
}

/** Wrap a handler so its failures become the caller's error shape. */
async function guard(
  deps: RouteDeps,
  req: NodeRequest,
  res: NodeResponse,
  full: string,
  arms: MethodTable,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const actual = (req.method ?? 'GET').toUpperCase()
  // Segments below the mounted path. For an exact route this is empty unless the
  // request carried a suffix the server matched anyway; for a prefix route it is
  // the whole subtree, which is what the guarded handlers dispatch on.
  const parts = url.pathname.slice(full.length).split('/').filter(part => part !== '')
  try {
    const handler = arms[actual as Method]
    if (handler === undefined) {
      // The path is real but the verb is not. Saying so beats a 404, which would
      // read as "this feature does not exist".
      res.setHeader('allow', Object.keys(arms).join(', '))
      throw new HttpError(405, 'method', `${url.pathname} 不支持 ${actual}。`)
    }
    await handler(req, res, parts, url.searchParams)
  } catch (error) {
    if (res.writableEnded === true) return
    const status = error instanceof HttpError ? error.status : 500
    const code = error instanceof HttpError ? error.code : 'internal'
    const message = error instanceof Error ? error.message : String(error)
    if (status >= 500) deps.log('warn', `${actual} ${url.pathname} 失败：${message}`)
    send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error: code, message }))
  }
}

/**
 * Why the configured chord may not do what the user expects, if anything.
 *
 * Surfaced on the settings page rather than only in a log, because every one of
 * these outcomes is invisible otherwise: the wheel simply never appears, and there
 * is nothing on screen connecting that to a preference set weeks earlier.
 *
 * @param accelerator - the chord as stored.
 * @returns a sentence to show, or undefined when there is nothing to say.
 */
function describeHotkeyProblem(accelerator: string): string | undefined {
  if (parseAccelerator(accelerator) === undefined) {
    return `「${accelerator}」不能作为触发键：它必须以字母、数字或空格等单个键结尾，例如 Control+Option+Space。`
  }
  const collision = reservedCollision(accelerator)
  if (collision !== undefined) {
    return `「${describeChord(accelerator)}」通常已被系统或输入法占用。轮盘不会抢占它，但两者会同时触发；建议换一个组合。`
  }
  return undefined
}

/** One resolved slot, as the page receives it. */
function describeSlot(resolved: SlotAssets): Record<string, unknown> {
  return {
    id: resolved.slot.id,
    action: resolved.slot.action,
    sector: resolved.slot.sector,
    kind: resolved.slot.kind,
    emoteName: resolved.slot.emoteName,
    emoteNameZh: resolved.slot.emoteNameZh,
    meaning: resolved.slot.meaning,
    hover: resolved.slot.hover,
    image: resolved.image?.url ?? null,
    animation: resolved.animation?.url ?? null,
    sound: resolved.sound?.url ?? null,
    missing: resolved.missing ?? null,
  }
}

/** Keep the private canonical answer text inside the Host. */
function targetView(target: ActionBinding | undefined, includeToken = false): Record<string, unknown> | null {
  if (!target) return null
  return {
    sessionId: target.sessionId,
    answerId: target.answerId,
    answerSeq: target.answerSeq,
    artifactLabel: target.artifactLabel,
    ...(target.artifactVersion === undefined ? {} : { artifactVersion: target.artifactVersion }),
    kind: target.kind,
    valid: target.valid,
    ...(target.invalidReason === undefined ? {} : { invalidReason: target.invalidReason }),
    ...(includeToken ? { versionToken: target.versionToken } : {}),
  }
}

/**
 * Find one asset by the two path segments the route produced.
 *
 * The directory is not trusted from the URL. The catalogue decides which slot a
 * file name belongs to, so a request cannot use the path to reach a file the
 * wheel never declared.
 */
function lookup(deps: RouteDeps, dir: string | undefined, name: string | undefined): ResolvedAsset | undefined {
  if (name === undefined || name === '') return undefined
  if (dir === 'sounds') return deps.assets.resolveSound(name)
  for (const slot of deps.catalogue()) {
    if (slot.image === name) return deps.assets.resolve(slot).image
    if (slot.animation === name) return deps.assets.resolve(slot).animation
    if (slot.sound === name) return deps.assets.resolve(slot).sound
  }
  return undefined
}

/** Serve one overlay page document. */
function page(res: NodeResponse, name: keyof typeof SLOTS): void {
  res.setHeader('cache-control', 'no-store')
  send(res, 200, 'text/html; charset=utf-8', SLOTS[name].html)
}

/** Send a whole response. */
function send(res: NodeResponse, status: number, type: string, body: string | Uint8Array): void {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.end(body)
}

/** Send one JSON body. */
function ok(res: NodeResponse, value: unknown): void {
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(value))
}

/** Write one server-sent event. */
function write(res: NodeResponse, chunk: string): void {
  if (res.writableEnded === true) return
  res.write(chunk)
}

/** Read and parse a JSON body. */
async function readJson(req: NodeRequest): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Uint8Array) => {
      size += chunk.byteLength
      if (size > 30 * 1024 * 1024) { reject(new HttpError(413, 'too_large', '截图过大，请缩小框选区域后重试。')); return }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve() })
    req.on('error', (error: Error) => { reject(error) })
  })
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    throw new HttpError(400, 'bad_json', '请求内容不是有效的 JSON。')
  }
}

/** One bounded screenshot, with final decoding and policy checks delegated to DSH. */
function readImages(raw: unknown): ImageUpload[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 1) throw new HttpError(400, 'bad_images', '一次最多发送一张截图。')
  return raw.map(value => {
    if (!value || typeof value !== 'object' || value.type !== 'image' || value.mediaType !== 'image/png'
      || typeof value.data !== 'string' || !value.data || value.data.length > 28 * 1024 * 1024) {
      throw new HttpError(400, 'bad_image', '图片必须是有效的 PNG 截图。')
    }
    return { type: 'image', mediaType: 'image/png', data: value.data, name: '屏幕截图.png' }
  })
}

/** Read a string field. */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** A sentence for each dispatch outcome. */
function describeOutcome(outcome: DispatchOutcome): string {
  switch (outcome.kind) {
    case 'started': return '已收到，正在执行。'
    case 'merged': return `已合并到正在进行的${outcome.running ?? '动作'}，不会启动第二个执行。`
    case 'noop': return outcome.reason
    case 'refused': return outcome.reason
    case 'failed': return `执行失败：${outcome.reason}`
  }
}
