import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRichStyles, renderRich } from '../renderer/ui/rich-text.js';

function fakeNode(css) {
  const node = {
    attrs: new Map([['data-vds-style', css]]),
    style: { cssText: '' },
    getAttribute(name) {
      return this.attrs.has(name) ? this.attrs.get(name) : null;
    },
    removeAttribute(name) {
      this.attrs.delete(name);
    },
  };
  return node;
}

test('applyRichStyles：data-vds-style 通过 CSSOM 回填并移除属性', () => {
  const node = fakeNode('height:2.0074em;vertical-align:-0.686em;');
  const root = { querySelectorAll: (sel) => (sel === '[data-vds-style]' ? [node] : []) };
  assert.equal(applyRichStyles(root), root);
  assert.equal(node.style.cssText, 'height:2.0074em;vertical-align:-0.686em;');
  assert.equal(node.attrs.has('data-vds-style'), false);
  assert.equal(applyRichStyles(null), null);
});

test('applyRichStyles：url()/expression() 等危险声明被丢弃', () => {
  const bad = fakeNode('background:url(http://x/a.png)');
  const root = { querySelectorAll: () => [bad] };
  applyRichStyles(root);
  assert.equal(bad.style.cssText, '');
  assert.equal(bad.attrs.has('data-vds-style'), false);
});

test('renderRich：KaTeX 的 style 转为 data-vds-style，HTML 中不出现 style 属性', () => {
  globalThis.window = {
    marked: {
      setOptions() {},
      parse: (s) => `<p>${s}</p>`,
    },
    DOMPurify: { sanitize: (h) => h },
    katex: {
      renderToString: (tex, opts) =>
        `<span class="katex${opts && opts.displayMode ? ' katex-display' : ''}" style="height:2em;vertical-align:-0.5em">${tex}</span>`,
    },
  };
  try {
    const html = renderRich('行内 $x^2$ 与公式');
    assert.match(html, /data-vds-style="height:2em;vertical-align:-0.5em"/);
    assert.ok(!/\sstyle="/.test(html), '不得保留会被 CSP 拦截的 style 属性');
    assert.match(html, /class="katex/);
  } finally {
    delete globalThis.window;
  }
});
