/**
 * Structural declarations for every DSH host service this plugin consumes.
 *
 * A profile-installed bundle is linked into the profile with pnpm's `link:`, so a
 * bare specifier such as `@deepseek-ai/cordis` does not resolve from this
 * package's real directory. This plugin therefore imports nothing from DSH at
 * runtime and re-declares only the surfaces it calls, transcribed from the
 * 0.2.1-alpha.2 sources; each member names the file it was read from.
 *
 * @module @local/dsh-quick-help/host/dsh
 */

/** A cordis context, limited to the members this plugin calls. */
export interface Context {
  /**
   * Register an owned contribution. The callback returns its disposer, which runs
   * on unload, HMR replacement, and profile recomposition.
   * Source: vendor/cordis `Context.effect`.
   */
  effect(contribution: () => (() => void | Promise<void>) | void, label?: string): () => void

  /** Resolve an optional service, or `undefined` when the profile omits it. */
  get(name: string): unknown

  /** The domain form over the storage hub. */
  storageDomain: StorageDomainFacility

  /** The live agent registry. */
  agents: AgentRegistry

  /** Read existing session events without creating a second writer. */
  sessionController: SessionController

  /** Durable desktop workspace registry. */
  workspaceRegistry: WorkspaceRegistry

  /** Durable image admission and readback. Source: packages/attachment/attachment. */
  attachments: AttachmentStore
  /** Canonical human feedback, logged without starting a model turn. */
  messageFeedback: {
    list(request: { sessionId: string }): Promise<{ ok: boolean; value?: { items: { messageId: string; version: string }[] }; error?: { code: string } }>
    put(request: { sessionId: string; messageId: string; rating: 'positive' | 'negative'; note: string; ifVersion: string | null }): Promise<{ ok: boolean; error?: { code: string } }>
  }

  /** The loopback HTTP carrier the panel and the overlay pages are served by. */
  webServer: WebServer

  /**
   * The deployment default model selection.
   * Source: packages/core/agent-default-model/src/index.ts.
   */
  agentDefaultModel?: AgentDefaultModel

  /** Host logging. Source: vendor/cordis `Context.logger`. */
  logger?: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

/** Model route and optional per-agent options. Source: packages/core/agent/src/runtime-types.ts. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Default model selection. Source: packages/core/agent-default-model/src/index.ts. */
export interface AgentDefaultModel {
  currentSelection(): ModelSelection
}

/** A model-visible user-role message. Source: packages/llm/llm/src/message.ts. */
export interface UserMessage {
  id: string
  role: 'user'
  content: readonly MessageContent[]
  source: unknown
}

/** Raster attachment fields from the official attachment service. */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

/** Uploaded PNG bytes awaiting official validation. */
export interface ImageUpload {
  type: 'image'
  mediaType: 'image/png'
  data: string
  name?: string
}

export type MessageContent = { type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }

export interface AttachmentStore {
  admitPromptContent(content: readonly ({ type: 'text'; text: string } | ImageUpload)[]): Promise<MessageContent[]>
  readImage(ref: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
}

/** Cancellation reasons accepted by the DSH Agent API. Source: packages/core/session/src/types.ts. */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** The live agent handle. Source: packages/core/agent/src/runtime-types.ts. */
export interface Agent {
  readonly id: string
  readonly session: SessionLike
  /** Agent-scoped event context. Source: packages/core/agent/src/runtime-types.ts. */
  readonly ctx: AgentContext
  /** How the agent identifies itself in the session list. */
  readonly title?: string
  readonly status?: 'idle' | 'running'
  readonly options?: { provider?: string; model?: string; reasoningEffort?: string }
  /** Send one user turn. */
  followup(message: UserMessage): void
  /** Abandon the turn in flight. */
  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void
  /** Resolves when no turn is running. */
  whenIdle(): Promise<void>
}

/** One transient assistant stream chunk published by the live Agent. */
export interface AssistantStreamFrame {
  readonly type: 'start' | 'chunk' | 'end'
  readonly chunk?: { readonly type: string; readonly text?: string }
}

/** The Agent-scoped event surface used for transient model output. */
export interface AgentContext {
  on(name: 'agent/inbox/inserted', listener: (payload: { message: UserMessage }) => void): () => void
  on(name: 'agent/assistant-stream', listener: (payload: { agent: Agent; frame: AssistantStreamFrame }) => void): () => void
  on(name: 'agent/error', listener: (payload: { agent: Agent; error: unknown }) => void): () => void
  on(name: 'agent/status', listener: (payload: { agent: Agent; status: 'idle' | 'running' }) => void): () => void
}

/** Session inspection fields consumed from session-controller.inspect(). */
export interface InspectedEvent {
  type: string
  seq: number
  time: number
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number }
  data: {
    id?: string
    content?: readonly { type: string; text?: string; attachment?: ImageAttachmentRef }[]
    source?: { kind: string; form?: string; summary?: string; action?: string }
    message?: { id: string; content: readonly { type: string; text?: string; attachment?: ImageAttachmentRef }[] }
    interrupted?: boolean
    reason?: { kind: string; error?: { message?: string } }
  }
}

export interface SessionInspection {
  meta: { id: string; cwd?: string; createdAt: number }
  events: readonly InspectedEvent[]
}

export interface SessionController {
  inspect(sessionId: string): Promise<SessionInspection>
  create(request: { sessionId: string; workspaceId: string }): Promise<{ sessionId: string; agentPreset?: string }>
  resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: Error & { code?: string } }>
  prompt(request: { sessionId: string; requestId: string; mode: 'queue' | 'steer'; content: readonly ({ type: 'text'; text: string } | ImageUpload)[] }, signal: AbortSignal): Promise<{ accepted: true }>
  selectModel(request: { sessionId: string } & ModelSelection): Promise<{ selected: ModelSelection }>
}

export interface Workspace {
  readonly id: string
  readonly path: string
  attachSession(sessionId: string): Promise<void>
}

export interface WorkspaceRegistry {
  create(path: string, title?: string): Promise<Workspace>
}

/** The session surface this plugin reads. Source: packages/core/session/src/index.ts. */
export interface SessionLike {
  readonly id: string
  readonly seq: number
}

/** An owned agent plus its disposer. Source: packages/core/agent/src/index.ts. */
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

/** Composition-time setup for a freshly created or resumed agent. */
export type AgentSetup = (agentCtx: Context, agent: Agent) => void

/** Agent creation options. Source: packages/core/agent/src/index.ts. */
export interface CreateAgentOptions {
  sessionId: string
  /**
   * The model route. A plugin-created Agent carries no route of its own and
   * `{{model}}` resolves from `agent.options.model`, so this must be passed
   * explicitly or the turn runs with no model at all.
   */
  agentOptions?: ModelSelection
  meta?: { cwd?: string; origin?: 'subagent' }
  setup?: AgentSetup
}

/** Resume options for an agent on a persisted session. */
export interface ResumeAgentOptions {
  resumeSessionId: string
  agentOptions?: ModelSelection
  setup?: AgentSetup
}

/** The agent registry. Source: packages/core/agent/src/index.ts. */
export interface AgentRegistry {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  get(id: string): Agent | undefined
}

/** One declared table handle. Source: packages/storage/storage-domain/src/domain.ts. */
export interface KvTable<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[string, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** One open domain. Source: packages/storage/storage-domain/src/domain.ts. */
export interface Domain {
  readonly name: string
  table(name: string): KvTable<string, unknown>
  close(): Promise<void>
}

/** The domain facility. Source: packages/storage/storage-domain/src/index.ts. */
export interface StorageDomainFacility {
  /** Open (or join) a declared domain. */
  open(spec: unknown): Promise<Domain>
}

/** One named HTTP route. Source: packages/host/webserver/src/index.ts. */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: NodeRequest, res: NodeResponse) => void | Promise<void>
}

/** Minimal request surface. Source: node:http IncomingMessage. */
export interface NodeRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: 'data', listener: (chunk: Uint8Array) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  /** Abort signal derived from the socket closing, for a streaming response. */
  on(event: 'close', listener: () => void): void
}

/** Minimal response surface. Source: node:http ServerResponse. */
export interface NodeResponse {
  statusCode: number
  /** True once the response was sent; guards a second write after an error. */
  readonly writableEnded?: boolean
  on(event: 'close', listener: () => void): void
  setHeader(name: string, value: string): void
  /** Write one chunk of a streaming response. */
  write(chunk: string): void
  end(body?: string | Uint8Array): void
}

/** The web server registry. Source: packages/host/webserver/src/index.ts. */
export interface WebServer {
  register(route: WebRoute): () => void
  /** The port the harness is listening on; zero until the server listens. */
  readonly port: number
  /** The bind host, always loopback for a local profile. */
  readonly host: string
}
