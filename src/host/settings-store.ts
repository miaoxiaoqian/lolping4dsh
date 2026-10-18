/**
 * Persisted settings, and the state directory they live in.
 *
 * Written atomically through a temporary file and a rename, so a crash during a
 * save cannot leave a half-written settings file that reads as empty defaults and
 * silently discards the user's hotkey. Mode 0600 because the file records where
 * the user's notes and task output live.
 *
 * @module @local/dsh-quick-help/host/settings-store
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAccelerator } from '../shared/hotkey.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import type { InteractionMode, QuickHelpSettings } from '../shared/types.ts'

/** File name inside the plugin's state directory. */
const FILE = 'settings.json'

/** Wheel sizes the user may pick, in DIP. The extremes are deliberate bounds. */
export const SIZE_CHOICES = [24, 32, 40, 48, 56, 64, 72] as const

/**
 * Coerce anything read off disk into a valid settings object.
 *
 * A settings file is user-editable and survives across plugin versions, so every
 * field is checked rather than trusted. An unknown action id is dropped instead of
 * kept: a slot naming an emote this build does not ship would render as a broken
 * button, and the honest response is to fall back to the default wheel.
 */
export function normalizeSettings(raw: unknown, knownActions: readonly string[]): QuickHelpSettings {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  // Trimmed before the empty check: a binding of spaces would register as a
  // hotkey that can never be pressed.
  const requested = str(input.hotkey, DEFAULT_SETTINGS.hotkey).trim()
  // A chord the helper cannot match is worse than no chord at all: the settings
  // page would show a binding that silently never fires. Unparseable input falls
  // back to the default rather than being stored and quietly ignored.
  const hotkey = parseAccelerator(requested) === undefined ? DEFAULT_SETTINGS.hotkey : requested
  // Empty is legitimate here — it means "no direct ask shortcut", unlike the wheel's.
  const askHotkey = str(input.askHotkey, DEFAULT_SETTINGS.askHotkey).trim()
  const requestedMode: InteractionMode = input.mode === 'hold' ? 'hold' : 'press'
  // Bare Space is never a key-only hotkey: a plain tap is replayed as input,
  // while only Space+pointer movement creates the wheel gesture.
  const mode: InteractionMode = ['space', 'control', 'ctrl'].includes(hotkey.trim().toLowerCase()) ? 'hold' : requestedMode
  const iconSize = SIZE_CHOICES.includes(input.iconSize as 48) ? Number(input.iconSize) : DEFAULT_SETTINGS.iconSize
  const disabled = Array.isArray(input.disabled)
    ? input.disabled.filter((id): id is string => typeof id === 'string' && knownActions.includes(id))
    : [...DEFAULT_SETTINGS.disabled]
  const placement = input.placement === 'center' ? 'center' : 'pointer'
  const oldDefaultOrder = ['ask', 'revise', 'explain', 'verify', 'stop', 'continue', 'save', 'accept']
  const storedActions = Array.isArray(input.actions) ? input.actions : undefined
  const migrateDefaultOrder = storedActions !== undefined
    && storedActions.length === oldDefaultOrder.length
    && oldDefaultOrder.every((id, index) => storedActions[index] === id)
  const normalizedActions = storedActions
    ? storedActions.filter((id): id is string => typeof id === 'string' && knownActions.includes(id))
    : [...DEFAULT_SETTINGS.actions]
  return {
    // Already validated above: whatever reaches here parses as a chord.
    hotkey,
    // Missing is intentionally false for existing installs: users must opt in
    // before the native helper buffers a bare Space key.
    spaceGestureEnabled: input.spaceGestureEnabled === true,
    askHotkey,
    mode,
    iconSize,
    // Eight sectors, always. A wheel with fewer would leave dead angles that the
    // native helper still reports as sectors, and more has no meaning here.
    actions: migrateDefaultOrder
      ? [...DEFAULT_SETTINGS.actions]
      : normalizedActions.length === 8 ? normalizedActions : [...DEFAULT_SETTINGS.actions],
    disabled,
    paused: input.paused === true,
    modelRoute: str(input.modelRoute, ''),
    timeoutMs: clampNumber(input.timeoutMs, 5_000, 600_000, DEFAULT_SETTINGS.timeoutMs),
    keepFocus: input.keepFocus === true,
    placement,
    soundEnabled: input.soundEnabled !== false,
    soundVolume: typeof input.soundVolume === 'number' && Number.isFinite(input.soundVolume)
      ? Math.max(0, Math.min(1, input.soundVolume))
      : DEFAULT_SETTINGS.soundVolume,
  }
}

/** Read a string field, falling back when it is absent or the wrong shape. */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Read a number inside a range. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Reads and writes the settings file. */
export class SettingsStore {
  /** @param stateDir - This plugin's own directory under the DSH home. */
  constructor(private readonly stateDir: string) {}

  /** Load the settings, falling back to defaults on anything unreadable. */
  read(knownActions: readonly string[]): QuickHelpSettings {
    try {
      return normalizeSettings(JSON.parse(readFileSync(join(this.stateDir, FILE), 'utf8')) as unknown, knownActions)
    } catch {
      // A missing file is the normal first run. A corrupt one is reported the
      // same way rather than crashing the plugin over its own preferences.
      return { ...DEFAULT_SETTINGS }
    }
  }

  /** Write the settings atomically. */
  write(settings: QuickHelpSettings): void {
    mkdirSync(this.stateDir, { recursive: true })
    const target = join(this.stateDir, FILE)
    const temp = `${target}.tmp`
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, target)
    chmodSync(target, 0o600)
  }

  /** Where the plugin keeps its state. */
  get dir(): string {
    return this.stateDir
  }
}

/**
 * The DSH home, taken from the environment the host already set.
 *
 * The settings file must not live in a profile directory the plugin manager may
 * replace, so it goes under the home next to the other per-plugin state.
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME_PATH ?? env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const home = env.HOME
  if (home !== undefined && home !== '') return join(home, '.dsh')
  return join(process.cwd(), '.dsh')
}
