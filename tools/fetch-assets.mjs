/** Fetch only pinned original media into git-ignored local directories. */
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {join,dirname} from 'node:path'
const root=fileURLToPath(new URL('../',import.meta.url))
const manifest=JSON.parse(await readFile(join(root,'assets/manifest.json'),'utf8'))
const args=process.argv.slice(2)
if(args.length && !(args.length===2 && args[0]==='--from'))throw new Error('Usage: node tools/fetch-assets.mjs [--from /local/lolPing/assets]')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
let checked=0
for(const file of manifest.files){
 if(!/^(textures|emotes|sounds)\/[\w.-]+\.(png|webp|ogg|wav)$/.test(file.path))throw new Error('Unexpected manifest path')
 const target=join(root,'assets',file.path)
 let existing
 try{existing=await readFile(target)}catch(error){if(error.code!=='ENOENT')throw error}
 if(existing){if(sha(existing)!==file.sha256)throw new Error(`Refusing to overwrite changed local asset: ${file.path}`);checked++;continue}
 let bytes
 if(args.length)bytes=await readFile(join(args[1],file.path))
 else{
  const url=`https://raw.githubusercontent.com/darrenprx/lolPing/${manifest.commit}/assets/${file.path}`
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)})
  if(!response.ok)throw new Error(`Asset download failed (${response.status}): ${file.path}`)
  bytes=Buffer.from(await response.arrayBuffer())
 }
 if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)throw new Error(`Asset hash mismatch: ${file.path}`)
 await mkdir(dirname(target),{recursive:true})
 const temporary=`${target}.download-${process.pid}`
 await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,target);checked++
}
console.log(`Verified ${checked} original media files locally. Media remains excluded from Git.`)
