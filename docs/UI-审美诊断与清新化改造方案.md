# 学习播放器 · UI 审美诊断与「清新 / 简约 / 通透」改造方案

> 审阅版本：v0.4.4（2026-10-23）  
> 审阅对象：`renderer/` 的界面层（HTML / CSS / 组件），不含数据、IPC、播放内核  
> 证据：4 个视图 × 2 主题的 1344×821 基线截图、`renderer/style.css`（823 行）、`renderer/index.html`（252 行）及全部 UI 组件代码、WCAG 对比度计算  
> 结论性质：视觉方案，不改功能与数据；Phase 1 可以做到只改 `style.css`  
> 后续：清新化落地后，界面已继续演进为「液态玻璃 + 悬浮面板」，色板与字体层级保持不变，见 `docs/UI-液态玻璃与悬浮面板改造.md`。

---

## 0. 摘要

### 0.1 一句话结论

**功能骨架已经是成品，视觉仍停留在“工程默认值”。** 当前界面不难用，也不丑到不可救，但明显缺少一次“收口”：系统原生控件、Emoji 图标、同权按钮、过多 1px 边框和过小字号同时存在，使界面呈现出一种“开发中的管理工具”气质，而不是一个让人愿意长时间停留的学习应用。

### 0.2 三个根因

1. **没有设计系统，只有逐条样式。** 823 行 CSS 里有 532 个 px 字面量、11 种字号、7 种圆角、19 条按钮相关规则；同类控件之间没有共享的尺寸、状态和层级。
2. **层级关系反了。** 顶栏按钮、卡片边框、蓝色主按钮都很“响”，真正重要的当前课程、当前分集、学习进度却最弱；空白很多，但不是有节奏的留白。
3. **主题不完整。** 浅色模式下播放区仍是固定深色，导致空状态标题几乎不可见；主按钮、状态文字、原生控件存在多处对比度不足；深色与浅色像两套不同完成度的皮肤。

### 0.3 改造判断

这不是一次“重做界面”，而是一次**视觉收口 + 组件统一**：

| 层级 | 做法 | 代码量 | 视觉收益 |
|---|---|---:|---:|
| Phase 1 | 只改 CSS 变量与既有组件样式：配色、字号、间距、圆角、按钮、输入、进度条、空状态、弹窗 | 约 200–300 行 CSS | 约 70% |
| Phase 2 | 顶栏分组、SVG 图标、空状态/看板小结构、AI 输入区，改少量 HTML/JS | 约 300–400 行 HTML/CSS + < 50 行 JS | 剩余 30% |
| 总计 | 不引框架、不动 store / actions / IPC / 数据格式 | 约 1–1.5 人日 | 完整清新化 |

如果只想以最小风险改善“第一眼”，**只执行 Phase 1 即可**，不碰任何 HTML 结构和 JS 行为。

---

## 1. 审阅范围与现状评分

### 1.1 审阅素材

| 视图 | 浅色 | 深色 | 主要观察点 |
|---|---|---|---|
| 课程播放页 | `course-light.png` | `course-dark.png` | 顶栏、左侧两级列表、播放器控制条、当前分集 |
| 空状态 | `empty-light.png` | `empty-dark.png` | 空库引导、播放区主题断裂 |
| 学习看板 | `dashboard-light.png` | `dashboard-dark.png` | 卡片、进度、统计、页面节奏 |
| AI 停靠区 | `ai-light.png` | `ai-dark.png` | 双栏挤压、工具条、输入区、欢迎卡 |
| 设置 / 导入 / 帮助 | 静态代码审阅 | 静态代码审阅 | 弹窗层级、表单密度、背板与滚动 |

> 截图里的彩色测试画面是夹具视频，不是界面本身；本报告只评价窗口外壳与控件。所有 UI 尺寸按 1344×821 窗口、Windows 100% 缩放读取。

### 1.2 主观评分（10 分制）

| 维度 | 分数 | 判断依据 |
|---|---:|---|
| 信息层级 | 5 | 课程、分集、播放三项功能清楚，但顶栏 8 个同权动作抢走注意力 |
| 配色一致性 | 5 | 蓝色主色明确，但原生进度条是绿色，状态色与小字对比度不稳 |
| 字体与密度 | 5 | 基础字号 14px，实际界面大量 11–13px；中文 11px 偏小，字距处理不统一 |
| 空间节奏 | 6 | 三栏结构成熟，但留白集中在“没内容的地方”，内容区反而拥挤 |
| 组件一致性 | 4 | 10 余种按钮/可点击行，各自为政；系统控件未接管 |
| 主题完整度 | 4 | 浅色空状态有可见性缺陷；播放区、原生控件、系统背景不跟随 |
| 可访问性 | 4 | 多处小字与主按钮未达到 4.5:1；主题按钮语义有歧义 |
| 品牌辨识度 | 3 | 默认蓝 + 系统字体 + Emoji，换成任何同类工具也成立 |

**综合评价：5.0 / 10。** 不是“设计差”，而是“设计没有完成”。好消息是大部分问题都在样式层，改造成本远低于重构。

---

## 2. 具体问题清单

### 2.1 P0：可见性与对比度缺陷（必须修）

#### A1. 浅色空状态标题几乎不可见

- 证据：`renderer/style.css:263` 把 `#playerPanel` 背景固定为 `#0b0d11`；`.empty-title` 没有独立颜色，继承 `body` 的 `#1e2530`。
- 实测对比度：**1.26:1**（深色文字落在近黑背景上），远低于正文所需的 4.5:1。
- 观感：浅色模式下用户看到一整块黑，标题“把学习资料加进来吧”几乎消失，只剩两个按钮。这是功能可见性问题，不只是审美。
- 修法：空状态容器使用 `--bg`，或在浅色主题下把空状态设为浅色表面；播放视频时 `#videoArea` 仍保持纯黑。**不要让整个播放区在浅色主题下变成黑色空洞。**

#### A2. 主按钮的文字对比度不足

- 当前浅色 `--accent: #2f6ff2`，白字对比度 **4.49:1**，13px 常规字重已在 AA 边缘；深色 `--accent: #4f8cff`，白字仅 **3.22:1**。
- `.btn.primary:hover { filter: brightness(1.1); }` 会在悬停时把底色提亮，白字对比度进一步下降。
- 影响范围：顶栏“＋ 导入”、AI“发送”、看板“继续播放”、空状态大按钮、播放失败浮层的按钮。
- 修法：拆分 `--accent`（文字/描边）与 `--accent-fill`（按钮底），主按钮统一使用深青绿底 + 白字（浅色），或薄荷底 + 深墨字（深色）。禁止靠 `brightness()` 做 hover。

#### A3. 小字号文字与“选中态”多处低于 4.5:1

| 场景 | 前景 / 背景 | 对比度 |
|---|---|---:|
| 浅色当前课程/当前行蓝字 | `#2f6ff2` on `#eaf1fe` | **3.96:1** |
| 浅色 `.mini-btn` 等辅助按钮 | `#66707f` on `#e8ecf3` | **4.23:1** |
| 浅色完成勾选（`.st`，`--ok`） | `#0f9d63` on `#ffffff` | **3.49:1** |
| 浅色 AI 测试失败提示（12px） | `#a86e00` on `#ffffff` | **4.29:1** |
| 深色主按钮 | `#ffffff` on `#4f8cff` | **3.22:1** |

- 这些不是装饰性图标：当前课程、当前分集、AI 工具条、完成状态都是需要读懂的信息。
- 修法：主色加深；`--ok / --warn / --danger` 分别给出“浅色模式可读”的深色版本；所有 12px 以下的中文至少 4.5:1；状态不只用颜色，还配图标/文字。

#### A4. 原生控件完全脱离设计系统

- 实际截图中的 `progress` 填充是 Chrome 默认绿 **#1e8000**、轨道是 **#808080**，与蓝色主色没有任何关系；`accent-color` 在当前 Chromium 渲染里没有接管该进度条。
- 播放器的 seek/volume 是原生 range：1px 细轨 + 系统蓝圆点；倍速是原生 `<select>`；复选框也是系统样式。
- 未设置 `color-scheme`。深浅主题切换时，原生下拉菜单、自动填充、滚动条可能回退到系统亮/暗默认样式。
- 修法：用 `appearance: none` 自定义 `progress` 与 `range`；`select` 至少设置 `color-scheme` 并统一高度和背景；这是“设计完成度”最明显的一块。

#### A5. 状态样式不完整

- `.btn` 没有 `:disabled`、`:active`、`aria-pressed` 的视觉配套；`#aiTestBtn` 在测试连接时会被设成 disabled，但看起来仍可点击。
- 主题按钮文案是“夜间/白天”（动作），同时又设置 `aria-pressed`（当前状态）。读屏会读成“夜间，切换按钮，已按下”，语义是拧的。
- 修法：补齐 `:hover / :focus-visible / :active / :disabled` 四态；主题按钮改为图标 + `aria-label="切换到夜间模式"`，不要用 `aria-pressed` 表达“当前是浅色”。

---

### 2.2 P1：视觉语言与组件问题

#### B1. 顶栏是“九个按钮 + 一个搜索框”的抽屉

- 顶栏共 12 个可感知的交互/信息元素：9 个 `<button>`（含最左菜单，右侧 8 个动作）、搜索框、进度 chip、课程标题。
- 所有按钮默认都是同样的 30px 高、6px 圆角、灰色边框；只有“导入”是实心蓝。视觉上没有“浏览 / 工具 / 数据 / 系统”的分组，设置、帮助、主题和 AI、讲义混在同一排。
- 搜索框固定 190px；<1024px 时缩到 136px，占位文案“搜索课程 / 分集… Ctrl+K”必然截断，而快捷键其实可以放在 tooltip 里。
- “进度 0/3”和左侧当前课程行的“0/3”重复；“讲义”在顶栏和 dock 页签重复；“AI”在两个地方都能开。
- “导入”作为全屏唯一的实心蓝按钮，实际不是当前页面最该做的事；真正的主任务是继续学习/播放。
- 修法：
  - 分 3–4 组：**浏览**（首页）、**工具**（AI / 讲义）、**资料**（目录 / 导入）、**系统**（主题 / 帮助 / 设置）。
  - 系统项改成 36×36 的 SVG 图标按钮；保留 `aria-label` / `title`。
  - 顶栏不放实心主按钮；主按钮留给页面内容（打开目录、继续播放、发送）。
  - 进度并入面包屑或副标题，例如“数学 / 高数 · 已完成 0/3”，不再单独占一枚蓝色 chip。

#### B2. 字号虽多，层级却弱

- 共 11 种字号（10–24px，另有 0）；91 处 `font-size` 声明。基础 14px，但大部分界面文字是 11–13px。
- 11px 的中文出现在分集元信息、文档范围、统计小标签、AI 角色名；在 Windows 的微软雅黑下笔画会糊，长时间看很累。
- 面板标题、段落标题、文档头使用 `letter-spacing: 1px`。中文加 1px 字距等于 8% tracking，字与字被拉开，反而不如默认紧凑自然。
- `body` 没有 `line-height`，双行分集标题的行间距只有 `1.35`，标题与 11px 元信息之间只有 1px；密集但并不精致。
- 修法：建立 5 级字阶（24 / 15 / 14 / 13 / 12），中文最小 12px，正文 14/1.6，元信息 12/1.5；去掉中文 `letter-spacing`；字号、行高、字重全部 token 化。

#### B3. 尺寸与间距没有节奏

- 532 个 px 字面量，按钮高度横跨 18–45px：`.row-btn` 约 18px，`.mini-btn` 约 20px，`.ctl` 约 24px，`.btn` 约 30px，`.big-btn` 约 45px。
- 圆角有 4 / 6 / 7 / 8 / 10 / 12 / 999 七种；卡片、输入、按钮之间没有明确对应关系。
- 点击目标偏小：顶栏“？”、行内“打开/讲义”、AI 的“清空/上下文”、文档的“刷新匹配”都在 20px 上下，鼠标用户也容易点空。
- 修法：4px 间距基数；控件统一 36px 高，小按钮 32px，图标按钮 36×36，列表行 56px；圆角只留 10（控件）/ 14（卡片）/ 18（浮层）三档；可点击区域不小于 32×32。

#### B4. 边框太多，阴影太重，但层次反而更弱

- 面板、按钮、输入框、卡片、弹窗、下拉、toast 几乎全部带 1px 边框。
- 但边框本身的对比度只有 **1.35:1（浅色）/ 1.33:1（深色）**，既不能形成清晰边界，又制造了“线框稿”感。
- 浮层阴影却是 `0 10px 30px rgba(0,0,0,.5)`、`0 12px 40px rgba(0,0,0,.5)` 这类很重的黑色投影；浅色模式像脏了一圈，深色模式又几乎看不出。
- 修法：分两层边界——装饰性线用极浅 `--line`，交互控件用 `--line-strong`；卡片去掉描边，靠表面色差 + 极轻阴影；阴影只给真正浮起的元素（弹窗、popover、toast、悬停预览），并且用带色相的软阴影。

#### B5. 图标是 Unicode/Emoji 拼盘

- 现有字符：`☰`、`＋`、`▶`、`⏸`、`⏮`、`⏭`、`🔊`、`🔇`、`⛶`、`📷`、`✔`、`✕`、`▼`、`·`。
- 在 Windows 上，扬声器和相机是彩色 Emoji，播放/全屏是黑白几何字符，光学大小和笔画粗细都不一样；放大后像不同年代的系统图标拼在一起。
- 行首的“·”未开始状态尤其像渲染残渣，和蓝色播放三角、绿色完成勾之间没有统一的形状语言。
- 修法：只引入一套 16–20 个内联 SVG 图标（stroke 1.75，20×20，`currentColor`），不要图标字体、不要外链。播放/暂停、静音/取消静音用两个 SVG 节点切换 class，而不是改 `textContent`。

#### B6. 主色承担了太多语义

- 蓝色同时是：品牌色、链接色、当前项、进度、按钮底、focus ring、chip、拖放虚框、AI 提示。
- 当“当前集 + 当前课 + AI 打开 + 首页 + 导入”同时出现时，蓝色铺满顶栏和左栏，没有主次。
- 浅色主题的冷灰蓝底 `#f3f5f9` + 纯白 + 高饱和蓝，是“默认企业后台”的组合，不是“清新学习工具”；深色主题则是冷黑 + 高亮蓝，像开发工具。
- 原生进度条的绿色又引入了第二种“进度色”，与蓝色当前项互相打架。
- 修法：确定一个低饱和的青绿主色，把蓝色全部收回；进度、当前项、主按钮统一；success / warning 只用于真实状态，不做装饰；保证全屏彩色面积 < 10%。

#### B7. 浅色与深色不是同一套界面

- 浅色主题下 `#playerPanel` 固定 `#0b0d11`；看板、侧栏、顶栏是白色，播放器是黑洞，中间没有任何过渡。
- `main.js` 的窗口 `backgroundColor` 固定 `#101318`，浅色主题冷启动会先闪一下深色。
- 原生 `select`、`progress`、range 不跟随主题；`color-scheme` 缺失。
- 主题切换是瞬间跳变，没有过渡；也没有 `prefers-reduced-motion` 处理。
- 修法：明确“**浅色外壳 + 深色视频舞台**”是设计规则，而不是遗漏：空状态跟随外壳，视频区保持纯黑；原生控件自定义；给 `body` 设置 `color-scheme`；主题切换加 160ms 颜色过渡，并尊重减少动态偏好。

#### B8. 看板像一张没有排版的报表

- 看板没有页面级标题，只有 13px 的“继续学习 / 科目进度 / 本周学习”三段小字。
- 内容从窗口左边缘 32px 开始铺满 1344px；继续学习卡片内缩略图 208×117，信息区很长，CTA 漂到最右，中间形成约 900px 的横向空白。
- 进度条用默认绿色；0 值统计仍用 24px 蓝色数字，四个白卡片四个边框，视觉重心落在“0”上。
- 内容只占页面上半部分，下面 400px 全空；空不是“呼吸感”，而是没有内容规划。
- 修法：内容最大宽度约 1120px 居中；加入 24px 页面标题和一句说明；“继续学习”做成带浅薄荷渐变的特色卡；进度条自定义；统计收进一个软表面，0 值用次文字色，正值才用主色；1150px 以下两列改一列。

#### B9. 空状态三套语言，且其中一套不可读

- 侧栏：“还没有科目 / 点右上「目录」添加”，12–13px，缩在巨大空白中。
- 分集栏：启动空库时直接留白（组件注释明确“避免多出一行视觉噪音”）。
- 播放区：一个不可见的标题 + 一行说明 + 两个大按钮。
- 三处没有统一的插画/图标/标题/操作层级；空状态没有“下一步在哪里”的视觉指引。
- 修法：统一为“图标 + 22px 标题 + 13px 说明 + 一个主操作（+ 一个次操作）”。侧栏用小型 icon + 一句提示；分集栏保留轻量占位；播放区按主题自适应。

#### B10. AI 停靠区把四个工具条叠在一起

- 340px 宽度里依次是：dock 页签头、AI 工具条（上下文/清空）、快捷 chips、输入条；消息区被夹在中间。
- 输入框 placeholder 两行换行；截图按钮是彩色相机 Emoji；欢迎卡是一大块灰底；用户/AI 的“我/AI”角色标签额外占一行。
- 顶栏“AI”和 dock 里的“AI”页签同时高亮，两个入口争夺“当前状态”。
- 修法：页签头保留但弱化；工具栏并入输入区上方一行；“上下文：开”改成开关图标 + 文字；消息区更透气，assistant 消息去掉灰底，user 用薄荷浅底；输入区做成一张完整的 composer 卡，focus-within 有光环。

#### B11. 文案与微文案的“工程师味”

- “进度 0/3”不明确是已完成还是剩余；“已转”是转封装术语；“目录”是动作不明的按钮；“夜间/白天”动作与状态混用。
- “＋ 导入”和“导入视频 / 文件”两种写法；“讲义”与“讲义 / 习题”不统一；“点右上「目录」添加”在窄布局下可能产生误导。
- 时间 `00:40 30%` 没有单位、没有分隔；当前行 `00:12` 与 `第 1 集 / 共 3 集` 的信息层级不稳定。
- 修法：统一为“已完成 0/3”“可直接播放”“学习目录”“切换到夜间模式”“60 秒 · 已看 30%”。这属于零风险文案修改，但能显著提升精致度。

---

### 2.3 哪些东西应该保留

- 三栏 + 停靠区的信息架构是合理的，不需要改成网页式导航。
- P3 的两行分集标题、keyed 增量渲染、键盘导航、焦点环、焦点归还都应该保留。
- 深色主题正文的对比度（`#e8ecf2` on `#171b22` = 14.56:1）很好，不要为了“通透”把正文变灰。
- 行内操作只在 hover/focus 时出现，方向是对的；只需增大命中区并统一图标。
- 当前 8px 圆角、克制的蓝，比很多花哨 UI 更接近“简约”。改造是“提纯”，不是“加装饰”。

---

## 3. 「清新 · 简约 · 通透」的设计方案

### 3.1 关键词如何落到规则

| 关键词 | 不是 | 而是 |
|---|---|---|
| 清新 | 高饱和渐变、荧光绿、插画堆满 | 带绿意的暖白/墨绿中性色 + 一个低饱和青绿主色；大面积留白；少量薄荷色块 |
| 简约 | 把所有东西变灰、变细 | 减少选择：一个视图一个主按钮；三档圆角；两种边框；五级字号；图标统一 |
| 通透 | 所有卡片都做毛玻璃 | 分层：画布 → 表面 → 浮层；只有浮层使用半透明 + blur；视频区保持纯黑，不玻璃化 |

### 3.2 推荐配色（可直接替换现有变量）

核心变化：**从默认蓝 `#2f6ff2 / #4f8cff` 换成“深青绿 + 薄荷”**，中性色从冷灰蓝换成微绿暖白/墨绿。它更贴近“学习、安静、清新”，也避开了 Windows 默认蓝的廉价感。

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` 画布 | `#f4f8f6` | `#0e1512` | 窗口底、空状态 |
| `--bg2` 表面 | `#ffffff` | `#141d19` | 面板、卡片 |
| `--bg3` 浅表面 | `#eef5f2` | `#1a2520` | hover、输入底、soft chip |
| `--line` 装饰线 | `#e2ebe7` | `#27342f` | 面板分隔、卡片边 |
| `--line-strong` 控件线 | `#b8cbc4` | `#3b514a` | 输入框、可交互边界 |
| `--text` | `#1b2823` | `#e9f2ee` | 主文字 |
| `--text-dim` | `#5d6f67` | `#9db0a8` | 元信息、副标题 |
| `--accent` 文字/描边 | `#0b7662` | `#6fe0c7` | 链接、当前项、focus |
| `--accent-fill` 按钮底 | `#0b7662` | `#35c7a8` | 主按钮 |
| `--on-accent` 按钮字 | `#ffffff` | `#05241c` | 主按钮文字 |
| `--accent-soft` | `#e7f4ef` | `rgba(53,199,168,.14)` | 当前行、选中底、进度轨 |
| `--ok` | `#137a4f` | `#5fd6a6` | 完成 |
| `--warn` | `#8a5a00` | `#f2bd6b` | 提醒 |
| `--danger` | `#b42318` | `#ff8a80` | 删除、错误 |
| `--player-bg` | `#080c0a` | `#080c0a` | 视频舞台，永远纯黑 |
| `--glass` | `rgba(255,255,255,.78)` | `rgba(14,21,18,.72)` | 仅浮层 |

已实测的对比度：

- 深青绿主色 on 白：**5.55:1**；白字 on 主色：**5.55:1**；主色 on 浅底：**4.91:1**。
- 次文字 on 白：**5.34:1**；on 画布：**4.98:1**。
- 深色薄荷 on 墨绿表面：**10.79:1**；深墨字 on 薄荷按钮底：**7.75:1**。
- 成功、提醒、危险在浅色模式均 ≥ 5.3:1。

> 如果只换颜色，也要同时改按钮：把 `.btn.primary` 从 `background: var(--accent); color:#fff` 改为 `background: var(--accent-fill); color: var(--on-accent)`，否则深色模式的薄荷底 + 白字仍然不合格（2.12:1）。

> `--line-strong` 是视觉加强线，不自动等于 WCAG 1.4.11 的 3:1 控件边界。如果团队按严格标准验收，输入框边线应加深到约 `#789288`（canvas 上约 3.13:1），或让控件底色产生更明显的色差；focus 环必须始终 ≥ 3:1。

若希望保留现有蓝色品牌，可将 `--accent` / `--accent-fill` 替换为 `#1f5fbf` 或 `#2563a8` 一类深蓝，并将中性色改为暖灰；但“清新”会弱一些，且更接近后台模板。

### 3.3 字体与排版

字体栈（不新增字体文件、不改 CSP）：

```css
font-family:
  -apple-system, BlinkMacSystemFont,
  "Segoe UI Variable Text", "Segoe UI",
  "Microsoft YaHei UI", "Microsoft YaHei",
  "PingFang SC", "Noto Sans SC",
  system-ui, sans-serif;
line-height: 1.6;
```

- 中文最小 12px；正文 14px；只保留 400 / 500 / 600 三个字重。
- 字阶：`24`（页面标题）、`15`（区块标题）、`14`（正文）、`13`（顶栏/按钮）、`12`（元信息）。
- 去掉所有中文 `letter-spacing`；只有英文大写或极短标签可用 `0.04em`。
- 时间、进度、计数统一 `font-variant-numeric: tabular-nums`。
- 两行分集标题行高 `1.45`，标题与元信息间距至少 2px。
- 页面标题（看板/空状态）真正用于建立锚点，不再只有 13px 灰色小字。

### 3.4 空间、几何与动效

- **间距基数 4px**：4 / 8 / 12 / 16 / 24 / 32。
- 高度：顶栏 56，面板头 44，播放控制条 56，普通控件 36，小控件 32，列表行 56。
- 圆角：10（按钮/输入）、14（卡片）、18（弹窗/浮层）、999（chip）。不再出现 6/7/8/12 混用。
- 阴影：只保留两档，且带色相——
  - 轻：`0 8px 24px rgba(27,40,35,.08)`（浅）/ `0 8px 28px rgba(0,0,0,.35)`（深）
  - 浮：`0 24px 64px rgba(27,40,35,.14)`（浅）/ `0 24px 64px rgba(0,0,0,.5)`（深）
- 过渡：`160ms ease-out`，只作用于 `background-color / border-color / color / box-shadow / transform`；`prefers-reduced-motion: reduce` 时关闭。
- 焦点：按钮用 `2px solid var(--accent)` + `2px` offset；输入框用 `0 0 0 3px var(--accent-soft), 0 0 0 1px var(--accent)` 的内外双环。两种都要在浅色/深色上可见。

### 3.5 “通透”的具体做法

通透感不是把一切都变透明，而是让用户感知到“层”：

1. **画布层**：`--bg` + 极淡的薄荷径向渐变（仅看板/空状态可见），避免大面积死白。
2. **表面层**：面板、卡片、列表使用 92–100% 不透明表面；不使用 blur，保证滚动文字清晰。
3. **浮层**：弹窗背板、popover、hover 预览、toast 使用 `color-mix` / `rgba` + `backdrop-filter: blur(14px) saturate(1.05)`；透明卡片用 88–94% 不透明，既透又读得清。
4. **视频舞台**：永远纯黑；可以给视频区 14px 圆角和内缩 12px（浅色下更像一块“屏幕”），但全屏时取消圆角和外边距。
5. **性能边界**：`backdrop-filter` 最多同时作用于 3–5 个浮层；静态面板不加；提供 `@supports not (backdrop-filter: blur(1px))` 的实色回退。

---

## 4. 组件级改造规格

### 4.1 顶栏

```text
[☰] 学习播放器   数学 / 高数 · 已完成 0/3       [🔍 搜索课程或分集 220px]
                                         [首页] [AI] [讲义] │ [目录] [＋导入] │ [☾] [?] [⚙]
```

- 使用 3 组视觉分隔：浏览/工具、资料、系统；分隔用 1px `--line`，组内 gap 4–8px。
- 系统项变成 36×36 SVG 图标按钮，保留 `aria-label` 和 `title`。
- “AI / 讲义”可以做图标 + 文字，但不要再同时让顶栏和 dock 两处高亮；顶栏只表达“停靠区是否打开”，dock 内部用页签表达“当前是哪一页”。
- 搜索：220–260px，左侧放大镜图标，placeholder 改为“搜索课程或分集”；`Ctrl+K` 放进 tooltip 或右侧 kbd 提示，不塞进输入框。
- 进度 chip：改成面包屑尾部的次文字“已完成 0/3”，不使用蓝底胶囊。
- 顶栏不再放实心主按钮；`＋导入` 改为描边/浅底次要按钮，主按钮回到内容区（空状态“打开学习目录”、看板“继续播放”、AI“发送”）。
- 窄窗策略：<1100px 搜索缩到 180px 并隐藏进度副文案；<1024px 课程标题省略、工具按钮只保留图标 + `title`；任何宽度都不允许顶栏换行或出现横向滚动。

### 4.2 按钮系统

| 类型 | 样式 | 高度 | 用途 |
|---|---|---:|---|
| Primary | 实心 `--accent-fill`，无边框，`--on-accent` 字 | 36 / 44 | 每个视图最多 1 个：继续播放、发送、确认 |
| Secondary | 表面 + 1px `--line`，深色字 | 36 | 讲义、目录、取消等普通动作 |
| Ghost | 透明，`--text-dim`，hover 浅表面 | 32 / 36 | 图标、工具栏、行内操作 |
| Danger | 透明或浅红底，`--danger` | 32 / 36 | 删除、清理 |
| Chip | `--accent-soft` 或 `--bg3`，999 圆角，12px | 24–28 | 快捷提问、范围标签 |
| Icon | 36×36 方形，图标 18–20 | 36 | 主题、帮助、设置、关闭 |

所有按钮统一：

```css
.btn {
  height: 36px;
  padding: 0 14px;
  border-radius: 10px;
  font: 500 13px/1 var(--ui-font);
  transition: background-color .16s ease-out, border-color .16s ease-out,
              color .16s ease-out, box-shadow .16s ease-out;
}
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: .45; cursor: not-allowed; pointer-events: none; }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

不要再用 `filter: brightness()` 做 hover；直接定义 `--accent-hover`。图标与文字间距 6px，图标 18px；同一屏内不要出现两种图标视觉重量。

### 4.3 输入、选择与进度

- 输入/选择框：36px 高，`--bg3` 浅底，1px `--line`，10px 圆角；focus 时边线转 `--accent` + 3px `--accent-soft` 光环；placeholder 用 `--text-dim`。
- `body { color-scheme: dark; }` / `body.light { color-scheme: light; }`，让原生下拉、autofill、滚动条至少跟随主题。
- `progress`：6px 高，圆角轨道 `--accent-soft`，填充 `--accent-fill`；去掉原生绿。
- `range`：4px 轨道，`--line`；已完成部分用 `--accent-fill` 渐变；14px 白色拇指 + 2px 主色描边；hover 加 4px 外围光环。
- 自定义 seek 的已播放部分需要一个 CSS 变量：
  ```js
  // 现有 onTimeUpdate 中加 1 行即可，不改变播放逻辑
  seekBar.style.setProperty('--seek-pct', `${pct}%`);
  ```
  如果希望 Phase 1 完全不改 JS，也可以只做“灰轨 + 主色圆点”，但完整度不如填充版本。

### 4.4 播放器

- 控制条 56px，按钮 36×36 Ghost，图标 18–20；时间 12px tabular；倍速选择 36px；全屏按钮在最右。
- `#playerPanel` 背景改为 `var(--bg)`；`#videoArea` 保持 `#080c0a`。
- 浅色主题空状态：浅色画布 + 72px 圆形图标（播放三角/文件夹线稿）+ 22px 标题 + 13px 说明 + 主次按钮。**彻底修复 A1。**
- 正在播放区：浅色主题下给视频舞台 14px 圆角、10px 内缩和轻阴影；深色主题可以全出血，避免“视频里套卡片”的多余感。
- 加载/错误遮罩：`rgba(6,10,8,.66)` + `backdrop-filter: blur(6px)`；错误文案用 `--warn` 但只占小面积；按钮统一 36px。

### 4.5 侧栏与分集行

- 面板头 44px，标题 12px `--text-dim`，去掉 letter-spacing；右侧搜索框 32px、无边框、淡底，获得焦点后再出现边框。
- 课程项 36px；active 使用 `--accent-soft` 底 + 左侧 3px 主色条 + 主文字 600；课程进度用 12px tabular，不再用蓝色。
- 分集行 56px；当前行左侧 3px 主色条；状态从“·”改成 20px 圆徽：
  - 未开始：无徽标或 6px 空心圆；
  - 进行中：主色圆 + 白色播放三角；
  - 完成：浅绿底 + 深绿勾。
- 元信息 `00:40 · 已看 30%` 用 12px；行内“讲义/打开”改为 28px Ghost 按钮，hover 才显形，但保留键盘可达（现有 `focus-within` 已满足）。
- 当前行标题保持主文字色 600；不要整行变蓝。蓝色/青色只留给状态与进度，降低“满屏蓝”的压迫。

### 4.6 看板

- 内容 `max-width: 1120px; margin-inline: auto; padding: 28px 32px 48px;`。
- 页面标题“学习看板”24px 600，副标题 13px `--text-dim`；不要只靠 13px 小标题。
- “继续学习”特色卡：14px 圆角；背景 `linear-gradient(135deg, var(--accent-soft), var(--surface) 58%)`；缩略图 180×101；进度 6px；CTA 放右侧，但信息区与 CTA 之间至少 24px，不要让进度条拉到 900px。
- 科目进度：一个软表面容器内按行分隔，不再每行一张白卡；名称 140px，进度自适应，分数 12px。
- 本周学习：一个软表面容器，2×2 网格，内部用 1px 分隔线；数值 20px，0 值用 `--text-dim`，正值才用主色；移动布局改 1×4 或 2×2 自适应。
- 1150px 以下改为单列，避免继续学习卡在窄窗里被压缩。

### 4.7 弹窗（设置 / 导入 / 帮助）

- 背板：`rgba(8,18,14,.32)` + `backdrop-filter: blur(6px)`；卡片 94% 表面 + 18px 圆角 + 浮动阴影。
- 宽度：设置 480px，帮助 560px，导入 460px；标题 17px 600；副标题/说明 12px。
- 表单按语义分组：学习目录 / 播放 / AI 助手；组间 20px 留白 + 一条 `--line`；组标题 14px 600，不再用 13px 灰字当唯一层级。
- 输入 36px；标签列宽 76px；`hint-row` 12px 行高 1.7；AI 测试按钮和结果同一行，结果用 success/warn 的可读深色。
- 底部操作栏 64px，右侧 36px 按钮；不要把“完成”做得比内容还抢眼。
- 移除 `.modal-card` 与 `.modal-body` 的嵌套 `overflow: auto` 风险：让卡片本身 `overflow: hidden`，只让 body 滚动。

### 4.8 AI 停靠区

- 340px 宽内减少层级：dock 页签头 44px → 消息区 → 快捷 chips → composer；把“上下文/清空”移进 composer 上方一行，减少一个工具条。
- Assistant 消息不使用灰色气泡，直接正文排版，行高 1.7，最大宽度 100%；User 消息用 `--accent-soft` 胶囊，右下角小圆角。去掉“我/AI”角色标签，减少噪音。
- 欢迎卡改为浅薄荷底 + 线稿图标；不要用整块灰底。
- composer：一张 12px 圆角卡片，内含 textarea + 底部操作（相机图标、上下文开关、发送）。focus-within 时整卡有主色光环；发送按钮 36px 主色。
- 相机/上下文/清空换成 SVG 图标；placeholder 改为“问点什么…”单行短句，Enter 提示放 tooltip 或 12px 辅助行。
- 页签改为文字 + 底部 2px 主色（或软胶囊），不再同时用背景 + 下边框 + 蓝色。

### 4.9 Toast、popover、hover 预览

- 统一 18px 圆角、88% 表面 + blur、细边、软阴影；toast 底部 24px，短文案一行，左侧状态图标。
- popover 最大宽度 360px；列表行 36px；不再用 0.5 不透明黑色阴影。
- hover 预览在窄窗口下限制在分集栏右侧 8px，避免压住播放器控制条；图片 16:9、圆角 10。

---

## 5. 实施计划（按风险从低到高）

### 5.1 文件触达面

| 文件 | 改动 | 风险 |
|---|---|---|
| `renderer/style.css` | token 替换、组件重绘、自定义 progress/range、状态与响应式 | 低（纯样式） |
| `renderer/index.html` | 顶栏分组、空状态 icon、SVG sprite、少量语义化 wrapper | 低（保留全部 id） |
| `renderer/components/topbar.js` | 主题按钮文案/aria、进度文案 | 极低 |
| `renderer/components/player.js` | 播放/静音图标切换、seek 变量 | 低 |
| `renderer/views/dashboard-view.js` | 页面标题/副标题、0 值 class（可选） | 低 |
| `renderer/components/ai-panel.js` | 相机图标、角色标签（可选） | 低 |
| `scripts/gen-icon.js` | 主色换青绿时同步 2 行色值并重生成 icon | 低 |
| `docs/refactor/baseline/*` | 审批后重新生成基线截图 | 无运行风险 |

**不碰**：`store.js`、`actions.js`、`api.js`、`preload.js`、`main.js` 的数据逻辑、26 个 IPC、文件扫描、播放/续播逻辑。不要重命名任何现有 id/class；新增 class 采用前缀，避免冒烟脚本和 UIA 失效。

### 5.2 Phase 1：只改 CSS，2–4 小时拿到 70%

1. 建分支/备份；记录当前基线与 `git diff`。
2. 替换 `:root` 与 `body.light` 的 20 个变量；新增 `--accent-fill / --on-accent / --line-strong / --surface / --glass / --radius-* / --shadow-*`。
3. 给 `body` / `body.light` 加 `color-scheme`；补 `::selection`、滚动条、placeholder、禁用态。
4. 修 `#playerPanel` 与 `#emptyState`：播放区黑、空状态随主题。
5. `.btn`、`.big-btn`、`.mini-btn`、`.ctl`、`.row-btn`、`.d-btn` 统一高度、圆角、四态；把 `brightness()` hover 换成变量。
6. 自定义 `progress` 与 `input[type=range]`；`select` 统一高度/背景。
7. 字号：11px → 12px（保留显式例外）；去掉中文 letter-spacing；补 line-height；时间/计数 tabular。
8. 面板头 44、列表行 56、看板 `max-width`、空状态对比度、深色主按钮对比度。
9. 跑 `npm run build && npm test`，再跑 `npm run smoke`；Phase 1 不改 DOM，`dom-snapshot` 应完全一致；8 张截图会按新样式自动刷新，逐张人工确认。

> 当前冒烟脚本每次都会把 8 张截图写回 `docs/refactor/baseline/`，但不做像素级自动比对；DOM 快照才会自动比对。因此不要把“截图能生成”误当成“视觉已验收”，Phase 1 后需要人工看图。

### 5.3 Phase 2：小结构收口，0.5–1 天

1. 在 `index.html` 放一个隐藏的 SVG symbol sprite（16–20 个图标：menu, search, home, sparkles, book, folder, plus, sun/moon, help, settings, play, pause, prev, next, volume, mute, fullscreen, camera, close, chevron）。
2. 顶栏按“浏览 / 工具 / 资料 / 系统”包 3 个 wrapper；不改变现有按钮 id 和点击委托。
3. 为空状态加图标容器与主/次按钮层级；空库侧栏/分集栏统一文案。
4. 看板加页面标题、最大宽度、特色卡、统计容器。
5. 设置弹窗分组；AI composer 收口；toast/popover 玻璃化。
6. 若采用青绿主色：同步 `scripts/gen-icon.js` 的图标色并执行 `npm run icon`；同时更新 `main.js` 窗口背景色（仅 1 行，可选）。
7. 若 Phase 2 改动了按钮文案、空状态结构或页面标题，运行 `npm run smoke:baseline` 更新 DOM 快照与截图，并在 `docs/refactor/baseline/README.md` 记录每张图的预期变化；旧基线保留在本地备份目录便于回滚。

### 5.4 验收方法

- 功能：`npm test`、`npm run smoke` 全绿；ID、焦点顺序、键盘路径、AI/讲义/导入/弹窗/续播不变。
- 视觉：980×620、1344×821、1920×1080 三档，深浅两主题，逐张截图对照。注意截图基线不是像素级自动门禁，需要人工审核。
- 对比度：正文/元信息/按钮 ≥ 4.5:1；大字号 ≥ 3:1；focus ring 在两种主题上都可见。
- 交互：Tab 走完全流程；hover/focus/disabled/active 四态明确；所有图标按钮有 `aria-label`。
- 主题：浅色空状态可读；深色主按钮可读；原生下拉/进度/滑块无默认绿/系统蓝；无闪黑。
- 密度：顶栏、面板头、行高、按钮高度使用统一 token；无 18–24px 的可点击目标（辅助按钮除外，但也要 ≥ 28px）。
- 动效：160ms；减少动态偏好下关闭；无布局抖动。

---

## 6. 可直接使用的 token 起步代码

```css
:root {
  color-scheme: dark;
  --bg: #0e1512;
  --bg2: #141d19;
  --bg3: #1a2520;
  --line: #27342f;
  --line-strong: #3b514a;
  --text: #e9f2ee;
  --text-dim: #9db0a8;
  --accent: #6fe0c7;
  --accent-fill: #35c7a8;
  --on-accent: #05241c;
  --accent-soft: rgba(53, 199, 168, .14);
  --accent-hover: #62d8bb;
  --ok: #5fd6a6;
  --warn: #f2bd6b;
  --danger: #ff8a80;
  --player-bg: #080c0a;
  --glass: rgba(14, 21, 18, .72);
  --radius-control: 10px;
  --radius-card: 14px;
  --radius-overlay: 18px;
  --shadow-soft: 0 8px 28px rgba(0, 0, 0, .35);
  --shadow-float: 0 24px 64px rgba(0, 0, 0, .5);
  --ui-font: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI",
    "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC",
    system-ui, sans-serif;
}

body.light {
  color-scheme: light;
  --bg: #f4f8f6;
  --bg2: #ffffff;
  --bg3: #eef5f2;
  --line: #e2ebe7;
  --line-strong: #b8cbc4;
  --text: #1b2823;
  --text-dim: #5d6f67;
  --accent: #0b7662;
  --accent-fill: #0b7662;
  --on-accent: #ffffff;
  --accent-soft: #e7f4ef;
  --accent-hover: #085c4c;
  --ok: #137a4f;
  --warn: #8a5a00;
  --danger: #b42318;
  --glass: rgba(255, 255, 255, .78);
  --shadow-soft: 0 8px 24px rgba(27, 40, 35, .08);
  --shadow-float: 0 24px 64px rgba(27, 40, 35, .14);
}

body {
  font-family: var(--ui-font);
  line-height: 1.6;
  background: var(--bg);
  color: var(--text);
}

.btn.primary {
  background: var(--accent-fill);
  border-color: transparent;
  color: var(--on-accent);
}
.btn.primary:hover { background: var(--accent-hover); filter: none; }

#playerPanel { background: var(--bg); }
#videoArea { background: var(--player-bg); }
#emptyState { background: var(--bg); }

progress {
  appearance: none;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--accent-soft);
}
progress::-webkit-progress-bar { background: var(--accent-soft); }
progress::-webkit-progress-value { background: var(--accent-fill); border-radius: 999px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    transition-duration: .01ms !important;
  }
}
```

---

## 7. 风险与约束

| 风险 | 对策 |
|---|---|
| `backdrop-filter` 在低端 Windows/远程桌面掉帧 | 只用于 3–5 个浮层；静态面板不用；提供实色回退；必要时用 8px 而非 24px blur |
| 换主色后应用图标仍为蓝色 | Phase 2 同步 `scripts/gen-icon.js` 并重新生成 Windows/macOS 图标；否则 Phase 1 先保留蓝色，仅修对比度 |
| 改 HTML 导致冒烟/UIA 选择器失效 | 不改现有 id；新增 class 加前缀；按钮文字变更单独提交、单独更新 `dom-snapshot` |
| 深色/浅色截图基线大面积变化 | 这是预期变化；Phase 1 先本地评审，Phase 2 后一次更新基线并保留旧图 |
| 中文 12px 在 125%/150% 缩放下仍偏小 | 用 Windows 125% 与 150% 实机复验；必要时正文 14、元信息 12.5/13，不回到 11 |
| 玻璃效果影响文字可读性 | 卡片/面板不玻璃；浮层 88–94% 不透明；正文区域始终实色 |
| 只改 CSS 时，顶栏仍然拥挤 | Phase 1 先降低按钮视觉权重、缩窄搜索；Phase 2 再做分组与图标，不把结构改造压进 Phase 1 |

---

## 8. 附录

### 8.1 当前实现的关键位置

| 问题 | 位置 |
|---|---|
| 浅色播放区固定黑 | `renderer/style.css:263` |
| 空状态标题继承深色文字 | `renderer/style.css:265-268` |
| 主按钮白字 / hover 提亮 | `renderer/style.css:79-86`、`:270-275` |
| 原生 range / progress | `renderer/style.css:318-325`、`:515` |
| 顶栏 9 个按钮 | `renderer/index.html:12-31` |
| 顶栏搜索宽度 | `renderer/style.css:92-101`、`:443-450` |
| 字号与中文 letter-spacing | `renderer/style.css:130-135`、`:471-473`、`:616-621` |
| 分集行三列引导 | `renderer/components/episode-row.js:53-74` |
| 播放器 Unicode 图标 | `renderer/components/player.js:80-83`、`:280-304` |
| AI 面板四段工具区 | `renderer/components/ai-panel.js:395-442` |
| 弹窗双层滚动风险 | `renderer/style.css:368-393` |
| 窗口背景固定深色 | `main.js:28` |
| 应用图标蓝色 | `scripts/gen-icon.js:4`、`:83` |

### 8.2 对比度计算口径

- 按 WCAG 2.1 相对亮度公式，sRGB，前景/背景均为实色；带透明度的颜色先与背景合成再计算。
- “AA 正文”要求 4.5:1；“大字号”要求 3:1；UI 控件边界与焦点环要求 3:1。
- 文中数字为静态计算的四舍五入值，截图 JPEG 压缩会带来 ±0.02 的取色误差，不影响结论。

### 8.3 一句话执行建议

**先做 Phase 1 的 8 个 CSS 动作：换 token、修空状态、拆主按钮颜色、接管 progress/range、统一按钮四态、去掉 11px、降低边框和阴影、看板限宽。** 这 8 个动作不需要改任何功能代码，预计半天内就能让项目从“工程默认值”变成“有设计感的半成品”；随后再决定是否投入 Phase 2 的顶栏与图标收口。
