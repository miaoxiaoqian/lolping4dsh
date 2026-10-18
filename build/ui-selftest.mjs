/** Run the real shared and ask-page scripts against a tiny browser surface. */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const nodes = new Map()
const timers = []
class Node {
  constructor(id = '') { this.id = id; this.listeners = new Map(); this.children = []; this.hidden = false; this.value = ''; this.textContent = ''; this.style = {}; this.dataset = {}; this.className = ''; this.scrollHeight = 0; this.scrollTop = 0 }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list) }
  async dispatch(type) { for (const fn of this.listeners.get(type) || []) await fn({ type, preventDefault() {} }) }
  play() { played.push({ src: this.src, volume: this.volume }); return Promise.resolve() }
  appendChild(node) { this.children.push(node); return node }
  focus() {}
  setAttribute(name, value) { this[name] = value }
  set innerHTML(value) { this.children = []; this._html = value }
  get innerHTML() { return this._html || '' }
  remove() {}
}
const document = {
  body: new Node('body'),
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id) },
  querySelector(name) { return this.getElementById(name) },
  createElement() { return new Node() },
  addEventListener() {},
}
const calls = []
const played = []
let selectedImage
const sendBodies = []
const bridge = {
  environment: async () => ({ displays: [{ id: 1, x: 0, y: 0, width: 1000, height: 800, scale: 1 }], cursor: { x: 400, y: 300 }, accessibility: false, supported: true, helper: 'no-access' }),
  show: async request => { calls.push(['show', request]) },
  hide: async route => { calls.push(['hide', route]) },
  focusMain: async () => {}, probeHotkey: async () => ({ ok: true, available: true }),
  configure: async () => {}, suspend: async () => {}, rendererReady: async () => {}, feedback: async () => {},
  readCapture: async () => selectedImage,
  captureSelection: async () => { selectedImage='data:image/png;base64,cG5n'; return 'captured' },
  discardCapture: async () => { selectedImage=undefined },
  onInput: () => () => {}, onHelperStatus: () => () => {},
}
const state = { sessionId:'s1', turns: [], draft: '', target: null, modelRoute: 'test/model', placement: 'pointer', keepFocus: false, busy: false, running: null, queued: 0, stopped: false, pinned: false, feedback: { sound: '/test.wav' }, soundEnabled: true, soundVolume: 0.4 }
const context = createContext({
  window: { __DSH_QUICK_HELP__: bridge, addEventListener() {} }, document,
  fetch: async (url,options) => {
    if(url.endsWith('/send')){
      sendBodies.push(JSON.parse(options.body));
      return { ok:true, body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: done\ndata: {"turns":[]}\n\n'));controller.close();}}) };
    }
    return { ok: true, json: async () => state };
  },
  setTimeout: fn => { timers.push(fn); return timers.length }, clearTimeout() {}, setInterval() { return 1 },
  Date, Math, JSON, Error, String, Promise, TextDecoder,
})

runInContext(readFileSync(new URL('../src/host/ui/common.js', import.meta.url), 'utf8'), context, { filename: 'common.js' })
document.getElementById('problem').hidden = true
runInContext(readFileSync(new URL('../src/host/ui/ask.js', import.meta.url), 'utf8'), context, { filename: 'ask.js' })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(played, [], '聊天页不能再播放遮挡输入框的动作媒体')
assert.ok(calls.some(([, request]) => request?.route === 'ask' && request.bounds?.x === 418 && request.bounds?.y === 318 && request.bounds?.width === 360 && request.bounds?.height === 400), 'ask窗口按实际pointer位置使用360×400 bounds')
await nodes.get('settings').dispatch('click')
await nodes.get('close').dispatch('click')
assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
  ['show', { route: 'ask', bounds: { x: 418, y: 318, width: 360, height: 400 }, focusable: true, clickThrough: false }],
  ['show', { route: 'settings', focusable: true, clickThrough: false }],
  ['hide', 'ask'],
])
assert.equal(nodes.get('problem').hidden, true)
await nodes.get('capture').dispatch('click')
await new Promise(resolve=>setImmediate(resolve))
assert.equal(nodes.get('attachment').hidden,false,'框选后出现本地预览')
assert.equal(sendBodies.length,0,'框选与预览不能自动上传图片')
await nodes.get('remove-image').dispatch('click')
assert.equal(nodes.get('attachment').hidden,true,'删除待发送截图')
await nodes.get('capture').dispatch('click')
await new Promise(resolve=>setImmediate(resolve))
await nodes.get('send').dispatch('click')
await new Promise(resolve=>setImmediate(resolve))
assert.equal(sendBodies.length,1,'明确发送只提交一次')
assert.equal(sendBodies[0].sessionId,'s1')
assert.equal(sendBodies[0].images[0].type,'image')
assert.equal(sendBodies[0].images[0].data,'cG5n')
assert.equal(selectedImage,undefined,'成功后释放待发送图片内存')
console.log('实际 common.js + ask.js：设置切页与关闭桥接通过')
