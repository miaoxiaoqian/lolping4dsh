/** Exercise the pure decision/protocol code; never starts an event tap. */
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
const root=fileURLToPath(new URL('../',import.meta.url));const temp=mkdtempSync(join(tmpdir(),'lolping4dsh-native-'))
try{
 const output=join(temp,'decision-test')
 execFileSync('c++',['-std=c++20','-Wall','-Wextra','-I',join(root,'native/input-helper'),join(root,'native/input-helper/decision.cpp'),join(root,'native/input-helper/protocol.cpp'),join(root,'native/input-helper/tests/decision_test.cpp'),'-o',output],{stdio:'inherit'})
 execFileSync(output,[],{stdio:'inherit'})
}finally{rmSync(temp,{recursive:true,force:true})}
