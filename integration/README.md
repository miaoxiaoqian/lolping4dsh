# DSH 桌面集成

插件 Host 无法直接创建 Electron 原生窗口或全局事件监听。`desktop/desktop.patch` 补上原生助手生命周期、IPC/preload、独立反馈窗口和正式聊天的紧凑布局/附件入口，保留精确窗口、会话与顶层 frame 校验。

## 目标版本与检查

目标为官方 `dsh-v0.2.1-alpha.2`。`desktop/manifest.json` 记录了官方版本及原始本地基线的变更前后 SHA-256。发布前已在隔离目录对两种基线完成 `git apply --check`、实际应用和结果哈希验证；这不是完整的桌面构建或运行验收。其他 DSH 版本可能需要人工适配。

工具只接受清单中匹配的原文件；文件有修改或已经打补丁时会停止，不重置、不覆盖本地改动。先检查，再明确应用：

```sh
# 在 lolping4dsh 目录执行
export DSH_SOURCE_ROOT="/absolute/path/to/deepseek-harness"
export DSH_QUICK_HELP_ROOT="$(pwd)"
node tools/apply-integration.mjs "$DSH_SOURCE_ROOT" --check
node tools/apply-integration.mjs "$DSH_SOURCE_ROOT" --apply
```

`--check` 不修改源码。`--apply` 会修改指定 checkout 中列明的文件；建议为本次工作使用独立分支并保留现有改动。

## 构建

先在插件目录完成 `npm ci`、获取素材及 `npm run build:native`、`npm run build`。`DSH_QUICK_HELP_ROOT` 要指向插件的绝对目录，供开发启动和打包查找原生助手。它不是个人路径或秘密。

```sh
# 保持上一步两个环境变量，在 DSH checkout 执行
cd "$DSH_SOURCE_ROOT"
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop run package:mac:arm64:unsigned --dir
```

随后按主 README 将构建好的插件加入 `desktop` profile。上面命令针对 Apple Silicon、未公证开发构建；不是面向用户的已签名正式发行包。本仓库不包含完整 DSH checkout、个人主题、相册、工作台数据或桌面应用。

## 内容

补丁仅包含轮盘、快捷求助、紧凑会话和必要的原生/客户端接线及相关测试；不包含独立的个人主题改动或本机 Electron 解压排错修改。DeepSeek 原代码的 MIT 声明保存在 `../licenses/DeepSeek-MIT.txt`（仓库根目录 `licenses/`）。
