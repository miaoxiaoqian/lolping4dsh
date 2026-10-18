# 素材归属说明

本目录下的图片与音频**不是本项目创作的作品**，也不是本项目原创的替代品。它们原样复制自
[darrenprx/lolPing](https://github.com/darrenprx/lolPing) 仓库的 `assets/`，作者为 Danrui Meng。

## 代码与素材的许可范围不同

lolPing 的 `LICENSE` 采用 MIT，但作者在协议末尾明确划出了例外：

> This license covers lolPing's **source code only**. The ping icons in
> `assets/textures` and the sounds in `assets/sounds` are **© Riot Games, Inc.**,
> extracted from League of Legends, and **are not licensed under the MIT License**.
> lolPing isn't endorsed by Riot Games and doesn't reflect the views or opinions of
> Riot Games or anyone officially involved in producing or managing Riot Games
> properties. Riot Games, and all associated properties are trademarks or
> registered trademarks of Riot Games, Inc.

因此：

| 内容 | 权利人 | 本项目的关系 |
|---|---|---|
| 本插件的 TypeScript 代码（`src/`、`build/`） | 本项目 | MIT |
| `assets/textures/*.png` | Riot Games, Inc. | 原样复制，未修改 |
| `assets/sounds/*.wav` | Riot Games, Inc. | 原样复制，未修改 |
| `assets/emotes/*.png` `*.webp` `*.ogg` | Riot Games, Inc. | 原样复制，未修改 |

MIT 协议**不覆盖**本目录下的任何素材。素材的名称、形象、颜色、动画与音效均保持原样，
没有重绘、没有重新配制、没有转码。

## 素材清单与来源

### 轮盘实现参考

`src/host/ui/wheel.js` 与 `wheel.css` 的轮盘 SVG 几何、渐变配色、金色分隔线、扇区高亮和开场过渡，改编自
[darrenprx/lolPing 的 wheel.ts](https://github.com/darrenprx/lolPing/blob/main/src/renderer/overlay/wheel.ts)、
[overlay.css](https://github.com/darrenprx/lolPing/blob/main/src/renderer/overlay/overlay.css) 与
[geometry.ts](https://github.com/darrenprx/lolPing/blob/main/src/shared/geometry.ts)。原项目代码采用 MIT License，
其版权声明和许可全文随本插件收录于 [`licenses/lolPing-MIT.txt`](licenses/lolPing-MIT.txt)。
这里仅复用和改编轮盘实现样式；本插件的图标和音频仍按下表保留原样及各自的 Riot Games 权利说明。

### 信号纹理（`assets/textures/`）
独立反馈页 `src/host/ui/feedback.js` 与 `feedback.css` 的信号扩散圆环、弹出及浮动过渡改编自上游 `src/renderer/overlay/pingFx.ts` 与 `overlay.css`，代码采用随附 MIT 许可；颜色映射取自上游 `src/shared/pings.ts`。图片和音效的权利归属保持原样。

复制自 lolPing `assets/textures/`，文件名保持一致：

| 文件 | 对应轮盘槽位 |
|---|---|
| `assist_me.png` | 下 — 求救／协助我 |
| `need_vision.png` | 左下 — 需要视野 |
| `pingwheel_retreatrender.png` | 上 — 危险 |
| `omw.png` | 右 — 正在路上 |

### 表情（`assets/emotes/`）

复制自 lolPing `assets/emotes/`，每个表情三件套：`.png` 静态图、`.webp` 动画、`.ogg` 音效。

| slug | 中文名 | 用途 |
|---|---|---|
| `unworthy_cn` | 弱爆（文字版） | 默认槽位 — 自主再改一轮 |
| `come_again` | 一脸问号 | 默认槽位 — 重新解释 |
| `gg_heart` | 精彩的对局 <3 | 默认槽位 — 整理并保存 |
| `super_approved` | 超赞的 | 默认槽位 — 接受结果 |
| `facepalm` | 捂脸 | 可选池 — 定位具体错误 |
| `think_about_it` | 脑子是个好东西 | 可选池 — 深入推敲 |
| `sad_kitten` | 悲伤猫咪 | 可选池 — 降低解释门槛 |
| `angry_kitty` | 我生气了！ | 可选池 — 停止并纠偏 |
| `scout_approved` | 提莫说很好 | 可选池 — 逐项验收 |
| `poro_ride` | 溜了溜了 | 可选池 — 收起窗口保留草稿 |

表情标识与中文名取自 lolPing `src/shared/emoteCatalog.ts`；信号标识、图标文件名与音效文件名
取自 `src/shared/pings.ts`。本插件**只复用这两份清单里的标识与文件名**，未复制其代码。

### 音效（`assets/sounds/`）

复制自 lolPing `assets/sounds/`：

| 文件 | 用途 |
|---|---|
| `ComeHere.wav` | 求救 |
| `SRP_12.wav` | 弱爆 |
| `SRP_7.wav` | 需要视野 |
| `Danger.wav` | 危险 |
| `OnMyWay.wav` | 正在路上 |
| `button.wav` | 轮盘悬停切换提示音 |

表情自身的音效使用其同目录的 `.ogg` 三件套，不额外复制。

## 使用范围

本仓库只提供代码、固定上游版本与素材校验清单，不上传或分发任何图片、动画或音频文件。使用者在本机通过素材获取脚本或已有素材目录配置原版资源，并自行确认相应使用条件。

若要把本插件或这些素材提供给其他人，需自行向 Riot Games 取得授权。
