import { useState } from 'react'
import type { ReactElement } from 'react'

const API = '/quick-help/api'

interface Props {
  messageId: string
  bindTarget(messageId: string): Promise<void>
}

/** Bind this durable, finalized assistant message as the wheel's exact target. */
export function AssistantWheelTarget({ messageId, bindTarget }: Props): ReactElement | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bound, setBound] = useState(false)
  const bridge = (globalThis as { __DSH_QUICK_HELP__?: { compactSessionId?(): string | undefined } }).__DSH_QUICK_HELP__
  if (bridge?.compactSessionId?.()) return null

  const choose = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await bindTarget(messageId)
      setBound(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="button" disabled={busy} onClick={() => { void choose() }}>
        {busy ? '选择中…' : bound ? '轮盘正在评价这条' : '对这条使用轮盘'}
      </button>
      {error === null ? null : <span role="status" style={{ color: '#b8443c', fontSize: 11 }}>{error}</span>}
    </span>
  )
}

/** Encode a binding request with the slot's real Session and message identities. */
export async function bindAssistantAnswer(sessionId: string, messageId: string): Promise<void> {
  const response = await fetch(`${API}/target`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      answerId: messageId,
      artifactLabel: '快捷求助目标',
      kind: 'general',
      source: 'explicit',
    }),
  })
  const body = await response.json().catch(() => ({})) as { message?: string; reason?: string }
  if (!response.ok) throw new Error(body.message || body.reason || `目标绑定失败（${response.status}）`)
}
