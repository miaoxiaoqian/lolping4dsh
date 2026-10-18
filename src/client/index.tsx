/**
 * The browser half's entry point.
 *
 * It contributes two things — a sidebar row and the page behind it — which is the
 * pairing the sidebar requires: the list seat carries the entry's identity, label
 * and glyph, and the keyed `main` seat renders the same id as a full page.
 * Registering one without the other leaves a clickable row with no destination.
 *
 * @module @local/dsh-quick-help/client
 */
import type { ClientContext, PanelIconProps } from './dsh.ts'
import { AssistantWheelTarget, bindAssistantAnswer } from './assistant-action.tsx'
import { QuickHelpPanel } from './panel.tsx'
import { CompactCapture } from './capture.tsx'
import { CompactFeedbackStatus } from './feedback-status.tsx'
import { CompactConversations } from './conversations.tsx'
import { NS, dictionaries, zhCN, enUS, type T } from './locales.ts'

/** The panel's identity. One string, used by both seats. */
const PANEL_ID = 'quick-help'

/** Where in the sidebar's list this panel sits, beside the other local tools. */
const PANEL_ORDER = 34

/**
 * Services this half calls.
 *
 * This is the catalogue's *service* injection, not the `dsh.client.inject` module
 * list in package.json: the loader treats a service reached without a declaration
 * as an error at the moment it is read, so omitting this does not degrade the
 * panel — it aborts this entry's activation and the web boot then refuses to
 * finish, taking the whole application down with it.
 */
export const inject = ['slots', 'locale']

/**
 * The glyph the sidebar draws.
 *
 * A bare `<svg>` with no wrapper: the sidebar places it as the direct child of its
 * own slot, and a wrapper would make it the baseline of a line box and lift it
 * above the label. The sidebar owns the accessible name, so this is decorative.
 *
 * @param props - the requested edge length.
 * @returns the glyph.
 */
function QuickHelpIcon({ size }: PanelIconProps): unknown {
  const edge = typeof size === 'number' ? size : 16
  return (
    <svg
      width={edge}
      height={edge}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* A wheel: the outer ring with one sector picked out. */}
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v4M20.5 12h-4M12 20.5v-4M3.5 12h4" />
      {/* The highlighted sector, so the glyph reads as "choose one". */}
      <path d="M12 12l6.5-3.7" strokeWidth="2" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Register the panel's sidebar entry and its page.
 * @param ctx - the browser services this plugin uses.
 */
export function apply(ctx: ClientContext): void {
  // A throw in here leaves this entry without a fiber, which the web boot reports
  // as a failed plugin and then refuses to finish. The step is logged before the
  // error propagates; without it the reason for a dead window is invisible.
  let step = 'locale.register'
  try {
    step = 'locale.register'
    ctx.effect(() => ctx.locale.register(NS, { zh: zhCN, en: enUS }), 'quick-help: dictionaries')
    step = 'locale.bind'
    const t = ctx.locale.bind(NS) as T
    step = 'sidebar.panellist'
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: PANEL_ORDER,
      locale: NS,
      label: () => t('panel'),
    }, QuickHelpIcon))
    step = 'main'
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      // The bound translate function rides the injection rather than the
      // framework's `t` prop, so the panel's copy comes from this namespace and
      // cannot silently fall back to a missing key.
      inject: (): { t: T } => ({ t }),
    }, QuickHelpPanel))
    step = 'conversation.chat.assistant-actions'
    ctx.slots.inject('shell.compact-actions', () => ctx.slots.register({
      name: 'shell.compact-actions', id: 'quick-help-conversations', order: 10,
      locale: NS, inject: () => ({ t }),
    }, CompactConversations))
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left', id: 'quick-help-capture', order: 30,
      locale: NS, inject: (sessionId: string) => ({ sessionId, t }),
    }, CompactCapture))
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock', id: 'quick-help-status', order: 10,
      locale: NS, inject: (sessionId: string) => ({ sessionId, t }),
    }, CompactFeedbackStatus))
    ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: PANEL_ID,
      order: 35,
      inject: (sessionId: string) => ({
        bindTarget: (messageId: string) => bindAssistantAnswer(sessionId, messageId),
      }),
    }, AssistantWheelTarget))
  } catch (error: unknown) {
    console.error(`[quick-help] activation failed at ${step}`, error)
    throw error
  }
}

export { dictionaries }
