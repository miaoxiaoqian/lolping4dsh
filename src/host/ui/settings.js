const problem=el('problem'),okBox=el('ok'),statusEl=el('status'),slotsEl=el('slots'),poolEl=el('pool');
let data=null,dirty=false;

async function load(){
  data=await api('/settings');
  el('hotkey').value=data.settings.hotkey;
  el('spacegesture').checked=data.settings.spaceGestureEnabled===true;
  el('askhotkey').value=data.settings.askHotkey;
  el('mode').value=data.settings.mode;
  el('placement').value=data.settings.placement;
  el('paused').checked=data.settings.paused;
  el('keepfocus').checked=data.settings.keepFocus;
  el('soundenabled').checked=data.settings.soundEnabled!==false;
  el('soundvolume').value=String(data.settings.soundVolume??0.7);
  el('recordspath').value=data.storage?.recordsPath||'';
  const size=el('size');size.innerHTML='';
  for(const s of data.sizes){const o=document.createElement('option');o.value=String(s);o.textContent=s+' px';if(s===data.settings.iconSize)o.selected=true;size.appendChild(o);}
  // The host's own complaint about the stored chord, shown without waiting for a
  // save: a binding that silently never fires is the failure this prevents.
  if(data.hotkeyProblem){problem.textContent=data.hotkeyProblem;problem.hidden=false;}
  renderSlots();renderPool();renderStatus();
}

function renderStatus(){
  const s=data.status;
  const notes=[];
  notes.push(s.supported?'平台支持：macOS':'平台不支持：仅 macOS 可用');
  notes.push(s.helper==='running'?'输入助手：运行中':s.helper==='no-access'?'输入助手：缺少辅助功能权限':s.helper==='crashed'?'输入助手：已崩溃':s.helper==='starting'?'输入助手：启动中':'输入助手：未运行');
  if(s.boundHotkey)notes.push('系统已接受：'+s.boundHotkey);
  if(data.settings.hotkey.trim().toLowerCase()==='space'&&!data.settings.spaceGestureEnabled&&!data.settings.paused)notes.push('裸空格手势已关闭');
  if(s.modelAvailable)notes.push('模型：'+(s.defaultModelRoute||'已配置'));
  else notes.push('模型：未配置，无法提问');
  statusEl.textContent=notes.join(' · ');
}

function renderSlots(){
  slotsEl.innerHTML='';
  for(const slot of data.wheel){
    const row=document.createElement('div');row.className='slotrow';
    const img=document.createElement('img');img.src=slot.image||'';img.alt=slot.emoteNameZh;row.appendChild(img);
    const mid=document.createElement('div');mid.className='grow';
    const t=document.createElement('div');t.textContent=slot.emoteNameZh+'（'+slot.emoteName+'）';
    const h=document.createElement('small');h.className='dim';h.textContent=slot.hover;mid.appendChild(t);mid.appendChild(h);
    row.appendChild(mid);
    if(slot.missing){const w=document.createElement('span');w.className='msg err';w.textContent='素材缺失';row.appendChild(w);}
    if(slot.animation)row.appendChild(btn('预览',()=>{playPreview(slot.animation);playPreview(slot.sound);}));
    if(slot.sound)row.appendChild(btn('试听',()=>playPreview(slot.sound)));
    slotsEl.appendChild(row);
  }
}

/** The optional pool. Preview only: nothing here is a command until bound. */
function renderPool(){
  poolEl.innerHTML='';
  const bound=new Set(data.wheel.map(s=>s.image));
  for(const slot of data.catalogue){
    if(slot.sector>=0||bound.has(slot.image))continue;
    const row=document.createElement('div');row.className='slotrow';
    const img=document.createElement('img');img.src=slot.image||'';img.alt=slot.emoteNameZh;row.appendChild(img);
    const mid=document.createElement('div');mid.className='grow';
    const t=document.createElement('div');t.textContent=slot.emoteNameZh;
    const h=document.createElement('small');h.className='dim';h.textContent=slot.hover;mid.appendChild(t);mid.appendChild(h);
    row.appendChild(mid);
    row.appendChild(btn('预览',()=>{playPreview(slot.animation);playPreview(slot.sound);}));
    poolEl.appendChild(row);
  }
}

function playPreview(url){
  if(!url)return;
  const isSound=/\.(wav|ogg|mp3|m4a)$/i.test(url);
  if(isSound&&data&&data.settings.soundEnabled===false)return;
  void Promise.resolve(play(url,isSound&&data?data.settings.soundVolume:1)).catch(error=>{
    problem.textContent=error instanceof Error?error.message:String(error);
    problem.hidden=false;
  });
}

function btn(text,fn){const b=document.createElement('button');b.type='button';b.className='small';b.textContent=text;b.addEventListener('click',fn);return b;}

/**
 * Save, and report what the OS actually did.
 *
 * The order is deliberate. The settings are persisted first, because that is the
 * part this page owns; only then is the chord probed and pushed to the helper. A
 * chord the system refuses is the one failure the user must see, since a saved
 * preference that silently never fires is worse than an error.
 */
async function save(){
  problem.hidden=true;okBox.hidden=true;
  const typed=el('hotkey').value.trim();
  const body={
    ...data.settings,
    hotkey:typed,
    spaceGestureEnabled:el('spacegesture').checked,
    mode:el('mode').value,
    iconSize:Number(el('size').value),
    placement:el('placement').value,
    paused:el('paused').checked,
    keepFocus:el('keepfocus').checked,
    soundEnabled:el('soundenabled').checked,
    soundVolume:Number(el('soundvolume').value),
    recordsPath:el('recordspath').value,
  };
  const r=await api('/settings',{method:'PUT',body:JSON.stringify(body)});
  data.settings=r.settings;

  // The host validates too, and may have kept the default instead of what was
  // typed. Say so plainly rather than showing the rejected value as accepted.
  if(r.settings.hotkey!==typed){
    problem.textContent=r.hotkeyProblem||('「'+typed+'」不是可用的快捷键，已保留 '+r.settings.hotkey+'。');
    problem.hidden=false;
    await load();
    return;
  }

  // Probe, do not claim. The wheel watches keys through the input helper and lets
  // everything through that is not an exact match, so it never takes the
  // combination away from another application. This only asks whether someone else
  // already has it, then releases it immediately.
  const probe=await DSH.probeHotkey(r.settings.hotkey);
  if(!probe.available){
    problem.textContent='该组合已被其他应用占用：'+r.settings.hotkey
      +'。轮盘不会抢占它，但两者会同时响应；建议换一个组合。';
    problem.hidden=false;
  }

  // Push the parsed chord to the helper. `trigger` comes from the host so the
  // virtual-key table lives in exactly one place.
  const trigger=r.trigger;
  if(!trigger){
    problem.textContent='无法把「'+r.settings.hotkey+'」解析成按键，轮盘不会响应。';
    problem.hidden=false;
  }else{
    // Numbers, not booleans. The helper reads this line with `sscanf` and `%d`,
    // which stops dead on the `t` of `true` — so a boolean here would silently
    // truncate the message and leave later fields at their defaults. That is how
    // "按住选择" ended up never working: `holdMode` was the first field lost.
    await DSH.configure({
      triggerVk:trigger.code,
      modifierMask:trigger.mask,
      holdMode:r.settings.mode==='hold'?1:0,
      dragThreshold:12,
      watchdogMs:12000,
      enabled:r.settings.paused||(r.settings.hotkey.trim().toLowerCase()==='space'&&!r.settings.spaceGestureEnabled)?0:1,
    });
    // A chord with no modifiers means the key itself stops reaching applications,
    // because there is nothing to distinguish the trigger from ordinary typing.
    // Allowed, since the user may genuinely want it, but stated plainly rather than
    // presented as a success.
    if(!r.settings.paused && !trigger.mask && trigger.key!=='CONTROL' && !(r.settings.hotkey.trim().toLowerCase()==='space'&&!r.settings.spaceGestureEnabled)){
      problem.textContent='已保存，但 '+trigger.label+' 因此不再输入字符——没有修饰键就没有办法区分「唤出轮盘」和「正常打字」。'
        +'如果这不是你想要的，建议加上 Control+Option。';
      problem.hidden=false;
    }else if(problem.hidden){
      okBox.textContent=trigger.key==='CONTROL'
        ? '已保存。按住 Control 并移动鼠标打开轮盘，松开确认；单按及 Control 组合键照常使用。'
        : '已保存。只有按住 '+trigger.label+' 时轮盘才会出现；单独按下 '+trigger.key+' 仍然是正常输入。';
      okBox.hidden=false;
    }
  }
  if(r.settings.paused)await DSH.suspend();
  await load();
}

for(const id of ['hotkey','spacegesture','askhotkey','mode','size','placement','paused','keepfocus','soundenabled','soundvolume','recordspath']){
  el(id).addEventListener('change',()=>void save());
}
el('close').addEventListener('click',async()=>{
  try{await DSH.show({route:'ask',focusable:true,clickThrough:false});}
  catch(e){problem.textContent=e instanceof Error?e.message:String(e);problem.hidden=false;}
});
void load();
