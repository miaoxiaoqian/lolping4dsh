# lolping4dsh

给 DeepSeek Harness 加上 LoL 风格轮盘和紧凑求助窗口。按住 **Ctrl**、移动鼠标、松开选择；普通空格输入不参与轮盘手势。

> 当前是 macOS 开发版本，需要配套的 DSH 桌面集成。仅安装插件不能给原版 DSH 自动补上原生窗口、输入监听和 preload 桥接。代码与隔离测试已验证，完整桌面验收仍未完成。

## 功能

| 图标 | 动作 |
|---|---|
| 求助 | 打开可拖动的磨砂玻璃小窗，使用 DSH 正式会话 |
| 弱爆 | 评价当前回答不满意，要求 Agent 自查并修改一轮 |
| 一脸问号 | 换一种方式解释当前回答 |
| 需要视野 | 框选截图，加入当前会话预览，点击发送后才上传 |
| 危险 | 停止当前执行并清除该会话排队请求 |
| 正在路上 | 恢复被停止且尚未完成的任务 |
| GG | 整理并保存当前成果 |
| 超赞 | 接受当前回答，写入反馈而不调用模型 |

小窗支持新建、切换会话和独立草稿。默认工作区为 `~/Documents/DSH快捷求助`，Markdown 记录目录可改到 Obsidian 库内。轮盘默认 32px，透明窗口为 400 DIP；反馈动画出现在实际选择点附近。反馈使用简短状态，模型输入保留在正式会话记录中。

## 本地构建

需要 Node.js **24 或更新受支持版本**、npm；原生助手还需要 macOS 与 Xcode Command Line Tools。

```sh
git clone https://github.com/miaoxiaoqian/lolping4dsh.git
cd lolping4dsh
npm ci
npm run assets:fetch
npm run build:native   # 仅 macOS：编译并本地签名，不启动监听器
npm run build
npm run typecheck
npm run selftest
npm run test:native    # 纯状态机/协议测试，不监听真实输入
```

LoL 图片、动画和音频不提交到本仓库。`assets:fetch` 从固定的 [lolPing](https://github.com/darrenprx/lolPing) 提交获取原版素材，逐文件检查 SHA-256 和大小，并保存在 Git 忽略的目录内。也可使用已有素材：

```sh
node tools/fetch-assets.mjs --from /absolute/path/to/lolPing/assets
```

## DSH 桌面集成

兼容目标为 **DSH 0.2.1-alpha.2**。仓库附带独立集成补丁和文件哈希检查工具，详见 [integration/README.md](integration/README.md)。该补丁在原始本地基线与官方 `dsh-v0.2.1-alpha.2` 源码文件上均通过了应用及哈希检查；没有验证任意后续 DSH 版本。

先完成桌面集成、编译和打包，再将插件加入对应 profile。以下命令只用于用户准备更新时；请先结束正在使用的 DSH 会话。

```sh
# 在 lolping4dsh 目录执行，需已安装 dsh CLI
dsh plugin --profile desktop add "link:$(pwd)"
```

不要直接从 GitHub 地址安装后期待开箱即用：这个仓库不提交构建产物与 LoL 素材，需要先在本地构建。

## 权限与记录

Ctrl 全局手势需要当前输入助手的系统授权；截图需要屏幕录制权限。macOS 版本不同，入口可能叫「辅助功能」或「设备控制和数据访问」。只给当前构建内的助手授权，并在修改或重建后重新核实。完整操作、记录保存和反馈行为见 [docs/USAGE.md](docs/USAGE.md)。

本仓库不包含用户会话、模型凭据、个人配置、桌面 app 或已编译输入监听程序。构建与测试不需要真实模型 API key。

## 验证范围

已通过构建、类型检查、Host 路由/会话测试、实际 React 隔离 DOM、轮盘与媒体脚本重复触发测试、全部素材字节检查，以及纯原生状态机测试。这些检查不会操作桌面或播放真实音效。

先前安装版的求助、弱爆、问号、正在路上和危险已有部分桌面播放记录；其余图标的独立桌面验收、物理 Ctrl 连续唤醒和实际可听音效仍待完成。仓库包含后续后台修复源码，不能据此声称用户当前运行的安装版已加载全部修改。

## 许可

项目代码采用 [MIT](LICENSE)。改编的 lolPing 与 DeepSeek 代码保留各自声明，见 [素材归属说明](assets/ATTRIBUTION.md)、[lolPing MIT](assets/licenses/lolPing-MIT.txt) 和 [DeepSeek MIT](licenses/DeepSeek-MIT.txt)。LoL 素材属于 Riot Games，MIT 不覆盖这些素材；本项目不代表 Riot Games，也未获其背书。
