/**
 * P3 快捷键服务与焦点陷阱纯函数单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createShortcuts, isTypingTarget, normalizeCombo, SHORTCUT_SCOPES,
} from '../renderer/ui/shortcuts.js';
import { focusWrapTarget } from '../renderer/ui/dialog.js';

function evt(key, { ctrl = false, meta = false, alt = false, shift = false, target = { tagName: 'DIV' } } = {}) {
  const calls = { prevented: 0 };
  return {
    key,
    ctrlKey: ctrl,
    metaKey: meta,
    altKey: alt,
    shiftKey: shift,
    target,
    preventDefault() { calls.prevented++; },
    calls,
  };
}

test('normalizeCombo：mod 修饰、空格、大小写', () => {
  assert.deepEqual([...normalizeCombo('Ctrl+K').mods], ['ctrl']);
  assert.equal(normalizeCombo('Ctrl+K').key, 'k');
  assert.equal(normalizeCombo('mod+i').key, 'i');
  assert.deepEqual([...normalizeCombo('mod+i').mods], ['mod']);
  assert.equal(normalizeCombo('space').key, 'space');
  assert.deepEqual([...normalizeCombo('shift+arrowleft').mods], ['shift']);
  assert.deepEqual(SHORTCUT_SCOPES, ['dialog', 'input', 'global', 'player']);
});

test('isTypingTarget：输入框 / 下拉 / 文本域 / contentEditable', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
  assert.equal(isTypingTarget(null), false);
});

test('作用域：输入框聚焦不触发 player，global 仍可触发', () => {
  const seen = [];
  const sc = createShortcuts({ isTyping: (t) => t && t.tagName === 'INPUT', isDialogOpen: () => false });
  sc.register('space', () => seen.push('player'), { scope: 'player' });
  sc.register('mod+k', () => seen.push('global'), { scope: 'global' });
  sc.register('escape', () => seen.push('input'), { scope: 'input' });

  const input = { tagName: 'INPUT' };
  assert.equal(sc.handle(evt(' ', { target: input })), false);
  assert.equal(sc.handle(evt('k', { ctrl: true, target: input })), true);
  assert.equal(sc.handle(evt('Escape', { target: input })), true);
  assert.deepEqual(seen, ['global', 'input']);
});

test('作用域：弹窗打开时只走 dialog/global，player 不触发', () => {
  const seen = [];
  const sc = createShortcuts({ isTyping: () => false, isDialogOpen: () => true });
  sc.register('escape', () => seen.push('player'), { scope: 'player' });
  sc.register('escape', () => seen.push('dialog'), { scope: 'dialog' });
  sc.register('mod+k', () => seen.push('global'), { scope: 'global' });
  assert.equal(sc.handle(evt('Escape')), true);
  assert.deepEqual(seen, ['dialog']);
  assert.equal(sc.handle(evt('k', { ctrl: true })), true);
  assert.deepEqual(seen, ['dialog', 'global']);
});

test('mod 同时匹配 Ctrl 与 Meta；未声明的修饰键不误吞', () => {
  const seen = [];
  const sc = createShortcuts({ isTyping: () => false, isDialogOpen: () => false });
  sc.register('mod+i', () => seen.push('mod'), { scope: 'global' });
  sc.register('f', () => seen.push('f'), { scope: 'player' });
  assert.equal(sc.handle(evt('i', { ctrl: true })), true);
  assert.equal(sc.handle(evt('i', { meta: true })), true);
  assert.equal(sc.handle(evt('f', { ctrl: true })), false); // Ctrl+F 不误触全屏
  assert.equal(sc.handle(evt('f')), true);
  assert.deepEqual(seen, ['mod', 'mod', 'f']);
});

test('? 允许 Shift；shift+arrowleft 精确匹配', () => {
  const seen = [];
  const sc = createShortcuts({ isTyping: () => false, isDialogOpen: () => false });
  sc.register('?', () => seen.push('help'), { scope: 'global' });
  sc.register('arrowleft', () => seen.push('left'), { scope: 'player' });
  sc.register('shift+arrowleft', () => seen.push('shift-left'), { scope: 'player' });
  assert.equal(sc.handle(evt('?', { shift: true })), true);
  assert.equal(sc.handle(evt('ArrowLeft')), true);
  assert.equal(sc.handle(evt('ArrowLeft', { shift: true })), true);
  assert.deepEqual(seen, ['help', 'left', 'shift-left']);
});

test('when=false 跳过、后注册优先、可解绑、preventDefault 可控', () => {
  const seen = [];
  const sc = createShortcuts({ isTyping: () => false, isDialogOpen: () => false });
  sc.register('a', () => seen.push('a'), { scope: 'player', when: () => false });
  const off = sc.register('a', () => seen.push('a2'), { scope: 'player' });
  const event = evt('a');
  assert.equal(sc.handle(event), true);
  assert.equal(event.calls.prevented, 1);
  assert.deepEqual(seen, ['a2']);
  off();
  assert.equal(sc.handle(evt('a')), false);
  sc.register('b', () => seen.push('b'), { scope: 'player', preventDefault: false });
  const b = evt('b');
  assert.equal(sc.handle(b), true);
  assert.equal(b.calls.prevented, 0);
});

test('focusWrapTarget：Tab / Shift+Tab 在首尾回绕', () => {
  assert.equal(focusWrapTarget(3, 2, false), 0);
  assert.equal(focusWrapTarget(3, 1, false), -1);
  assert.equal(focusWrapTarget(3, 0, true), 2);
  assert.equal(focusWrapTarget(3, 1, true), -1);
  assert.equal(focusWrapTarget(3, -1, false), 0);
  assert.equal(focusWrapTarget(3, -1, true), 2);
  assert.equal(focusWrapTarget(0, -1, false), -1);
});
