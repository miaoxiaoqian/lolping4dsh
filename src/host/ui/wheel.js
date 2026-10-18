const ring=el('ring'),art=el('wheel-art'),extensions=el('wheel-extensions'),sliceLayer=el('wheel-slices'),dividers=el('wheel-dividers'),icons=el('wheel-icons');
const hub=el('wheel-hub'),feedback=el('feedback'),feedbackImg=el('feedback-img');
let view=null,selected=-1,lastTick=0,anchor={x:0,y:0},opened=false,opening=false,openGeneration=0,openingPointer=null,renderScale=1,frozenTarget=null,manualMode=false;
const GEOMETRY={innerR:86,outerR:188,extR:288,iconR:137,iconSize:48};

function reportError(error,effect){
  const message=error instanceof Error?error.message:String(error);
  try{sessionStorage.setItem('quick-help.error',message);}catch{}
  void DSH.show({route:'ask',focusable:true,...effect?{feedback:effect}:{}}).catch(()=>{});
}

// At iconSize=48 this is the upstream 600×600 wheel; scale all SVG geometry together.
const SIZE=()=>Math.max(1,Math.round(600*renderScale));

async function load(){
  view=await api('/wheel');
  if(view.status&&!view.status.supported)return;
  draw();
  const centerSlot=view.slots.find(slot=>slot.action==='stop'&&slot.image);
  if(centerSlot)hub.setAttribute('href',centerSlot.image);else hub.removeAttribute('href');
  bind();
  await DSH.rendererReady();
}

function svg(tag,attrs,parent){
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
  parent.appendChild(node);
  return node;
}
const polar=(radius,degrees)=>[radius*Math.cos(degrees*Math.PI/180),radius*Math.sin(degrees*Math.PI/180)];
function sectorPath(inner,outer,start,end){
  const [x0,y0]=polar(inner,start),[x1,y1]=polar(outer,start),[x2,y2]=polar(outer,end),[x3,y3]=polar(inner,end);
  return `M${x0},${y0} L${x1},${y1} A${outer},${outer} 0 0 1 ${x2},${y2} L${x3},${y3} A${inner},${inner} 0 0 0 ${x0},${y0}Z`;
}

/** Render the original radial geometry, using the wheel's existing LoL icons. */
function draw(){
  for(const layer of [extensions,sliceLayer,dividers,icons])layer.replaceChildren();
  const ordered=[...view.slots].sort((a,b)=>a.sector-b.sector);
  for(let i=0;i<8;i++){
    const mid=-90+i*45,reach=i%2===0?GEOMETRY.extR:GEOMETRY.outerR;
    if(i%2===0)svg('path',{d:sectorPath(GEOMETRY.outerR,GEOMETRY.extR,mid-22.5,mid+22.5),fill:'url(#wheel-ext)'},extensions);
    svg('path',{d:sectorPath(GEOMETRY.innerR,reach,mid-22.5,mid+22.5),fill:'url(#wheel-hot)','fill-opacity':'0',class:'wedge','data-sector':i},sliceLayer);
    const [x0,y0]=polar(GEOMETRY.innerR,mid-22.5),[x1,y1]=polar(GEOMETRY.outerR,mid-22.5);
    svg('line',{x1:x0,y1:y0,x2:x1,y2:y1,stroke:'#a08a5c','stroke-opacity':'.45','stroke-width':'1.2'},dividers);
    const slot=ordered.find(item=>item.sector===i);
    if(slot&&slot.image){
      const [ix,iy]=polar(GEOMETRY.iconR,mid),size=GEOMETRY.iconSize*(slot.kind==='emote'?1.25:1),image=svg('image',{x:ix-size/2,y:iy-size/2,width:size,height:size,class:'wheel-icon '+(slot.kind==='emote'?'emote':'ping'),'data-sector':i},icons);
      image.setAttribute('href',slot.image);
      image.setAttribute('role','button');image.setAttribute('aria-label',slot.emoteNameZh);image.setAttribute('tabindex','0');
      image.addEventListener('click',event=>{if(!manualMode)return;event.stopPropagation();void run(slot,Number.isFinite(event.screenX)&&Number.isFinite(event.screenY)?{x:event.screenX,y:event.screenY}:{x:anchor.x,y:anchor.y});});
      image.addEventListener('keydown',event=>{if(manualMode&&(event.key==='Enter'||event.key===' ')){event.preventDefault();void run(slot,{x:anchor.x,y:anchor.y});}});
      if(slot.missing)image.setAttribute('opacity','.45');
    }
  }
}

function tick(){const now=Date.now();if(now-lastTick<120)return;lastTick=now;if(view&&view.soundEnabled&&view.tick)void play(view.tick,view.soundVolume).catch(reportError);}
function highlight(sector){
  if(sector===selected)return;
  if(selected>=0){const previous=sliceLayer.querySelector('[data-sector="'+selected+'"]');if(previous)previous.setAttribute('fill-opacity','0');const icon=icons.querySelector('[data-sector="'+selected+'"]');if(icon)icon.classList.remove('hot');}
  selected=sector;
  if(sector<0)return;
  const slot=view.slots.find(item=>item.sector===sector);
  if(!slot)return;
  const wedge=sliceLayer.querySelector('[data-sector="'+sector+'"]');if(wedge)wedge.setAttribute('fill-opacity','.55');
  const icon=icons.querySelector('[data-sector="'+sector+'"]');if(icon)icon.classList.add('hot');
  tick();
}

/** Scale for the selected display, shrinking only when needed to keep the whole ring visible. */
function scaleFor(display){
  const requested=(view&&view.size?view.size:32)/GEOMETRY.iconSize;
  const fit=Math.min(display.width/600,display.height/600);
  return Math.max(.25,Math.min(requested,fit));
}

/** Open the wheel centred on the pointer and keep the full silhouette on-screen. */
async function openAt(x,y,generation){
  try{
    const env=await DSH.environment();
    if(generation!==openGeneration)return;
    const display=screenAt(env.displays,x,y)||{x:0,y:0,width:1440,height:900};
    renderScale=scaleFor(display);
    const box=SIZE();
    let left=x-box/2,top=y-box/2;
    if(left<display.x)left=display.x;if(top<display.y)top=display.y;
    if(left+box>display.x+display.width)left=display.x+display.width-box;
    if(top+box>display.y+display.height)top=display.y+display.height-box;
    left=Math.round(left);top=Math.round(top);
    anchor={x:left+box/2,y:top+box/2};
    ring.hidden=false;ring.classList.remove('open');selected=-1;
    await DSH.show({route:'wheel',bounds:{x:left,y:top,width:box,height:box},focusable:manualMode,clickThrough:view.mode==='hold'&&!manualMode});
    // A stale show completion must never mutate the shared DOM: a newer wheel may
    // already be visible in this same window.
    if(generation!==openGeneration)return;
    // A hidden BrowserWindow may suspend animation frames. Show it before
    // scheduling the first frame, and never make visibility depend on that frame.
    requestAnimationFrame(()=>{if(generation===openGeneration)ring.classList.add('open');});
    opened=true;opening=false;
    if(openingPointer!==null){highlight(sectorOf(openingPointer.x,openingPointer.y));openingPointer=null;}
  }catch(error){
    if(generation!==openGeneration)return;
    opened=false;opening=false;ring.hidden=true;
    try{await DSH.hide('wheel');}catch(hideError){console.warn('quick help: could not hide a failed wheel open',hideError);}
    reportError(error);
  }
}

function close(){
  if(!opened&&!opening)return;
  openGeneration++;opening=false;openingPointer=null;opened=false;
  ring.classList.remove('open');ring.hidden=true;feedback.hidden=true;selected=-1;
  void DSH.hide('wheel').catch(reportError);
}

/** Finish the acknowledgement before navigating away from the page owning its fetch. */
async function run(slot,pointer){
  const input=(view.inputs||{})[slot.action]||'none';
  if(slot.missing){reportError(slot.missing);return;}
  const effect={id:requestId(),sessionId:view.sessionId,kind:slot.kind,image:slot.image,animation:slot.animation||undefined,sound:view.soundEnabled?slot.sound||undefined:undefined,volume:view.soundVolume,x:pointer.x,y:pointer.y};
  // This acknowledges the selection, independently of whether the business action can run.
  close();
  if(slot.action!=='verify'){try{await DSH.feedback(effect);}catch(error){console.warn('quick help selection media:',error);}}
  if(slot.action==='ask'){
    await DSH.show({route:'ask',focusable:true,feedback:effect});
    return;
  }
  if(slot.action==='verify'){
    try{await DSH.captureSelection(view.sessionId);}
    catch(error){sessionStorage.setItem('quick-help.error',error instanceof Error?error.message:String(error));}
    await DSH.show({route:'ask',focusable:true,feedback:effect});
    return;
  }
  try{
    const result=await api('/action',{method:'POST',body:JSON.stringify({action:slot.action,requestId:effect.id,text:'',sessionId:frozenTarget?.sessionId||view.sessionId||'',targetToken:frozenTarget?.versionToken||''})});
    if(result.kind==='refused'||result.kind==='failed'){reportError(result.message,effect);return;}
    const accepted=true;
    if(result.kind==='noop'&&result.message)sessionStorage.setItem('quick-help.notice',result.message);
    await DSH.show({route:'ask',focusable:true,...accepted?{feedback:effect}:{}});
  }catch(error){reportError(error,effect);}
}

function bind(){
  DSH.onInput(event=>{
    if(event.type==='wheelOpen'){
      manualMode=event.manual===true;
      opening=true;openingPointer=null;const generation=++openGeneration;
      void refreshTargetAndOpen(event.x||0,event.y||0,generation);return;
    }
    if(event.type==='wheelMove'){if(opening){openingPointer={x:event.x,y:event.y};return;}if(opened)highlight(sectorOf(event.x,event.y));return;}
    if(event.type==='wheelRelease'){if(opening){close();return;}if(!opened)return;const slot=view&&view.slots.find(item=>item.sector===sectorOf(event.x,event.y));if(slot)void run(slot,{x:event.x,y:event.y});else close();return;}
    if(event.type==='cancel'){close();return;}
    if(event.type==='error')reportError(event.message||'输入助手出错。');
  });
}

async function refreshTargetAndOpen(x,y,generation){
  try{
    const latest=await api('/wheel');
    if(generation!==openGeneration)return;
    view=latest;
    frozenTarget=latest.target?Object.freeze({...latest.target}):null;
    draw();
    const centerSlot=view.slots.find(slot=>slot.action==='stop'&&slot.image);
    if(centerSlot)hub.setAttribute('href',centerSlot.image);else hub.removeAttribute('href');
    await openAt(x,y,generation);
  }catch(error){
    if(generation!==openGeneration)return;
    frozenTarget=null;opening=false;reportError(error);
  }
}

const HYSTERESIS_DEG=6;
function sectorOf(x,y){
  if(!view)return -1;
  const dx=x-anchor.x,dy=y-anchor.y;
  if(Math.hypot(dx,dy)<GEOMETRY.innerR*renderScale)return -1;
  const deg=(Math.atan2(dy,dx)*180/Math.PI+450)%360,slice=45;
  let index=Math.floor((deg+slice*.5)/slice)%8;
  if(selected<0)return index;
  const band=slice*.5+HYSTERESIS_DEG,fromPrevious=angleDiff(deg,selected*slice);
  return Math.abs(fromPrevious)<=band?selected:index;
}
function angleDiff(a,b){let difference=a-b;while(difference>180)difference-=360;while(difference<-180)difference+=360;return difference;}
document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
document.addEventListener('pointermove',event=>{if(manualMode&&opened)highlight(sectorOf(event.screenX,event.screenY));});
document.addEventListener('click',event=>{if(!manualMode||!opened)return;const slot=view.slots.find(item=>item.sector===sectorOf(event.screenX,event.screenY));if(slot)void run(slot,{x:event.screenX,y:event.screenY});else close();});
window.addEventListener('blur',()=>close());
void load();
