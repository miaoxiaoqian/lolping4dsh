/** Render the actual panel in an isolated DOM; no desktop windows or live HTTP. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const desktopRequire=createRequire(new URL('../package.json',import.meta.url))
const rootRequire=desktopRequire
const {JSDOM}=await import(pathToFileURL(rootRequire.resolve('jsdom')).href)
const reactUrl=pathToFileURL(desktopRequire.resolve('react')).href
const React=await import(reactUrl)
const {act}=React
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://isolated.invalid/'})
const original={window:globalThis.window,document:globalThis.document,navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout}
globalThis.window=dom.window;globalThis.document=dom.window.document
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true})
globalThis.IS_REACT_ACT_ENVIRONMENT=true
const {createRoot}=await import(pathToFileURL(desktopRequire.resolve('react-dom/client')).href)
const bundled=await build({entryPoints:[new URL('../src/client/panel.tsx',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',plugins:[{name:'actual-react',setup(b){b.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:pathToFileURL(desktopRequire.resolve(args.path)).href,external:true}))}}]})
const {QuickHelpPanel}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const timers=new Map();let nextTimer=1;let failure=false;let deferred;let active=0,maxActive=0;let reads=0;const paths=[]
const machine={supported:true,accessibility:true,helper:'starting',boundHotkey:'Control',defaultModelRoute:'test/model',modelAvailable:true}
const settings={hotkey:'Control',spaceGestureEnabled:false,mode:'hold',paused:false,iconSize:32,placement:'pointer',keepFocus:true,modelRoute:'',timeoutMs:120000,soundEnabled:true,soundVolume:.7}
const response=data=>({ok:true,text:async()=>JSON.stringify(data)})
globalThis.fetch=async(url,options={})=>{
 paths.push(url)
 if(url.endsWith('/status')){
  reads++;active++;maxActive=Math.max(maxActive,active)
  try{if(failure==='invalid')return response({});if(failure)throw new Error('offline');if(deferred)return await new Promise(resolve=>{deferred={resolve,signal:options.signal}});return response({status:{...machine,helper:'running'}})}finally{active--}
 }
 if(url.endsWith('/wheel'))return response({slots:[],status:{...machine}})
 if(url.endsWith('/ask'))return response({target:null})
 if(url.endsWith('/sessions'))return response({sessions:[]})
 if(url.endsWith('/settings'))return response({settings,sizes:[24,32,40]})
 throw new Error(`unexpected test request: ${url}`)
}
globalThis.setTimeout=(fn,ms,...args)=>{if(ms===1500){const id=nextTimer++;timers.set(id,fn);return id}return original.setTimeout(fn,ms,...args)}
globalThis.clearTimeout=id=>{if(timers.has(id))timers.delete(id);else original.clearTimeout(id)}
const tick=async()=>{await act(async()=>{for(let i=0;i<12;i++)await Promise.resolve()})}
const poll=async()=>{const first=timers.entries().next().value;assert.ok(first,'next poll scheduled');timers.delete(first[0]);await act(async()=>{first[1]();for(let i=0;i<12;i++)await Promise.resolve()})}
const root=createRoot(document.getElementById('root'))
try{
 await act(async()=>{root.render(React.createElement(QuickHelpPanel,{t:key=>key}));for(let i=0;i<16;i++)await Promise.resolve()})
 assert.ok(document.body.textContent.includes('helperRunning'),'starting snapshot must refresh to running without reopening page')
 assert.equal(reads,1)
 const input=document.querySelector('[aria-label="呼出轮盘快捷键"]')
 assert.ok(input)
 await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,'Control+Option+Q');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})
 await poll()
 assert.equal(input.value,'Control+Option+Q','status updates must preserve unsaved hotkey')
 assert.equal(paths.filter(p=>p.endsWith('/wheel')).length,1,'poll must not refresh target or history')
 assert.equal(paths.filter(p=>p.endsWith('/ask')).length,1)
 failure=true;await poll()
 assert.ok(document.body.textContent.includes('statusRefreshFailed'),'background failure must not silently pretend state is current')
 assert.ok(document.body.textContent.includes('helperRunning'),'last machine state stays visible')
 assert.equal(input.value,'Control+Option+Q')
 failure='invalid';await poll();assert.ok(document.body.textContent.includes('statusRefreshFailed'),'invalid reply must not crash the panel')
 failure=false;await poll()
 assert.equal(document.querySelector('[role="alert"]'),null,'error clears on recovery')
 deferred=true;await poll();assert.equal(active,1);assert.equal(timers.size,0,'slow requests must not overlap')
 const pending=deferred
 await act(async()=>root.unmount())
 assert.equal(pending.signal.aborted,true,'leaving panel cancels outstanding status request')
 pending.resolve(response({status:machine}));await tick()
 assert.equal(timers.size,0,'late completion must not schedule another poll')
 assert.equal(maxActive,1)
 console.log('actual React panel: live helper status, unsaved shortcut preservation, no history/target polling, failure/recovery, no overlap and unmount cancellation pass')
}finally{
 await act(async()=>root.unmount())
 globalThis.window=original.window;globalThis.document=original.document
 if(original.navigator)Object.defineProperty(globalThis,'navigator',original.navigator);else delete globalThis.navigator
 globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;globalThis.clearTimeout=original.clearTimeout
 delete globalThis.IS_REACT_ACT_ENVIRONMENT;dom.window.close()
}
