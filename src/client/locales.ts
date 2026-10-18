/**
 * Copy for this plugin's namespace.
 *
 * Kept as one object per language so a key added to one and forgotten in the other
 * is a type error rather than a raw key rendered on screen.
 *
 * @module @local/dsh-quick-help/client/locales
 */

/** Namespace this plugin registers its copy under. */
export const NS = 'quick-help'

/** Every key this plugin uses. */
const zh = {
  newConversation: '新建',
  switchConversation: '切换会话',
  currentConversation: '当前会话',
  conversationFailed: '未能打开会话，请重试',
  feedbackRevising: '不满意，正在改进…',
  feedbackWorking: '正在处理轮盘操作…',
  capture: '框选截图',
  captureFailed: '截图未能加入，请重试。',
  captureRejected: '截图已保留，请等待当前操作完成或切换支持图片的模型后重试。',
  panel: '全局轮盘',
  title: '全局轮盘与快捷求助',
  subtitle: '在任何应用里用快捷键呼出鼠标旁的轮盘，把表情变成对当前结果的操作。',

  sectionHotkey: '快捷键',
  sectionInteraction: '交互',
  sectionSlots: '八个槽位',
  sectionPool: '可选表情池',
  sectionTarget: '正在评价的回答',
  sectionSessions: '最近的快捷问答',

  hotkey: '呼出轮盘',
  askHotkey: '直接求助',
  askHotkeyHint: '留空则不绑定',
  mode: '交互模式',
  modePress: '按组合打开，移动并点击确认',
  modeHold: '按住组合并拖动，松开确认',
  iconSize: '图标大小',
  placement: '小窗口位置',
  placementPointer: '鼠标附近',
  placementCenter: '屏幕居中',
  paused: '暂停全局轮盘',
  keepFocus: '失焦时不隐藏小窗口',
  modelRoute: '模型',
  modelDefault: '跟随 DSH 默认',

  noTarget: '还没有可反馈的回答',
  bindTarget: '对这条使用轮盘',
  unbind: '返回当前小窗的回答',
  targetHint: '默认评价当前小窗里最近完成的回答，重新打开后也会恢复。评价桌面端的回答时，点那条回答的「对这条使用轮盘」。',

  supported: '平台支持',
  unsupported: '仅 macOS 可用',
  helperRunning: '输入助手运行中',
  helperStopped: '输入助手未运行',
  helperNoAccess: '输入助手未获设备控制和数据访问授权',
  helperCrashed: '输入助手已崩溃',
  helperStarting: '输入助手启动中',
  statusRefreshFailed: '状态更新失败，当前显示上次结果；正在重试',

  openSettings: '打开设置窗口',
  preview: '预览',
  listen: '试听',
  missing: '素材缺失',
  emptySlots: '没有槽位',
  emptySessions: '还没有快捷问答',
  reload: '刷新',
} as const

/** Chinese copy. */
export type T = (key: keyof typeof zh, params?: Record<string, string | number>) => string

/** Chinese dictionary. */
export const zhCN: Record<string, string> = zh

/**
 * English copy.
 *
 * The slot names are League's own, so they stay in the original even in an English
 * locale: a user who learned "Come again?" is looking for that word.
 */
const en = {
  newConversation: 'New',
  switchConversation: 'Switch conversation',
  currentConversation: 'Current conversation',
  conversationFailed: 'Could not open conversation. Please retry.',
  feedbackRevising: 'Improving the answer…',
  feedbackWorking: 'Processing wheel action…',
  capture: 'Capture screen region',
  captureFailed: 'Could not add the screenshot. Please retry.',
  captureRejected: 'Screenshot retained. Wait for the current operation or choose an image-capable model and retry.',
  panel: 'Quick Wheel',
  title: 'Global Wheel & Quick Ask',
  subtitle: 'Summon a wheel beside the pointer from any application, and turn an emote into an operation on the current result.',

  sectionHotkey: 'Shortcut',
  sectionInteraction: 'Interaction',
  sectionSlots: 'The eight slots',
  sectionPool: 'Optional emote pool',
  sectionTarget: 'Current task',
  sectionSessions: 'Recent quick asks',

  hotkey: 'Open the wheel',
  askHotkey: 'Ask directly',
  askHotkeyHint: 'leave empty to bind nothing',
  mode: 'Mode',
  modePress: 'Press the chord, move, and click to choose',
  modeHold: 'Hold the chord, drag, and release to choose',
  iconSize: 'Icon size',
  placement: 'Ask window placement',
  placementPointer: 'Near the pointer',
  placementCenter: 'Screen centre',
  paused: 'Pause the wheel',
  keepFocus: 'Keep the window when it loses focus',
  modelRoute: 'Model',
  modelDefault: 'Follow the DSH default',

  noTarget: 'No task bound',
  bindTarget: 'Bind the current answer',
  unbind: 'Unbind',
  targetHint: 'Every action except 「求救」 needs an explicit target. With none bound it refuses rather than guessing.',

  supported: 'Platform supported',
  unsupported: 'macOS only',
  helperRunning: 'Input helper running',
  helperStopped: 'Input helper stopped',
  helperNoAccess: 'Accessibility permission missing',
  helperCrashed: 'Input helper crashed',
  helperStarting: 'Input helper starting',
  statusRefreshFailed: 'Status update failed; showing the previous result and retrying',

  openSettings: 'Open the settings window',
  preview: 'Preview',
  listen: 'Play',
  missing: 'asset missing',
  emptySlots: 'No slots',
  emptySessions: 'No quick asks yet',
  reload: 'Reload',
} as const

/** English dictionary. */
export const enUS: Record<string, string> = en

/** The dictionary pair `ctx.locale.register` expects: simplified Chinese and English. */
export const dictionaries = { zh: zhCN, en: enUS }
