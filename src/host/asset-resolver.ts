/**
 * Resolves asset identifiers to files, and reports honestly when one is absent.
 *
 * The rule this module exists to enforce: a slot whose asset is missing must say
 * so and refuse to run. Substituting a different emote, drawing a grey box, or
 * falling back to a system emoji would all be worse — the user would see a
 * confident-looking button that means something else.
 *
 * @module @local/dsh-quick-help/host/asset-resolver
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { AssetKind, AssetSlot } from '../shared/assets.ts'
import { assetDir } from '../shared/assets.ts'

/** One resolved file, with the URL the overlay will load it from. */
export interface ResolvedAsset {
  /** Route the overlay fetches. */
  readonly url: string
  readonly absolutePath: string
  readonly bytes: number
}

/** What a slot actually has on disk. */
export interface SlotAssets {
  readonly slot: AssetSlot
  /** The still image drawn in the wheel. */
  readonly image?: ResolvedAsset
  /** The animated loop played as feedback, when the asset has one. */
  readonly animation?: ResolvedAsset
  /** The sound played once when the slot is accepted. */
  readonly sound?: ResolvedAsset
  /**
   * What is missing, in Chinese, phrased for the person configuring the wheel.
   *
   * `undefined` means every declared file is present. A ping with no animation is
   * not a missing asset: pings ship as static marks, so nothing is expected.
   */
  readonly missing?: string
}

/**
 * Serves assets over the plugin's own HTTP surface.
 *
 * The overlay is loaded from the Host, so it fetches assets from the same origin
 * with no credential of its own. Routes are registered per file rather than as a
 * directory listing: a path prefix route would expose the whole `assets/` tree,
 * including the ~30 files this plugin never loads.
 */
export class AssetResolver {
  /** Files that have been routed, so the same slot resolved twice registers once. */
  private readonly served = new Map<string, string>()

  /** @param assetsRoot - Absolute path of this plugin's `assets` directory. */
  constructor(private readonly assetsRoot: string) {}

  /**
   * Resolve every file one slot declares.
   *
   * @param slot - The asset slot to inspect.
   * @returns What exists, and what does not.
   */
  resolve(slot: AssetSlot): SlotAssets {
    const sub = assetDir(slot.kind)
    const image = this.file(sub, slot.image)
    const animation = slot.animation === undefined ? undefined : this.file(sub, slot.animation)
    // A ping's sound lives in assets/sounds/, not beside its texture, so the
    // directory comes from the extension rather than from the slot's kind.
    const sound = slot.sound === undefined ? undefined : this.file(this.soundDir(slot.sound), slot.sound)

    // The image is what the user sees, so a slot without one cannot be offered at
    // all. A missing animation or sound degrades the feedback but leaves the
    // action intact, so those are reported without blocking.
    const absent: string[] = []
    if (image === undefined) absent.push(`图标 ${slot.image}`)
    if (slot.animation !== undefined && animation === undefined) absent.push(`动画 ${slot.animation}`)
    if (slot.sound !== undefined && sound === undefined) absent.push(`音效 ${slot.sound}`)

    return {
      slot,
      ...image === undefined ? {} : { image },
      ...animation === undefined ? {} : { animation },
      ...sound === undefined ? {} : { sound },
      ...absent.length === 0 ? {} : { missing: `素材缺失：${absent.join('、')}。请确认 assets/ 目录完整。` },
    }
  }

  /** Resolve a bare sound file by name, for the hover tick. */
  resolveSound(name: string): ResolvedAsset | undefined {
    return this.file(this.soundDir(name), name)
  }

  /**
   * Which directory a sound file lives in.
   *
   * The wheel's ping sounds ship as `.wav` under `assets/sounds/`, while an
   * emote's own sound is the `.ogg` sitting beside its frames under
   * `assets/emotes/`. Deriving the directory from the extension is what keeps one
   * route per file instead of two kinds of sound sharing one wrong path.
   */
  private soundDir(name: string): 'sounds' | 'emotes' {
    return name.endsWith('.wav') ? 'sounds' : 'emotes'
  }

  /** Whether a slot can be shown at all. */
  isUsable(resolved: SlotAssets): boolean {
    return resolved.image !== undefined
  }

  /**
   * Register the HTTP routes for every file the given slots need.
   *
   * @param slots - Slots whose assets should become reachable.
   * @returns The disposer removing all of them.
   */
  register(slots: readonly AssetSlot[], register: (path: string, handler: () => { path: string; bytes: number }) => () => void): () => void {
    const disposers: (() => void)[] = []
    for (const slot of slots) {
      const resolved = this.resolve(slot)
      for (const asset of [resolved.image, resolved.animation, resolved.sound]) {
        if (asset === undefined) continue
        if (this.served.has(asset.url)) continue
        this.served.set(asset.url, asset.absolutePath)
        disposers.push(register(asset.url, () => ({ path: asset.absolutePath, bytes: asset.bytes })))
      }
    }
    return () => {
      for (const dispose of disposers) dispose()
      this.served.clear()
    }
  }

  /** One file, or `undefined` when it is absent or empty. */
  private file(sub: 'textures' | 'sounds' | 'emotes', name: string): ResolvedAsset | undefined {
    // A name from a settings file reaches here, so it is checked against the
    // shapes the catalogue actually uses. `..` would let a crafted settings file
    // read outside the assets directory, and a name with a path separator would
    // route a file the catalogue never declared.
    if (!/^[\w.-]+\.(png|webp|ogg|wav|gif|mp3)$/.test(name)) return undefined
    const absolutePath = join(this.assetsRoot, sub, name)
    let bytes: number
    try {
      const info = statSync(absolutePath)
      if (!info.isFile() || info.size === 0) return undefined
      bytes = info.size
    } catch {
      return undefined
    }
    return { url: `/quick-help/asset/${sub}/${name}`, absolutePath, bytes }
  }
}

/** Content type per extension. The wheel needs no more than this. */
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

/** The MIME type for one asset path. */
export function assetType(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? 'application/octet-stream' : ASSET_TYPES[path.slice(dot)] ?? 'application/octet-stream'
}
