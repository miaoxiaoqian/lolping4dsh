const layer=document.getElementById('layer');
const state=JSON.parse(new URL(location.href).searchParams.get('state')||'{}');
const bridge=window.__DSH_QUICK_HELP__;
const image=document.createElement('img');
image.src=state.kind==='ping'?state.image:(state.animation||state.image);
let started=false;
let audio;
function report(phase){
  if(!state.id||!state.sessionId)return;
  void fetch('/quick-help/api/media-status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:state.id,sessionId:state.sessionId,image:state.image,point:{x:state.x,y:state.y},bounds:state.bounds,phase}),keepalive:true}).catch(error=>console.warn('quick help media status:',error));
}
const decoded=image.decode().catch(async()=>{
  report('image-failed');image.src=state.image;await image.decode();
});
// Decode failures are reported immediately; the selection still opens its conversation.
void decoded.catch(()=>report('image-failed'));
async function start(generation){
  if(started||generation!==state.generation)return;
  started=true;report('visible');
  try{
    await decoded;
    if(state.kind==='ping'){
      const root=document.createElement('div');root.className='ping';root.style.setProperty('--c',state.color||'#55c5de');
      for(const className of ['ground','ring','ring r2','ring r3']){const node=document.createElement('div');node.className=className;root.append(node);}
      const art=document.createElement('div');art.className='art';const pop=document.createElement('div');pop.className='pop';pop.append(image);art.append(pop);root.append(art);layer.append(root);
    }else{
      const root=document.createElement('div');root.className='emote';root.append(image);layer.append(root);
    }
    report('image-ready');
  }catch(error){report('image-failed');console.warn('quick help feedback image:',error);}
  // An image failure must not suppress the independent sound or leave a blank panel open for 10 seconds.
  try{await bridge.feedbackReady(state.generation);}catch(error){console.warn('quick help native feedback lifetime:',error);}
  if(state.sound&&state.volume>0){
    audio=new Audio(state.sound);audio.volume=Math.max(0,Math.min(1,state.volume));
    try{await audio.play();report('audio-playing');}catch(error){report('audio-failed');console.warn('quick help feedback audio:',error);}
  }
}
// Electron initially reports a show:false document as visible. Only native show acknowledges display.
if(bridge&&typeof bridge.onFeedbackShown==='function')bridge.onFeedbackShown(generation=>{void start(generation);});
