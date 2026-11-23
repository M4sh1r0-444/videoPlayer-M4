/**
 * P2 增量渲染基础单测：keyed patch 复用节点 / 排序 / 删除，LRU 上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { patchRows } from '../renderer/ui/list-patch.js';
import { createLru } from '../renderer/ui/lru.js';

class FakeNode {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.parent = null;
    this.textContent = '';
  }
  insertBefore(node, ref) {
    if (node.parent) node.parent.removeChild(node);
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parent = this;
  }
  appendChild(node) {
    this.insertBefore(node, null);
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parent = null;
  }
  remove() {
    if (this.parent) this.parent.removeChild(this);
  }
}

test('patchRows：key 相同复用节点，只做必要的移动/删除', () => {
  const container = new FakeNode();
  const created = [];
  const updated = [];
  const items = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
  ];
  const options = {
    key: (item) => item.id,
    create: (item) => {
      const node = new FakeNode();
      created.push(item.id);
      return node;
    },
    update: (node, item) => {
      updated.push(item.id);
      if (node.textContent !== item.text) node.textContent = item.text;
    },
  };

  patchRows(container, items, options);
  assert.deepEqual(created, ['a', 'b', 'c']);
  const [a, b, c] = container.children;
  assert.deepEqual(container.children.map((n) => n.textContent), ['A', 'B', 'C']);

  // 顺序变化 + 删除 + 新增：a/b/c 节点应复用，只新增 d
  patchRows(container, [
    { id: 'b', text: 'B2' },
    { id: 'a', text: 'A' },
    { id: 'd', text: 'D' },
  ], options);
  assert.deepEqual(created, ['a', 'b', 'c', 'd']);
  assert.equal(container.children[0], b);
  assert.equal(container.children[1], a);
  assert.equal(container.children[2].textContent, 'D');
  assert.equal(container.children.includes(c), false);
  assert.equal(container.children.length, 3);
  assert.equal(a.textContent, 'A');
  assert.equal(b.textContent, 'B2');
  assert.ok(updated.includes('a'));
});

test('patchRows：空列表清空容器', () => {
  const container = new FakeNode();
  const options = {
    key: (x) => x,
    create: () => new FakeNode(),
    update: () => {},
  };
  patchRows(container, ['a', 'b'], options);
  patchRows(container, [], options);
  assert.equal(container.children.length, 0);
});

test('createLru：访问提升、超限逐出最久未用', () => {
  const lru = createLru(3);
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('c', 3);
  assert.equal(lru.get('a'), 1); // a 变为最新
  lru.set('d', 4); // 逐出 b
  assert.equal(lru.has('b'), false);
  assert.equal(lru.size(), 3);
  assert.deepEqual(lru.keys(), ['c', 'a', 'd']);
  lru.set('a', 9);
  assert.equal(lru.size(), 3);
  assert.deepEqual(lru.keys(), ['c', 'd', 'a']);
});
