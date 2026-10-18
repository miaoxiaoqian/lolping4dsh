import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { createContext, runInContext } from 'node:vm'
register(new URL('./ts-loader.mjs', import.meta.url), import.meta.url)
const { DEFAULT_SLOTS } = await import('../src/shared/assets.ts')
const { AssetResolver } = await import('../src/host/asset-resolver.ts')
const { MediaStatus } = await import('../src/host/media-status.ts')
const source = readFileSync(new URL('../src/host/ui/feedback.js', import.meta.url), 'utf8')
const resolver = new AssetResolver(new URL('../assets/', import.meta.url).pathname)
const tick = async () => { for(let i=0;i<8;i++) await Promise.resolve() }
async function scenario(slot, options={}) {
  const media=resolver.resolve(slot)
  const state={id:`test-${slot.id}`,sessionId:'own-session',generation:7,kind:slot.kind,image:media.image.url,animation:media.animation?.url,sound:media.sound?.url,volume:.5,x:500,y:400,bounds:{x:420,y:320,width:160,height:160}}
  const layer={children:[],append(node){this.children.push(node)}}
  const reports=[];const audios=[];const ready=[];let shown;let decode;let attempts=0
  const image={src:'',decode(){attempts++;if(options.imageFailure&&(attempts===1||options.imageFailure==='all'))return Promise.reject(new Error('decode failed'));return attempts===1?new Promise(resolve=>{decode=resolve}):Promise.resolve()}}
  const context=createContext({
    window:{__DSH_QUICK_HELP__:{onFeedbackShown(fn){shown=fn},async feedbackReady(generation){ready.push(generation)}}},
    document:{hidden:false,getElementById:()=>layer,createElement(tag){return tag==='img'?image:{children:[],style:{setProperty(){}},append(...nodes){this.children.push(...nodes)}}}},
    location:{href:`https://test/quick-help/feedback?state=${encodeURIComponent(JSON.stringify(state))}`},URL,
    Audio:class{constructor(url){this.url=url;audios.push(this)}async play(){if(options.audioFailure)throw new Error('audio failed')}},
    fetch:async(_url,request)=>{reports.push(JSON.parse(request.body));return{ok:true}},console:{warn(){}}
  })
  runInContext(source,context)
  await tick()
  assert.equal(layer.children.length,0,'hidden native window must not start CSS animation even if document.hidden=false')
  assert.equal(audios.length,0)
  shown(6);await tick();assert.equal(layer.children.length,0,'stale native acknowledgement ignored')
  shown(7);await tick()
  if(!options.imageFailure){assert.equal(layer.children.length,0,'visible window waits for delayed decode');assert.equal(ready.length,0);decode()}
  await tick()
  assert.equal(layer.children.length,options.imageFailure==='all'?0:1,slot.id)
  if(options.imageFailure!=='all')assert.equal(layer.children[0].className,slot.kind)
  assert.deepEqual(ready,[7])
  assert.equal(audios.length,1)
  assert.equal(audios[0].url,media.sound.url)
  assert.equal(audios[0].volume,.5)
  assert.ok(reports.some(r=>r.phase==='visible'))
  assert.equal(reports.some(r=>r.phase==='image-ready'),options.imageFailure!=='all')
  assert.ok(reports.some(r=>r.phase===(options.audioFailure?'audio-failed':'audio-playing')))
  if(options.imageFailure){assert.equal(image.src,media.image.url);assert.ok(reports.some(r=>r.phase==='image-failed'))}
  shown(7);await tick();assert.equal(audios.length,1,'duplicate native show cannot restart sound');assert.equal(layer.children.length,options.imageFailure==='all'?0:1)
  return reports
}
for(const slot of DEFAULT_SLOTS)for(let repeat=0;repeat<3;repeat++)await scenario(slot)
await scenario(DEFAULT_SLOTS[1],{imageFailure:true})
await scenario(DEFAULT_SLOTS[0],{audioFailure:true})
await scenario(DEFAULT_SLOTS[1],{imageFailure:'all'})
const dir=mkdtempSync(join(tmpdir(),'dsh-media-'))
try{
  const path=join(dir,'media.json');const store=new MediaStatus(path)
  const reports=await scenario(DEFAULT_SLOTS[0])
  for(const report of reports)assert.equal(store.report(report),true)
  assert.deepEqual(store.latest('own-session').phases.map(p=>p.phase),['visible','image-ready','audio-playing'])
  assert.equal(store.error('own-session'),undefined)
  assert.equal(store.latest('other-session'),undefined)
  assert.equal(statSync(path).mode&0o777,0o600)
  assert.equal(store.report({...reports[0],id:'new',phase:'visible'}),true)
  assert.equal(store.report({...reports[0],phase:'audio-failed'}),true)
  assert.equal(store.latest('own-session').id,'new','late reports cannot replace a newer choice')
  assert.equal(store.error('own-session'),undefined)
  assert.equal(store.report({...reports[0],id:'new',sessionId:'other'}),false)
  assert.equal(store.report({...reports[0],point:{x:NaN,y:0}}),false)
  assert.equal(store.report({...reports[0],image:'/private/file.png'}),false)
  assert.equal(store.report({...reports[0],phase:'invented'}),false)
  assert.equal(store.report({...reports[0],id:'new',phase:'audio-failed'}),true)
  assert.match(store.error('own-session'),/音效/)
  assert.equal(store.report({...reports[0],id:'new',phase:'image-failed'}),true)
  assert.match(store.error('own-session'),/动画和音效/)
  for(let i=0;i<25;i++)store.report({...reports[0],id:`bounded-${i}`})
  assert.equal(JSON.parse(readFileSync(path,'utf8')).length,16)
}finally{rmSync(dir,{recursive:true,force:true})}
console.log('feedback: all eight slots repeated 3 times; hidden/delayed/stale/duplicate playback, fallback, failure and bounded private diagnostics pass')
