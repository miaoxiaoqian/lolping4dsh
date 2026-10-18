/** Bounded local playback diagnostics contain asset names and geometry, never conversation text. */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PHASES = ['visible', 'image-ready', 'audio-playing', 'image-failed', 'audio-failed'] as const
type Phase = typeof PHASES[number]
interface Playback {
  id: string; sessionId: string; image: string; at: number
  point: { x: number; y: number }
  bounds: { x: number; y: number; width: number; height: number }
  phases: { phase: Phase; at: number }[]
}

export class MediaStatus {
  private readonly entries = new Map<string, Playback>()
  constructor(private readonly path: string) {}
  /** Validate a renderer report and retain at most 16 recent selections. */
  report(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false
    const input = raw as Record<string, unknown>
    if (typeof input.id !== 'string' || !input.id || input.id.length > 128
      || typeof input.sessionId !== 'string' || input.sessionId.length > 256
      || typeof input.image !== 'string' || !/^\/quick-help\/asset\/(textures|emotes)\/[\w.-]+\.png$/.test(input.image)
      || typeof input.phase !== 'string' || !(PHASES as readonly string[]).includes(input.phase)) return false
    const point = rectangle(input.point, ['x', 'y'])
    const bounds = rectangle(input.bounds, ['x', 'y', 'width', 'height'])
    if (!point || !bounds) return false
    let entry = this.entries.get(input.id)
    if (!entry) {
      entry = { id: input.id, sessionId: input.sessionId, image: input.image, at: Date.now(), point: { x: point.x!, y: point.y! }, bounds: { x: bounds.x!, y: bounds.y!, width: bounds.width!, height: bounds.height! }, phases: [] }
      this.entries.set(entry.id, entry)
    }
    if (entry.sessionId !== input.sessionId || entry.image !== input.image) return false
    if (!entry.phases.some(item => item.phase === input.phase)) entry.phases.push({ phase: input.phase as Phase, at: Date.now() })
    if (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value!)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify([...this.entries.values()], null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path)
    return true
  }
  /** Latest selection for this Session; late reports cannot replace a newer choice. */
  latest(sessionId: string): Playback | undefined {
    return [...this.entries.values()].findLast(item => item.sessionId === sessionId)
  }
  error(sessionId: string): string | undefined {
    const entry = this.latest(sessionId)
    if (!entry || Date.now() - entry.at > 8_000) return undefined
    const imageFailed = entry.phases.some(item => item.phase === 'image-failed')
    const audioFailed = entry.phases.some(item => item.phase === 'audio-failed')
    if (imageFailed && audioFailed) return '动画和音效未能播放，请重试。'
    if (imageFailed) return '动画未能加载，请重试。'
    if (audioFailed) return '音效未能播放，请重试。'
    return undefined
  }
}

function rectangle(value: unknown, keys: readonly string[]): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const result: Record<string, number> = {}
  for (const key of keys) { const n = record[key]; if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1_000_000) return undefined; result[key] = n }
  return result
}
