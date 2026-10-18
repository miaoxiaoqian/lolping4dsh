import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext, runInContext } from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ui = join(root, 'src', 'host', 'ui')
const buildDir = process.env.DSH_QUICK_HELP_TEST_BUILD_DIR || join(root, 'lib')
const host = readFileSync(join(buildDir, 'index.js'), 'utf8')
// Import the exact built Host bytes with test-only exports. This keeps the
// production plugin interface unchanged while exercising its embedded pages.
const probe = await import(`data:text/javascript;base64,${Buffer.from(`${host}\nexport { PAGES as __pages, SLOTS as __slots, registerRoutes as __registerRoutes, AssetResolver as __assetResolver, DEFAULT_SLOTS as __defaultSlots };`).toString('base64')}`)

const routes = new Map()
const assets = new probe.__assetResolver(join(root, 'assets'))
const dispose = probe.__registerRoutes({
  webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
  log() {},
  status: () => ({ helper: 'running', supported: true }),
  assets,
  catalogue: () => probe.__defaultSlots,
})

async function served(path) {
  const route = [...routes.values()]
    .filter(item => item.kind === 'exact' ? item.path === path : path === item.path || path.startsWith(`${item.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
  assert.ok(route, `missing route: ${path}`)
  return new Promise((resolve, reject) => {
    const headers = new Map()
    const response = {
      statusCode: 200,
      writableEnded: false,
      setHeader(name, value) { headers.set(name, value) },
      end(body) {
        this.writableEnded = true
        resolve({ status: this.statusCode, type: headers.get('content-type'), body: Buffer.from(body) })
      },
    }
    try { route.handler({ method: 'GET', url: path }, response) } catch (error) { reject(error) }
  })
}

const statusReply = await served('/quick-help/api/status')
assert.equal(statusReply.status, 200)
assert.equal(JSON.parse(statusReply.body).status.helper, 'running')

const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' }
for (const name of readdirSync(ui).sort()) {
  const extension = extname(name)
  if (!(extension in types)) continue
  const original = readFileSync(join(ui, name))
  const path = extension === '.html' ? `/quick-help/${name.slice(0, -5)}` : `/quick-help/overlay/${name}`
  const actual = await served(path)
  assert.equal(actual.status, 200, path)
  assert.equal(actual.type, types[extension], path)
  assert.deepEqual(actual.body, original, `built Host HTTP response changed ${name}`)
  if (extension === '.js') new Script(actual.body.toString('utf8'), { filename: `served/${name}` })
}

for (const slot of probe.__defaultSlots) {
  const resolved = assets.resolve(slot)
  assert.ok(resolved.image, `missing image for ${slot.id}`)
  assert.equal(resolved.missing, undefined, `missing media for ${slot.id}`)
  for (const media of [resolved.image, resolved.animation, resolved.sound].filter(Boolean)) {
    const actual = await served(media.url)
    const mime = { '.png': 'image/png', '.webp': 'image/webp', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }[extname(media.absolutePath)]
    assert.equal(actual.status, 200, media.url)
    assert.equal(actual.type, mime, media.url)
    assert.deepEqual(actual.body, readFileSync(media.absolutePath), `served media differs: ${slot.id}`)
    assert.ok(actual.body.length > 64, `empty media: ${slot.id}`)
  }
}

// Execute the built wheel document's scripts together, as the browser does.
// The fake API resolves immediately; the ready handshake must follow binding.
let listener
let ready = false
const elements = new Map()
const node = () => ({ hidden: false, children: [], attributes: {}, classList: { add() {}, remove() {} }, replaceChildren() { this.children = [] }, appendChild(child) { this.children.push(child) }, setAttribute(key, value) { this.attributes[key] = value }, removeAttribute(key) { delete this.attributes[key] } })
const context = createContext({
  window: { __DSH_QUICK_HELP__: {
    environment: async () => ({}), show: async () => {}, hide: async () => {}, focusMain: async () => {},
    probeHotkey: async () => ({}), configure: async () => {}, suspend: async () => {},
    rendererReady: async () => { assert.equal(typeof listener, 'function'); ready = true },
    feedback: async () => {},
    onInput: callback => { listener = callback }, onHelperStatus: () => {},
  }, addEventListener() {} },
  document: { getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id) }, createElementNS: node, createElement: node, addEventListener() {} },
  fetch: async () => ({ ok: true, json: async () => ({ status: { supported: true }, slots: [] }) }),
  sessionStorage: { setItem() {} }, setTimeout, console,
})
for (const name of ['common.js', 'wheel.js']) {
  const result = await served(`/quick-help/overlay/${name}`)
  runInContext(result.body.toString('utf8'), context, { filename: `served/${name}` })
}
await new Promise(resolve => setImmediate(resolve))
assert.equal(ready, true, 'built wheel did not bind input and signal rendererReady')
dispose()
console.log('built Host routes: all HTML/CSS/JS bytes match source; all eight icon, animation and sound responses match files; served JS parses; wheel signals ready')
