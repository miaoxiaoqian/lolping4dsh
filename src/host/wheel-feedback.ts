/** Logged wheel feedback; displayed as a notice rather than a typed user prompt. */
export interface WheelFeedback {
  readonly action: string
  readonly requestId: string
  readonly answerId: string
  readonly answerSeq: number
  readonly versionToken: string
  readonly summary: string
}

/** Compact, stable labels for the user's wheel gestures. */
export function feedbackSummary(action: string): string {
  switch (action) {
    case 'revise': return '不满意，请改进一轮'
    case 'explain': return '没看懂，请换种方式解释'
    case 'verify': return '请补充证据'
    case 'continue': return '继续未完成的任务'
    case 'save': return '整理并保存成果'
    default: return '轮盘反馈'
  }
}
