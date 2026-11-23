/**
 * AI 富文本渲染管线（P3 从 ai.js 平移，P4 补 CSP 合规）。
 *
 * 顺序：代码占位 → 公式占位 → marked → 代码回填 → DOMPurify → KaTeX 回填。
 * 占位符用 PUA 字符包裹，避免 marked 吃掉 LaTeX 的 _ * 等语法；
 * KaTeX trust:false（默认）输出可信，放在 sanitize 之后不引入风险。
 *
 * CSP：KaTeX 输出包含 style 属性，直接 innerHTML 会触发 style-src 违规
 * （且公式布局会丢失）。这里先把 style 收进 data-vds-style，插入 DOM 后
 * 再用 CSSOM（el.style.cssText）回填——CSSOM 赋值不受 CSP 限制，视觉与
 * KaTeX 原生输出一致，不需要放宽 CSP。调用方插入后必须调用 applyRichStyles。
 *
 * 依赖 vendor 暴露的 window.marked / window.DOMPurify / window.katex；
 * 任一缺失时退化为纯文本（绝不把未净化 HTML 写进 DOM）。
 */

import { esc } from './dom.js';

const PH_L = '\uE000';
const PH_R = '\uE001';
const STYLE_ATTR = 'data-vds-style';
let markedConfigured = false;

function vendor() {
  return {
    marked: typeof window !== 'undefined' ? window.marked : null,
    purifier: typeof window !== 'undefined' ? window.DOMPurify : null,
    katex: typeof window !== 'undefined' ? window.katex : null,
  };
}

function configureMarked(marked) {
  if (markedConfigured || !marked) return;
  try {
    marked.setOptions({ breaks: true, gfm: true });
  } catch {
    /* 老 marked 兼容 */
  }
  markedConfigured = true;
}

function stashPlaceholders(text) {
  const codeSlots = [];
  const kSlots = [];
  const pushK = (tex, display) => {
    kSlots.push({ tex: tex.trim(), display });
    return `${PH_L}K${kSlots.length - 1}${PH_R}`;
  };
  let s = String(text ?? '');
  s = s.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, (match) => `${PH_L}C${codeSlots.push(match) - 1}${PH_R}`);
  // 定界符四种写法都吃：$$..$$ 与 \(..\) / \[..\] 是模型常见输出，$..$ 兜底
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => pushK(tex, true));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => pushK(tex, true));
  s = s.replace(/\\begin\{(equation\*?|align\*?)\}([\s\S]+?)\\end\{\1\}/g, (_, _env, tex) => pushK(tex, true));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => pushK(tex, false));
  s = s.replace(/\$([^$\n]+?)\$/g, (_, tex) => pushK(tex, false));
  return { s, codeSlots, kSlots };
}

function codeToHtml(raw) {
  if (raw.startsWith('```')) {
    let body = raw.slice(3).replace(/```$/, '');
    const nl = body.indexOf('\n'); // 首行是 ```lang 标注
    if (nl >= 0) body = body.slice(nl + 1);
    return '<pre><code>' + esc(body.replace(/\s+$/, '')) + '</code></pre>';
  }
  return '<code>' + esc(raw.slice(1, -1)) + '</code>';
}

function katexToHtml(katex, slot) {
  try {
    return katex.renderToString(slot.tex, { displayMode: slot.display, throwOnError: false, strict: 'ignore' });
  } catch {
    return '<code>' + esc(slot.tex) + '</code>';
  }
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** KaTeX 只产生长度/对齐类声明；拒绝 url()/expression() 等可执行或外部引用 */
function isSafeStyleText(css) {
  if (!css || css.length > 500) return false;
  if (/url\s*\(|expression\s*\(|@import|javascript:/i.test(css)) return false;
  return /^[a-z0-9\s:;,.%#()!+\-*/]+$/i.test(css);
}

/** 把生成 HTML 里的 style 属性改存为 data-vds-style，避免 innerHTML 触 CSP */
function stashInlineStyles(html) {
  return String(html).replace(/\sstyle="([^"]*)"/g, (_, css) => ` ${STYLE_ATTR}="${escapeAttr(css)}"`);
}

/**
 * 插入后回填 KaTeX 的 style（CSSOM 不受 style-src 限制）。
 * 未带 data-vds-style 的节点不受影响；非法声明直接丢弃。
 */
export function applyRichStyles(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return root;
  for (const el of root.querySelectorAll(`[${STYLE_ATTR}]`)) {
    const css = el.getAttribute(STYLE_ATTR);
    el.removeAttribute(STYLE_ATTR);
    if (!isSafeStyleText(css)) continue;
    try {
      el.style.cssText = css;
    } catch {
      /* 非法声明：只丢样式，不影响文本 */
    }
  }
  return root;
}

/** Markdown + KaTeX → 已净化 HTML 字符串（style 暂存为 data-vds-style） */
export function renderRich(text) {
  const { marked, purifier, katex } = vendor();
  const raw = String(text ?? '');
  if (!marked || !purifier || !katex) return '<p>' + esc(raw) + '</p>';
  configureMarked(marked);

  const { s, codeSlots, kSlots } = stashPlaceholders(raw);
  let html;
  try {
    html = marked.parse(s);
  } catch {
    html = '<p>' + esc(s) + '</p>';
  }
  html = html.replace(new RegExp(`${PH_L}C(\\d+)${PH_R}`, 'g'), (_, i) => codeToHtml(codeSlots[+i]));
  html = purifier.sanitize(html);
  html = html.replace(new RegExp(`${PH_L}K(\\d+)${PH_R}`, 'g'), (_, i) => katexToHtml(katex, kSlots[+i]));
  return stashInlineStyles(html);
}
