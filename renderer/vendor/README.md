# renderer/vendor

> **由 `scripts/sync-vendor.mjs` 生成，禁止手改。** 来源只允许本地 `node_modules`，运行时不联网。

## 库与版本

| 库 | 版本 | 许可证 | 源包路径 | 同步产物 |
|---|---|---|---|---|
| marked | 18.0.14 | MIT | `node_modules/marked` | `marked.min.js` |
| dompurify | 3.4.15 | (MPL-2.0 OR Apache-2.0) | `node_modules/dompurify` | `dompurify.min.js` |
| katex | 0.16.47 | MIT | `node_modules/katex` | `katex.min.js`<br>`katex.min.css` |

字体：KaTeX 自带 20 个 woff2（合计 259792 B），清单见 `manifest.json` 的 `fonts`。

<details><summary>字体文件</summary>

- `fonts/KaTeX_AMS-Regular.woff2` (28076 B, sha256 0cdd387c9590…)
- `fonts/KaTeX_Caligraphic-Bold.woff2` (6912 B, sha256 de7701e42cf1…)
- `fonts/KaTeX_Caligraphic-Regular.woff2` (6908 B, sha256 5d53e70ad607…)
- `fonts/KaTeX_Fraktur-Bold.woff2` (11348 B, sha256 74444efd593c…)
- `fonts/KaTeX_Fraktur-Regular.woff2` (11316 B, sha256 51814d270d06…)
- `fonts/KaTeX_Main-Bold.woff2` (25324 B, sha256 0f60d1b89793…)
- `fonts/KaTeX_Main-BoldItalic.woff2` (16780 B, sha256 99cd42a3c072…)
- `fonts/KaTeX_Main-Italic.woff2` (16988 B, sha256 97479ca6cce9…)
- `fonts/KaTeX_Main-Regular.woff2` (26272 B, sha256 c2342cd8b869…)
- `fonts/KaTeX_Math-BoldItalic.woff2` (16400 B, sha256 dc47344dbb6c…)
- `fonts/KaTeX_Math-Italic.woff2` (16440 B, sha256 7af58c5ec8f1…)
- `fonts/KaTeX_SansSerif-Bold.woff2` (12216 B, sha256 e99ae51144bf…)
- `fonts/KaTeX_SansSerif-Italic.woff2` (12028 B, sha256 00b26ac825e2…)
- `fonts/KaTeX_SansSerif-Regular.woff2` (10344 B, sha256 68e8c73ef42a…)
- `fonts/KaTeX_Script-Regular.woff2` (9644 B, sha256 036d4e95149b…)
- `fonts/KaTeX_Size1-Regular.woff2` (5468 B, sha256 6b47c40166b6…)
- `fonts/KaTeX_Size2-Regular.woff2` (5208 B, sha256 d04c54219f9e…)
- `fonts/KaTeX_Size3-Regular.woff2` (3624 B, sha256 73d591271b16…)
- `fonts/KaTeX_Size4-Regular.woff2` (4928 B, sha256 a4af7d414440…)
- `fonts/KaTeX_Typewriter-Regular.woff2` (13568 B, sha256 71d517d67827…)

</details>

## 同步与校验

```powershell
npm run sync-vendor                     # 从 node_modules 同步并重写 manifest / README
node scripts/sync-vendor.mjs --check    # 只校验；build 前自动执行，漂移即失败
```

版本在 `package.json` 的 `devDependencies` 中固定为精确版本；`sync-vendor` 会同时核对
package.json、node_modules 包版本、产物内版本标记三者，任一不一致直接报错。

## 生成时间 / 哈希策略

- **不写生成时间戳**：同一 node_modules 重复同步得到字节一致的产物与清单，避免无意义 diff；
  需要追溯时看 `manifest.json` 的版本组合与文件 sha256，或文件系统 mtime。
- `manifest.json` 记录每个 JS / CSS / 字体文件的 `bytes` 与 `sha256`，以及字体集合 digest。
- `scripts/build.mjs` 先执行 `--check`；通过后把 `marked.min.js`、`dompurify.min.js`、`katex.min.js`
  按固定顺序拼进 `renderer/dist/app.<hash>.js` 的前导。**vendor 内容变化必然改变入口 hash**，
  不依赖 `?v=N` 手工版本号。
- `katex.min.css` 与 `fonts/*.woff2` 仍外链（路径相对 CSS），内容由 manifest 校验；
  若升级 KaTeX，CSS/字体随同步更新，入口 hash 也会因 katex.min.js 变化。

## 运行时取用

- 现代入口：bundle 前导在 classic script 顶层执行三个 UMD 库，`window.marked / DOMPurify / katex`
  在应用 IIFE 之前就绪；`renderer/ui/rich-text.js` 继续走 marked → DOMPurify → KaTeX 管线。
- KaTeX 输出里的 style 属性由 `renderer/ui/rich-text.js` 先转成 `data-vds-style`，插入 DOM 后
  再用 CSSOM 回填；避免 `style-src 'self'` 违规，也不放宽 CSP。
- `?legacy=1`：同一入口已提供三个全局；万一缺失，`renderer/app.js` 的 legacy 分支会按
  `marked → dompurify → katex` 动态加载本目录文件，再加载 `lib-boot.js → renderer.js → ai.js`。
- CSP 仍为 `script-src 'self'`；没有内联脚本，也不放宽 CSP。
