/**
 * The catalogue of League assets this wheel draws, and the mapping from each
 * asset to the DSH operation it triggers.
 *
 * The two halves are deliberately separate. An asset is a picture and a sound; a
 * business action is a decision about what should happen to a result. Keeping
 * them apart is what lets a user rebind `facepalm` to a different action, or
 * replace an asset they do not have, without touching a line of behaviour code.
 *
 * Nothing here decides whether an action *may* run — that is the action
 * registry's job, and it changes with the session. This module only answers
 * "what does this slot look and sound like, and what does it mean".
 *
 * @module @local/dsh-quick-help/shared/assets
 */
import type { ActionId } from './types.ts'

/** Which business action an asset triggers. */
export type BuiltinActionId =
  | 'ask'
  | 'revise'
  | 'explain'
  | 'verify'
  | 'stop'
  | 'continue'
  | 'accept'
  | 'save'
  /** 「溜了溜了」：hide 只收起窗口，不停止任务，因此不在这八格里。 */
  | 'hide'

/**
 * What kind of asset backs a slot.
 *
 * `ping` and `emote` are different shapes of thing and the difference shows in
 * the interface: a ping is a flat coloured mark with no animation, an emote has a
 * 320×320 animated loop. Treating them uniformly would mean either pretending the
 * pings animate or pretending the emotes do not.
 */
export type AssetKind = 'ping' | 'emote'

/** One asset slot: what to draw, what to play, and what it means. */
export interface AssetSlot {
  readonly id: ActionId
  /** The action this asset triggers. */
  readonly action: BuiltinActionId
  readonly kind: AssetKind
  /** League's own name, shown on hover so the mapping stays guessable. */
  readonly emoteName: string
  /** League's Chinese name. */
  readonly emoteNameZh: string
  /** File name inside `assets/emotes/`, or inside `assets/textures/` for a ping. */
  readonly image: string
  /** Animated file, when the asset has one. Pings are static and never have this. */
  readonly animation?: string
  /** Sound file name, inside the same directory as the image. */
  readonly sound?: string
  /** The DSH function this slot performs, in the user's terms. */
  readonly meaning: string
  /**
   * The full hover line: `表情名 → 实际功能`.
   *
   * Both halves are always present. A wheel whose icons carry meaning the user
   * has to guess is a wheel that has to be learned by trial and error.
   */
  readonly hover: string
  /** Sector on the wheel, counting clockwise from north. */
  readonly sector: number
}

/**
 * The eight default slots, clockwise from north.
 *
 * Sector indices match the native helper's own geometry: eight equal slices with
 * north as 0, which is the same convention `sector_for` uses in
 * `native/input-helper/decision.cpp`. The two must agree or a highlight will sit
 * on the wrong icon.
 */
export const DEFAULT_SLOTS: readonly AssetSlot[] = [
  {
    id: 'ask', action: 'ask', kind: 'ping', sector: 4,
    emoteName: 'Assist Me', emoteNameZh: '求救／协助我',
    image: 'assist_me.png', sound: 'ComeHere.wav',
    meaning: '召唤对话小窗口',
    hover: '求救／协助我 → 召唤对话小窗口',
  },
  {
    id: 'revise', action: 'revise', kind: 'emote', sector: 1,
    emoteName: 'Unworthy (Chinese text)', emoteNameZh: '弱爆（文字版）',
    image: 'unworthy_cn.png', animation: 'unworthy_cn.webp', sound: 'unworthy_cn.ogg',
    meaning: '自主再改一轮',
    hover: '弱爆（文字版）→ 自己检查不足，再改一轮',
  },
  {
    id: 'explain', action: 'explain', kind: 'emote', sector: 3,
    emoteName: 'Come again?', emoteNameZh: '一脸问号',
    image: 'come_again.png', animation: 'come_again.webp', sound: 'come_again.ogg',
    meaning: '换一种方式解释',
    hover: '一脸问号 → 换一种方式解释',
  },
  {
    id: 'verify', action: 'verify', kind: 'ping', sector: 5,
    emoteName: 'Need Vision', emoteNameZh: '需要视野',
    image: 'need_vision.png', sound: 'SRP_7.wav',
    meaning: '框选截图，预览后发送分析',
    hover: '需要视野 → 框选截图，预览后发送分析',
  },
  {
    id: 'stop', action: 'stop', kind: 'ping', sector: 0,
    emoteName: 'Danger', emoteNameZh: '危险',
    image: 'pingwheel_retreatrender.png', sound: 'Danger.wav',
    meaning: '停止当前任务',
    hover: '危险 → 停止当前任务',
  },
  {
    id: 'continue', action: 'continue', kind: 'ping', sector: 2,
    emoteName: 'On My Way', emoteNameZh: '正在路上',
    image: 'omw.png', sound: 'OnMyWay.wav',
    meaning: '继续当前任务',
    hover: '正在路上 → 继续当前任务',
  },
  {
    id: 'save', action: 'save', kind: 'emote', sector: 6,
    emoteName: 'GG <3', emoteNameZh: '精彩的对局 <3',
    image: 'gg_heart.png', animation: 'gg_heart.webp', sound: 'gg_heart.ogg',
    meaning: '整理并保存成果',
    hover: '精彩的对局 <3 → 整理并保存成果',
  },
  {
    id: 'accept', action: 'accept', kind: 'emote', sector: 7,
    emoteName: 'Super-Approved', emoteNameZh: '超赞的',
    image: 'super_approved.png', animation: 'super_approved.webp', sound: 'super_approved.ogg',
    meaning: '接受当前结果',
    hover: '超赞的 → 接受当前结果',
  },
]

/**
 * Extra emotes a user may bind to a slot, with the action each is suggested for.
 *
 * A binding to an action that does not exist is rejected at settings time rather
 * than shown as a slot that does nothing, which is the "preview only" rule: an
 * unbound emote can be previewed, never guessed at.
 */
export const OPTIONAL_EMOTES: readonly AssetSlot[] = [
  {
    id: 'opt-facepalm', action: 'verify', kind: 'emote', sector: -1,
    emoteName: 'Facepalm', emoteNameZh: '捂脸',
    image: 'facepalm.png', animation: 'facepalm.webp', sound: 'facepalm.ogg',
    meaning: '指出错误并针对性修复',
    hover: '捂脸 → 指出有错误，进入针对性修复',
  },
  {
    id: 'opt-think', action: 'explain', kind: 'emote', sector: -1,
    emoteName: 'Think About It', emoteNameZh: '脑子是个好东西',
    image: 'think_about_it.png', animation: 'think_about_it.webp', sound: 'think_about_it.ogg',
    meaning: '检查假设、反例与替代方案',
    hover: '脑子是个好东西 → 深入推敲，检查假设、反例和替代方案',
  },
  {
    id: 'opt-sad-kitten', action: 'explain', kind: 'emote', sector: -1,
    emoteName: 'Sad Kitten', emoteNameZh: '悲伤猫咪',
    image: 'sad_kitten.png', animation: 'sad_kitten.webp', sound: 'sad_kitten.ogg',
    meaning: '降低解释门槛，补基础与步骤',
    hover: '悲伤猫咪 → 降低解释门槛，补基础知识和步骤',
  },
  {
    id: 'opt-angry-kitty', action: 'stop', kind: 'emote', sector: -1,
    emoteName: 'Angry Kitty', emoteNameZh: '我生气了！',
    image: 'angry_kitty.png', animation: 'angry_kitty.webp', sound: 'angry_kitty.ogg',
    meaning: '停止当前方向并纠偏',
    hover: '我生气了！→ 停止当前方向，打开纠偏输入框',
  },
  {
    id: 'opt-scout', action: 'accept', kind: 'emote', sector: -1,
    emoteName: 'Scout-Approved', emoteNameZh: '提莫说很好',
    image: 'scout_approved.png', animation: 'scout_approved.webp', sound: 'scout_approved.ogg',
    meaning: '按原需求逐项检查验收',
    hover: '提莫说很好 → 按原需求逐项检查验收情况',
  },
  {
    id: 'opt-poro-ride', action: 'hide', kind: 'emote', sector: -1,
    emoteName: 'Poro Ride', emoteNameZh: '溜了溜了',
    image: 'poro_ride.png', animation: 'poro_ride.webp', sound: 'poro_ride.ogg',
    meaning: '收起小窗口，保留会话和草稿',
    hover: '溜了溜了 → 收起小窗口，保留会话和草稿',
  },
]

/** Every asset this plugin knows about, default slots first. */
export const ALL_SLOTS: readonly AssetSlot[] = [...DEFAULT_SLOTS, ...OPTIONAL_EMOTES]

/** The hover tick played when the highlight moves between sectors. */
export const HOVER_SOUND = 'button.wav'

/** The eight sectors, in clockwise order. */
export const SECTOR_COUNT = 8

/** Which subdirectory of `assets/` an asset's files live in. */
export function assetDir(kind: AssetKind): 'textures' | 'emotes' {
  return kind === 'ping' ? 'textures' : 'emotes'
}

/**
 * Look up a slot by its asset identifier.
 *
 * Unknown identifiers return `undefined` rather than a default, so a settings
 * file naming an emote this build does not ship surfaces as a broken slot the
 * user can see and fix, not as a silent substitution.
 */
export function slotById(id: string): AssetSlot | undefined {
  return ALL_SLOTS.find(slot => slot.id === id)
}

/** The default slot occupying one sector. */
export function slotAtSector(sector: number): AssetSlot | undefined {
  return DEFAULT_SLOTS.find(slot => slot.sector === sector)
}
