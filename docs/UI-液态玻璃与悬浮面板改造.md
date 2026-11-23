# 学习播放器 · 液态玻璃（Liquid Glass）与悬浮面板改造

> 版本：v0.4.4 · 2026-10-23  
> 范围：`renderer/style.css` 的视觉层；不改数据、IPC、播放内核、组件 DOM 与快捷键。  
> 结论：保留原有墨绿夜色 / 雾青纸感两套色板，把贴边实色面板改为悬浮玻璃板；`npm run build`、74 项单测、118 项 smoke 断言全部通过。

> **2026-11 更新**：本文的材质层（1px 高光描边 + 斜向高光带）已被「无边框 · 阴影 · 磨砂玻璃」取代，现状以 `renderer/style.css` 头部说明为准。
> 仍然有效的部分：两套色板、第 2.3 节的悬浮几何（12px 留白 / 8px 间隙 / 20px 圆角）、第 4 节断点与第 5 节层叠结论。
> 第 8 节的回滚步骤已不适用：恢复本文描述的样子，直接用 `.backup/pre-frosted-20261123-230808/renderer/style.css` 覆盖即可。
> 下文的截图已改为指向改造前的留档。

![浅色 · 课程页](../ui-audit/baseline-before-frosted/course-light.png)

![深色 · 课程页](../ui-audit/baseline-before-frosted/course-dark.png)

---

## 1. 目标与边界

这次改造只回答两个问题：

1. **同一套颜色，怎样看起来更像一块玻璃？** 不新增色相，所有玻璃色都由 `--bg / --bg2 / --bg3 / --text / --accent / --ok / --warn` 用 `color-mix()` 派生。
2. **同一套布局，怎样让面板“浮”起来？** 窗户外壳留白 12px、面板间隙 8px、20px 圆角，视频区仍然是纯黑嵌入卡。

明确不动的部分：

- 主色仍是 `#6fe0c7 / #35c7a8`（暗色）、`#0b7662`（浅色）；
- 画布仍是 `#0e1512`（暗色）、`#f4f8f6`（浅色）；
- 三栏 + 停靠区的容器查询断点、侧栏抽屉、停靠区浮层逻辑、快捷键与焦点管理；
- `#videoArea` 永远 `--player-bg (#080c0a)`，不参与玻璃化。

---

## 2. 设计语言

### 2.1 三层玻璃

| 层 | 做法 | 目的 |
|---|---|---|
| 底 | 环境底色 + 4 团大范围青绿/暖色 radial 光晕（`body::before`） | 给玻璃提供可折射的环境色，避免“玻璃贴在纯色墙上” |
| 面 | 半透明面板底 + 一层从主色派生的 tint + `backdrop-filter: blur(26px) saturate(1.6)` | 形成磨砂、色散和透光 |
| 边 | 1px 高光边（`inset 0 1px 0`）+ 斜向高光带（`::before`）+ 柔和外阴影 | 模拟玻璃片边缘接住光线的镜面反射 |

高光带是绝对定位伪元素、`z-index: -1`，压在内容下面，只在空白玻璃和面板边缘可见，不会盖住文字。所有面板共用一个材质选择器，避免每个组件各写一套玻璃。

### 2.2 颜色派生

| 角色 | 暗色 | 浅色 |
|---|---|---|
| 面板底 | `color-mix(in srgb, var(--bg2) 62%, transparent)` | `color-mix(in srgb, #ffffff 58%, transparent)` |
| 浮层底 | `bg2 84%` | `#ffffff 84%` |
| 弹窗底 | `bg2 92%`（表单可读性优先） | `#ffffff 92%` |
| 高光 | `rgba(255,255,255,.18)` | `rgba(255,255,255,.95)` |
| 描边 | `color-mix(in srgb, var(--text) 12%, transparent)` | `color-mix(in srgb, var(--text) 10%, transparent)` |
| 玻璃 tint | `color-mix(in srgb, var(--accent) 9%, transparent)` | `color-mix(in srgb, var(--accent) 8%, transparent)` |

暗色的 `--glass-fill` 从 66% 降到 62%、tint 从 7% 提到 9%，是为了让墨绿环境透进面板；浅色从 64% 降到 58%，让雾青底色参与成色。文字颜色一个都没改，正文对比度仍在 AA 以上。

### 2.3 悬浮几何

| 元素 | 数值 |
|---|---|
| 窗外壳留白 | `--shell-pad: 12px` |
| 面板间隙 | `--shell-gap: 8px` |
| 面板圆角 | `--panel-radius: 20px` |
| 面板内小岛圆角 | `--panel-radius-inner: 14px` |
| 控件 / 输入 | 10–12px，搜索框为胶囊 999px |
| 弹窗 | 24px |
| 模糊 | 面板 26px；弹窗遮罩 20px；遮罩层 10px |

顶栏是 56px 高的悬浮胶囊；播放区、左栏、分集栏、停靠区各自是一块独立玻璃；播放区内部再用 10px 内边距托起纯黑视频卡与独立控制条。

---

## 3. 组件落点

| 区域 | 处理 |
|---|---|
| 顶栏 `#topbar` | 悬浮胶囊、z-index 45（保证搜索下拉盖过停靠区）；导入按钮改为 accent 玻璃，不再实心抢层级 |
| 左栏 / 分集栏 | 独立圆角玻璃，选中行用 15% accent 玻璃 + 3px 内嵌主色条 |
| 播放区 `#playerPanel` | 玻璃外框 + 纯黑 `#videoArea` + 半透明控制条；全屏时去掉圆角与玻璃边 |
| 停靠区 `#dock` | 与播放区同高的玻璃板；页签改为玻璃分段控件；浮层模式保持圆角与遮罩 |
| 看板 | 画布透明，卡片浮在环境底上；周统计 2×2 小玻璃块 |
| 弹窗 / 下拉 / Toast | 更实的玻璃底、24px 圆角、柔和大阴影；表单弹窗用 92% 不透明度保证可读性 |
| 输入 / 按钮 | 半透明表面 + 内高光，不再是一排 1px 边框；焦点环保持 accent 4px 扩散 |
| 滚动条 | 用 `color-mix(text 16%)` 降低存在感 |

---

## 4. 布局与断点

新增 8px 间隙后，原有断点需要精确补偿：

- 停靠区常驻阈值仍为容器宽度 `1072px`，但 1280px 以上钳制公式减去 3 道 8px 间隙：`calc(100cqw - nav - list - player-main - 24px)`；
- 停靠区宽度范围从 `280–340` 放宽到 `276–340`，保证 1280px 窗口下播放器仍有 420px；
- 窗口 `1072–1119px` 是“停靠区常驻 + 播放器 ≥420”的临界区：外壳临时收紧为 `pad 4 / gap 6 / player-min 394`，1100px 时播放器为 422px；
- 1120px 起恢复 `pad 12 / gap 8`，此时播放器回到 420px；
- 窗口 ≤900px 时外壳统一 8px，减少小窗占用。

验证结果（smoke）：

| 视口 | 结果 |
|---|---|
| 1344×821 | 停靠区 340px，播放器 420px，无横向溢出 |
| 1100×700 | 导航 64 / 分集 288 / 停靠 300，停靠区常驻，播放器 422px |
| 980×620 | 停靠区为浮层，播放器 ≥420，无横向溢出 |

---

## 5. 层叠与交互修复

玻璃化会引入新的 stacking context，本次一并处理：

- `#topbar`：`position: relative; z-index: 45`，搜索下拉不会被 `#dock` 或播放面板盖住；
- `#episodePanel`：`z-index: 20`，让栏内的 `#hoverPreview`（z-index 40）能盖过后面的播放面板；
- `#dock` 仍为 30、弹窗 50、Toast 80；
- 抽屉/停靠遮罩增加 10px 背景模糊，打开浮层时聚焦当前面板；
- 面板的 `::before` 高光只画在内容下面，不拦截点击；
- 所有原有 `:focus-visible`、Tab 焦点陷阱、Esc 关闭、抽屉焦点归还逻辑均未改动。

---

## 6. 验证与证据

```text
npm run build                通过（入口 hash 不变：app.bc1ec9f030.js）
node --test test/*.test.mjs  74 / 74 通过
node scripts/smoke.mjs       118 / 118 通过
```

smoke 额外覆盖并全部通过：

- 1344 / 1100 / 980 三档断点、深浅两主题、99 集真实数据；
- 原生 `<dialog>` 设置、导入、帮助弹窗的焦点陷阱与 Esc 归位；
- 全局搜索、停靠区页签、分集悬停预览；
- 无未捕获异常、无 console.error、无 CSP violation；
- `?legacy=1` 旧界面同样叠加玻璃材质，功能不受影响。

补充抽查脚本：`node ui-audit/capture-liquid.mjs`，输出到 `ui-audit/liquid-shots/`，覆盖 1100 / 980 断点、深色设置、浅色导入、浅色帮助与悬停预览。

![浅色 · 导入弹窗](../ui-audit/liquid-shots/import-light.png)

![980 · AI 浮层](../ui-audit/liquid-shots/980-ai-dark.png)

![深色 · 设置弹窗](../ui-audit/liquid-shots/settings-dark.png)

---

## 7. 可访问性与降级

- `@supports not (backdrop-filter: blur(1px))`：所有玻璃面板退回 `--bg2` 实色；
- `prefers-reduced-transparency: reduce`：关闭模糊与伪元素环境底，改用实色；
- `prefers-reduced-motion: reduce`：沿用全局规则，关闭过渡/动画；
- 关键正文、表单、按钮仍使用原有高对比文字色；弹窗单独提高填充不透明度；
- 视频区始终纯黑，浅色主题下不再出现“黑块空状态”问题（空状态放在玻璃面板的浅色表面）。

---

## 8. 回滚方式

本次只改 `renderer/style.css`（另有基线截图与文档）。回滚时：

1. 删除 `style.css` 末尾 `Liquid Glass · 悬浮面板` 整段，以及 `:root / body.light` 中新增的 `--shell-* / --glass-* / --ambient-*` token；
2. 恢复停靠区公式 `24px → 0`、`276px → 280px`，删除 1072–1119 的临时媒体查询；
3. 如需恢复视觉基线，使用 `ui-audit/baseline-before-liquid/` 中的旧截图与 `dom-snapshot.json`；
4. 无需重新构建 JS，入口 hash 不受 CSS 影响。

---

## 9. 后续可选项（未实现）

- 指针跟随的镜面高光（需要少量 JS 写入 `--mx / --my`）；
- 环境光晕的极慢漂移（会持续触发 backdrop 重算，默认不做，避免播放时占用 GPU）；
- 圆角面板出现/收起时的形变动画（需接入 `View Transition` 或 FLIP，超出本次纯 CSS 范围）。
