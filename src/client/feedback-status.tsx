/** Small status/error strip for wheel actions; never inserts a synthetic user bubble. */
import { useEffect, useState } from 'react'
import type { T } from './locales.ts'

export function CompactFeedbackStatus({ sessionId, t }: { sessionId: string; t: T }) {
  const bridge = (globalThis as { __DSH_QUICK_HELP__?: { compactSessionId?(): string | undefined } }).__DSH_QUICK_HELP__
  const compact = bridge?.compactSessionId?.() === sessionId
  const [notice, setNotice] = useState({ text: '', error: false })
  useEffect(() => {
    if (!compact) return
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deferredError = sessionStorage.getItem('quick-help.error')
    const deferred = deferredError || sessionStorage.getItem('quick-help.notice')
    const expires = Date.now() + 6_000
    sessionStorage.removeItem('quick-help.error')
    sessionStorage.removeItem('quick-help.notice')
    if (deferred) setNotice({ text: deferred, error: !!deferredError })
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch('/quick-help/api/action-status', { signal: lifetime.signal })
        if (!response.ok) return
        const state = await response.json() as { sessionId: string; actionError?: string; mediaError?: string; running?: string }
        if (state.sessionId !== sessionId || lifetime.signal.aborted) return
        if (state.mediaError) setNotice({ text: state.mediaError, error: true })
        else if (state.actionError) setNotice({ text: state.actionError, error: true })
        else if (state.running) setNotice({ text: state.running === 'revise' ? t('feedbackRevising') : t('feedbackWorking'), error: false })
        else if (!deferred || Date.now() >= expires) setNotice({ text: '', error: false })
      } catch (cause) {
        if (!lifetime.signal.aborted) console.warn('quick help action status:', cause)
      } finally { if (!lifetime.signal.aborted) timer = setTimeout(() => { void poll() }, 1_000) }
    }
    void poll()
    return () => { lifetime.abort(); clearTimeout(timer) }
  }, [compact, sessionId, t])
  if (!compact || !notice.text) return null
  return <div role={notice.error ? 'alert' : 'status'} style={{fontSize:11,lineHeight:'16px',maxHeight:40,overflowY:'auto',padding:'3px 8px',color:notice.error?'#b64141':'inherit'}}>{notice.text}</div>
}
