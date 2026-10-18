/**
 * Structural declarations for every browser-side service this plugin calls.
 *
 * The panel is bundled into the Harness Client module table, so a bare specifier
 * such as `@deepseek-ai/dsh-client-ui-slots` resolves from that table rather than
 * from this package. Rather than depend on another plugin's build output, the
 * panel imports nothing but `react` and re-declares the small surface it uses,
 * transcribed from the 0.2.1-alpha.2 client sources; each member names its origin.
 *
 * @module @local/dsh-quick-help/client/dsh
 */

/** The browser-side context. Members read from the 0.2.1-alpha.2 client sources. */
export interface ClientContext {
  /**
   * Register an owned contribution; the callback returns its disposer.
   * Source: vendor/cordis `Context.effect`.
   */
  effect(contribution: () => (() => void | Promise<void>) | void, label?: string): () => void

  /** Client copy, owned per namespace. Source: packages/client/locale/src/index.ts. */
  locale: LocaleService

  /** Registered UI seats. Source: packages/client/ui-slots/src/index.ts. */
  slots: SlotsService
}

/** Localized copy. Source: packages/client/locale/src/index.ts. */
export interface LocaleService {
  /**
   * Register one namespace's dictionaries.
   * @returns The disposer that removes them.
   */
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void

  /**
   * Bind a namespace to a translate function.
   * @param namespace - a registered namespace.
   * @returns `t(key, params)` rendering in the active locale.
   */
  bind(namespace: string): Translate
}

/** One localized string lookup. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** The seat registry. Source: packages/client/ui-slots/src/index.ts. */
export interface SlotsService {
  /**
   * Wait for one owner seat, then contribute to it.
   * @param owner - The owner seat's name, e.g. `sidebar.panellist`.
   * @param callback - contributes to the owner; runs once it exists.
   */
  inject(owner: string, callback: (sessionId: string) => void): unknown

  /**
   * Register one contribution into a seat.
   *
   * The seat is named inside the spec rather than as an argument, and the component
   * is the second positional argument — not a property — because the sidebar's list
   * seat treats a component passed as `icon` differently from one passed here.
   * Source: packages/client/ui-slots/src/index.ts.
   *
   * @param spec - The entry, carrying the seat's name and the identity it expects.
   * @param component - The panel's root component.
   * @returns The disposer that removes the contribution.
   */
  register<P>(spec: SlotSpec, component: (props: P) => unknown): () => void
}

/** One contribution's identity, as the owning seat reads it. */
export interface SlotSpec {
  /** The seat this entry belongs to. */
  readonly name: string
  /** The sidebar row's id. */
  readonly id?: string
  /** Where the row sits in the list. */
  readonly order?: number
  /** The namespace this entry's copy comes from. */
  readonly locale?: string
  /** The row's label, resolved through the bound namespace. */
  readonly label?: () => string
  /** The `main` seat's key; matches the row's id. */
  readonly key?: string
  /** Values the seat injects into the component's props. */
  readonly inject?: (sessionId: string) => Record<string, unknown>
}

/** The requested glyph edge length. Source: packages/client/ui-sidebar. */
export interface PanelIconProps {
  size?: number | string
}

/** One component the sidebar may render. */
export type PanelIcon = (props: PanelIconProps) => unknown
