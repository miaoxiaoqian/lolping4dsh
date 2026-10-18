/**
 * Self-test for the quick-help browser half.
 *
 * Two kinds of check, because the two failure modes are different.
 *
 * The dictionaries are imported for real: a translation key present in one
 * language and missing in the other renders as a raw key in the sidebar, which is
 * a defect users see and no type-checker catches, because both dictionaries are
 * typed as `Record<string, string>`.
 *
 * Everything else is read as source. The panel's two files import React, which the
 * host supplies at runtime and Node cannot resolve, so importing them here would
 * mean stubbing the framework the code actually runs against — testing a stand-in.
 * The invariants that break the sidebar are structural anyway: a panel registered
 * in one seat and not the other is a clickable row with no destination, and a
 * service reached without being declared aborts activation and takes the whole
 * web boot down with it.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const clientDir = join(root, 'src', 'client')

register(pathToFileURL(join(root, 'build', 'ts-loader.mjs')).href, import.meta.url)

const { NS, dictionaries, zhCN, enUS } = await import(pathToFileURL(join(clientDir, 'locales.ts')).href)

const indexSource = readFileSync(join(clientDir, 'index.tsx'), 'utf8')
const panelSource = readFileSync(join(clientDir, 'panel.tsx'), 'utf8')
const commonUiSource = readFileSync(join(root, 'src', 'host', 'ui', 'common.js'), 'utf8')
const askUiSource = readFileSync(join(root, 'src', 'host', 'ui', 'ask.js'), 'utf8')
const settingsUiSource = readFileSync(join(root, 'src', 'host', 'ui', 'settings.js'), 'utf8')
const wheelUiSource = readFileSync(join(root, 'src', 'host', 'ui', 'wheel.js'), 'utf8')
const askCssSource = readFileSync(join(root, 'src', 'host', 'ui', 'ask.css'), 'utf8')
const desktopQuickHelpSource = readFileSync(join(root, 'integration', 'desktop', 'desktop.patch'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let passed = 0
let failed = 0
const failures = []
const pending = []

/** Register a test. Async bodies are awaited in order at the end of the run. */
function test(name, body) {
  pending.push({ name, body })
}

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
    }
  }
}

// ── 字典 ────────────────────────────────────────────────────────────────────

test('中英字典的键完全一致', () => {
  const zh = Object.keys(zhCN).sort()
  const en = Object.keys(enUS).sort()
  const missingInEn = zh.filter(key => en.includes(key) === false)
  const missingInZh = en.filter(key => zh.includes(key) === false)
  assert.deepEqual(missingInEn, [], `英文缺少这些键：${missingInEn.join('、')}`)
  assert.deepEqual(missingInZh, [], `中文缺少这些键：${missingInZh.join('、')}`)
  assert.ok(zh.length > 20, `字典只有 ${zh.length} 个键，看起来不完整`)
})

test('没有空字符串的文案', () => {
  // An empty string renders as a gap in the UI and passes every type check, so it
  // is worth failing on rather than discovering on screen.
  const blank = Object.entries(zhCN).filter(([, value]) => value.trim() === '').map(([key]) => key)
  assert.deepEqual(blank, [], `这些中文文案是空的：${blank.join('、')}`)
})

test('中文和英文不是同一份内容', () => {
  // The bug this catches is a real one that shipped: `dictionaries` pointed both
  // locales at the English table, which types as valid and reads as translated.
  assert.notDeepEqual(zhCN, enUS, '中英字典内容相同，英文可能被误当作中文')
  assert.equal(dictionaries.zh, zhCN)
  assert.equal(dictionaries.en, enUS)
})

test('命名空间与插件名一致', () => {
  // The sidebar resolves labels through this namespace; a mismatch leaves the row
  // showing its key rather than its name.
  assert.equal(NS, 'quick-help')
})

// ── 装配 ────────────────────────────────────────────────────────────────────

test('面板座位和逐回答作座位都注册', () => {
  // A row without a page is a click with nowhere to go, and a page without a row
  // is unreachable. They are bound by a shared id, so a typo in either is silent.
  const panelId = /const PANEL_ID = '([^']+)'/.exec(indexSource)
  assert.notEqual(panelId, null, 'index.tsx 里找不到 PANEL_ID')
  assert.equal(panelId[1], NS, 'PANEL_ID 与命名空间不一致')

  const seats = [...indexSource.matchAll(/ctx\.slots\.register\(\{\s*\n\s*name: '([^']+)'/g)].map(m => m[1])
  assert.deepEqual(seats.sort(), ['conversation.chat.assistant-actions', 'conversation.input.dock', 'conversation.input.left', 'main', 'shell.compact-actions', 'sidebar.panellist'], `注册的座位是：${seats.join('、')}`)

  // Both registrations must carry the panel's id, under whichever key the seat uses.
  const ids = [...indexSource.matchAll(/(?:id|key): PANEL_ID/g)].length
  assert.equal(ids, 3, `main、sidebar 与 assistant action 有 ${ids} 处引用了 PANEL_ID`)
  assert.match(indexSource, /name: 'conversation\.chat\.assistant-actions',[\s\S]*?id: PANEL_ID/)
})

test('六个座位都通过 slots.inject 声明', () => {
  // Registering without the inject wrapper skips the seat's readiness handshake;
  // the row simply never appears, with no error to explain it.
  const seats = ['sidebar.panellist', 'main', 'conversation.chat.assistant-actions', 'conversation.input.left', 'conversation.input.dock', 'shell.compact-actions']
  for (const seat of seats) {
    assert.ok(indexSource.includes(`ctx.slots.inject('${seat}'`), `${seat} 没有用 slots.inject 包裹`)
  }
})

test('面板用到的服务都在 inject 里声明了', () => {
  // An undeclared service aborts this entry's activation, and the web boot then
  // refuses to finish — so the failure is the whole application, not this panel.
  const declared = /export const inject = \[([^\]]+)\]/.exec(indexSource)
  assert.notEqual(declared, null, 'index.tsx 里找不到 inject 声明')
  const services = [...declared[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.ok(services.includes('slots'), 'inject 未声明 slots')
  assert.ok(services.includes('locale'), 'inject 未声明 locale')

  // Every `ctx.<service>` actually read must be in that list.
  const used = new Set([...indexSource.matchAll(/ctx\.([a-zA-Z]+)/g)].map(m => m[1]))
  used.delete('effect')
  for (const name of used) {
    assert.ok(services.includes(name), `用到了 ctx.${name} 但 inject 里没有声明`)
  }
})

test('面板没有自己越过注入去拿服务', () => {
  // The panel receives `t` through the seat's inject instead of reaching for the
  // locale service, which is what keeps its copy inside this namespace.
  const reach = [...panelSource.matchAll(/ctx\.(slots|locale)\b/g)].map(m => m[0])
  assert.deepEqual(reach, [], `panel.tsx 不应直接访问 ${reach.join('、')}`)
  assert.ok(panelSource.includes('t('), 'panel.tsx 没有使用传入的 t')
})

test('package.json 声明了客户端注入的模块', () => {
  // This list is what the loader loads before this entry; a service reached without
  // it is an error at the moment it is read, not a graceful degradation.
  const modules = manifest.dsh?.client?.inject
  assert.ok(Array.isArray(modules), 'package.json 缺少 dsh.client.inject')
  for (const expected of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-chat']) {
    assert.ok(modules.includes(expected), `dsh.client.inject 缺少 ${expected}`)
  }
  assert.equal(manifest.dsh.client.platform, 'web')
})

test('入口与客户端产物都指向存在的路径', () => {
  assert.equal(manifest.main, './lib/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
})

test('设置读取有超时且加载页仍可直接测试轮盘或求救', () => {
  assert.match(panelSource, /AbortSignal\.timeout\(LOAD_TIMEOUT_MS\)/)
  assert.match(panelSource, /LOAD_TIMEOUT_MS\s*=\s*8_000/)
  assert.match(panelSource, /if \(data === null\)[\s\S]*?\{immediateActions\}/)
  assert.match(panelSource, /if \(error !== null\)[\s\S]*?\{immediateActions\}/)
  assert.match(panelSource, /当前桌面程序缺少轮盘接口，请更新并重启/)
})

test('求助页公共脚本从 preload 安全桥接并明确报缺失错误', () => {
  assert.match(commonUiSource, /window\.__DSH_QUICK_HELP__/)
  assert.match(commonUiSource, /const DSH=/)
  assert.match(commonUiSource, /当前桌面程序缺少轮盘接口，请更新并重启/)
  assert.doesNotMatch(commonUiSource, /window\.DSH\s*=\s*\{/) // 不用另造、与 preload 脱节的伪接口
})

test('关闭和设置按钮直接调用已校验的桌面桥接并显示错误', () => {
  assert.match(askUiSource, /el\('settings'\)\.addEventListener\('click',async\(\)=>\{try\{await flushDraft\(\);suppressBlurHide=true;await DSH\.show\(\{route:'settings',focusable:true,clickThrough:false\}\)/)
  assert.match(askUiSource, /el\('close'\)\.addEventListener\('click',async\(\)=>\{try\{await flushDraft\(\);await DSH\.hide\('ask'\)/)
  assert.match(askUiSource, /problem\.textContent=e instanceof Error\?e\.message:String\(e\)/)
  assert.match(settingsUiSource, /route:'ask',focusable:true,clickThrough:false/)
})

test('回答流按实际 SSE 空行分帧并解析多行 data', () => {
  assert.match(askUiSource, /buf\.indexOf\('\\n\\n'\)/)
  assert.doesNotMatch(askUiSource, /buf\.indexOf\('\\\\n\\\\n'\)/)
  assert.match(askUiSource, /event==='update'/)
  assert.match(askUiSource, /event==='done'/)
})

test('无全局权限时仍绘制和监听手动轮盘，ready 在监听安装后发送', () => {
  assert.doesNotMatch(wheelUiSource, /helper\s*===\s*['"]no-access['"]\)\s*\{[^}]*return/)
  assert.match(wheelUiSource, /draw\(\);[\s\S]*?bind\(\);\s*await DSH\.rendererReady\(\)/)
  assert.match(wheelUiSource, /if\(view\.status&&!view\.status\.supported\)return/)
})

test('每条已完成回答都能用真实 Session 与 messageId 设为轮盘目标', () => {
  const actionSource = readFileSync(join(clientDir, 'assistant-action.tsx'), 'utf8')
  assert.match(indexSource, /ctx\.slots\.inject\('conversation\.chat\.assistant-actions'/)
  assert.match(indexSource, /inject: \(sessionId: string\)/)
  assert.match(actionSource, /answerId: messageId/)
  assert.match(actionSource, /sessionId,/)
})

test('轮盘、问答与设置音效会调用 play 并应用静音/音量', () => {
  assert.match(commonUiSource, /node\.play\(\)/)
  assert.match(commonUiSource, /node\.volume=Math\.max\(0,Math\.min\(1/)
  assert.match(wheelUiSource, /view\.soundEnabled&&view\.tick/)
  assert.match(askUiSource, /Promise\.resolve\(play\(url,isSound&&state\?state\.soundVolume:1\)\)\.catch/)
})

test('快捷求助窗口以 360×400 逻辑像素贴近鼠标并限制在屏幕内', () => {
  assert.match(desktopQuickHelpSource, /clampAskBounds\(position, area, 360, 400\)/)
  assert.match(desktopQuickHelpSource, /screen\.getCursorScreenPoint\(\)/)
  assert.match(askCssSource, /height: 51px/)
})

// ── 结果 ────────────────────────────────────────────────────────────────────

await run()

console.log(`\n${'─'.repeat(50)}`)
console.log(`${passed} 通过, ${failed} 失败`)
if (failed > 0) {
  console.log('\n失败详情：')
  for (const f of failures) {
    console.log(`\n[${f.name}]`)
    console.log(f.error instanceof Error ? f.error.message : String(f.error))
  }
  process.exit(1)
}
