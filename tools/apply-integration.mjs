/** Apply the narrow desktop patch only after checking every affected file. */
import {readFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const args=process.argv.slice(2)
if(args.length!==2||!['--check','--apply'].includes(args[1]))throw new Error('Usage: node tools/apply-integration.mjs /path/to/deepseek-harness --check|--apply')
const target=resolve(args[0]);const root=fileURLToPath(new URL('../',import.meta.url))
const manifest=JSON.parse(readFileSync(join(root,'integration/desktop/manifest.json'),'utf8'))
const sha=path=>existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null
for(const item of manifest.files){
 const current=sha(join(target,item.path))
 if(current!==item.beforeSha256 && current!==item.upstreamBeforeSha256)throw new Error(`Changed or unsupported file; nothing applied: ${item.path}`)
}
const patch=join(root,'integration/desktop/desktop.patch')
execFileSync('git',['apply','--check',patch],{cwd:target,stdio:'inherit'})
if(args[1]==='--check'){console.log('All affected files and patch match. No files changed.');process.exit(0)}
execFileSync('git',['apply',patch],{cwd:target,stdio:'inherit'})
for(const item of manifest.files){const current=sha(join(target,item.path));if(current!==item.afterSha256&&current!==item.upstreamAfterSha256)throw new Error(`Post-application hash mismatch: ${item.path}`)}
console.log('Desktop integration applied and hashes verified. Build/restart separately when convenient.')
