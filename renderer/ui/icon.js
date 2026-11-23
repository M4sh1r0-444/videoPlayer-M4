/**
 * Phase 2：内联 SVG 图标工厂。
 *
 * 图标本体统一放在 index.html 的隐藏 symbol sprite 中，这里只创建
 * `<svg><use href="#i-..."></use></svg>` 节点。所有图标沿用
 * stroke=1.75 / currentColor，不发起网络请求，也不依赖图标字体。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} name sprite 中的 symbol 名（不含 i- 前缀）
 * @param {{ size?: number, className?: string }} [options]
 */
export function svgIcon(name, { size = 18, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className ? `ico ${className}` : 'ico');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
