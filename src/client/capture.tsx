/** Screen selection feeds the standard composer's image intake, never a parallel send path. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { T } from './locales.ts'

interface CaptureBridge {
  compactSessionId(): string | undefined
  captureSelection(owner: string): Promise<'captured' | 'cancelled'>
  readCapture(owner: string): Promise<string | undefined>
  discardCapture(): Promise<void>
  show(request: { route: 'ask'; focusable: true; clickThrough: false }): Promise<void>
}

/** Only a compact desktop document may access a pending screen selection. */
function bridgeFor(sessionId: string): CaptureBridge | undefined {
  const bridge = (globalThis as { __DSH_QUICK_HELP__?: CaptureBridge }).__DSH_QUICK_HELP__
  return bridge?.compactSessionId?.() === sessionId ? bridge : undefined
}

/** A PNG stays local until the user sends it with the normal composer. */
export function CompactCapture({ sessionId, addFiles, t }: { sessionId: string; addFiles(files: readonly File[]): boolean; t: T }) {
  const bridge = bridgeFor(sessionId)
  const loading = useRef(false)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const adopt = useCallback(async (): Promise<void> => {
    if (!bridge || loading.current) return
    loading.current = true
    try {
      const url = await bridge.readCapture(sessionId)
      if (!url || !mounted.current) return
      if (!url.startsWith('data:image/png;base64,')) throw new Error(t('captureFailed'))
      const bytes = Uint8Array.from(atob(url.slice('data:image/png;base64,'.length)), char => char.charCodeAt(0))
      const file = new File([bytes], '截图.png', { type: 'image/png' })
      if (!addFiles([file])) throw new Error(t('captureRejected'))
      await bridge.discardCapture()
      if (mounted.current) setError('')
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('captureFailed'))
    } finally { loading.current = false }
  }, [bridge, sessionId, addFiles, t])
  useEffect(() => { mounted.current = true; void adopt(); return () => { mounted.current = false } }, [adopt])
  if (!bridge) return null
  return <>
    <button type="button" title={t('capture')} aria-label={t('capture')} disabled={busy} onClick={() => {
      setBusy(true)
      void (async () => {
        try { await bridge.captureSelection(sessionId); await bridge.show({ route: 'ask', focusable: true, clickThrough: false }); await adopt() }
        catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t('captureFailed')) }
        finally { if (mounted.current) setBusy(false) }
      })()
    }}>▣</button>
    {error ? <span role="alert" title={error} style={{fontSize:11,lineHeight:'16px',maxHeight:48,overflowY:'auto',maxWidth:260,whiteSpace:'normal'}}>{error.replace(/^Error invoking remote method '[^']+': Error: /, '')}</span> : null}
  </>
}
