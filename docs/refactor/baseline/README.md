# 基线（P0 建立，P1 / P2 / P3 / P4 / Liquid Glass / 无边框磨砂玻璃 更新）

由 `node scripts/smoke.mjs --write-baseline` 生成。

- 生成时间：2026-10-23T02:53:32.460Z
- 夹具：系统临时目录下的 `vds-fixture/library/数学`（由 scripts/fixtures/gen-fixture.mjs 生成）
- 截图：4 视图 × 2 主题，窗口 1344×821
- dom-snapshot.json：结构性快照；`docMatch` 为易变字段，比对时忽略

P1 更新说明：仅「讲义自动匹配」修复带来的行内事件按钮变化（默认悬停才可见，静态截图不变）。
P2 更新说明：主视图改为组件化壳 + keyed 增量渲染；8 张截图中 7 张逐像素一致，仅 dashboard 的「活跃天数」由 1 变 0——该值取决于一次毫秒级 timeupdate 是否恰好落在冒烟暂停前，属于统计时序，不是结构/样式变化。
P3 更新说明：P3 有明确视觉变化（停靠区、两行分集行、顶栏导航/帮助按钮、断点栏宽）。8 张截图全部有意变化；dashboard 的「活跃天数」仍可能因同一统计时序为 0。
P4 更新说明：内容哈希构建不改变视觉；截图前统一把鼠标移到左上角，消除空状态按钮 hover 的偶发像素差（empty-* 两图由 hover 态变为无 hover 态），其余 6 张逐像素一致。
Liquid Glass 更新说明：8 张截图全部有意变化。外壳改为 12px 留白 + 8px 间隙的悬浮玻璃面板，顶栏、左栏、分集栏、播放区、看板卡片均重新材质化；DOM 快照同步更新 topbar / nav / list / player / main 的 x/y/w/h。设计说明见 `docs/UI-液态玻璃与悬浮面板改造.md`。
无边框磨砂玻璃更新说明（2026-11-24）：8 张截图全部有意变化，DOM 快照未重写且仍然一致。全局去掉可见描边（含面板分隔线、输入 / 按钮描边、表格线），层级改由明度差与阴影表达；面板改为静态极光底上的磨砂玻璃（半透明底 + backdrop-filter + 细颗粒），顶栏分隔线换成 6px 空隙。布局几何未变：topbar / nav / list / player / dock / main 在 29 个场景下与 Liquid Glass 基线逐像素一致。基线未覆盖的场景（搜索下拉、Toast、弹窗、断点、?legacy=1）可用 `node ui-audit/capture-frosted.mjs` 抽查（截图不入库）。

重新生成会覆盖截图，请确认视觉变化是预期的。