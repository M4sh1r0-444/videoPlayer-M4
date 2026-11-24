# 学习播放器

本地视频学习播放器：把硬盘里的网课视频按「科目 → 课程 → 分集」自动整理，配上续播、进度、学习看板、讲义关联和 AI 提问侧边栏。基于 Electron，数据全部保存在本机；除了你自己配置的 AI 接口，不连接任何服务器。

> 目前只在 Windows 上运行和验证过。macOS / Linux 的情况见[文末](#macos--linux)。

## 功能

### 目录自动整理

- 添加「学习目录」后自动扫描。以所选目录为根，规则是：
  - 根下某个一级文件夹里直接有视频 → 根算一个科目，一级文件夹都是课程；
  - 否则，一级文件夹里（往下最多两层）有视频的算科目，它的子文件夹是课程；这种情况下没有视频的文件夹会被跳过。
- 课程文件夹里的视频（往下最多两层）成为分集。文件名里 `[1.2.10]` 这类方括号编号用来排序（带编号的排在前面，各段按数值比较），显示时去掉编号前缀和扩展名；没有编号的按中文自然序排列。
- 不会移动、改名或修改任何视频文件。
- 不在学习目录里的零散视频、课程文件夹或讲义，可以用「导入」或直接拖进窗口，归到指定的（或新建的）科目 / 课程下。导入只登记路径，文件留在原处。

### 续播与进度

- 播放中每 3 秒、以及暂停和播完时保存进度；重新打开后从上次位置继续（位置超过 10 秒、且距结尾还有 8 秒以上才会续播）。
- 看到超过 90% 记为「看完」。列表里用图标区分未开始、看过一部分、已看完。
- 可选「播完自动连播下一集」。倍速 0.5x–3x；音量、主题、面板宽度都会记住。

### 学习看板

- **继续学习**：最近在看的分集，带缩略图，一键回到播放位置。
- **科目进度**：每个科目已看完的集数 / 总集数。
- **本周学习**：活跃天数、看完集数、累计观看、今日时长。

### 讲义关联

- 课程文件夹里的文档自动列为讲义 / 习题：PDF、Word、PPT、Excel、TXT 和图片。
- 文件名里的数字（包括「第 X 讲 / 集 / 课」的写法）如果恰好对应唯一一集的编号，就挂到那一集，否则作为课程级资料。
- 也可以手动关联到当前分集、刷新匹配，或从课程里移除。

### 转封装内播

- mp4、webm、m4v、ogv、ogg、mov 直接播放。
- MKV、FLV、TS 这类浏览器内核不能直接播放的格式，在装有 ffmpeg 时会**不重新编码**地转封装成 mp4 并缓存，之后可以直接在应用内播放。要求视频编码是 H.264，音频（如果有）是 AAC 或 MP3。
- 不满足条件时会提示改用系统播放器打开。

### AI 提问侧边栏

- 接入任意 OpenAI 兼容接口，流式回答，支持 Markdown 和 LaTeX 公式。
- 「上下文」开关：自动把当前课程、分集和播放位置告诉 AI。
- 播放中可以截取当前画面，随下一条提问一起发送（需要 ffmpeg，并且模型要支持图片输入）。
- 对话记录保存在本机。

### 其他

- 全局搜索课程和分集（`Ctrl+K`）。
- 深色 / 浅色主题；三栏宽度可拖动并记住；窗口变窄时，侧栏会折叠成图标轨或抽屉，停靠区变为浮层。
- 选课、播放、切集、开关 AI、关弹窗等主要操作都可以用键盘完成。

### 快捷键

在应用里按 `?` 可随时查看。输入框获得焦点时快捷键不触发。

| 分类 | 按键 | 作用 |
|---|---|---|
| 播放 | `Space` | 播放 / 暂停 |
| 播放 | `←` / `→` | 快退 / 快进 5 秒（`Shift` 为 30 秒） |
| 播放 | `↑` / `↓` | 音量 ±5% |
| 播放 | `F` / 双击画面 | 全屏 |
| 播放 | `M` | 静音 / 取消静音 |
| 播放 | `N` / `P` | 下一集 / 上一集 |
| 播放 | `0`–`9` | 跳到 0%–90% |
| 全局 | `Ctrl+K` | 聚焦全局搜索 |
| 全局 | `Ctrl+I` | 打开 / 关闭 AI 页签 |
| 全局 | `?` | 打开快捷键帮助 |
| 全局 | `Esc` | 关闭弹窗 / 停靠区浮层 |
| 列表 / 侧栏 | `Tab` | 在按钮、侧栏、分集列表间移动 |
| 列表 / 侧栏 | `↑` / `↓` | 在分集列表中移动（列表获得焦点时） |
| 列表 / 侧栏 | `Enter` | 选课 / 播放当前分集 |

## 环境要求

- **系统**：Windows 10 及以上（已在 Windows 11 上验证）。
- **Node.js** 22.12 或更高版本，以及 **npm**（Electron 44 要求 Node ≥ 22.12）。
- **Git**
- **ffmpeg**：可选，见[下一节](#ffmpeg可选)。

## 快速开始

```bat
git clone <仓库地址>
cd <仓库目录>
npm ci
npm start
```

几点说明：

- **只能用 `npm start` 启动。** 它会先构建再启动（`npm run build && electron .`）。构建产物 `renderer/dist/` 不入库，不构建直接启动，界面不会加载。
- **首次 `npm ci` 会下载约 150 MB 的 Electron 二进制**，下载源是仓库 `.npmrc` 里配置的镜像（`electron_mirror`）。
- 如果安装时跳过了脚本（例如用了 `--ignore-scripts`），`npm start` 会在第一次启动时自动下载；也可以手动执行 `npx install-electron`。
- 镜像配置只在通过 npm 执行命令时生效（`npm ci`、`npm start`、`npx install-electron`）。直连 GitHub 困难的环境下，请不要绕过 npm 直接运行 `node_modules` 里的 `electron`。

## ffmpeg（可选）

不装 ffmpeg 也能播放 mp4 等浏览器原生支持的格式，但会少掉下面这些功能：

| 功能 | 装了 ffmpeg | 没装 ffmpeg |
|---|---|---|
| 缩略图 | 看板「继续学习」卡片、分集悬停预览显示画面 | 不显示画面 |
| 时长 | 后台逐步读取每集时长，显示时长和已看百分比 | 不预先读取时长（播放过的分集除外），多数分集只显示已看位置 |
| 转封装内播 | MKV / FLV / TS 等可以在应用内播放 | 提示「需 ffmpeg 转封装后才能内播」 |
| AI 截图提问 | 可以截取当前画面 | 提示「未检测到 ffmpeg，无法截图」 |

应用按下面的顺序查找 ffmpeg，取第一个可用的：

1. `PATH`（`where ffmpeg` 的第一个结果）
2. `D:\ffmpeg\bin`
3. `C:\ffmpeg\bin`
4. `C:\Program Files\ffmpeg\bin`
5. `%LOCALAPPDATA%\Programs\ffmpeg\bin`
6. `%USERPROFILE%\scoop\shims`

`ffmpeg` 和 `ffprobe` 必须在同一个文件夹里。应用运行期间只查找一次，装好或改了 `PATH` 之后需要重启应用。

## AI 助手（可选）

在「设置 → AI 助手」里配置：

1. 选一个预设（DeepSeek、Kimi、智谱 GLM、OpenAI、Ollama），或者选「自定义」。
2. 填写接口地址（OpenAI 兼容的 Base URL，含 `/v1`，不含 `/chat/completions`）、API Key 和模型名；可以按需追加系统提示词。
3. 点「测试连接」确认可用。

- 密钥只保存在本机的 `learn.json` 里（明文），请求由应用直接发往你填写的接口地址，不经过其他服务。
- 截图提问要求模型支持图片输入。
- 对话记录保存在同目录的 `ai-history.json`。

## 数据存放

全部在 `%APPDATA%\学习播放器\`：

| 文件 / 目录 | 内容 |
|---|---|
| `learn.json` | 学习目录、导入的课程、观看进度、学习统计、设置、AI 配置（含密钥） |
| `ai-history.json` | AI 对话记录 |
| `thumbnails\` | 缩略图缓存 |
| `remux\` | 转封装缓存（mp4） |

设置里的「打开数据文件夹」可以直接打开这个目录，「缓存管理」可以分别清理缩略图和转封装缓存。

## 开发

### npm 脚本

| 命令 | 作用 |
|---|---|
| `npm start` | 构建并启动应用 |
| `npm run build` | 构建：校验 `renderer/vendor`，用 esbuild 打包渲染层，生成带内容哈希的入口 `renderer/dist/app.<hash>.js` |
| `npm test` | 单元测试（会先构建） |
| `npm run smoke` | 冒烟测试：启动真实的应用窗口逐项断言，见[测试](#测试) |
| `npm run smoke:packaged` | 对打包产物跑冒烟测试（先执行 `npm run dist:dir`） |
| `npm run smoke:baseline` | 重新生成视觉基线（截图和 DOM 快照），会覆盖 `docs/refactor/baseline/` |
| `npm run sync-vendor` | 把固定版本的 marked / DOMPurify / KaTeX 从 `node_modules` 同步到 `renderer/vendor` |
| `npm run fixture` | 生成冒烟测试用的媒体夹具（需要 ffmpeg） |
| `npm run icon` | 生成应用图标（Windows ICO 和 macOS ICNS / PNG） |
| `npm run icon:mac` | 只生成 macOS 图标 |
| `npm run dist` | 打包 Windows 安装版和便携版到 `dist/` |
| `npm run dist:dir` | 只打包出免安装目录 `dist/win-unpacked/` |
| `npm run dist:mac` | 打包 macOS dmg（只能在 macOS 上执行） |

### 目录结构

```text
main.js          主进程：目录扫描、数据存储、ffmpeg（缩略图 / 时长 / 转封装）、窗口与 IPC
ai-bridge.js     AI：流式对话、连接测试、截帧、对话记录文件
platform.js      平台相关：查找 ffmpeg、文件路径转 file:// URL
preload.js       预加载脚本：向渲染层暴露 window.api
renderer/        渲染层
  app.js         默认入口（组件化界面）
  index.html     页面骨架与 CSP
  style.css      全部样式
  views/         页面级视图
  components/    界面组件
  data/          状态、动作与持久化
  core/          纯函数（分集解析、讲义匹配、进度判定等），主进程与渲染层共用
  ui/            基础设施（DOM、对话框、快捷键、富文本渲染等）
  vendor/        marked / DOMPurify / KaTeX，由 npm run sync-vendor 同步，不要手改
  renderer.js    旧界面，连同 ai.js、lib-boot.js 只在 ?legacy=1 时加载
scripts/         构建、vendor 同步、冒烟测试、测试夹具、图标生成
test/            单元测试
build/           应用图标
docs/            设计与重构方案文档
ui-audit/        视觉抽查脚本
```

### 测试

```bat
npm test
npm run smoke
```

- `npm test`：单元测试（`node --test`），不需要额外环境。
- `npm run smoke`：用独立的临时数据目录启动真实的应用窗口，覆盖扫描、播放与续播、搜索、讲义、设置、导入、看板、键盘操作、AI（本地 mock 接口）和 `?legacy=1` 等链路，并把 DOM 快照与基线比对。注意：
  - 只支持 Windows，并且需要 ffmpeg 在 `PATH` 上；
  - 运行期间测试窗口必须保持可见（不要最小化、锁屏或切走桌面）：窗口不可见时，浏览器内核会把定时器节流到每秒一次并暂停动画帧，时序类断言会因此失败；
  - 每次运行都会重写 `docs/refactor/baseline/` 下 8 张已入库的基线截图（像素级的时序差异），跑完请用 `git checkout -- docs/refactor/baseline/` 还原；
  - 其中「真实 99 集」用例依赖一份本机的数据快照，没有这份快照时会跳过。

### 打包

```bat
npm run dist
```

输出在 `dist/`：安装版 `学习播放器-Setup-<版本>.exe` 和便携版 `学习播放器-Portable-<版本>.exe`（x64）。安装包没有数字签名，在其他电脑上第一次运行时 Windows 可能弹出未知发布者之类的提示。打包过程需要联网下载 Electron 和打包工具。

## 许可证

[MIT](LICENSE)

## macOS / Linux

代码里已经有平台分支（ffmpeg 改用 `which` 和 Homebrew / MacPorts 路径、可执行文件名不带 `.exe`、非 Windows 路径的处理）和 mac 打包配置（`npm run dist:mac`），但**没有在 macOS 或 Linux 上运行和验证过**，不保证可用。
