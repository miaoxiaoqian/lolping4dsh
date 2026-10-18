/** Restore feedback to the answer shown by this quick-help conversation. */
import type { BindingTracker, ActionBinding } from './binding.ts'
import type { SessionManager } from './sessions.ts'

/** Rehydrate a carried target without selecting any other conversation. */
export async function currentTarget(sessions: SessionManager, bindings: BindingTracker): Promise<ActionBinding | undefined> {
  const held = bindings.bound
  if (held && bindings.provenance?.source === 'explicit') {
    try { bindings.refresh(await sessions.context(held.sessionId, held.answerId)) }
    catch (error) { bindings.invalidate(error instanceof Error ? error.message : String(error)) }
    return bindings.bound
  }
  const sessionId = sessions.current()
  if (held && held.sessionId !== sessionId) bindings.clear()
  if (!sessions.has(sessionId)) return undefined
  try {
    const snapshot = await sessions.context(sessionId)
    bindings.advance(snapshot)
  } catch (error) {
    // A fresh question or an unfinished first answer has no completed feedback target.
    if (bindings.bound) bindings.invalidate(error instanceof Error ? error.message : String(error))
  }
  return bindings.bound
}
