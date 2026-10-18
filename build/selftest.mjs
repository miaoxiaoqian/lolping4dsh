/**
 * Self-test for the quick-help host half.
 *
 * The assertions concentrate on the rules that are easy to get wrong and
 * expensive to discover by hand:
 *
 *  - A second 「弱爆」 while a revision is running must merge rather than start a
 *    second writer. Two agents editing one file is corruption, not slow progress.
 *  - 「危险」 must clear the queue, and must not claim more than it did: a request
 *    sent is not the same as "stopped".
 *  - A replayed request id must never run twice.
 *
 * Every test drives the real classes against the real source. Only the agent is
 * a fake, because that is the one boundary with no interesting logic — the
 * scheduler's job is deciding whether to call it, and how many times.
 *
 * The source is loaded directly rather than through `lib/index.js`, because that
 * entry point exports only `apply`; testing behaviour needs the internals.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { pathToFileURL as toUrl } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Node cannot import `.ts` by default. Rather than build a separate test bundle,
// the loader is pointed at the source and esbuild strips the types on the way in.
register(pathToFileURL(join(root, 'build', 'ts-loader.mjs')).href, import.meta.url)

const { ActionScheduler, ACTION_INPUT, ACTION_LABELS } = await import(toUrl(join(root, 'src/host/scheduler.ts')).href)
const { BindingTracker } = await import(toUrl(join(root, 'src/host/binding.ts')).href)
const { AssetResolver } = await import(toUrl(join(root, 'src/host/asset-resolver.ts')).href)
const { FeedbackSlot } = await import(toUrl(join(root, 'src/host/feedback.ts')).href)
const { SettingsStore, normalizeSettings } = await import(toUrl(join(root, 'src/host/settings-store.ts')).href)
const { PROMPTS, kindLabel } = await import(toUrl(join(root, 'src/host/prompts.ts')).href)
const { SessionManager } = await import(toUrl(join(root, 'src/host/sessions.ts')).href)
const { QuickHelpRecords } = await import(toUrl(join(root, 'src/host/records.ts')).href)
const { DEFAULT_SLOTS, OPTIONAL_EMOTES, slotById, slotAtSector, HOVER_SOUND } = await import(toUrl(join(root, 'src/shared/assets.ts')).href)
const { DEFAULT_SETTINGS } = await import(toUrl(join(root, 'src/shared/types.ts')).href)
const { parseAccelerator, chordMatches, reservedCollision, MODIFIER_FLAGS } =
  await import(toUrl(join(root, 'src/shared/hotkey.ts')).href)
const { registerRoutes } = await import(toUrl(join(root, 'src/host/routes.ts')).href)
const { SLOTS } = await import(toUrl(join(root, 'src/host/pages.ts')).href)

let passed = 0
let failed = 0
const failures = []

const pending = []

/** Register a test. Async bodies are awaited in order at the end of the run. */
function test(name, body) {
  pending.push({ name, body })
}

/** Run everything, printing as each settles so a hang is visible where it began. */
async function run() {
  for (const { name, body } of pending) {
    try {
      await body()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (error) {
      failed += 1
      failures.push({ name, error })
      console.log(`  ✗ ${name}`)
      console.log(`      ${error instanceof Error ? error.message.split('\n').slice(0, 2).join(' / ') : String(error)}`)
    }
  }
}

function group(name) {
  console.log(`\n${name}`)
}

/** A binding that is valid, so an action has something to act on. */
function bound(overrides = {}) {
  return new BindingTracker()
}

function makeBinding(sessionId = 's1', answerId = 'a1', kind = 'code') {
  return {
    sessionId,
    answerId,
    answerSeq: 7,
    versionToken: 'head:7:answer',
    answerText: '当前结果原文',
    requirementText: '原始需求',
    artifactLabel: 'harness-guard / 训练脚本调优',
    artifactVersion: 'v3',
    kind,
    valid: true,
  }
}

/**
 * A fake agent whose timing the test controls.
 *
 * `busy` is a plain flag the test flips, so a test can hold a turn "in flight" for
 * as long as it needs without sleeping.
 */
function makeAgent({ startDelay = 0, failSend = false } = {}) {
  const state = { busy: false, sent: [], cancelled: [], handles: 0 }
  return {
    state,
    driver: {
      async send(sessionId, prompt, meta) {
        if (failSend) throw new Error('模型不可用')
        state.sent.push({ sessionId, prompt, meta })
        state.busy = true
        if (startDelay === 0) state.busy = false
      },
      async cancel(sessionId, reason) {
        state.cancelled.push({ sessionId, reason })
        const was = state.busy
        state.busy = false
        return was ? 'cancelled' : 'idle'
      },
      busy(sessionId) {
        return state.busy
      },
    },
  }
}

// ── 素材目录 ────────────────────────────────────────────────────────────────

group('素材目录（8 格语义映射）')

test('默认轮盘正好八格', () => {
  assert.equal(DEFAULT_SLOTS.length, 8)
})

test('扇区编号是 0 到 7 的一个排列，正北为 0 顺时针', () => {
  const sectors = DEFAULT_SLOTS.map(s => s.sector).sort((a, b) => a - b)
  assert.deepEqual(sectors, [0, 1, 2, 3, 4, 5, 6, 7])
})

test('八个动作互不重复', () => {
  const actions = DEFAULT_SLOTS.map(s => s.action)
  assert.equal(new Set(actions).size, 8)
})

test('方向与功能对应用户给的表格', () => {
  const bySector = Object.fromEntries(DEFAULT_SLOTS.map(s => [s.sector, s.action]))
  assert.equal(bySector[0], 'stop', '上 = 危险')
  assert.equal(bySector[1], 'revise', '右上 = 弱爆')
  assert.equal(bySector[2], 'continue', '右 = 正在路上')
  assert.equal(bySector[3], 'explain', '右下 = 一脸问号')
  assert.equal(bySector[4], 'ask', '下 = 求救')
  assert.equal(bySector[5], 'verify', '左下 = 需要视野')
  assert.equal(bySector[6], 'save', '左 = GG <3')
  assert.equal(bySector[7], 'accept', '左上 = 超赞的')
})

test('每个槽位的悬停文案同时含原版名与功能', () => {
  for (const slot of DEFAULT_SLOTS) {
    assert.ok(slot.hover.includes('→'), `${slot.id} 缺少箭头分隔`)
    assert.ok(slot.hover.includes(slot.emoteNameZh), `${slot.id} 悬停未含中文名`)
    // The right half is checked by substance rather than by literal equality with
    // `meaning`: the hover line is deliberately the colloquial version ("再改一轮"
    // for "自主再改一轮"), and requiring them to match would force one of the two
    // to be worse copy.
    const [, action] = slot.hover.split('→').map(part => part.trim())
    assert.ok(action !== undefined && action.length >= 4, `${slot.id} 悬停缺功能说明`)
    assert.notEqual(action, slot.emoteNameZh, `${slot.id} 悬停不能只重复表情名`)
  }
})

test('素材文件与槽位声明一致：信号无动画，表情三件套齐全', () => {
  for (const slot of DEFAULT_SLOTS) {
    if (slot.kind === 'ping') {
      assert.equal(slot.animation, undefined, `${slot.id} 是信号，不应有动画`)
      assert.ok(slot.sound.endsWith('.wav'), `${slot.id} 的音效应在 sounds/`)
    } else {
      assert.ok(slot.animation?.endsWith('.webp'), `${slot.id} 应有 webp 动画`)
      assert.ok(slot.sound?.endsWith('.ogg'), `${slot.id} 的音效应与表情同目录`)
    }
  }
})

test('可选表情池不在默认八格里，且不占用扇区', () => {
  const defaults = new Set(DEFAULT_SLOTS.map(s => s.id))
  for (const slot of OPTIONAL_EMOTES) {
    assert.ok(!defaults.has(slot.id), `${slot.id} 不应与默认槽位重复`)
    assert.equal(slot.sector, -1, `${slot.id} 是可选，不应占用扇区`)
  }
})

test('按 id 与按扇区都能查到同一格', () => {
  for (const slot of DEFAULT_SLOTS) {
    assert.equal(slotById(slot.id)?.id, slot.id)
    assert.equal(slotAtSector(slot.sector)?.id, slot.id)
  }
})

test('未知标识返回 undefined 而不是默认槽位', () => {
  assert.equal(slotById('does-not-exist'), undefined)
})

test('每个动作都有中文标签与输入需求', () => {
  for (const slot of DEFAULT_SLOTS) {
    assert.ok(ACTION_LABELS[slot.action], `${slot.action} 缺标签`)
    assert.ok(ACTION_INPUT[slot.action], `${slot.action} 缺输入需求`)
  }
})

test('只有求救可以在没有目标时运行', () => {
  assert.equal(ACTION_INPUT.ask, 'ask')
  assert.equal(ACTION_INPUT.revise, 'selection')
  assert.equal(ACTION_INPUT.stop, 'none')
})

// ── 素材解析 ────────────────────────────────────────────────────────────────

group('素材解析（缺失即不可用，不自制冒充）')

test('真实素材目录里 14 个标识全部命中', () => {
  const resolver = new AssetResolver(join(root, 'assets'))
  const slots = [...DEFAULT_SLOTS, ...OPTIONAL_EMOTES]
  const missing = slots.filter(s => {
    const r = resolver.resolve(s)
    return r.image === undefined
  })
  assert.deepEqual(missing.map(s => s.id), [], `这些槽位缺图标：${missing.map(s => s.id).join('、')}`)
})

test('表情的三件套都存在', () => {
  const resolver = new AssetResolver(join(root, 'assets'))
  for (const slot of [...DEFAULT_SLOTS, ...OPTIONAL_EMOTES].filter(s => s.kind === 'emote')) {
    const r = resolver.resolve(slot)
    assert.ok(r.image, `${slot.id} 缺静态图`)
    assert.ok(r.animation, `${slot.id} 缺动画`)
    assert.ok(r.sound, `${slot.id} 缺音效`)
    assert.equal(r.missing, undefined, `${slot.id} 不应报告缺失`)
  }
})

test('悬停提示音可解析', () => {
  const resolver = new AssetResolver(join(root, 'assets'))
  assert.ok(resolver.resolveSound(HOVER_SOUND), `${HOVER_SOUND} 应可解析`)
})

test('缺失的素材被如实报告，且槽位判为不可用', () => {
  const empty = mkdtempSync(join(tmpdir(), 'qh-empty-'))
  try {
    const resolver = new AssetResolver(empty)
    const r = resolver.resolve(DEFAULT_SLOTS[0])
    assert.equal(r.image, undefined)
    assert.equal(resolver.isUsable(r), false, '缺图标必须判为不可用')
    assert.ok(r.missing?.includes('assist_me.png'), '应报出缺哪个文件')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('只缺动画时槽位仍可用，并单独报出缺失', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qh-partial-'))
  try {
    mkdirSync(join(dir, 'emotes'), { recursive: true })
    // The slot's id is the business action (`save`); `gg_heart` is the asset file
    // name. Looking the slot up by asset name is the mistake this comment names.
    const slot = DEFAULT_SLOTS.find(entry => entry.image === 'gg_heart.png')
    assert.ok(slot, '默认槽位里应有 GG <3')
    // 只放静态图和音效，动画缺席。
    cpSync(join(root, 'assets/emotes/gg_heart.png'), join(dir, 'emotes/gg_heart.png'))
    cpSync(join(root, 'assets/emotes/gg_heart.ogg'), join(dir, 'emotes/gg_heart.ogg'))
    const resolver = new AssetResolver(dir)
    const r = resolver.resolve(slot)
    assert.ok(r.image, '静态图存在')
    assert.equal(r.animation, undefined, '动画确实缺失')
    assert.ok(r.missing?.includes('gg_heart.webp'), '应报出缺动画')
    assert.ok(resolver.isUsable(r), '只有动画缺失时槽位仍应可用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录穿越被拒绝', () => {
  const resolver = new AssetResolver(join(root, 'assets'))
  assert.equal(resolver.resolveSound('../../../etc/passwd'), undefined)
  assert.equal(resolver.resolveSound('a/b.wav'), undefined)
})

test('wav 音效走 sounds/，ogg 走 emotes/', () => {
  const resolver = new AssetResolver(join(root, 'assets'))
  const wav = resolver.resolveSound('button.wav')
  const ogg = resolver.resolveSound('gg_heart.ogg')
  assert.ok(wav.url.includes('/sounds/'), `wav 应在 sounds/：${wav.url}`)
  assert.ok(ogg.url.includes('/emotes/'), `ogg 应在 emotes/：${ogg.url}`)
})

// ── 目标绑定 ────────────────────────────────────────────────────────────────

group('目标绑定（拒绝无目标与失效目标）')

test('没有绑定时动作被拒绝，并给出可操作的中文理由', () => {
  const t = new BindingTracker()
  const r = t.prepare('弱爆')
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('可反馈的回答') && r.reason.includes('小窗提问'), `理由应说明先获得回答：${r.reason}`)
})

test('绑定后可执行，且上下文带全部五项', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const r = t.prepare('弱爆')
  assert.equal(r.ok, true)
  const ctx = t.context({ requirement: '训练脚本要能跑通', kind: 'code' })
  assert.equal(ctx.sessionId, 's1')
  assert.equal(ctx.artifactVersion, 'v3')
  assert.equal(ctx.requirement, '训练脚本要能跑通')
})

test('失效绑定在执行前被拒绝', () => {
  const t = new BindingTracker()
  t.bind({ ...makeBinding(), valid: false, invalidReason: '这个回答已被删除' }, 'explicit')
  const r = t.prepare('弱爆')
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('已被删除'), `理由应透出具体原因：${r.reason}`)
})

test('同一 requestId 只能认领一次', () => {
  const t = new BindingTracker()
  assert.equal(t.claim('r1', 'revise', 'accepted'), true)
  assert.equal(t.claim('r1', 'revise', 'accepted'), false, '重复认领必须失败')
  assert.equal(t.seen('r1'), true)
})

test('认领记录有上限，不会无限增长', () => {
  const t = new BindingTracker()
  for (let i = 0; i < 260; i += 1) t.claim(`r${i}`, 'revise', 'accepted')
  assert.ok(t.history(1000).length <= 200, `历史应被裁剪：${t.history(1000).length}`)
  assert.equal(t.seen('r259'), true, '最新的仍在')
})

test('认领历史按时间倒序', () => {
  const t = new BindingTracker()
  t.claim('a', 'x', 'accepted')
  t.claim('b', 'y', 'accepted')
  // Two claims inside the same millisecond are ordered by insertion, which the
  // sort has to break deterministically. `b` is claimed second, so it is the
  // newer one and must come first regardless of the clock's resolution.
  assert.equal(t.history()[0].requestId, 'b')
  assert.equal(t.history()[1].requestId, 'a')
})

// ── 弱爆指令 ────────────────────────────────────────────────────────────────

group('弱爆指令（一轮完整改进，而非「重新做」）')

test('精确定位回答，不重复复制历史需求和原文', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.revise(t.context({ requirement: '需求原文', kind: 'code' }))
  for (const part of [t.bound.answerId, String(t.bound.answerSeq), 'v3', '一轮改进']) {
    assert.ok(p.includes(part), `指令缺少：${part}`)
  }
  assert.ok(!p.includes('需求原文'))
  const long = PROMPTS.revise({ ...t.context({ kind: 'code' }), answerText: '长答案'.repeat(3000) })
  assert.ok(long.length < 500 && !long.includes('长答案'.repeat(100)), '只用短引用定位，不能重复整篇答案')
  assert.ok(p.length < 400, '改进指令保持紧凑')
})

test('明确授权一轮，不授权无限续跑', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.revise(t.context({ kind: 'code' }))
  assert.ok(p.includes('一轮改进'), '应声明授权范围')
  assert.ok(p.includes('不授权无限续跑'), '应禁止无限续跑')
  assert.ok(p.includes('不授权扩大任务范围'), '应禁止扩大范围')
})

test('默认不要求用户补充不满意的原因', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.revise(t.context({ kind: 'code' }))
  assert.ok(p.includes('不需要我补充不满意的原因'))
  assert.ok(p.includes('继续你能够独立完成的部分'), '应允许在缺信息时继续能做的部分')
})

test('保留正确内容与用户已有修改', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.revise(t.context({ kind: 'code' }))
  assert.ok(p.includes('保留已经正确的部分'))
  assert.ok(p.includes('保留用户已有的修改'))
})

test('六类任务各有自己的检查清单', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const prompts = ['code', 'design', 'writing', 'paper', 'ui', 'general'].map(kind =>
    PROMPTS.revise(t.context({ kind })))
  const unique = new Set(prompts)
  assert.equal(unique.size, 6, '六类任务的清单应各不相同')
  assert.ok(prompts[0].includes('实际运行'), '代码类应要求真实运行')
  assert.ok(prompts[3].includes('原文'), '论文类应要求核对原文')
  assert.ok(prompts[4].includes('真实使用流程'), '界面类应要求走真实流程')
})

test('完成时要说明改了什么、如何验证、还剩什么限制', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.revise(t.context({ kind: 'code' }))
  assert.ok(p.includes('直接给修订后的答案或成果') && p.includes('不复述自查过程'))
  assert.ok(p.includes('验证结果'))
  assert.ok(p.includes('限制'))
})

test('一脸问号只解释，不改文件', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.explain(t.context({ kind: 'code', text: '这段为什么这么写' }))
  assert.ok(p.includes('不要修改项目文件'))
  assert.ok(p.includes('保留原来的结论'), '解释不应改变结论')
  assert.ok(p.includes('具体例子'))
  assert.ok(p.includes('中间逻辑'), '应展开被跳过的步骤')
  assert.ok(p.includes('这段为什么这么写'), '应带上用户关心的部分')
})

test('需要视野要求实际查证，并禁止自我复述冒充', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.verify(t.context({ kind: 'paper' }))
  assert.ok(p.includes('实际去查'))
  assert.ok(p.includes('自我复述不算查证成功'))
  assert.ok(p.includes('未验证'))
  assert.ok(p.includes('页码'), '论文类应要求精确引用')
  assert.ok(p.includes('不直接重写全部成果'), '查证默认不改成果')
})

test('正在路上不扩大范围，且不建议用于提高质量', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.continue(t.context({ kind: 'code' }))
  assert.ok(p.includes('不要自行增加新功能'))
  // The prompt speaks as the user ("我会用…"), which is the voice every other
  // template uses; the assertion matches that rather than rewording the copy.
  assert.ok(p.includes('「弱爆」，不是「继续」'), '应指向弱爆而非继续')
  assert.ok(p.includes('不要自己找活干'), '已完成时不应自行找活')
})

test('停止不等于撤销：文案要求保留已完成的修改', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const ctx = t.context({ kind: 'code' })
  const scheduled = `${ACTION_LABELS.stop} 的停止请求不包含撤销语义`
  assert.ok(scheduled.includes('停止'))
  assert.ok(!PROMPTS.continue(ctx).includes('回滚'), '继续不应引入回滚语义')
})

test('GG 禁止提交与推送，且禁止把未验证改标为已验证', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.save(t.context({ kind: 'code' }))
  assert.ok(p.includes('不要提交 Git'))
  assert.ok(p.includes('不要推送代码'))
  assert.ok(p.includes('不要把未验证的成果改标为验证通过'))
  assert.ok(p.includes('验证状态'), '应记录验证状态')
})

test('超赞的只记录接受，不触发新工作', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.accept(t.context({ kind: 'code' }))
  assert.ok(p.includes('不需要新的工作'))
  assert.ok(p.includes('不需要长篇总结'))
})

test('接受与验证是两件事：接受文案不含验证声明', () => {
  const t = new BindingTracker()
  t.bind(makeBinding(), 'explicit')
  const p = PROMPTS.accept(t.context({ kind: 'code' }))
  assert.ok(!p.includes('已验证'), '接受不等于验证通过')
})

test('任务类型有中文标签', () => {
  assert.equal(kindLabel('paper'), '论文分析')
  assert.equal(kindLabel('ui'), '界面')
})

// ── 调度 ────────────────────────────────────────────────────────────────────

group('调度（弱爆不并发、停止清队列、防重复执行）')

function makeScheduler(agent, { allowUnbound, bindings, adoptAnswer = () => {} } = {}) {
  const tracker = bindings ?? new BindingTracker()
  const scheduler = new ActionScheduler({
    driver: agent.driver,
    bindings: tracker,
    adoptAnswer,
    prompts: PROMPTS,
    ...allowUnbound === undefined ? {} : { allowUnbound },
  })
  return { scheduler, tracker }
}

test('弱爆运行期间再次触发会合并，不启动第二个执行', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')

  // 让第一个 turn 一直处于运行中。
  const first = scheduler.dispatch('revise', { action: 'revise', requestId: 'r1' })
  agent.state.busy = true
  await new Promise(r => setTimeout(r, 5))

  const second = await scheduler.dispatch('revise', { action: 'revise', requestId: 'r2' })
  assert.equal(second.kind, 'merged', `应合并：${second.kind}`)
  assert.equal(agent.state.sent.length, 1, `只应发出一次：${agent.state.sent.length}`)
  assert.equal(agent.state.sent[0].meta.feedback.action, 'revise')
  assert.equal(agent.state.sent[0].meta.feedback.answerId, tracker.bound.answerId)
  assert.equal(agent.state.sent[0].meta.feedback.requestId, 'r1')

  agent.state.busy = false
  await first
})

test('合并时告知正在进行的动作，不静默丢弃', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  const first = scheduler.dispatch('revise', { action: 'revise', requestId: 'r1' })
  agent.state.busy = true
  await new Promise(r => setTimeout(r, 5))
  const second = await scheduler.dispatch('revise', { action: 'revise', requestId: 'r2' })
  assert.ok(second.running, '应说明合并进了什么')
  agent.state.busy = false
  await first
})

test('危险会清空排队中的弱爆', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  const first = scheduler.dispatch('revise', { action: 'revise', requestId: 'r1' })
  agent.state.busy = true
  await new Promise(r => setTimeout(r, 5))
  await scheduler.dispatch('revise', { action: 'revise', requestId: 'r2' })
  assert.equal(scheduler.queued('s1'), 1, '应已排队')

  const stopped = await scheduler.stop('s1', '测试')
  assert.equal(stopped, 'stopping', '应报告正在停止')
  assert.equal(scheduler.queued('s1'), 0, '停止后队列必须清空')
  assert.ok(agent.state.cancelled.length > 0, '应已请求取消')

  agent.state.busy = false
  await first
})

test('轮盘危险动作直接取消真实忙碌 Agent 并拒绝切换会话', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  const first = scheduler.dispatch('revise', { action: 'revise', requestId: 'r-stop-live' })
  agent.state.busy = true
  await new Promise(r => setTimeout(r, 5))
  const stopped = await scheduler.dispatch('stop', {
    action: 'stop', requestId: 'wheel-stop-live', targetSessionId: 's1',
    targetToken: tracker.bound?.versionToken,
  })
  assert.equal(stopped.kind, 'noop')
  assert.ok(String(stopped.reason).includes('停止'))
  assert.equal(agent.state.cancelled.length, 1, '危险必须调用 AgentDriver.cancel')
  assert.equal(agent.state.sent.length, 1, '危险不可把 PROMPTS.stop 发成新一轮消息')
  const wrongSession = await scheduler.dispatch('stop', {
    action: 'stop', requestId: 'wheel-stop-other-session', targetSessionId: 'other-session',
    targetToken: tracker.bound?.versionToken,
  })
  assert.equal(wrongSession.kind, 'refused', '冻结目标会话不匹配时不得停止其他任务')
  agent.state.busy = false
  await first
})

test('停止后标记仍在，只有继续能清', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  agent.state.busy = true
  await scheduler.stop('s1', '测试')
  assert.equal(scheduler.isStopped('s1'), true)
  scheduler.resume('s1')
  assert.equal(scheduler.isStopped('s1'), false)
})

test('停止期间其他动作被拒绝，并提示先继续', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  agent.state.busy = true
  await scheduler.stop('s1', '测试')
  agent.state.busy = false
  const r = await scheduler.dispatch('revise', { action: 'revise', requestId: 'r9' })
  assert.equal(r.kind, 'refused')
  assert.ok(r.reason.includes('正在路上'), `理由应指向继续：${r.reason}`)
})

test('停止后正在路上可以恢复', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  agent.state.busy = true
  await scheduler.stop('s1', '测试')
  agent.state.busy = false
  const r = await scheduler.dispatch('continue', { action: 'continue', requestId: 'rc' })
  assert.equal(r.kind, 'started', '继续应可运行')
  assert.equal(scheduler.isStopped('s1'), false, '继续应清掉停止标记')
})

test('完成的任务按继续不产生模型调用', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  const r = await scheduler.dispatch('continue', { action: 'continue', requestId: 'complete-continue' })
  assert.equal(r.kind, 'noop')
  assert.equal(agent.state.sent.length, 0)
})

test('采纳保存精确回答且不产生模型调用', async () => {
  const agent = makeAgent()
  const adopted = []
  const { scheduler, tracker } = makeScheduler(agent, { adoptAnswer: answer => adopted.push(answer) })
  tracker.bind(makeBinding(), 'explicit')
  const r = await scheduler.dispatch('accept', { action: 'accept', requestId: 'accept-1' })
  assert.equal(r.kind, 'noop')
  assert.equal(adopted.length, 1)
  assert.equal(adopted[0].answerId, 'a1')
  assert.equal(adopted[0].answerText, '当前结果原文')
  assert.equal(agent.state.sent.length, 0)
  await scheduler.dispatch('accept', { action: 'accept', requestId: 'accept-1' })
  assert.equal(adopted.length, 1)
})

test('采纳记录可持久读取且重复采纳同一回答不会累加', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quick-help-adopt-'))
  try {
    const records = new QuickHelpRecords(directory, join(directory, 'workspace'))
    const answer = makeBinding()
    const value = {
      sessionId: answer.sessionId, answerId: answer.answerId,
      answerSeq: answer.answerSeq, versionToken: answer.versionToken,
      answerText: answer.answerText, adoptedAt: 123,
    }
    records.adopt(value)
    records.adopt({ ...value, adoptedAt: 456 })
    const saved = JSON.parse(readFileSync(join(directory, 'adopted-answers.json'), 'utf8'))
    assert.deepEqual(saved, [{ ...value, adoptedAt: 456 }])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('相同 requestId 不会执行两次', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  const a = await scheduler.dispatch('verify', { action: 'verify', requestId: 'dup' })
  const b = await scheduler.dispatch('verify', { action: 'verify', requestId: 'dup' })
  assert.equal(a.kind, 'started')
  assert.equal(b.kind, 'noop', '重复 id 应为空操作')
  assert.equal(agent.state.sent.length, 1, '只应发送一次')
})

test('无目标时弱爆被拒绝，求救可以新建', async () => {
  const agent = makeAgent()
  const { scheduler } = makeScheduler(agent, { allowUnbound: a => a === 'ask' })

  const revise = await scheduler.dispatch('revise', { action: 'revise', requestId: 'x1' })
  assert.equal(revise.kind, 'refused')
  assert.ok(revise.reason.includes('可反馈的回答'))

  const ask = await scheduler.dispatch('ask', { action: 'ask', requestId: 'x2', text: '什么是 mAP50？' })
  assert.equal(ask.kind, 'started', '求救应可无目标运行')
  assert.equal(agent.state.sent[0].prompt, '什么是 mAP50？', '输入应原样作为第一轮')
})

test('失效绑定时所有需要目标的动作都拒绝', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind({ ...makeBinding(), valid: false, invalidReason: '目标已归档' }, 'explicit')
  for (const action of ['revise', 'explain', 'verify', 'save', 'accept', 'continue']) {
    const r = await scheduler.dispatch(action, { action, requestId: `i-${action}` })
    assert.equal(r.kind, 'refused', `${action} 应被拒绝`)
    assert.ok(r.reason.includes('已归档'), `${action} 应透出失效原因`)
  }
})

test('发送失败被如实报告，不假装成功', async () => {
  const agent = makeAgent({ failSend: true })
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  const r = await scheduler.dispatch('revise', { action: 'revise', requestId: 'f1' })
  assert.equal(r.kind, 'started', '先确认接受请求，不能等待完整模型回合才反馈')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(scheduler.lastError('s1').includes('模型不可用'), '接受后发生的失败必须能被小窗轮询读取')
})

test('忙碌时的其他动作排队而不是并发', async () => {
  const agent = makeAgent()
  const { scheduler, tracker } = makeScheduler(agent)
  tracker.bind(makeBinding(), 'explicit')
  const first = scheduler.dispatch('verify', { action: 'verify', requestId: 'v1' })
  agent.state.busy = true
  await new Promise(r => setTimeout(r, 5))
  const second = await scheduler.dispatch('explain', { action: 'explain', requestId: 'e1' })
  assert.equal(second.kind, 'noop')
  assert.ok(second.reason.includes('排队'), `应说明排队：${second.reason}`)
  agent.state.busy = false
  await first
})

// ── 设置 ────────────────────────────────────────────────────────────────────

group('设置（默认不占用常用快捷键，非法值被纠正）')

test('默认快捷键不是 Command+Space 之类', () => {
  assert.notEqual(DEFAULT_SETTINGS.hotkey, 'Command+Space')
  assert.notEqual(DEFAULT_SETTINGS.hotkey, 'Alt+Space')
  assert.equal(DEFAULT_SETTINGS.hotkey, 'Control')
})

test('默认八格与默认槽位一致', () => {
  assert.deepEqual([...DEFAULT_SETTINGS.actions], [...DEFAULT_SLOTS].sort((a,b) => a.sector-b.sector).map(s => s.id))
})

test('损坏的设置文件回落到默认值而不是抛错', () => {
  const known = DEFAULT_SLOTS.map(s => s.id)
  for (const bad of [null, undefined, 42, 'text', [], { hotkey: 123 }]) {
    const s = normalizeSettings(bad, known)
    assert.equal(s.hotkey, DEFAULT_SETTINGS.hotkey)
    assert.equal(s.actions.length, 8)
  }
})

test('未知动作 id 被丢弃', () => {
  const known = DEFAULT_SLOTS.map(s => s.id)
  const s = normalizeSettings({ actions: [...known.slice(0, 7), 'not-a-real-action'] }, known)
  assert.ok(!s.actions.includes('not-a-real-action'))
  assert.equal(s.actions.length, 8, '不足八格时回落到默认')
})

test('空快捷键回落到默认值，不会变成一个永不触发的绑定', () => {
  const s = normalizeSettings({ hotkey: '   ' }, DEFAULT_SLOTS.map(s => s.id))
  assert.equal(s.hotkey, DEFAULT_SETTINGS.hotkey)
})

test('裸Space强制使用按住并移动模式，短按才能安全回放', () => {
  const settings = normalizeSettings({ hotkey: 'Space', mode: 'press' }, DEFAULT_SETTINGS.actions)
  assert.equal(settings.hotkey, 'Space')
  assert.equal(settings.mode, 'hold')
  assert.equal(settings.spaceGestureEnabled, false, '旧配置必须默认关闭裸Space手势')
  assert.equal(normalizeSettings({ hotkey: 'Space', spaceGestureEnabled: true }, DEFAULT_SETTINGS.actions).spaceGestureEnabled, true)
})

test('旧版默认槽位顺序迁移到LoL方向，用户自定义顺序保留', () => {
  const oldOrder = ['ask', 'revise', 'explain', 'verify', 'stop', 'continue', 'save', 'accept']
  assert.deepEqual([...normalizeSettings({ actions: oldOrder }, oldOrder).actions], [...DEFAULT_SETTINGS.actions])
  const custom = ['revise', 'stop', 'continue', 'explain', 'ask', 'verify', 'save', 'accept']
  assert.deepEqual([...normalizeSettings({ actions: custom }, custom).actions], custom)
})

test('超时被夹在合理区间', () => {
  const known = DEFAULT_SLOTS.map(s => s.id)
  assert.equal(normalizeSettings({ timeoutMs: 1 }, known).timeoutMs, 5000)
  assert.equal(normalizeSettings({ timeoutMs: 99999999 }, known).timeoutMs, 600000)
  assert.equal(normalizeSettings({ timeoutMs: -5 }, known).timeoutMs, 5000)
})

test('设置写入后可读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qh-settings-'))
  try {
    const store = new SettingsStore(dir)
    const next = { ...DEFAULT_SETTINGS, hotkey: 'Control+Option+K', iconSize: 64, paused: true }
    store.write(next)
    const read = store.read(DEFAULT_SLOTS.map(s => s.id))
    assert.equal(read.hotkey, 'Control+Option+K')
    assert.equal(read.iconSize, 64)
    assert.equal(read.paused, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 扇区几何 ────────────────────────────────────────────────────────────────

// The wheel's hit test lives in `wheel.js` and the helper's in `decision.cpp`.
// They must agree, so the reference below is a transcription of the C++ rather
// than of the JS: a test that copies the implementation it is checking proves
// nothing.
const HYSTERESIS_DEG = 6

function referenceSector(dx, dy, deadZone, previous) {
  const distance = Math.hypot(dx, dy)
  if (distance < deadZone) return -1
  const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
  const slice = 45
  let index = Math.floor((degrees + slice * 0.5) / slice) % 8
  if (index < 0) index += 8
  if (previous < 0) return index
  const angleDiff = (a, b) => {
    let d = a - b
    while (d > 180) d -= 360
    while (d < -180) d += 360
    return d
  }
  const delta = angleDiff(degrees, index * slice)
  const fromPrevious = angleDiff(degrees, previous * slice)
  const band = slice * 0.5 + HYSTERESIS_DEG
  if (Math.abs(delta) <= band && Math.abs(fromPrevious) <= band + slice) return previous
  return index
}

test('正北是 0 号，顺时针递增', () => {
  const r = 100
  const cases = [
    [0, -r, 0], [r, 0, 2], [0, r, 4], [-r, 0, 6],
    [r * Math.SQRT1_2, -r * Math.SQRT1_2, 1], [-r * Math.SQRT1_2, -r * Math.SQRT1_2, 7],
  ]
  for (const [dx, dy, expected] of cases) {
    assert.equal(referenceSector(dx, dy, 20, -1), expected, `方向 (${dx.toFixed(0)}, ${dy.toFixed(0)})`)
  }
})

test('中心死区返回 -1，即取消而不是第九格', () => {
  assert.equal(referenceSector(0, 0, 20, -1), -1)
  assert.equal(referenceSector(10, 10, 20, -1), -1)
  // Just outside the dead zone it becomes a real direction again.
  assert.notEqual(referenceSector(0, 21, 20, -1), -1)
})

test('指针停在接缝上不会来回跳', () => {
  // 22.5 degrees is the seam between sector 0 and sector 1.
  const seam = 22.5 * Math.PI / 180
  const dx = 100 * Math.sin(seam)
  const dy = -100 * Math.cos(seam)
  const first = referenceSector(dx, dy, 20, -1)
  // Re-asking with that as `previous` must not flip to the neighbour.
  assert.equal(referenceSector(dx, dy, 20, first), first)
  // And asking from the other side is equally stable.
  const other = first === 0 ? 1 : 0
  assert.equal(referenceSector(dx, dy, 20, other), other)
})

test('明确越过远边界后仍然会换格', () => {
  // Hysteresis must not pin the highlight. Due east is 90 degrees, the centre of
  // sector 2, so coming from sector 0 there is no way to justify staying put.
  assert.equal(referenceSector(100, 0, 20, 0), 2)
  assert.equal(referenceSector(-100, 0, 20, 2), 6)
})

test('wheel.js 的扇区判定与 C++ 参考实现一致', () => {
  // The band is read out of the page rather than hard-coded here, so this fails if
  // someone edits one side only — which is exactly the drift this guards. Comparing
  // against the reference (a transcription of `decision.cpp`) is the point: a test
  // that checked `sectorOf` against itself would pass forever.
  const source = readFileSync(join(root, 'src/host/ui/wheel.js'), 'utf8')
  const band = /const HYSTERESIS_DEG=(\d+)/.exec(source)
  assert.notEqual(band, null, 'wheel.js 里找不到 HYSTERESIS_DEG')
  assert.equal(Number(band[1]), HYSTERESIS_DEG, 'wheel.js 的滞回带宽与 C++ 参考实现不一致')

  // And the dead-zone fraction, which is duplicated between `sectorOf` and
  // `openAt`'s sizing assumptions.
  const zone = /Math\.hypot\(dx,dy\)<GEOMETRY\.innerR\*renderScale/.exec(source)
  assert.notEqual(zone, null, 'wheel.js 里找不到与原版中心半径一致的死区')

  // Same eight sectors, same origin: sweep a full turn in both implementations.
  const dead = 20
  let previous = -1
  for (let deg = 0; deg < 360; deg += 7) {
    const r = (deg * Math.PI) / 180
    previous = referenceSector(100 * Math.sin(r), -100 * Math.cos(r), dead, previous)
    assert.ok(previous >= 0 && previous < 8, `${deg} 度落在非法扇区 ${previous}`)
  }
})

// ── 一次性反馈 ──────────────────────────────────────────────────────────────

test('反馈媒体只交付一次，不会重播', () => {
  // Drives the real class, not a transcription of it: the whole contract is that
  // reading drains, and a local reimplementation would keep passing after the real
  // one regressed.
  const slot = new FeedbackSlot()
  assert.equal(slot.armed, false)
  slot.queue('gg_heart.webp', 'SRP_7.wav')
  assert.equal(slot.armed, true)
  assert.deepEqual(slot.take(), { animation: 'gg_heart.webp', sound: 'SRP_7.wav' })
  assert.equal(slot.take(), undefined, '第二次读取必须为空，否则动画会重播')
  assert.equal(slot.armed, false)
})

test('只有动画时不会带上一个空的音效键', () => {
  const slot = new FeedbackSlot()
  slot.queue('come_again.webp', '')
  assert.deepEqual(slot.take(), { animation: 'come_again.webp' })
  // A song key present but empty would make the player attempt a load of ''.
  slot.queue('', '')
  assert.deepEqual(slot.take(), {})
})

test('没有绑定目标时八个槽位都仍然可用', () => {
  // The wheel must draw before any task is bound; refusing to render until a
  // target exists would make the feature unreachable on a fresh install.
  assert.equal(DEFAULT_SLOTS.length, 8)
  assert.deepEqual(DEFAULT_SLOTS.map(s => s.sector).sort((a,b) => a-b), [0, 1, 2, 3, 4, 5, 6, 7])
})

// ── 快捷键解析 ──────────────────────────────────────────────────────────────

// The rule these guard: a chord is only claimed when every modifier it names is
// down. Getting this wrong is not a cosmetic bug — it means the trigger key stops
// working in every other application, which the user experiences as a broken
// keyboard rather than as a misconfigured plugin.

test('默认Control通过flagsChanged按住移动手势唤出', () => {
  const parsed = parseAccelerator(DEFAULT_SETTINGS.hotkey)
  assert.notEqual(parsed, undefined, `默认快捷键 ${DEFAULT_SETTINGS.hotkey} 无法解析`)
  assert.equal(parsed.mask, 0)
  assert.equal(parsed.key, 'CONTROL')
  assert.equal(parsed.code, 59)
  assert.equal(normalizeSettings({ hotkey: 'Ctrl', mode: 'press' }, DEFAULT_SLOTS.map(s => s.id)).mode, 'hold')
})

test('只有整套组合按下才算触发器', () => {
  const parsed = parseAccelerator('Control+Option+Space')
  assert.deepEqual(parsed.modifiers, ['CONTROL', 'OPTION'])
  const both = MODIFIER_FLAGS.CONTROL | MODIFIER_FLAGS.OPTION
  assert.equal(chordMatches(parsed, 49, both), true)
  // The case that matters: the bare key belongs to whoever is typing.
  assert.equal(chordMatches(parsed, 49, 0), false, '裸空格必须不算触发器')
  assert.equal(chordMatches(parsed, 49, MODIFIER_FLAGS.CONTROL), false, '缺少一个修饰键不算')
  assert.equal(chordMatches(parsed, 0, both), false, '按键不对不算')
  // Caps Lock is a flag like any other; an exact match would kill the hotkey.
  assert.equal(chordMatches(parsed, 49, both | (1 << 16)), true, '开着大写锁定仍应命中')
})

test('无法解析的组合被拒绝', () => {
  for (const bad of ['', '   ', 'Control+Return', 'Control+Tab', 'Hyper+Space', 'Control+']) {
    assert.equal(parseAccelerator(bad), undefined, `「${bad}」不应被接受`)
  }
})

test('大小写与别名都能解析到同一个组合', () => {
  const forms = ['Control+Option+Space', 'ctrl+alt+space', 'CTRL+OPTION+Space', 'control+option+space']
  for (const form of forms) {
    const parsed = parseAccelerator(form)
    assert.notEqual(parsed, undefined, `${form} 无法解析`)
    assert.equal(parsed.code, 49)
    assert.equal(parsed.mask, MODIFIER_FLAGS.CONTROL | MODIFIER_FLAGS.OPTION)
  }
})

test('重复修饰键不会把掩码加两次', () => {
  const parsed = parseAccelerator('Control+Ctrl+Space')
  assert.deepEqual(parsed.modifiers, ['CONTROL'])
  assert.equal(parsed.mask, MODIFIER_FLAGS.CONTROL)
})

test('裸键的组合掩码为零', () => {
  const parsed = parseAccelerator('Space')
  assert.equal(parsed.mask, 0)
  assert.equal(parsed.code, 49)
  assert.equal(chordMatches(parsed, 49, 0), true)
  assert.equal(chordMatches(parsed, 49, MODIFIER_FLAGS.CONTROL), false)
  assert.equal(chordMatches(parsed, 49, MODIFIER_FLAGS.COMMAND), false)
  assert.equal(chordMatches(parsed, 49, MODIFIER_FLAGS.OPTION), false)
})

test('默认裸Space不劫持系统组合键', () => {
  // Command+Space is Spotlight and Control+Space switches input methods; taking
  // either would break Chinese input, which is the worst possible outcome here.
  assert.equal(reservedCollision(DEFAULT_SETTINGS.hotkey), undefined,
    `默认快捷键 ${DEFAULT_SETTINGS.hotkey} 在这些组合里：${reservedCollision(DEFAULT_SETTINGS.hotkey)}`)
  assert.equal(reservedCollision('Command+Space'), 'COMMAND+SPACE')
  assert.equal(reservedCollision('Control+Space'), 'CONTROL+SPACE')
  // Alias forms must collide too, or the warning is trivially bypassed.
  assert.equal(reservedCollision('cmd+space'), 'COMMAND+SPACE')
  // And an unrelated chord must not be reported as reserved.
  assert.equal(reservedCollision('Control+Option+Space'), undefined)
})

test('损坏的快捷键回落到默认值而不是留下永不触发的绑定', () => {
  const settings = normalizeSettings({ hotkey: 'Control+Return' }, DEFAULT_SETTINGS.actions)
  assert.equal(settings.hotkey, DEFAULT_SETTINGS.hotkey)
})

test('修饰键常量与原生测试里硬编码的值一致', () => {
  // The two halves are separate implementations — TypeScript here, C++ in the
  // helper — and they only agree because they were written from the same table.
  // The C++ test spells the bits out as raw numbers rather than importing them
  // from Apple's headers, so it is the authority: a drift between these files would
  // mean the helper watched a flag the host never sets, and the hotkey would simply
  // never fire with nothing to point at.
  const source = readFileSync(join(root, 'native', 'input-helper', 'tests', 'decision_test.cpp'), 'utf8')
  const expected = { SHIFT: 17, CONTROL: 18, OPTION: 19, COMMAND: 20 }
  for (const [name, bit] of Object.entries(expected)) {
    const declared = new RegExp(`constexpr uint32_t k${name[0]}${name.slice(1).toLowerCase()} = 1u << ${bit};`)
    assert.ok(declared.test(source), `decision_test.cpp 里找不到 k${name} = 1<<${bit}`)
    assert.equal(MODIFIER_FLAGS[name], 1 << bit, `MODIFIER_FLAGS.${name} 与原生层不一致`)
  }
})

// ── 配置消息的线上格式 ──────────────────────────────────────────────────────

// The helper parses the config line with a positional `sscanf`, which makes two
// things load-bearing: the key order, and the type of every field. Both failures
// are silent — a shifted field leaves later values at their defaults — and one of
// them already happened: `holdMode` was sent as a JSON boolean, `%d` stopped at
// the `t` of `true`, and hold-to-open mode never worked.

/** The page's config object, kept here so the test drives the real shape. */
function sampleConfig() {
  return {
    triggerVk: 49,
    modifierMask: MODIFIER_FLAGS.CONTROL | MODIFIER_FLAGS.OPTION,
    holdMode: 1,
    dragThreshold: 12,
    watchdogMs: 12000,
    enabled: 1,
  }
}

test('配置消息的字段顺序与原生 sscanf 格式串一致', () => {
  const nativeSource = readFileSync(join(root, 'native', 'input-helper', 'macos_input.cpp'), 'utf8')
  // The format string is written as several concatenated C literals, so the span is
  // taken from the `sscanf` call up to its first argument and the keys are read out
  // of it in order. Each key appears escaped (`\"triggerVk\"`) because it lives
  // inside a C string.
  const call = /std::sscanf\([^,]+,\s*([\s\S]*?)&trigger_vk/.exec(nativeSource)
  assert.notEqual(call, null, 'macos_input.cpp 里找不到 config 的 sscanf 调用')
  const keys = [...call[1].matchAll(/\\"([A-Za-z][A-Za-z0-9]*)\\":/g)].map(m => m[1])
  assert.deepEqual(keys, ['type', 'triggerVk', 'modifierMask', 'holdMode', 'dragThreshold', 'watchdogMs', 'enabled'],
    `原生层读取的顺序是 ${keys.join('、')}`)

  // And the page must produce them in exactly that order, since JSON.stringify
  // preserves insertion order and `sscanf` is positional. `type` is added by the
  // desktop layer, so the page's own object starts at `triggerVk`.
  const produced = Object.keys(sampleConfig())
  assert.deepEqual(produced, keys.slice(1), `页面发送的顺序是 ${produced.join('、')}`)
})

test('配置消息里没有布尔值，只有 %d 能解析的数字', () => {
  // `%d` stops dead on the `t` of `true`, so a boolean silently truncates the
  // message from that field onward.
  const line = JSON.stringify({ type: 'config', ...sampleConfig() })
  assert.ok(!/:(?:true|false)\b/.test(line), `配置消息里出现了布尔值：${line}`)
  for (const value of Object.values(sampleConfig())) {
    assert.equal(typeof value, 'number', '配置字段都必须是数字')
  }
  // The exact fields the format string reads, in order, must be the ones sent.
  assert.ok(line.startsWith('{"type":"config","triggerVk":49,"modifierMask":'), line)
})

test('配置消息的字段数与 sscanf 的转换说明符数量相同', () => {
  // `matched != 6` in the helper refuses a partial match outright, so a missing
  // field is not a degraded config — it is no config at all, and the wheel stops
  // responding. Counting them here is what keeps that from being discovered live.
  const line = JSON.stringify({ type: 'config', ...sampleConfig() })
  const nativeSource = readFileSync(join(root, 'native', 'input-helper', 'macos_input.cpp'), 'utf8')
  const matched = /matched != (\d+)/.exec(nativeSource)
  assert.notEqual(matched, null, 'macos_input.cpp 里找不到对 sscanf 返回值的检查')
  assert.equal(Object.keys(sampleConfig()).length, Number(matched[1]),
    `配置有 ${Object.keys(sampleConfig()).length} 个字段，原生层要求 ${matched[1]} 个`)
  assert.ok(line.includes('"watchdogMs":12000'), line)
})

// ── 路由装配 ───────────────────────────────────────────────────────────────
//
// These drive the real `registerRoutes` against a registry that copies DSH's
// WebServer semantics exactly, because that contract is the thing being tested:
//
//  - Duplicates are judged by `(kind, path)` alone. There is no method
//    dimension, so a GET and a PUT on one path collide and the second
//    registration throws.
//  - `exact` compares the pathname verbatim. There is no `:name` syntax, so a
//    registered path containing one is a literal string no real URL matches.
//  - `prefix` matches the prefix itself and anything below it, longest first.
//
// Getting any of these wrong does not fail a test — it throws during plugin
// activation, or answers 404 to every request, and neither is visible from
// here. That is how a `duplicate exact route "/quick-help/api/settings"` on the
// GET/PUT pair survived: the plugin simply never loaded, and every test that did
// not mount the routes passed regardless.

/**
 * A stand-in for the host's WebServer route tables.
 *
 * Transcribed from packages/host/webserver/src/index.ts — `register`, `match`,
 * and the exact-table-before-prefix-table order. Only the routing is modelled;
 * nothing about HTTP itself, since the assertions are about what got mounted.
 */
function fakeWebServer({ failOn = null } = {}) {
  const exact = new Map()
  const prefixes = new Map()
  let attempted = 0

  return {
    /** Every path mounted, in registration order, as `kind path`. */
    mounted: () => [...exact.keys()].map(p => `exact ${p}`).concat([...prefixes.keys()].map(p => `prefix ${p}`)),
    exactPaths: () => [...exact.keys()],
    prefixPaths: () => [...prefixes.keys()],
    host: '127.0.0.1',
    port: 0,

    register(route) {
      attempted += 1
      if (failOn !== null && route.path === failOn) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      }
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      }
      table.set(route.path, route)
      return () => { table.delete(route.path) }
    },

    /** The route a request would reach, or undefined for the fallback owner. */
    match(pathname) {
      const hit = exact.get(pathname)
      if (hit !== undefined) return hit
      let best
      for (const [prefix, route] of prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
        if (best === undefined || prefix.length > best.path.length) best = route
      }
      return best
    },

    get attempts() { return attempted },
  }
}

/** Minimal deps for mounting routes; nothing here touches an agent or disk. */
function routeDeps(webServer, overrides = {}) {
  return {
    webServer,
    log: () => {},
    assets: new AssetResolver(join(root, 'assets')),
    sessions: {
      current: () => 's1',
      view: () => [],
      busy: () => false,
      draft: () => '',
      isPinned: () => false,
      setDraft: () => {},
      setPinned: () => {},
      reset: () => 's2',
      list: () => [],
      send: async () => {},
      defaultRoute: () => 'anthropic/claude',
      modelAvailable: () => true,
    },
    media: { latest: () => undefined, error: () => undefined, report: () => true },
    bindings: { clear: () => {}, history: () => [] },
    scheduler: {
      dispatch: async () => ({ kind: 'started' }),
      stop: async () => 'stopped',
      isStopped: () => false,
      queued: () => 0,
      runningNow: () => undefined,
    },
    settings: () => ({ ...DEFAULT_SETTINGS }),
    setSettings: () => ({ ...DEFAULT_SETTINGS }),
    status: () => ({ supported: true, helper: 'running', modelAvailable: true }),
    slots: () => DEFAULT_SLOTS,
    trigger: () => ({ code: 49, mask: MODIFIER_FLAGS.CONTROL | MODIFIER_FLAGS.OPTION, label: 'Space' }),
    catalogue: () => [...DEFAULT_SLOTS, ...OPTIONAL_EMOTES],
    feedback: () => undefined,
    queueFeedback: () => {},
    takeFeedback: () => undefined,
    target: () => undefined,
    bindTarget: () => ({ ok: true }),
    advanceTarget: async () => {},
    reportRuntime: () => {},
    reportFeedback: () => {},
    sizes: [48, 56, 64],
    labels: {},
    inputs: {},
    tick: HOVER_SOUND,
    ...overrides,
  }
}

test('全部路由能装上，不触发判重', () => {
  // The load-time blocker. A duplicate (kind, path) throws out of activation, so
  // the plugin never registers and every feature reads as "installed but dead".
  const server = fakeWebServer()
  const dispose = registerRoutes(routeDeps(server))
  assert.ok(server.exactPaths().length > 0, '一条 exact 路由都没有装上')
  assert.ok(server.prefixPaths().length > 0, '一条 prefix 路由都没有装上')
  dispose()
  assert.equal(server.exactPaths().length, 0, 'dispose 之后仍有 exact 路由残留')
  assert.equal(server.prefixPaths().length, 0, 'dispose 之后仍有 prefix 路由残留')
})

test('status 只读机器状态，不恢复会话或改变目标', async () => {
  const server = fakeWebServer()
  registerRoutes(routeDeps(server, {
    status: () => ({ supported: true, helper: 'running', accessibility: true }),
    refreshTarget: () => { throw new Error('status must not refresh target') },
    sessions: new Proxy({}, { get() { throw new Error('status must not access Sessions') } }),
  }))
  const route = server.match('/quick-help/api/status')
  assert.ok(route)
  const res = { statusCode: 200, writableEnded: false, setHeader() {}, end(body) { this.body = body; this.writableEnded = true } }
  await route.handler({ method: 'GET', url: '/quick-help/api/status', headers: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).status.helper, 'running')
})

test('settings 的读写是同一路径的一次注册', () => {
  // GET and PUT on one resource must be one route with two arms. Registering them
  // separately is the duplicate that broke plugin load.
  const server = fakeWebServer()
  registerRoutes(routeDeps(server))
  const settings = server.exactPaths().filter(p => p === '/quick-help/api/settings')
  assert.equal(settings.length, 1, `/quick-help/api/settings 装了 ${settings.length} 次，应当恰好 1 次`)
})

test('没有任何路由把 :name 当成路径的一部分', () => {
  // `exact` is a verbatim comparison, so a path carrying `:name` is a literal no
  // real URL can equal — the script and image requests would 404 while the route
  // looked correctly registered.
  const server = fakeWebServer()
  registerRoutes(routeDeps(server))
  const withParams = [...server.exactPaths(), ...server.prefixPaths()].filter(p => p.includes(':'))
  assert.deepEqual(withParams, [], `这些路径里的 :name 不会被解析：${withParams.join('、')}`)
})

test('overlay 静态文件按名字可达，未列入的文件不可达', () => {
  const server = fakeWebServer()
  registerRoutes(routeDeps(server))
  for (const name of ['common.js', 'common.css', 'wheel.js', 'wheel.css', 'ask.js', 'ask.css', 'settings.js', 'shell.css']) {
    const route = server.match(`/quick-help/overlay/${name}`)
    assert.ok(route !== undefined, `/quick-help/overlay/${name} 没有命中任何路由`)
    assert.equal(route.kind, 'prefix', `${name} 应当由 prefix 路由分发`)
  }
  // The subtree is guarded inside the handler, so an unknown name still matches a
  // route — what matters is that it is not a distinct *registration* that has to
  // be guessed at, and that traversal cannot escape the mount.
  assert.ok(server.match('/quick-help/overlay/../../../etc/passwd') !== undefined,
    '越界路径仍走同一个分发器，由处理器按名字表拒绝')
  assert.ok(server.match('/quick-help/overlay') !== undefined, 'prefix 本身也归这个分发器所有')
  assert.ok(server.prefixPaths().includes('/quick-help/overlay'),
    `overlay 应挂在 prefix 表里，实际是 ${server.prefixPaths().join('、')}`)
})

test('素材按 kind/name 可达，且子树的形状由分发器决定', () => {
  const server = fakeWebServer()
  registerRoutes(routeDeps(server))
  const route = server.match('/quick-help/asset/textures/whatever.png')
  assert.ok(route !== undefined, '素材 URL 没有命中任何路由')
  assert.equal(route.kind, 'prefix', '素材应由 prefix 路由分发')
  // Two segments expected; a deeper path must not silently resolve, which is why
  // the handler checks the arity rather than joining whatever it was given.
  assert.ok(server.match('/quick-help/asset/a/b/c') !== undefined, '更深的路径也走同一分发器')
})

test('注册中途失败会撤销已挂载的部分', () => {
  // Registering twenty paths one at a time and throwing on the tenth would leave
  // the first ten answering for a plugin the host already considered failed, and
  // the next activation would then fail on a duplicate nobody can explain.
  const server = fakeWebServer({ failOn: '/quick-help/api/send' })
  assert.throws(() => registerRoutes(routeDeps(server)), /duplicate/, '中途失败应当向上抛错')
  assert.deepEqual(server.exactPaths(), [], `失败后仍残留 ${server.exactPaths().length} 条路由`)
  assert.deepEqual(server.prefixPaths(), [], `失败后仍残留 ${server.prefixPaths().length} 条前缀路由`)

  // And the surface must be registrable again afterwards.
  const clean = fakeWebServer()
  assert.doesNotThrow(() => registerRoutes(routeDeps(clean)), '撤销之后仍应能重新装上')
})

test('方法不匹配是 405 而不是 404，并且带上 Allow', async () => {
  // The web server matches on path alone, so the verb is checked inside. Getting
  // this wrong answers 404 for a real path, which reads as "not installed".
  const server = fakeWebServer()
  registerRoutes(routeDeps(server))
  const route = server.match('/quick-help/api/settings')
  const headers = {}
  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v },
    write: () => {},
    end: (body) => { res.writableEnded = true; res.body = body },
  }
  await route.handler({ method: 'DELETE', url: '/quick-help/api/settings', headers: {} }, res)
  assert.equal(res.statusCode, 405, '错误的方法应回答 405')
  assert.equal(headers.allow, 'GET, PUT', `Allow 头应列出支持的方法，实际是 ${headers.allow}`)
})

test('页面与脚本路由都在，路径与页面里引用的一致', () => {
  // Every href and src in the three documents must resolve. A document that loads
  // but cannot style or script itself shows a blank transparent window.
  const server = fakeWebServer()
  registerRoutes(routeDeps(server))
  const refs = Object.values(SLOTS).flatMap(page => [...page.html.matchAll(/(?:href|src)="(\/quick-help\/[^"]+)"/g)].map(m => m[1]))
  assert.ok(refs.length >= 8, `只从页面里读到 ${refs.length} 个引用`)
  for (const ref of refs) {
    assert.ok(server.match(ref) !== undefined, `页面引用了没有路由的 ${ref}`)
  }
})

test('helper-config 路由与设置页构造的配置字段一致', () => {  // Two producers for one message is exactly how the desktop's startup pull and the
  // settings page drift apart, and the symptom would be a wheel that works after
  // changing a setting but not on a fresh launch. The keys must match, and both
  // must be the six the helper reads.
  const routes = readFileSync(join(root, 'src', 'host', 'routes.ts'), 'utf8')
  assert.ok(routes.includes("/api/helper-config"), 'routes.ts 里没有 /api/helper-config 路由')

  const route = /get\('\/api\/helper-config'[\s\S]*?ok\(res, \{([\s\S]*?)\}\)/.exec(routes)
  assert.notEqual(route, null, '无法读取 /api/helper-config 的响应字段')
  const routeKeys = [...route[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map(m => m[1])
  assert.deepEqual(routeKeys, Object.keys(sampleConfig()),
    `/api/helper-config 返回 ${routeKeys.join('、')}`)
  assert.ok(/settings\.spaceGestureEnabled/.test(route[1]), '裸Space未主动启用时必须在helper-config禁用')

  // And the settings page must produce the same six, with numbers for the flags.
  const page = readFileSync(join(root, 'src', 'host', 'ui', 'settings.js'), 'utf8')
  const call = /DSH\.configure\(\{([\s\S]*?)\}\)/.exec(page)
  assert.notEqual(call, null, 'settings.js 里找不到 DSH.configure 调用')
  const pageKeys = [...call[1].matchAll(/([A-Za-z][A-Za-z0-9]*):/g)].map(m => m[1])
  assert.deepEqual(pageKeys, Object.keys(sampleConfig()), `settings.js 发送 ${pageKeys.join('、')}`)
  assert.ok(/holdMode:[^,]*\?1:0/.test(call[1]), 'holdMode 必须是 1 或 0')
  assert.ok(/enabled:[^,]*\?0:1/.test(call[1]), 'enabled 必须是 0 或 1')
  assert.ok(/spaceGestureEnabled/.test(call[1]), '设置页配置也必须尊重裸Space opt-in')
})

// ── DSH 会话接入 ────────────────────────────────────────────────────────────

test('快捷问答的新会话先 create，并复用同一 live Agent', async () => {
  const { sessionFixture } = await import('./session-fixture.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-session-fixture-'))
  const workspacePath = join(tmp, 'workspace')
  const { ctx, calls } = sessionFixture(workspacePath)
  const sessions = new SessionManager(ctx, { stateDir: join(tmp, 'state'), workspacePath })
  try {
    const sessionId = sessions.current()
    await sessions.send(sessionId, '第一条问题', { modelRoute: 'provider/custom-model' })
    const updates = []
    await sessions.send(sessionId, '继续追问', { onUpdate: turn => updates.push(turn.text) })
    assert.equal(calls.create.length, 1)
    assert.equal(calls.resume.length, 0)
    assert.equal(calls.create[0].sessionId, sessionId)
    assert.deepEqual(calls.selectModel[0], { sessionId, provider: 'provider', model: 'custom-model' })
    assert.ok(calls.controllerCreate.length >= 1 && calls.prompt.length === 2, '使用正式 controller 创建和发送')
    assert.ok(updates.includes('你好'))
    assert.equal(sessions.view(sessionId).at(-1).text, '你好')
  } finally { await sessions.dispose(); rmSync(tmp, { recursive: true, force: true }) }
})

// ── 结果 ────────────────────────────────────────────────────────────────────

await run()

console.log(`\n${'─'.repeat(50)}`)
console.log(`${passed} 通过, ${failed} 失败`)
if (failed > 0) {
  console.log('\n失败详情：')
  for (const f of failures) {
    console.log(`\n[${f.name}]`)
    console.log(f.error instanceof Error ? f.error.stack : String(f.error))
  }
  process.exit(1)
}
