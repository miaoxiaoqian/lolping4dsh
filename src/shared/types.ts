/**
 * Shapes shared by the host half, the overlay pages, and the settings panel.
 *
 * These declarations are transcribed rather than imported: a profile-installed
 * bundle is linked into the profile, so a bare specifier would not resolve from
 * this package's real directory. Each block names where the same shape is
 * declared on the desktop side, because the two must agree and there is no import
 * that would let them prove it at build time.
 *
 * @module @local/dsh-quick-help/shared/types
 */

/** The four default actions, plus whatever other plugins register. */
export type ActionId = string

/** How the wheel is summoned. */
export type InteractionMode = 'press' | 'hold'

/**
 * Why an action may not be offered right now.
 *
 * An action with a reason is not shown at all rather than shown and failing: a
 * wheel button that lights up and then refuses is worse than an absent one.
 */
export interface ActionAvailability {
  readonly available: boolean
  /** Chinese sentence shown in the settings panel when unavailable. */
  readonly reason?: string
}

/** One entry in the wheel. */
export interface WheelAction {
  readonly id: ActionId
  /** Chinese label drawn under the icon. */
  readonly label: string
  /** Inline SVG path data, drawn by the page itself. No binary assets. */
  readonly icon: string
  /** Short line explaining what the action will do, for the settings panel. */
  readonly hint: string
  /** Whether the action runs a model turn, which the UI must say out loud. */
  readonly usesModel: boolean
  readonly availability: ActionAvailability
}

/**
 * One action as this plugin knows it, before availability is resolved.
 *
 * Other plugins register through this shape and nothing richer: there is no way
 * to hand the wheel a callback it would have to trust with arbitrary authority.
 */
export interface ActionRegistration {
  readonly id: ActionId
  readonly label: string
  readonly icon: string
  readonly hint?: string
  /** Whether selecting this action starts a model turn. Default false. */
  readonly usesModel?: boolean
  /**
   * Whether the action can run right now. Checked again at selection time, not
   * only when the wheel is built, because a model can become unavailable between
   * the two.
   */
  readonly isAvailable?: () => ActionAvailability
  /**
   * What the action needs from the user before it can run.
   *
   * `none` runs immediately. `ask` opens the ask window and runs with the typed
   * text. `selection` opens the ask window with the user's current text
   * selection already filled in, which the page reads from the clipboard the
   * moment the button is pressed rather than at any earlier time.
   */
  readonly input?: 'none' | 'ask' | 'selection'
  /** Run the action. Called at most once per selection. */
  readonly run: (request: ActionRunRequest) => Promise<void>
}

/** What a selected action receives. */
export interface ActionRunRequest {
  /** The text the user typed in the ask window, when the action needed one. */
  readonly text: string
  /** The conversation the answer belongs to. */
  readonly sessionId: string
  /** Report progress back to the ask window. */
  readonly emit: (chunk: string) => void
}

/** Everything the wheel page needs to draw itself. */
export interface WheelView {
  readonly actions: readonly WheelAction[]
  readonly size: number
  readonly mode: InteractionMode
  readonly holdKeyLabel: string
}

/** Persisted settings. */
export interface QuickHelpSettings {
  /**
   * Global hotkey, in Electron accelerator syntax.
   *
   * Bare Space is treated as a gesture candidate for only 500ms: a tap is
   * replayed as normal input, while pointer movement commits to the wheel.
   * Modified Space chords are never claimed.
   */
  readonly hotkey: string
  /** Bare Space buffering is opt-in because it briefly intercepts ordinary input. */
  readonly spaceGestureEnabled: boolean
  /** Global shortcut that opens the ask window directly, skipping the wheel. */
  readonly askHotkey: string
  readonly mode: InteractionMode
  readonly iconSize: number
  readonly actions: readonly ActionId[]
  readonly disabled: readonly ActionId[]
  /** Paused globally; the wheel stops responding without being uninstalled. */
  readonly paused: boolean
  /** Which model route quick asks use. Empty means "whatever the deployment uses". */
  readonly modelRoute: string
  /** Milliseconds before an unanswered ask is abandoned. */
  readonly timeoutMs: number
  /** Whether the ask window stays when it loses focus. */
  readonly keepFocus: boolean
  /** Where the ask window opens relative to the pointer. */
  readonly placement: 'pointer' | 'center'
  /** Whether action and hover sounds are played. */
  readonly soundEnabled: boolean
  /** Playback volume from 0 through 1. */
  readonly soundVolume: number
}

/** The defaults, in one place so the panel and the host cannot disagree. */
export const DEFAULT_SETTINGS: QuickHelpSettings = {
  // A plain Control press passes through; movement while held opens the wheel.
  hotkey: 'Control',
  spaceGestureEnabled: false,
  askHotkey: '',
  mode: 'hold',
  iconSize: 32,
  // The eight default slots, clockwise from north, matching DEFAULT_SLOTS in
  // `shared/assets.ts`. Written out rather than derived so a broken import cannot
  // silently produce a four-slot wheel.
  actions: ['stop', 'revise', 'continue', 'explain', 'ask', 'verify', 'save', 'accept'],
  disabled: [],
  paused: false,
  modelRoute: '',
  timeoutMs: 120_000,
  keepFocus: false,
  placement: 'pointer',
  soundEnabled: true,
  soundVolume: 0.7,
}

/** Machine state the settings panel shows but does not set. */
export interface QuickHelpStatus {
  /** Whether this OS can run the wheel at all. */
  readonly supported: boolean
  /** Whether the OS has granted the accessibility permission. */
  readonly accessibility: boolean
  /** The native helper's state. */
  readonly helper: 'stopped' | 'starting' | 'running' | 'no-access' | 'crashed' | 'unsupported'
  /** Why the helper is unhappy, when it is. */
  readonly helperDetail?: string
  /** The bound hotkey as the OS actually accepted it. */
  readonly boundHotkey: string
  /** The deployment's current default model route, for display. */
  readonly defaultModelRoute: string
  /** Whether a model turn is possible right now. */
  readonly modelAvailable: boolean
  /** The most recent quick ask, so the panel can point at it. */
  readonly lastSession?: { readonly sessionId: string; readonly title: string; readonly at: number }
}

/** One quick-ask turn as the ask window renders it. */
export interface AskTurn {
  /** Logged wheel action, shown as a compact notice instead of a user bubble. */
  readonly feedback?: { readonly action: string }
  readonly id?: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly at: number
  /** Same durable images shown by the main desktop conversation. */
  readonly images?: readonly { attachmentId: string; mediaType: string; width: number; height: number; name?: string; url: string }[]
  /** Set while an assistant turn is still streaming. */
  readonly streaming?: boolean
  /** Present when this turn ended badly; the text is whatever did arrive. */
  readonly error?: string
}

/** Everything the ask window renders. */
export interface AskView {
  readonly sessionId: string
  readonly turns: readonly AskTurn[]
  /** True while a turn is streaming. */
  readonly busy: boolean
  /** Whether the model route cannot be used; the input is disabled and says so. */
  readonly modelUnavailable?: string
  /** The saved state of the window, restored on the next open. */
  readonly draft: string
  readonly pinned: boolean
  /** Set after the user pressed stop, so the UI can say it was deliberate. */
  readonly stopped?: boolean
  /**
   * Media to play once when this view is first rendered.
   *
   * The animation cannot play in the wheel window: the wheel closes the instant a
   * slice is chosen, so anything started there is hidden before its first frame
   * lands. The action therefore hands its media to the window that outlives the
   * gesture, and the host clears it once delivered so a reopen does not replay.
   */
  readonly feedback?: { readonly animation?: string; readonly sound?: string }
}
