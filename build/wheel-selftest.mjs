import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const nodes = new Map()
class Node {
  constructor(id = '') {
    this.id = id
    this.listeners = new Map()
    this.children = []
    this.style = {}
    this.dataset = {}
    this.attributes = {}
    this.textContent = ''
    this.classes = new Set()
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      toggle: (name, force) => force === undefined ? (this.classes.has(name) ? this.classes.delete(name) : this.classes.add(name)) : (force ? this.classes.add(name) : this.classes.delete(name)),
      contains: name => this.classes.has(name),
    }
    this.hidden = false
  }
  addEventListener(type, fn) {
    const listeners = this.listeners.get(type) || []
    listeners.push(fn)
    this.listeners.set(type, listeners)
  }
  appendChild(node) { this.children.push(node); return node }
  replaceChildren(...nodes) { this.children = nodes }
  set innerHTML(value) { this.children = []; this._html = value }
  get innerHTML() { return this._html || '' }
  querySelector(selector) {
    const match = /\[data-sector="(\d+)"\]/.exec(selector)
    if (!match) return null
    return this.children.find(node => node.attributes['data-sector'] === match[1]) || null
  }
  querySelectorAll() { return [] }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  removeAttribute(name) { delete this.attributes[name] }
}
const document = {
  body: new Node('body'),
  getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, new Node(id))
    return nodes.get(id)
  },
  createElement() { return new Node() },
  createElementNS() { return new Node() },
  addEventListener() {},
}
const shows = []
let inputListener
let delayEnvironment = false
let finishEnvironment
let delayShow = false
let finishFirstShow
const bridge = {
  environment: async () => {
    if (delayEnvironment) await new Promise(resolve => { finishEnvironment = resolve })
    return {
      displays: [{ x: 0, y: 0, width: 1000, height: 800 }],
      accessibility: true,
      supported: true,
      helper: 'running',
    }
  },
  show: async request => {
    for (const value of Object.values(request.bounds||{})) assert.equal(Number.isInteger(value), true, 'Electron window bounds must use integer DIP values')
    shows.push(request)
    if (delayShow) {
      delayShow = false
      await new Promise(resolve => { finishFirstShow = resolve })
    }
  },
  hide: async () => {},
  focusMain: async () => {},
  probeHotkey: async () => ({ ok: true, available: true }),
  configure: async () => {},
  suspend: async () => {},
  rendererReady: async () => {},
  feedback: async () => {},
  onInput: listener => { inputListener = listener; return () => {} },
  onHelperStatus: () => () => {},
}
const state = {
  status: { supported: true, helper: 'running' },
  mode: 'hold',
  size: 56,
  target: null,
  paused: false,
  tick: null,
  slots: Array.from({ length: 8 }, (_, sector) => ({
    sector,
    action: sector === 0 ? 'stop' : `action-${sector}`,
    image: '/fixture.png',
    emoteNameZh: `槽位${sector}`,
    hover: `动作${sector}`,
  })),
}
const context = createContext({
  window: { __DSH_QUICK_HELP__: bridge, addEventListener() {} },
  document,
  fetch: async () => ({ ok: true, json: async () => state }),
  screen: {},
  // Hidden Electron windows can suspend rAF until showInactive runs. If the
  // renderer awaits this callback first, the real window never appears.
  requestAnimationFrame: () => 0,
  Date,
  Math,
  JSON,
  Error,
  String,
  Promise,
})

runInContext(readFileSync(new URL('../src/host/ui/common.js', import.meta.url), 'utf8'), context, { filename: 'common.js' })
runInContext(readFileSync(new URL('../src/host/ui/wheel.js', import.meta.url), 'utf8'), context, { filename: 'wheel.js' })
await new Promise(resolve => setImmediate(resolve))
assert.equal(typeof inputListener, 'function', 'wheel listener must be installed before ready')
delayEnvironment = true
inputListener({ type: 'wheelOpen', x: 500, y: 400 })
await new Promise(resolve => setImmediate(resolve))
inputListener({ type: 'wheelRelease', x: 500, y: 400 })
finishEnvironment()
delayEnvironment = false
await new Promise(resolve => setImmediate(resolve))
assert.equal(shows.length, 0, 'a quick release while the first display query is pending must cancel the late show')
inputListener({ type: 'wheelOpen', x: 500, y: 400 })
await new Promise(resolve => setImmediate(resolve))
assert.equal(shows.length, 1)
assert.deepEqual(JSON.parse(JSON.stringify(shows[0].bounds)), { x: 150, y: 50, width: 700, height: 700 })
assert.equal(shows[0].clickThrough, true, 'hold gesture wheel must not intercept Control+click')
const moveAt = degrees => {
  const radians = degrees * Math.PI / 180
  inputListener({ type: 'wheelMove', x: 500 + Math.sin(radians) * 200, y: 400 - Math.cos(radians) * 200 })
  return nodes.get('wheel-slices').children.find(node => node.attributes['fill-opacity'] === '.55')?.attributes['data-sector']
}
assert.equal(moveAt(0), '0', 'north selects sector zero')
assert.equal(moveAt(27), '0', 'the old sector remains stable inside its hysteresis band')
assert.equal(moveAt(45), '1', 'crossing the boundary selects the adjacent sector')
assert.equal(moveAt(90), '2', 'a direct move to the next sector does not get stuck')
delayShow = true
inputListener({ type: 'wheelOpen', x: 500, y: 400 })
for (let attempt = 0; attempt < 5 && finishFirstShow === undefined; attempt++) await new Promise(resolve => setImmediate(resolve))
assert.equal(typeof finishFirstShow, 'function', 'first show must be pending')
inputListener({ type: 'cancel' })
inputListener({ type: 'wheelOpen', x: 500, y: 400 })
await new Promise(resolve => setImmediate(resolve))
assert.equal(nodes.get('ring').hidden, false, 'new generation must show while the older show is pending')
finishFirstShow()
await new Promise(resolve => setImmediate(resolve))
assert.equal(nodes.get('ring').hidden, false, 'a late old show must not hide the newer visible ring')
for (let cycle = 0; cycle < 10; cycle++) {
  inputListener({ type: 'wheelRelease', x: 500, y: 400 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(nodes.get('ring').hidden, true, `cycle ${cycle}: center release hides the wheel`)
  inputListener({ type: 'wheelOpen', x: 500, y: 400 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(nodes.get('ring').hidden, false, `cycle ${cycle}: the next trigger opens again`)
}
inputListener({ type: 'cancel' })
assert.equal(nodes.get('ring').hidden, true, 'cancel hides the wheel')
state.slots[1].action='revise';state.slots[1].kind='emote';state.inputs={revise:'selection'};state.sessionId='same-session';
let finishAction
context.fetch=async url=>url.endsWith('/action')?new Promise(resolve=>{finishAction=resolve}):{ok:true,json:async()=>state};
inputListener({type:'wheelOpen',x:500,y:400})
await new Promise(resolve=>setImmediate(resolve))
inputListener({type:'wheelRelease',x:700,y:200})
await new Promise(resolve=>setImmediate(resolve))
assert.equal(typeof finishAction,'function')
assert.equal(shows.at(-1).route,'wheel','动作确认前不能切页并销毁其 fetch 所属页面')
finishAction({ok:true,json:async()=>({kind:'started'})})
await new Promise(resolve=>setImmediate(resolve))
assert.equal(shows.at(-1).route,'ask')
assert.equal(shows.at(-1).feedback.image,'/fixture.png','导航和独立动画使用同一个 IPC 请求，避免切页丢失动画')
inputListener({type:'wheelOpen',manual:true,x:500,y:400})
await new Promise(resolve=>setImmediate(resolve))
assert.equal(shows.at(-1).focusable,true,'手动测试轮盘可获得焦点以操作图标')
assert.equal(shows.at(-1).clickThrough,false,'手动测试可直接点击图标，而非穿透到底层')
const manualImage=nodes.get('wheel-icons').children.find(node=>node.attributes['data-sector']==='1')
assert.equal(manualImage.attributes.role,'button')
manualImage.listeners.get('click')[0]({stopPropagation(){}})
await new Promise(resolve=>setImmediate(resolve))
assert.equal(shows.at(-1).route,'wheel','手动动作同样先等待服务确认')
finishAction({ok:true,json:async()=>({kind:'started'})})
await new Promise(resolve=>setImmediate(resolve))
assert.equal(shows.at(-1).route,'ask')
assert.ok(shows.at(-1).feedback,'手动选择沿用同一动作和反馈链')

inputListener({ type: "cancel" })
state.size = 32
inputListener({ type: "wheelOpen", x: 500, y: 400 })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(JSON.parse(JSON.stringify(shows.at(-1).bounds)), { x: 300, y: 200, width: 400, height: 400 }, "紧凑档缩小整张轮盘，命中坐标与视觉使用相同缩放")
inputListener({ type: "cancel" })

// Exercise the actual selection script, including refusal and cancelled capture.
const { register } = await import('node:module')
register(new URL('./ts-loader.mjs', import.meta.url), import.meta.url)
const { DEFAULT_SLOTS } = await import('../src/shared/assets.ts')
const { AssetResolver } = await import('../src/host/asset-resolver.ts')
const resolver = new AssetResolver(new URL('../assets/', import.meta.url).pathname)
state.slots = DEFAULT_SLOTS.map(slot => {
  const files = resolver.resolve(slot)
  return { ...slot, image: files.image.url, animation: files.animation?.url, sound: files.sound?.url }
})
state.soundEnabled = true; state.soundVolume = .7
const effects=[];let captures=0
bridge.feedback=async effect=>{effects.push(effect)}
bridge.captureSelection=async()=>{captures++;return 'cancelled'}
context.sessionStorage={setItem(){}}
for(const slot of state.slots){
  const before=effects.length
  context.fetch=async url=>{
    if(url.endsWith('/action')){
      assert.equal(effects.length,before+1,'selection acknowledgement must precede even a refused action')
      return {ok:true,json:async()=>({kind:'refused',message:'No answer yet'})}
    }
    return {ok:true,json:async()=>state}
  }
  inputListener({type:'wheelOpen',x:500,y:400})
  await new Promise(resolve=>setImmediate(resolve))
  const radians=slot.sector*45*Math.PI/180
  const pointer={x:500+Math.sin(radians)*100,y:400-Math.cos(radians)*100}
  inputListener({type:'wheelRelease',...pointer})
  await new Promise(resolve=>setImmediate(resolve))
  const result=shows.at(-1)
  assert.equal(result.route,'ask',slot.id)
  assert.equal(result.feedback.image,slot.image,slot.id)
  assert.equal(result.feedback.sound,slot.sound,slot.id)
  assert.equal(result.feedback.volume,.7)
  assert.equal(result.feedback.x,pointer.x)
  assert.equal(result.feedback.y,pointer.y)
  assert.equal(effects.length,before+(slot.action==='verify'?0:1))
  if(slot.action!=='verify')assert.equal(result.feedback.id,effects.at(-1).id,'later chat acknowledgement reuses selection id')
}
assert.equal(captures,1,'cancelled capture still acknowledges Vision and never sends a message')
console.log('actual wheel: 32px/400 DIP, all eight selections retain exact media/position; refused actions and cancelled screenshot still acknowledge selection; ten reopen/cancel cycles pass')
