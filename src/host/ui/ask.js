const log=el('log'),input=el('input'),sendBtn=el('send'),stopBtn=el('stop'),copyBtn=el('copy'),pinBtn=el('pin');
const statusEl=el('status'),banner=el('banner'),problem=el('problem'),taskEl=el('task'),routeEl=el('route');
let state=null,busy=false,composing=false,draftTimer=0,lastAnswer='',requestInFlight=false,suppressBlurHide=false;
let pendingImage='',imageSessionId='',capturing=false;
let dragging=false;
const header=document.querySelector('header');
header.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.target.closest('button')||typeof DSH.dragWindow!=='function')return;
  event.preventDefault();dragging=true;header.setPointerCapture(event.pointerId);void DSH.dragWindow('start');
});
header.addEventListener('pointermove',()=>{if(dragging)void DSH.dragWindow('move');});
for(const name of ['pointerup','pointercancel','lostpointercapture'])header.addEventListener(name,()=>{
  if(!dragging)return;dragging=false;void DSH.dragWindow('end');
});

function renderAttachment(){
  el('attachment').hidden=!pendingImage;
  el('attachment-image').src=pendingImage;
}

async function loadCapture(){
  if(typeof DSH.readCapture!=='function')return;
  const data=await DSH.readCapture(state.sessionId);
  if(data){pendingImage=data;imageSessionId=state.sessionId;renderAttachment();}
}

async function capture(){
  if(capturing||requestInFlight)return;
  capturing=true;suppressBlurHide=true;
  try{
    if(typeof DSH.captureSelection!=='function')throw new Error('当前桌面版本尚未提供截图接口，请更新桌面程序。');
    await flushDraft();
    await DSH.captureSelection(state.sessionId);
    await loadCapture();
  }catch(error){problem.textContent=error instanceof Error?error.message:String(error);problem.hidden=false;}
  finally{capturing=false;await DSH.show({route:'ask',focusable:true,clickThrough:false});suppressBlurHide=false;}
}

function showDeferredError(){
  let message='';
  try{message=sessionStorage.getItem('quick-help.error')||'';sessionStorage.removeItem('quick-help.error');}catch{}
  if(message){problem.textContent=message;problem.hidden=false;}
}

function playFeedback(url){
  if(!url)return;
  const isSound=/\.(wav|ogg|mp3|m4a)$/i.test(url);
  if(isSound&&state&&state.soundEnabled===false)return;
  void Promise.resolve(play(url,isSound&&state?state.soundVolume:1)).catch(error=>{
    problem.textContent=error instanceof Error?error.message:String(error);
    problem.hidden=false;
  });
}

async function load(){
  const first=state===null;
  state=await api('/ask');
  render();
  input.value=state.draft||'';
  pinBtn.textContent=state.pinned?'已固定':'固定';
  pinBtn.setAttribute('aria-pressed',String(!!state.pinned));
  pinBtn.title=state.pinned?'取消固定窗口':'固定窗口';
  if(first)await placeAskWindow();
  if(first)await loadCapture();
  showDeferredError();
  // Play whatever the wheel queued for this gesture, once per window opening.
  // `load()` also runs after a send, and the host has already drained the media by
  // then — an animation firing twice reads as the action running twice, which is
  // the exact confusion the requestId guard exists to prevent.
  // Action media belongs to the separate click-through feedback window.
  // Only autofocus when the window is actually going to take focus, which it is
  // for the ask window; the wheel never gets here.
  input.focus();
}

async function placeAskWindow(){
  const env=await DSH.environment();
  const displays=env.displays||[];
  const pointer=env.cursor||{x:0,y:0};
  let display=displays.find(d=>pointer.x>=d.x&&pointer.x<d.x+d.width&&pointer.y>=d.y&&pointer.y<d.y+d.height)||displays[0];
  if(!display)return;
  const width=360,height=400;
  let x=state.placement==='center'?display.x+(display.width-width)/2:pointer.x+18;
  let y=state.placement==='center'?display.y+(display.height-height)/2:pointer.y+18;
  x=Math.round(Math.max(display.x,Math.min(x,display.x+display.width-width)));
  y=Math.round(Math.max(display.y,Math.min(y,display.y+display.height-height)));
  suppressBlurHide=true;
  try{await DSH.show({route:'ask',bounds:{x,y,width,height},focusable:true,clickThrough:false});}
  finally{setTimeout(()=>{suppressBlurHide=false;},300);}
}

async function refreshWhileBusy(){
  if(!state||requestInFlight)return;
  try{
    const next=await api('/ask');
    if(next.sessionId!==state.sessionId)return;
    const scrollTop=log.scrollTop;
    state={...state,...next};
    pinBtn.textContent=state.pinned?'已固定':'固定';
    pinBtn.setAttribute('aria-pressed',String(!!state.pinned));
    render(false);
    log.scrollTop=scrollTop;
    showDeferredError();
  }catch(error){console.warn('quick help: could not refresh the session view',error);}
}

/** Draw the conversation. */
function render(autoScroll=true){
  const scrollTop=log.scrollTop;
  log.innerHTML='';
  for(const t of state.turns){
    const d=document.createElement('div');d.className='turn '+(t.feedback?'feedback':t.role);
    const b=document.createElement('div');b.className='body';b.textContent=t.text||(t.streaming?'…':'');
    d.appendChild(b);
    for(const image of t.images||[]){const img=document.createElement('img');img.className='screenshot';img.alt=image.name||'截图';img.src=image.url;d.appendChild(img);}
    if(t.error){const e=document.createElement('div');e.className='msg err';e.textContent=t.error;d.appendChild(e);}
    if(t.role==='assistant')lastAnswer=t.text||lastAnswer;
    log.appendChild(d);
  }
  log.scrollTop=autoScroll?log.scrollHeight:scrollTop;
  taskEl.textContent=state.target?(state.target.artifactLabel||'快捷问答'):'快捷问答';
  routeEl.textContent=state.modelRoute||'未配置模型';
  busy=state.busy;
  sendBtn.hidden=busy||!!state.modelUnavailable;
  stopBtn.hidden=!busy;
  copyBtn.hidden=lastAnswer==='';
  sendBtn.textContent='发送';
  const notes=[];
  if(state.adopted)notes.push('已采纳这条回答');
  if(state.running)notes.push(({revise:'不满意，正在改进…',explain:'正在换一种方式解释…',continue:'正在继续…',save:'正在整理成果…',verify:'正在核查…'})[state.running]||'正在处理…');
  if(state.queued)notes.push('排队中 '+state.queued+' 项');
  if(state.stopped)notes.push('已停止，需按「正在路上」继续');
  statusEl.textContent=notes.join(' · ');
  if(state.actionError){problem.textContent=state.actionError;problem.hidden=false;}
  banner.hidden=!state.modelUnavailable;
  if(state.modelUnavailable)banner.textContent=state.modelUnavailable;
}

/** Persist one captured draft to the Session it belonged to. */
async function persistDraft(sessionId,text){
  if(!sessionId)return;
  await api('/draft',{method:'POST',body:JSON.stringify({sessionId,draft:text})});
}

/** Save the current draft while keeping its owning Session fixed. */
function saveDraft(){
  const sessionId=state&&state.sessionId;
  const text=input.value;
  clearTimeout(draftTimer);
  draftTimer=setTimeout(()=>{
    draftTimer=0;
    void persistDraft(sessionId,text).catch(error=>{problem.textContent=error instanceof Error?error.message:String(error);problem.hidden=false;});
  },400);
}

/** Flush before a route or Session change can replace the captured owner. */
async function flushDraft(){
  clearTimeout(draftTimer);draftTimer=0;
  const sessionId=state&&state.sessionId;
  await persistDraft(sessionId,input.value);
}

window.addEventListener('pagehide',()=>{
  const sessionId=state&&state.sessionId;
  if(!sessionId)return;
  void fetch(API+'/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,draft:input.value}),keepalive:true});
});

async function submit(){
  if(busy)return;
  if(pendingImage&&imageSessionId!==state.sessionId){problem.textContent='截图所属会话已变化，请重新框选。';problem.hidden=false;return;}
  const text=input.value.trim()||(pendingImage?'请根据这张截图解释我看到的内容，指出关键问题；看不清的地方请明确说明。':'');
  if(text==='')return;
  const submitSessionId=state.sessionId;
  const capturedImage=pendingImage;
  requestInFlight=true;sendBtn.hidden=true;stopBtn.hidden=false;statusEl.textContent='正在回答…';
  // Echo the user's own words immediately. Waiting for the round trip would
  // leave the box looking like nothing happened.
  const optimistic={turns:[...(state.turns||[]),{role:'user',text,at:Date.now()}],busy:true};
  state={...state,...optimistic};render();
  await flushDraft().catch(error=>{problem.textContent=error instanceof Error?error.message:String(error);problem.hidden=false;});
  input.value='';
  try{
    const images=capturedImage?[{type:'image',mediaType:'image/png',data:capturedImage.replace(/^data:image\/png;base64,/,''),name:'屏幕截图.png'}]:[];
    const r=await fetch(API+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,images,sessionId:submitSessionId})});
    if(!r.ok||!r.body){const e=await r.json().catch(()=>({message:'请求失败'}));throw new Error(e.message||'请求失败');}
    const reader=r.body.getReader();const dec=new TextDecoder();let buf='';
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      buf+=dec.decode(value,{stream:true});
      let i;
      while((i=buf.indexOf('\n\n'))>=0){
        const raw=buf.slice(0,i);buf=buf.slice(i+2);
        const event=raw.split(/\r?\n/).find(line=>line.startsWith('event:'))?.slice(6).trim();
        const payload=raw.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
        if(event==='done'){
          const data=JSON.parse(payload||'{}');
          state={...state,turns:data.turns||[],target:data.target,busy:false};
          pendingImage='';imageSessionId='';renderAttachment();
          if(typeof DSH.discardCapture==='function')await DSH.discardCapture();
          requestInFlight=false;render();return;
        }
        if(event==='update'){
          const data=JSON.parse(payload||'{}');
          const turns=[...(state.turns||[])];
          const index=turns.findIndex(t=>t.role==='assistant'&&t.streaming);
          if(index>=0)turns[index]=data.turn;
          else turns.push(data.turn);
          state={...state,turns,busy:true};render();
        }
        if(event==='error'){
          const data=JSON.parse(payload||'{}');
          problem.textContent=data.message||'执行失败';problem.hidden=false;
        }
      }
    }
  }catch(e){
    problem.textContent=e instanceof Error?e.message:String(e);problem.hidden=false;
  }
  requestInFlight=false;
  await load();
}

input.addEventListener('input',saveDraft);
input.addEventListener('compositionstart',()=>{composing=true;});
input.addEventListener('compositionend',()=>{composing=false;});
input.addEventListener('keydown',e=>{
  // `isComposing` is the reliable signal; the keyCode fallback covers Safari and
  // the Electron versions where the composition events are late.
  if(e.key==='Enter'&&!e.shiftKey&&!composing&&!e.isComposing&&e.keyCode!==229){
    e.preventDefault();void submit();
  }
});

sendBtn.addEventListener('click',()=>void submit());
stopBtn.addEventListener('click',async()=>{
  const r=await api('/stop',{method:'POST',body:JSON.stringify({})});
  problem.hidden=true;banner.hidden=false;banner.className='msg warn';banner.textContent=r.message;banner.hidden=false;
  await load();
});
copyBtn.addEventListener('click',async()=>{await navigator.clipboard.writeText(lastAnswer);banner.hidden=false;banner.className='msg';banner.textContent='已复制最后一条回答。';setTimeout(()=>{banner.hidden=true;},1600);});
el('new').addEventListener('click',async()=>{try{await flushDraft();await api('/new',{method:'POST',body:'{}'});pendingImage='';imageSessionId='';renderAttachment();if(typeof DSH.discardCapture==='function')await DSH.discardCapture();await load();input.focus();}catch(error){problem.textContent=error instanceof Error?error.message:String(error);problem.hidden=false;}});
el('capture').addEventListener('click',()=>void capture());
el('upload').addEventListener('click',()=>el('image-file').click());
el('image-file').addEventListener('change',async()=>{
  const file=el('image-file').files?.[0];if(!file)return;
  try{
    if(file.type!=='image/png'||file.size>20*1024*1024)throw new Error('请选择不超过20 MB的 PNG 图片。');
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败。'));reader.readAsDataURL(file);});
    pendingImage=String(data);imageSessionId=state.sessionId;
    if(typeof DSH.stageCapture==='function')await DSH.stageCapture(imageSessionId,pendingImage);
    renderAttachment();
  }catch(error){problem.textContent=error instanceof Error?error.message:String(error);problem.hidden=false;}
});
el('remove-image').addEventListener('click',async()=>{pendingImage='';imageSessionId='';renderAttachment();if(typeof DSH.discardCapture==='function')await DSH.discardCapture();});
pinBtn.addEventListener('click',async()=>{try{await flushDraft();const r=await api('/pin',{method:'POST',body:JSON.stringify({sessionId:state.sessionId,pinned:!state.pinned})});state={...state,pinned:r.pinned};pinBtn.textContent=state.pinned?'已固定':'固定';pinBtn.setAttribute('aria-pressed',String(!!state.pinned));pinBtn.title=state.pinned?'取消固定窗口':'固定窗口';}catch(error){problem.textContent=error instanceof Error?error.message:String(error);problem.hidden=false;}});
el('settings').addEventListener('click',async()=>{try{await flushDraft();suppressBlurHide=true;await DSH.show({route:'settings',focusable:true,clickThrough:false});setTimeout(()=>{suppressBlurHide=false;},300);}catch(e){problem.textContent=e instanceof Error?e.message:String(e);problem.hidden=false;}});
el('close').addEventListener('click',async()=>{try{await flushDraft();await DSH.hide('ask');}catch(e){problem.textContent=e instanceof Error?e.message:String(e);problem.hidden=false;}});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    // Hide and keep the draft. Closing would throw the user's typing away, which
    // is the one thing a window that is meant to be summoned constantly must not do.
    e.preventDefault();void flushDraft().then(()=>DSH.hide('ask')).catch(error=>{problem.textContent=error instanceof Error?error.message:String(error);problem.hidden=false;});
  }
});
window.addEventListener('blur',()=>{if(!suppressBlurHide&&state&&!state.keepFocus&&!state.pinned)void flushDraft().then(()=>DSH.hide('ask')).catch(error=>{problem.textContent=error instanceof Error?error.message:String(error);problem.hidden=false;});});
void load();
setInterval(()=>void refreshWhileBusy(),900);
