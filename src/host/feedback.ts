/** One-shot media delivery; reading consumes the pending selection. */
export interface PendingMedia {
  readonly animation?: string
  readonly sound?: string
}

/** Keeps one pending effect so reloading a hidden window cannot replay it. */
export class FeedbackSlot {
  private pending: PendingMedia | undefined

  get armed(): boolean { return this.pending !== undefined }

  queue(animation: string, sound: string): void {
    this.pending = { ...(animation ? { animation } : {}), ...(sound ? { sound } : {}) }
  }

  take(): PendingMedia | undefined {
    const pending = this.pending
    this.pending = undefined
    return pending
  }
}
