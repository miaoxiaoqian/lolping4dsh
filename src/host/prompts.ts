/** Compact model instructions for logged wheel feedback; history stays in the original session. */
import type { TaskKind, ActionContext } from './binding.ts'

const TASK_CHECKS: Readonly<Record<TaskKind, string>> = {
  code: '检查需求遗漏与边界，实际运行适当检查。',
  design: '检查流程、功能缺口及实现可行性。',
  writing: '检查事实、结构与论据，删除冗余。',
  paper: '核对原文与术语，讲清问题、方法、证据和结论。',
  ui: '检查布局、控件、输入及错误状态，走真实使用流程。',
  general: '对照原需求，优先修复最影响质量的问题。',
}

/** Pin the exact answer without copying material already in this session. */
function target(ctx: ActionContext): string {
  return `针对所选回答（${ctx.answerId}，序号 ${ctx.answerSeq}）${ctx.artifactVersion ? `，版本 ${ctx.artifactVersion}` : ''}；该回答开头：${JSON.stringify(ctx.answerText.trim().slice(0, 80))}。`
}

/** Chinese label for a task kind, used in the prompt heading. */
export function kindLabel(kind: TaskKind): string {
  switch (kind) {
    case 'code': return '代码'
    case 'design': return '设计'
    case 'writing': return '文案'
    case 'paper': return '论文分析'
    case 'ui': return '界面'
    case 'general': return '通用'
  }
}

/** 「弱爆」—— one full round of self-directed revision. */
export function revisePrompt(ctx: ActionContext): string {
  return [target(ctx), '用户不满意，请自主检查并完成一轮改进。', TASK_CHECKS[ctx.kind],
    '沿用原需求与约束，保留已经正确的部分，保留用户已有的修改；不授权扩大任务范围，不授权无限续跑。',
    '不需要我补充不满意的原因；有必要信息缺失时，继续你能够独立完成的部分。',
    '直接给修订后的答案或成果；不复述自查过程。只有必要时简短说明验证结果或限制。',
  ].join('\n')
}

/** Re-explain the selected answer without editing its deliverables. */
export function explainPrompt(ctx: ActionContext): string {
  return [target(ctx), '用户没看懂。保留原来的结论，用简单语言、具体例子补全中间逻辑，解释术语；不要修改项目文件。',
    ctx.kind === 'paper' ? '讲清问题、方法、证据和结论，关键术语保留英文。' : '',
    ctx.text.trim() ? `关注：${ctx.text.trim()}` : '',
  ].filter(Boolean).join('\n')
}

/** Verify selected claims; screenshot capture itself is handled before submission. */
export function verifyPrompt(ctx: ActionContext): string {
  return [target(ctx), '核查最关键的主张，使用原始资料、代码或运行检查实际去查，并给出来源。区分证实、冲突与未验证；自我复述不算查证成功，不直接重写全部成果。',
    ctx.kind === 'paper' ? '核对原文、实验条件、数值与页码。' : '',
  ].filter(Boolean).join('\n')
}

/** Resume stopped work from preserved progress. */
export function continuePrompt(ctx: ActionContext): string {
  return [target(ctx), '从保留进度继续未完成的任务，沿用原需求与约束；不要自行增加新功能。已完成就结束，不要自己找活干。提高质量用「弱爆」，不是「继续」。'].join('\n')
}

/** Acceptance is persisted directly; this template does not start work. */
export function acceptPrompt(ctx: ActionContext): string {
  return `${target(ctx)}用户采纳这一版，不需要长篇总结，不需要新的工作。`
}

/** Summarize existing deliverables without publishing. */
export function savePrompt(ctx: ActionContext): string {
  return `${target(ctx)}整理任务目标、成果、依据、验证状态及未解决事项，保存为记录。不要提交 Git、不要推送代码或发布；不要把未验证的成果改标为验证通过。`
}

/** 「停止」 is not an instruction to an agent; it is handled by the scheduler. */
export const STOP_MESSAGE =
  '用户要求停止当前任务。已停止后续执行，请保留已完成的内容与当前文件状态，不要回滚或删除已经完成的修改。'

/** The templates, keyed by the action they belong to. */
export const PROMPTS = {
  revise: revisePrompt,
  explain: explainPrompt,
  verify: verifyPrompt,
  continue: continuePrompt,
  accept: acceptPrompt,
  save: savePrompt,
} as const
