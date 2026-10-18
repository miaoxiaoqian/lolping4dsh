/**
 * The settings panel in the main window.
 *
 * What it shows is deliberately different from the overlay's settings window: this
 * one reports what is actually true (whether the helper is running, whether the
 * permission was granted, which model route will be used) and binds a target for
 * the wheel to act on. The overlay's page is where the wheel is configured while
 * it is open, because that is the moment the choice is relevant.
 *
 * Every write goes through the plugin's own HTTP surface, which re-validates the
 * values. This panel is a convenience, never the authority.
 *
 * @module @local/dsh-quick-help/client/panel
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { T } from './locales.ts'

/** The plugin's API mount point. */
const API = '/quick-help/api'
const LOAD_TIMEOUT_MS = 8_000

const panelStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', height: '100%', maxWidth: 920, minWidth: 0, minHeight: 0, margin: '0 auto',
  overflowY: 'auto',
  padding: '20px clamp(16px, 3vw, 32px) 36px', display: 'flex', flexDirection: 'column', gap: 18,
  color: 'var(--dsw-alias-label-primary, #292b28)',
}
const sectionStyle: CSSProperties = {
  boxSizing: 'border-box', minWidth: 0, padding: 16,
  border: '1px solid var(--dsw-alias-border-l2, #dcdcd5)', borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-1, #fcfcfa)', display: 'flex', flexDirection: 'column', gap: 12,
}
const headingStyle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 650, color: 'var(--dsw-alias-label-primary, #292b28)' }
const gridStyle: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 10,
}
const controlRowStyle: CSSProperties = {
  display: 'flex', minWidth: 0, flexWrap: 'wrap', alignItems: 'center', gap: 10,
}
const controlStyle: CSSProperties = {
  boxSizing: 'border-box', maxWidth: '100%', minWidth: 0, minHeight: 34, padding: '5px 9px',
  color: 'var(--dsw-alias-label-primary, #292b28)', background: 'var(--dsw-alias-bg-layer-1, #fcfcfa)',
  border: '1px solid var(--dsw-alias-border-l2, #dcdcd5)', borderRadius: 7, font: 'inherit', fontSize: 13,
}
const buttonStyle: CSSProperties = {
  boxSizing: 'border-box', minHeight: 34, padding: '6px 11px', borderRadius: 7,
  border: '1px solid var(--dsw-alias-border-l2, #dcdcd5)',
  color: 'var(--dsw-alias-label-primary, #292b28)', background: 'var(--dsw-alias-bg-layer-1, #fcfcfa)',
  font: 'inherit', fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer',
}

/** One slot as the panel receives it. */
interface SlotView {
  id: string
  action: string
  sector: number
  kind: string
  emoteName: string
  emoteNameZh: string
  meaning: string
  hover: string
  image: string | null
  animation: string | null
  sound: string | null
  missing: string | null
}

/** Machine state, which the panel reports but never sets. */
interface Status {
  supported: boolean
  accessibility: boolean
  helper: string
  helperDetail?: string
  boundHotkey: string
  defaultModelRoute: string
  modelAvailable: boolean
  lastSession?: { sessionId: string; title: string; at: number }
}

interface Settings {
  hotkey: string
  spaceGestureEnabled: boolean
  mode: 'press' | 'hold'
  paused: boolean
  iconSize: number
  placement: 'pointer' | 'center'
  keepFocus: boolean
  modelRoute: string
  timeoutMs: number
  soundEnabled: boolean
  soundVolume: number
}

/** The bound target. */
interface Target {
  sessionId: string
  answerId: string
  artifactLabel: string
  artifactVersion?: string
  kind: string
  valid: boolean
}

/** Everything the panel reads in one round. */
interface Snapshot {
  sizes: number[]
  slots: SlotView[]
  status: Status
  target: Target | null
  sessions: { sessionId: string; title: string; at: number }[]
  settings: Settings
}

declare global {
  interface Window {
    dshDesktop?: { quickHelp?: {
      probeHotkey(accelerator: string): Promise<{ ok: boolean; available: boolean; reason?: string }>
      openWheel(): Promise<void>
      openAsk(): Promise<void>
      retry(): Promise<void>
    } }
  }
}

/** Props the slot seat injects. */
interface PanelProps {
  t: T
}

/** Read the panel's state. */
async function load(): Promise<Snapshot> {
  const signal = AbortSignal.timeout(LOAD_TIMEOUT_MS)
  const [wheel, ask, sessions, configuration] = await Promise.all([
    fetch(`${API}/wheel`, { signal }).then(readJson),
    fetch(`${API}/ask`, { signal }).then(readJson),
    fetch(`${API}/sessions`, { signal }).then(readJson),
    fetch(`${API}/settings`, { signal }).then(readJson),
  ])
  return {
    sizes: configuration.sizes as number[],
    slots: (wheel.slots ?? []) as SlotView[],
    status: wheel.status as Status,
    target: (ask.target ?? null) as Target | null,
    sessions: (sessions.sessions ?? []) as { sessionId: string; title: string; at: number }[],
    settings: configuration.settings as Settings,
  }
}

/** Parse a JSON body, turning a failure into a readable message. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const value = text === '' ? {} : JSON.parse(text) as unknown
  if (!response.ok) {
    const message = value !== null && typeof value === 'object' && 'message' in value
      ? String((value as { message: unknown }).message)
      : `请求失败（${response.status}）`
    throw new Error(message)
  }
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** The panel's own state. */
function useSnapshot() {
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState(false)
  const reload = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setData(await load())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  // Poll only machine state; full reloads hydrate histories and overwrite form snapshots.
  const loaded = data !== null
  useEffect(() => {
    if (!loaded) return
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(LOAD_TIMEOUT_MS)])
        const latest = await fetch(`${API}/status`, { signal }).then(readJson)
        if (lifetime.signal.aborted) return
        if (latest.status === null || typeof latest.status !== 'object') throw new Error('missing machine status')
        setData(current => current === null ? null : { ...current, status: latest.status as Status })
        setStatusError(false)
      } catch {
        if (!lifetime.signal.aborted) setStatusError(true)
      } finally {
        if (!lifetime.signal.aborted) timer = setTimeout(() => { void poll() }, 1_500)
      }
    }
    void poll()
    return () => { lifetime.abort(); clearTimeout(timer) }
  }, [loaded])
  return { data, error, statusError, reload }
}

/** One status chip. */
function Chip({ ok, children }: { ok: boolean; children: string }): ReactElement {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: '999px',
      fontSize: '11px', lineHeight: '1.6',
      background: ok ? 'rgba(80,160,90,.16)' : 'rgba(190,90,80,.18)',
      color: ok ? '#7fce8e' : '#f0a5a0',
    }}>
      {children}
    </span>
  )
}

/**
 * Show one slot's animation, from its first frame.
 *
 * The preview does not run the action: a preview that invoked the Agent would make
 * it impossible to look at the six optional emotes without spending six model turns
 * on them.
 *
 * Replaying means building a fresh element rather than rewinding a cached one. The
 * DOM has no typed way to seek an animated image — `currentTime` exists on the
 * element at runtime but is not in the standard typings — and a new element starts
 * at frame zero for free, which is the behaviour a "did my click land" preview needs.
 */
function previewAnimation(slot: SlotView): void {
  if (slot.animation === null) return
  document.getElementById('qh-preview')?.remove()
  const img = document.createElement('img')
  img.id = 'qh-preview'
  img.alt = slot.emoteNameZh
  // `src` is set after insertion so the load begins once the element is in the
  // document, which is also what makes a repeat click replay rather than resume.
  Object.assign(img.style, {
    position: 'fixed', inset: '0', margin: 'auto', width: '180px', height: '180px',
    objectFit: 'contain', zIndex: '2147483647', pointerEvents: 'none',
    filter: 'drop-shadow(0 4px 20px rgba(0,0,0,.5))',
  })
  document.body.appendChild(img)
  img.src = slot.animation
  setTimeout(() => img.remove(), 3000)
}

/**
 * Release the bound target.
 *
 * A POST rather than a DELETE because the route is registered once with its own
 * verb, and adding a second verb for one action would mean two registrations that
 * have to stay in step. An empty binding is a normal state, not an error.
 */
async function unbind(): Promise<void> {
  await fetch(`${API}/target`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unbind: true }),
  })
}

/** The panel. */
export function QuickHelpPanel({ t }: PanelProps): ReactElement {
  const { data, error, statusError, reload } = useSnapshot()
  const [hotkey, setHotkey] = useState('Control')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [desktopAction, setDesktopAction] = useState<string | null>(null)
  const [desktopMessage, setDesktopMessage] = useState<string | null>(null)
  useEffect(() => { if (data !== null) setHotkey(data.settings.hotkey) }, [data?.settings.hotkey])

  const runDesktopAction = async (name: string, run: (bridge: NonNullable<Window['dshDesktop']>['quickHelp']) => Promise<void>): Promise<void> => {
    setDesktopAction(name)
    setDesktopMessage(null)
    try {
      const bridge = window.dshDesktop?.quickHelp
      if (bridge === undefined) throw new Error('当前桌面程序缺少轮盘接口，请更新并重启。')
      await run(bridge)
      setDesktopMessage(name === '测试呼出轮盘' ? '轮盘已显示。' : `${name}已打开。`)
    } catch (cause) {
      setDesktopMessage(`失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setDesktopAction(null)
    }
  }
  const immediateActions = (
    <div style={controlRowStyle}>
      <button style={buttonStyle} disabled={desktopAction !== null} onClick={() => { void runDesktopAction('测试呼出轮盘', bridge => bridge!.openWheel()) }}>测试呼出轮盘</button>
      <button style={buttonStyle} disabled={desktopAction !== null} onClick={() => { void runDesktopAction('立即求救', bridge => bridge!.openAsk()) }}>立即求救</button>
      {desktopAction === null && desktopMessage !== null ? <p role="status" style={{ margin: 0, color: desktopMessage.includes('失败') || desktopMessage.includes('缺少') ? '#f0a5a0' : '#8b9199', fontSize: 12 }}>{desktopMessage}</p> : null}
      {desktopAction !== null ? <p role="status" style={{ margin: 0, color: '#8b9199', fontSize: 12 }}>{desktopAction}…</p> : null}
    </div>
  )

  if (error !== null) {
    return (
      <div style={{ ...panelStyle, color: '#b8443c', fontSize: 13 }} role="alert">
        <p style={{ margin: 0 }}>读取轮盘设置失败：{error}</p>
        <button style={buttonStyle} onClick={() => { void reload() }}>{t('reload')}</button>
        {immediateActions}
      </div>
    )
  }
  if (data === null) {
    return <div style={{ ...panelStyle, color: '#888', fontSize: 13 }}>
      <p style={{ margin: 0 }}>正在读取轮盘设置…最多等待 8 秒。</p>
      {immediateActions}
    </div>
  }

  const { status } = data
  const settings = data.settings
  const saveSettings = async (patch: Partial<Settings>): Promise<void> => {
    setSaving(true)
    setSettingsError(null)
    try {
      if (patch.hotkey !== undefined) {
        // Bare Space is a buffered movement gesture, not an Electron global
        // shortcut. Registering it even briefly would steal ordinary text input.
        if (patch.hotkey.trim().toLowerCase() !== 'space') {
          const bridge = window.dshDesktop?.quickHelp
          if (bridge === undefined) throw new Error('当前桌面程序缺少轮盘接口，请更新并重启。')
          const probe = await bridge.probeHotkey(patch.hotkey)
          if (!probe.ok || !probe.available) throw new Error(probe.reason ?? '快捷键无法使用。')
        }
      }
      await fetch(`${API}/settings`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...settings, ...patch }),
      }).then(readJson)
      await reload()
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  const helperText = status.helper === 'running' ? t('helperRunning')
    : status.helper === 'no-access' ? t('helperNoAccess')
      : status.helper === 'crashed' ? t('helperCrashed')
        : status.helper === 'starting' ? t('helperStarting')
          : t('helperStopped')

  return (
    <div style={panelStyle}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ ...headingStyle, fontSize: 18 }}>{t('title')}</h2>
        <p style={{ margin: 0, fontSize: '12px', color: '#8b9199', lineHeight: 1.6 }}>{t('subtitle')}</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          <Chip ok={status.supported}>{status.supported ? t('supported') : t('unsupported')}</Chip>
          <Chip ok={status.helper === 'running'}>{helperText}</Chip>
          {status.boundHotkey === '' ? null : <Chip ok>{status.boundHotkey}</Chip>}
          <Chip ok={status.modelAvailable}>
            {status.modelAvailable ? `${t('modelRoute')}：${status.defaultModelRoute}` : `${t('modelRoute')}：${t('modelDefault')}`}
          </Chip>
        </div>
        {statusError ? <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-primary, #292b28)' }}>{t('statusRefreshFailed')}</p> : null}
        {status.helperDetail === undefined ? null : (
          <p style={{ margin: 0, fontSize: '11px', color: '#c8a06a' }}>{status.helperDetail}</p>
        )}
      </header>

      <section style={sectionStyle}>
        <h3 style={headingStyle}>快捷键与交互</h3>
        <div style={controlRowStyle}>
          <label style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 13 }}>呼出轮盘 <input style={{ ...controlStyle, width: 190 }} aria-label="呼出轮盘快捷键" value={hotkey} onChange={event => setHotkey(event.target.value)} /></label>
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={!settings.paused} onChange={event => { void saveSettings({ paused: !event.target.checked }) }} /> 启用全局轮盘</label>
          {hotkey.trim().toLowerCase() === 'space' ? <label style={{ fontSize: 12 }}><input type="checkbox" checked={settings.spaceGestureEnabled} onChange={event => { void saveSettings({ spaceGestureEnabled: event.target.checked }) }} /> 启用裸空格手势</label> : null}
          <label style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 13 }}>模式 <select style={controlStyle} value={settings.mode} onChange={event => { void saveSettings({ mode: event.target.value as Settings['mode'] }) }}><option value="press" disabled={hotkey.trim().toLowerCase() === 'space'}>按快捷键打开，移动后点击确认</option><option value="hold">按住触发键，移动后松开确认</option></select></label>
          <button style={buttonStyle} disabled={saving} onClick={() => { void saveSettings({ hotkey }) }}>保存快捷键</button>
          <button style={buttonStyle} disabled={desktopAction !== null || !status.supported || settings.paused} onClick={() => { void runDesktopAction('测试呼出轮盘', bridge => bridge!.openWheel()) }}>测试呼出轮盘</button>
          <button style={buttonStyle} disabled={desktopAction !== null || !status.supported || !status.modelAvailable} onClick={() => { void runDesktopAction('立即求救', bridge => bridge!.openAsk()) }}>立即求救</button>
          {status.helper !== 'running' ? <button style={buttonStyle} disabled={desktopAction !== null} onClick={() => { void runDesktopAction('重试输入助手', async bridge => { await bridge!.retry(); reload() }) }}>重试输入助手</button> : null}
        </div>
        <div style={controlRowStyle}>
          <label style={{ fontSize: 12 }}>大小 <select style={controlStyle} value={settings.iconSize} onChange={event => { void saveSettings({ iconSize: Number(event.target.value) }) }}>{data.sizes.map(size => <option key={size} value={size}>{size}px</option>)}</select></label>
          <label style={{ fontSize: 12 }}>问答窗口 <select style={controlStyle} value={settings.placement} onChange={event => { void saveSettings({ placement: event.target.value as Settings['placement'] }) }}><option value="pointer">鼠标附近</option><option value="center">屏幕居中</option></select></label>
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={settings.keepFocus} onChange={event => { void saveSettings({ keepFocus: event.target.checked }) }} /> 失焦后保留问答窗口</label>
          <label style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 13 }}>模型 <input style={{ ...controlStyle, width: 240 }} aria-label="快捷求助模型路由" placeholder="跟随 DSH 默认" value={settings.modelRoute} onChange={event => { void saveSettings({ modelRoute: event.target.value }) }} /></label>
          <label style={{ fontSize: 12 }}>超时秒数 <input style={{ ...controlStyle, width: 84 }} aria-label="快捷求助超时秒数" type="number" min={5} max={600} value={Math.round(settings.timeoutMs / 1000)} onChange={event => { void saveSettings({ timeoutMs: Number(event.target.value) * 1000 }) }} /></label>
        </div>
        {settingsError === null ? null : <p role="alert" style={{ margin: 0, color: '#f0a5a0', fontSize: 12 }}>{settingsError}</p>}
        {desktopAction === null && desktopMessage !== null ? <p role="status" style={{ margin: 0, color: desktopMessage.includes('失败') || desktopMessage.includes('缺少') ? '#f0a5a0' : '#8b9199', fontSize: 12 }}>{desktopMessage}</p> : null}
        {desktopAction !== null ? <p role="status" style={{ margin: 0, color: '#8b9199', fontSize: 12 }}>{desktopAction}…</p> : null}
        {!status.accessibility ? <p style={{ margin: 0, color: '#c8a06a', fontSize: 12 }}>系统设置 → 隐私与安全性 → 设备控制和数据访问，允许 DeepSeek Harness 后返回此处重试。</p> : null}
        {hotkey.trim().toLowerCase() === 'space' ? <p style={{ margin: 0, color: '#8b9199', fontSize: 12 }}>裸空格手势默认关闭，以保护普通输入和中文选词。组合键可先试 Control+Option+Space，并在本机确认不与输入法冲突。</p> : null}
        {hotkey.trim().toLowerCase() === 'space' && !settings.spaceGestureEnabled && !settings.paused ? <p style={{ margin: 0, color: '#c8a06a', fontSize: 12 }}>全局轮盘当前已启用，但裸空格手势仍关闭；请使用 Control+Option+Space，或主动勾选“启用裸空格手势”。</p> : null}
      </section>

      {/* The bound target, which every action except 「求救」 depends on. */}
      <section style={sectionStyle}>
        <h3 style={headingStyle}>{t('sectionTarget')}</h3>
        {data.target === null
          ? <p style={{ margin: 0, fontSize: '12px', color: '#8b9199' }}>{t('noTarget')}</p>
          : (
            <div style={{ fontSize: '12px', display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{data.target.artifactLabel}</span>
              {data.target.artifactVersion === undefined ? null : <code style={{ color: '#8b9199' }}>{data.target.artifactVersion}</code>}
              {!data.target.valid ? <Chip ok={false}>失效</Chip> : null}
              <button
                style={{ ...buttonStyle, marginLeft: 'auto', fontSize: 11 }}
                onClick={() => { void unbind() }}
              >
                {t('unbind')}
              </button>
            </div>
          )}
        <p style={{ margin: 0, fontSize: '11px', color: '#6f757c', lineHeight: 1.6 }}>{t('targetHint')}</p>
      </section>

      {/* The eight slots, each showing both names. */}
      <section style={sectionStyle}>
        <h3 style={headingStyle}>{t('sectionSlots')}</h3>
        <div style={gridStyle}>
          {data.slots.length === 0
            ? <p style={{ margin: 0, fontSize: '12px', color: '#8b9199' }}>{t('emptySlots')}</p>
            : data.slots.map(slot => (
              <div
                key={slot.id}
                style={{
                  boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) auto auto', alignItems: 'center', gap: 10, minWidth: 0, padding: '10px 12px',
                  border: '1px solid var(--dsw-alias-border-l1, #e2e2dc)', borderRadius: 9, fontSize: 12,
                  background: 'var(--dsw-alias-bg-layer-1, #fcfcfa)',
                }}
              >
                {slot.image === null
                  ? <span style={{ width: 28, height: 28, display: 'grid', placeItems: 'center', color: '#5a6068' }}>?</span>
                  : <img src={slot.image} alt="" width={28} height={28} style={{ objectFit: 'contain' }} />}
                <div style={{ minWidth: 0 }}>
                  <div>{slot.emoteNameZh} <span style={{ color: '#6f757c' }}>({slot.emoteName})</span></div>
                  <small style={{ color: '#8b9199' }}>{slot.hover}</small>
                </div>
                {slot.missing === null ? null : <Chip ok={false}>{t('missing')}</Chip>}
                {slot.animation === null ? null : (
                  <button
                    style={{ ...buttonStyle, fontSize: 11, marginLeft: 'auto' }}
                    onClick={() => previewAnimation(slot)}
                  >
                    {t('preview')}
                  </button>
                )}
                {slot.sound === null ? null : (
                  <button
                    style={{ ...buttonStyle, fontSize: 11 }}
                    onClick={() => { void new Audio(slot.sound ?? '').play().catch(() => undefined) }}
                  >
                    {t('listen')}
                  </button>
                )}
              </div>
            ))}
        </div>
      </section>

      {/* Recent quick asks, which is also how a stale target is spotted. */}
      <section style={sectionStyle}>
        <h3 style={headingStyle}>{t('sectionSessions')}</h3>
        {data.sessions.length === 0
          ? <p style={{ margin: 0, fontSize: '12px', color: '#8b9199' }}>{t('emptySessions')}</p>
          : data.sessions.slice(0, 6).map(session => (
            <div key={session.sessionId} style={{ fontSize: '12px', display: 'flex', gap: 8 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.title}</span>
              <span style={{ marginLeft: 'auto', color: '#6f757c', fontSize: '11px' }}>
                {new Date(session.at).toLocaleString()}
              </span>
            </div>
          ))}
      </section>
    </div>
  )
}
