/** Durable window preferences and readable exports; DSH remains the conversation authority. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AskTurn } from '../shared/types.ts'
import type { ImageAttachmentRef } from './dsh.ts'

export interface WindowRecord {
  id: string
  owned: boolean
  persisted: boolean
  draft: string
  pinned: boolean
  title: string
  at: number
  stopped?: boolean
}

export interface WindowState {
  currentId?: string
  records: WindowRecord[]
}

/** A user's adoption of one exact completed answer, without a model judgment. */
export interface AdoptedAnswer {
  sessionId: string
  answerId: string
  answerSeq: number
  versionToken: string
  answerText: string
  adoptedAt: number
}

/** Atomic, private writes in directories owned by this feature. */
function atomic(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

/** Stores only window state plus derived Markdown, never a second model history. */
export class QuickHelpRecords {
  recordsPath: string
  constructor(readonly stateDir: string, readonly workspacePath: string) {
    this.recordsPath = join(workspacePath, '对话记录')
    const path = join(stateDir, 'storage.json')
    if (existsSync(path)) {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!value || typeof value !== 'object' || !('recordsPath' in value) || typeof value.recordsPath !== 'string' || !isAbsolute(value.recordsPath)) throw new Error('记录目录设置无效，原文件已保留。')
      this.recordsPath = value.recordsPath
    }
  }

  /** Change future exports without moving or deleting any existing note. */
  setRecordsPath(path: string): void {
    if (!path || !isAbsolute(path) || path.includes('\0')) throw new Error('请填写记录文件夹的完整路径，例如 /Users/你的名字/Obsidian/论文。')
    mkdirSync(path, { recursive: true, mode: 0o700 })
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    atomic(join(this.stateDir, 'storage.json'), `${JSON.stringify({ recordsPath: path }, null, 2)}\n`)
    this.recordsPath = path
  }

  isAdopted(sessionId: string, answerId: string): boolean {
    const path = join(this.stateDir, 'adopted-answers.json')
    if (!existsSync(path)) return false
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(value)) throw new Error('采纳记录损坏，原文件已保留。')
    return value.some(item => item && item.sessionId === sessionId && item.answerId === answerId)
  }

  /** Copy validated raster bytes beside the Markdown so exported notes remain portable. */
  image(ref: ImageAttachmentRef, data: Uint8Array): void {
    const directory = join(this.recordsPath, '附件')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const extension = ref.mediaType.split('/')[1]!
    const key = createHash('sha256').update(ref.attachmentId).digest('hex')
    const path = join(directory, `${key}.${extension}`)
    if (existsSync(path)) {
      if (!Buffer.from(data).equals(readFileSync(path))) throw new Error('导出的附件已有不同内容，未覆盖。')
      return
    }
    writeFileSync(path, data, { flag: 'wx', mode: 0o600 })
  }

  /** Keep adoption separate from conversation history, which DSH owns. */
  adopt(answer: AdoptedAnswer): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const path = join(this.stateDir, 'adopted-answers.json')
    const existing: AdoptedAnswer[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as AdoptedAnswer[] : []
    if (!Array.isArray(existing)) throw new Error('采纳记录损坏；原文件已保留。')
    const next = existing.filter(item => item.sessionId !== answer.sessionId || item.answerId !== answer.answerId)
    next.push(answer)
    atomic(path, `${JSON.stringify(next, null, 2)}\n`)
  }

  read(): WindowState {
    const path = join(this.stateDir, 'conversations.json')
    if (!existsSync(path)) return { records: [] }
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || !('records' in value) || !Array.isArray(value.records)) {
      throw new Error('快捷求助窗口记录损坏；原文件已保留，请检查 conversations.json。')
    }
    const records: WindowRecord[] = []
    for (const entry of value.records) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string'
        || typeof entry.owned !== 'boolean' || typeof entry.persisted !== 'boolean'
        || typeof entry.draft !== 'string' || typeof entry.pinned !== 'boolean'
        || typeof entry.title !== 'string' || typeof entry.at !== 'number') {
        throw new Error('快捷求助窗口记录格式不正确；没有覆盖原文件。')
      }
      records.push(entry)
    }
    return { records, ...('currentId' in value && typeof value.currentId === 'string' ? { currentId: value.currentId } : {}) }
  }

  write(state: WindowState): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    atomic(join(this.stateDir, 'conversations.json'), `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Refresh an owned export without colliding with arbitrary user files. */
  export(sessionId: string, title: string, turns: readonly AskTurn[]): string {
    const directory = this.recordsPath
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
    const marker = `<!-- dsh-quick-help:${key} -->`
    let path = join(directory, `对话-${key}.md`)
    if (existsSync(path) && !readFileSync(path, 'utf8').startsWith(marker)) {
      path = join(directory, `对话-${key}-${randomUUID()}.md`)
    }
    const cleanTitle = title.replace(/[\r\n]/g, ' ')
    const sections = turns.map(turn => {
      const images = (turn.images ?? []).map(image => `![截图](附件/${createHash('sha256').update(image.attachmentId).digest('hex')}.${image.mediaType.split('/')[1]})`).join('\n\n')
      const adopted = turn.id && turn.role === 'assistant' && this.isAdopted(sessionId,turn.id) ? '\n\n> 已采纳（用户反馈，不代表已验证）。' : ''
      return `## ${turn.feedback ? '轮盘反馈' : turn.role === 'user' ? '提问' : '回答'} · ${new Date(turn.at).toLocaleString('zh-CN')}\n\n${turn.text}${images ? `\n\n${images}` : ''}${adopted}${turn.error ? `\n\n> ${turn.error}` : ''}`
    })
    atomic(path, `${marker}\n# ${cleanTitle}\n\n会话 ID：\`${sessionId.replace(/`/g, '')}\`\n\n此文件是阅读记录；在 DSH「DSH快捷求助」工作区继续原会话。\n\n${sections.join('\n\n---\n\n')}\n`)
    return path
  }
}
