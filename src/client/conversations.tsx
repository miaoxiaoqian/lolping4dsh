/** Minimal conversation navigation for the dedicated quick-help titlebar. */
import { useEffect, useRef, useState } from 'react'
import type { T } from './locales.ts'

interface CompactBridge {
  compactSessionId(): string | undefined
  show(request: { route: 'ask'; focusable: true; clickThrough: false }): Promise<void>
}
interface Conversation { sessionId: string; title: string }

async function request(method: 'GET' | 'POST', body?: object): Promise<{ sessions?: Conversation[] }> {
  const response = await fetch('/quick-help/api/compact-conversations', {
    method, signal: AbortSignal.timeout(8_000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.message || `请求失败（${response.status}）`)
  return value
}

/** Native selection keeps the picker small and scrollable without adding a sidebar. */
export function CompactConversations({ t }: { t: T }) {
  const bridge = (globalThis as { __DSH_QUICK_HELP__?: CompactBridge }).__DSH_QUICK_HELP__
  const current = bridge?.compactSessionId?.()
  const [sessions, setSessions] = useState<Conversation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  async function load(): Promise<void> {
    try {
      const value = await request('GET')
      if (mounted.current) setSessions((value.sessions ?? []).filter(item => typeof item.sessionId === 'string' && typeof item.title === 'string'))
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t('conversationFailed')) }
  }
  useEffect(() => { mounted.current = true; if (current) void load(); return () => { mounted.current = false } }, [current])
  if (!current || !bridge) return null
  async function navigate(sessionId?: string): Promise<void> {
    if (pending.current || !bridge) return
    pending.current = true; setBusy(true); setError('')
    try {
      await request('POST', { expectedSessionId: current, mode: sessionId ? 'select' : 'new', ...(sessionId ? { sessionId } : {}) })
      // Main owns the URL and exact Session authorization; the renderer never navigates itself.
      await bridge.show({ route: 'ask', focusable: true, clickThrough: false })
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t('conversationFailed')) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  return <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
    <select aria-label={t('switchConversation')} title={t('switchConversation')} value={current} disabled={busy}
      onFocus={() => { void load() }} onChange={event => { void navigate(event.target.value) }}
      style={{ width: 120, minWidth: 0, height: 26, font: 'inherit', fontSize: 12, color: 'inherit', background: 'transparent', border: 0, borderRadius: 'var(--dsw-radius-sm)', textOverflow: 'ellipsis' }}>
      {!sessions.some(item => item.sessionId === current) ? <option value={current}>{t('currentConversation')}</option> : null}
      {sessions.map(item => <option key={item.sessionId} value={item.sessionId}>{item.title}</option>)}
    </select>
    <button type="button" aria-label={t('newConversation')} title={t('newConversation')} disabled={busy}
      style={{ width: 'auto', padding: '0 6px', fontSize: 12 }} onClick={() => { void navigate() }}>{t('newConversation')}</button>
    {error ? <span role="alert" style={{ position: 'absolute', top: 36, left: 8, right: 8, zIndex: 10, padding: 6, fontSize: 12, background: 'var(--dsw-alias-bg-layer-1)' }}>{error}</span> : null}
  </div>
}
