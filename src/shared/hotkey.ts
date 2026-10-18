/**
 * Accelerator parsing: one chord string to one key code plus a modifier mask.
 *
 * This is the piece that decides whether a keystroke belongs to the wheel. It
 * exists as its own module because two very different consumers need the same
 * answer — the settings page, to show the user what it understood, and the native
 * helper, to decide whether to swallow an event — and a chord that the two
 * disagree about is a key that either does nothing or stops working everywhere.
 *
 * The rule the whole design rests on: a chord is only claimed when *every*
 * modifier it names is actually down. A bare trigger key therefore passes straight
 * through, which is what keeps the rest of the keyboard usable.
 */

/** The keys an accelerator may end with, as macOS virtual key codes. */
export const TRIGGER_VK: Readonly<Record<string, number>> = {
  A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38, K: 40,
  L: 37, M: 46, N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17, U: 32,
  V: 9, W: 13, X: 7, Y: 16, Z: 6,
  0: 29, 1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 24,
  SPACE: 49, BACKQUOTE: 50, MINUS: 27, LEFTBRACKET: 33, RIGHTBRACKET: 30,
  BACKSLASH: 42, SEMICOLON: 41, QUOTE: 39, COMMA: 43, PERIOD: 47, SLASH: 44,
}

/**
 * `CGEventFlags` bits for the modifiers.
 *
 * Catalogued rather than hard-coded into the helper, so the C++ side only ever
 * compares against a number this module produced. Caps Lock and the numeric-keypad
 * bit are deliberately absent: they are flags on an event but nobody names them in
 * an accelerator, so requiring or forbidding them would be a guess.
 */
export const MODIFIER_FLAGS: Readonly<Record<string, number>> = {
  SHIFT: 1 << 17,
  CONTROL: 1 << 18,
  OPTION: 1 << 19,
  COMMAND: 1 << 20,
}

/** Spellings seen in the wild, folded onto the four flags above. */
const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  SHIFT: 'SHIFT',
  CTRL: 'CONTROL', CONTROL: 'CONTROL',
  ALT: 'OPTION', OPT: 'OPTION', OPTION: 'OPTION',
  CMD: 'COMMAND', COMMAND: 'COMMAND', SUPER: 'COMMAND', META: 'COMMAND',
}

/** What an accelerator resolves to. */
export interface ParsedHotkey {
  /** The accelerator as written, trimmed and with its parts in a stable order. */
  readonly accelerator: string
  /** The final key, upper-cased, as it appears in `TRIGGER_VK`. */
  readonly key: string
  /** macOS virtual key code the helper watches. */
  readonly code: number
  /** Flags that must all be down for this to be a trigger; 0 for no modifiers. */
  readonly mask: number
  /** The modifier names, for display. */
  readonly modifiers: readonly string[]
}

/**
 * Parse an accelerator, or return undefined when it names no usable trigger key.
 *
 * @param accelerator - a chord such as `Control+Option+Space`.
 * @returns the parsed chord, or undefined if the last part is not a trigger key.
 */
export function parseAccelerator(accelerator: string): ParsedHotkey | undefined {
  if (typeof accelerator !== 'string') return undefined
  const parts = accelerator.split('+').map(part => part.trim().toUpperCase())
  if (parts.some(part => part === '')) return undefined

  if (parts.length === 1 && (parts[0] === 'CONTROL' || parts[0] === 'CTRL')) {
    // VK 59 is a protocol marker for a Control-only gesture. The native tap
    // watches flagsChanged and accepts either physical Control key.
    return { accelerator: 'Control', key: 'CONTROL', code: 59, mask: 0, modifiers: [] }
  }

  const key = parts[parts.length - 1] as string
  const code = TRIGGER_VK[key]
  // A chord ending in Return, Tab or a function key is nearly always a mistake:
  // those keys carry meaning in almost every application, and the list above
  // deliberately omits them rather than guessing what the user meant.
  if (code === undefined) return undefined

  const modifiers = parts.slice(0, -1)
  const canonical: string[] = []
  let mask = 0
  for (const modifier of modifiers) {
    const name = MODIFIER_ALIASES[modifier]
    // An unknown modifier is a typo, not a request to ignore it. Accepting the
    // chord anyway would bind something the user did not ask for.
    if (name === undefined) return undefined
    if (canonical.includes(name)) continue
    canonical.push(name)
    mask |= MODIFIER_FLAGS[name] as number
  }

  return {
    accelerator: [...canonical, key].join('+'),
    key,
    code,
    mask,
    modifiers: canonical,
  }
}

/**
 * Whether a keystroke belongs to the wheel.
 *
 * Every named modifier must be down; extras are tolerated on purpose. Caps Lock is
 * a flag on the event like any other, so demanding an exact flag match would mean
 * the wheel stopped responding the moment the user turned Caps Lock on — a failure
 * with no visible cause. Superfluous modifiers are the cheaper mistake: holding
 * Shift as well still triggers, which is survivable, whereas a dead hotkey is not.
 *
 * @param parsed - the chord to test against.
 * @param keycode - the event's virtual key code.
 * @param flags - the event's `CGEventFlags`, as a number.
 */
export function chordMatches(parsed: ParsedHotkey, keycode: number, flags: number): boolean {
  if (parsed.key === 'CONTROL') return false // flagsChanged, never KeyDown.
  if (keycode !== parsed.code) return false
  // Bare Space is an intentional gesture trigger. Modified Space must remain
  // entirely available to macOS input-source switching and application shortcuts.
  if (parsed.code === TRIGGER_VK.SPACE && parsed.mask === 0) {
    const modifiers = (MODIFIER_FLAGS.SHIFT ?? 0) | (MODIFIER_FLAGS.CONTROL ?? 0) |
      (MODIFIER_FLAGS.OPTION ?? 0) | (MODIFIER_FLAGS.COMMAND ?? 0)
    return (flags & modifiers) === 0
  }
  // `(flags & mask) === mask` is "all required bits present", which is the tolerant
  // form described above.
  return (flags & parsed.mask) === parsed.mask
}

/**
 * Chords spoken for by macOS itself, so the settings page can warn before the user
 * picks one and wonders why two things happen at once.
 *
 * Only defaults that ship with a clean install. `Option+Space` is deliberately
 * absent here and must be checked on the running machine. Third-party input methods may claim it, and that is what the runtime probe
 * is for — a list like this cannot see the user's machine, and padding it with
 * guesses would train people to ignore the warning.
 *
 * The wheel does not *claim* a chord (it observes, and lets through everything that
 * is not an exact match), so a collision here means both actions fire, not that the
 * other one is broken. That is still worth saying.
 */
export const RESERVED_CHORDS: readonly string[] = [
  'COMMAND+SPACE',         // Spotlight
  'COMMAND+OPTION+SPACE',  // Finder search window
  'CONTROL+SPACE',         // select the previous input source
  // Control+Option+R is not reserved by macOS defaults; third-party bindings
  // remain discoverable only through the running-host probe when available.
  'COMMAND+TAB', 'COMMAND+GRAVE',
  'COMMAND+Q', 'COMMAND+H', 'COMMAND+M', 'COMMAND+W',
]

/**
 * Whether a chord is on the courtesy list above.
 *
 * @param accelerator - the chord as written.
 * @returns the canonical form of the reserved chord it collides with, if any.
 */
export function reservedCollision(accelerator: string): string | undefined {
  const parsed = parseAccelerator(accelerator)
  if (parsed === undefined) return undefined
  const canonical = [...parsed.modifiers, parsed.key].join('+')
  return RESERVED_CHORDS.includes(canonical) ? canonical : undefined
}

/**
 * A human label for a chord, for the settings page and error messages.
 *
 * @param accelerator - the chord as written.
 * @returns something readable, or the original string when it cannot be parsed.
 */
export function describeChord(accelerator: string): string {
  const parsed = parseAccelerator(accelerator)
  if (parsed === undefined) return accelerator
  if (parsed.key === 'CONTROL') return 'Control'
  const names: Record<string, string> = { SHIFT: 'Shift', CONTROL: 'Control', OPTION: 'Option', COMMAND: 'Command' }
  return [...parsed.modifiers.map(name => names[name] ?? name), parsed.key].join('+')
}
