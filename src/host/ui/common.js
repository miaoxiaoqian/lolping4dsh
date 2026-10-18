/**
 * Shared plumbing for the three overlay windows.
 *
 * Loaded first via `<script src>` in each page, so every function here is a plain
 * global on purpose. The pages are served as three separate documents with a
 * strict CSP, and a module graph would buy nothing for roughly a hundred lines.
 */

/** This plugin's own API mount point; the overlay is served from the same origin. */
const API='/quick-help/api';

/** The narrowly scoped Electron bridge installed by the desktop preload. */
const DSH=(()=>{
  const bridge=window.__DSH_QUICK_HELP__;
  const required=['environment','show','feedback','hide','focusMain','probeHotkey','configure','suspend','rendererReady','onInput','onHelperStatus'];
  if(!bridge||required.some(name=>typeof bridge[name]!=='function')){
    const message='当前桌面程序缺少轮盘接口，请更新并重启。';
    setTimeout(()=>{
      let node=document.getElementById('problem')||document.getElementById('status');
      if(node){node.textContent=message;node.hidden=false;}
      else {node=document.createElement('div');node.className='msg err';node.textContent=message;document.body.prepend(node);}
    },0);
    const fail=async()=>{throw new Error(message);};
    return Object.fromEntries(required.map(name=>[name,fail]));
  }
  return bridge;
})();

/**
 * Look an element up by id, failing loudly.
 *
 * A silent `null` here would surface as "cannot read property of null" somewhere
 * in a gesture handler, which is a miserable thing to trace back to a typo in an
 * id attribute in a different file.
 */
function el(id){
  const node=document.getElementById(id);
  if(node===null)throw new Error('quick help: missing element #'+id);
  return node;
}

/**
 * Call the plugin API.
 *
 * Errors surface as thrown Errors carrying the server's own sentence: the host
 * sends human-readable text, not a code, and swallowing it would leave the user
 * looking at a wheel that silently did nothing.
 */
async function api(path,options){
  const init=options===undefined?{}:options;
  const response=await fetch(API+path,{...init,headers:{'content-type':'application/json',...(init.headers||{})}});
  if(!response.ok){
    const body=await response.json().catch(()=>({}));
    throw new Error(body.message||body.reason||('请求失败（HTTP '+response.status+'）'));
  }
  return response.json();
}

/**
 * A fresh id for one user gesture.
 *
 * The host rejects a repeated requestId rather than running an action twice, so
 * this is generated per attempt and never derived from the payload.
 */
function requestId(){
  return 'qh-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
}

/**
 * macOS virtual key codes for the keys an accelerator may end with.
 *
 * The native helper watches one key code and reads the modifiers off each event's
 * flags, so the trigger is a single physical key and the chord is carried by the
 * flags rather than by the key code.
 *
 * The host now does this parsing and hands the page a finished `{ code, mask }`
 * from `/api/wheel`, so nothing here is on the critical path. It is kept as a
 * local preview only — the settings page shows what the user is about to bind
 * *before* saving, and that needs an answer without a round trip.
 */
const TRIGGER_VK={
  A:0,B:11,C:8,D:2,E:14,F:3,G:5,H:4,I:34,J:38,K:40,
  L:37,M:46,N:45,O:31,P:35,Q:12,R:15,S:1,T:17,U:32,
  V:9,W:13,X:7,Y:16,Z:6,
  0:29,1:18,2:19,3:20,4:21,5:23,6:22,7:26,8:28,9:24,
  SPACE:49,BACKQUOTE:50,MINUS:27,EQUAL:24,LEFTBRACKET:33,RIGHTBRACKET:30,
  BACKSLASH:42,SEMICOLON:41,QUOTE:39,COMMA:43,PERIOD:47,SLASH:44
};

/** `CGEventFlags` bits, so the local preview agrees with the host's own table. */
const MODIFIER_FLAGS={SHIFT:1<<17,CONTROL:1<<18,OPTION:1<<19,COMMAND:1<<20};

/** Spellings seen in the wild, folded onto the four flags above. */
const MODIFIER_ALIASES={
  SHIFT:'SHIFT',
  CTRL:'CONTROL',CONTROL:'CONTROL',
  ALT:'OPTION',OPT:'OPTION',OPTION:'OPTION',
  CMD:'COMMAND',COMMAND:'COMMAND',SUPER:'COMMAND',META:'COMMAND'
};

/**
 * The final key an accelerator names, or undefined when it names no known key.
 *
 * Splitting the chord out first keeps the preview and the host's parser reading the
 * string the same way; a chord ending in Return or Tab is rejected because the
 * table below deliberately omits those, not by a separate rule.
 */
function triggerOf(accelerator){
  if(typeof accelerator!=='string')return undefined;
  const parts=accelerator.split('+').map(function(part){return part.trim().toUpperCase();});
  if(parts.some(part=>part===''))return undefined;
  if(parts.length===1&&(parts[0]==='CONTROL'||parts[0]==='CTRL'))return {key:'CONTROL',code:59,modifiers:[]};
  if(parts.length===0)return undefined;
  const key=parts[parts.length-1];
  const code=TRIGGER_VK[key];
  if(code===undefined)return undefined;
  return {key:key,code:code,modifiers:parts.slice(0,-1)};
}

/**
 * Parse an accelerator for local preview, mirroring the host's `parseAccelerator`.
 *
 * @returns {{accelerator: string, key: string, code: number, mask: number}|undefined}
 */
function parseAccelerator(accelerator){
  const trigger=triggerOf(accelerator);
  if(trigger===undefined)return undefined;
  let mask=0;
  for(const raw of trigger.modifiers){
    const name=MODIFIER_ALIASES[raw];
    // An unknown modifier is a typo, not a request to ignore it — the host rejects
    // the chord, so the preview must too or it would promise a binding that is
    // silently discarded on save.
    if(name===undefined)return undefined;
    mask|=MODIFIER_FLAGS[name];
  }
  return {accelerator:accelerator,key:trigger.key,code:trigger.code,mask:mask};
}

/**
 * Play a sound or an animation.
 *
 * Every element is created fresh and self-destructs. The requirement is that each
 * trigger plays from the first frame, and reusing one element would need
 * `currentTime = 0` — which does not exist on an image, only on media elements. A
 * new element starts at zero by construction, so the same code handles both.
 */
function play(url,volume=1){
  if(typeof url!=='string'||url==='')return;
  const isSound=/\.(wav|ogg|mp3|m4a)$/i.test(url);
  const node=document.createElement(isSound?'audio':'img');
  node.className='preview-media';
  node.src=url;
  if(!isSound){node.width=180;node.alt='';}
  else node.volume=Math.max(0,Math.min(1,Number.isFinite(volume)?volume:1));
  document.body.appendChild(node);
  const remove=function(){node.remove();};
  if(isSound){
    node.addEventListener('ended',remove,{once:true});
    return node.play().then(function(){return true;},function(error){
      remove();
      throw new Error('音效播放失败：'+(error&&error.message?error.message:'浏览器拒绝了播放'));
    });
  }
  setTimeout(remove,isSound?4000:3000);
  return Promise.resolve(true);
}

/**
 * The display a point lands on, or undefined when it matches none.
 *
 * The caller decides what an unknown display means; guessing a rectangle here
 * would put the wheel somewhere the user cannot see it.
 */
function screenAt(displays,x,y){
  if(!Array.isArray(displays))return undefined;
  for(const display of displays){
    if(x>=display.x&&x<display.x+display.width&&y>=display.y&&y<display.y+display.height)return display;
  }
  return undefined;
}
