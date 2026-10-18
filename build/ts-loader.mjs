/**
 * A module customization hook that lets Node import this plugin's `.ts` sources.
 *
 * The self-test needs the internals — `ActionScheduler`, `BindingTracker`, the
 * prompt builders — but `lib/index.js` exports only `apply`, and building a
 * second test bundle just to reach them would mean two artifacts that can drift.
 *
 * esbuild strips the types and nothing else: no transpile settings that would
 * change behaviour, and no bundling, so what runs is the same code that ships.
 *
 * Registered by `build/selftest.mjs`, not by the plugin itself.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'


/** @type {(specifier: string, context: object, next: Function) => Promise<{format: string, source: string | ArrayBuffer | Uint8Array, shortCircuit?: boolean}>} */
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.ts') === false) return next(specifier, context)

  // A relative specifier keeps its `.ts` extension in the source. Node's resolver
  // would look for a file that does not exist, so the URL is rebuilt against the
  // *importing module's* directory. `new URL(specifier, parentURL)` already does
  // exactly that and handles `../` correctly — deriving a path by string
  // concatenation would not, which is why the path is never rebuilt by hand here.
  if (specifier.startsWith('.') || specifier.startsWith('file:')) {
    if (context.parentURL !== undefined) {
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    }
  }
  return next(specifier, context)
}

/** @type {(url: string, context: object, next: Function) => Promise<{format: string, source: string | ArrayBuffer | Uint8Array, shortCircuit?: boolean}>} */
export async function load(url, context, next) {
  if (url.startsWith('file:') === false || url.endsWith('.ts') === false) return next(url, context)
  const source = await readFile(fileURLToPath(url), 'utf8')
  const result = await transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'node22',
    // `import type` lines are erased by the transform; nothing is bundled, so a
    // relative import stays relative and is resolved by this hook on the way in.
    sourcefile: fileURLToPath(url),
  })
  return { format: 'module', source: result.code, shortCircuit: true }
}
