/**
 * 导入弹窗（P3）：文件/文件夹/讲义；数据变更全部 dispatch 给 actions。
 * 宿主换成原生 <dialog>（Esc / 焦点陷阱 / 焦点归还 / 背板关闭由 ui/dialog 负责）。
 */

import { h } from '../ui/dom.js';

const TITLES = { videos: '导入视频', folder: '导入课程文件夹', docs: '导入讲义 / 习题' };

export function createImportDialog() {
  let dialogEl = null;
  let dialog = null;
  let ctx = null;
  let openCtx = null;
  let isOpen = false;
  let busy = false;
  let card = null;

  function $id(id) {
    return dialogEl ? dialogEl.querySelector(`#${id}`) : document.getElementById(id);
  }

  function setSummary(nodes) {
    $id('importSummary').replaceChildren(...nodes);
  }

  function renderSummary(context) {
    const nodes = [];
    if (context.type === 'folder') {
      context.dirs.forEach((dir, i) => {
        if (i) nodes.push(h('br'));
        nodes.push(dir);
      });
      nodes.push(h('br'), `共 ${context.dirs.length} 个课程文件夹（内部视频自动成集、文档自动归为讲义）`);
    } else {
      const names = context.files.map((f) => '· ' + f.split(/[\\/]/).pop());
      names.slice(0, 8).forEach((name, i) => {
        if (i) nodes.push(h('br'));
        nodes.push(name);
      });
      if (names.length > 8) nodes.push(h('br'), `… 共 ${names.length} 个文件`);
    }
    setSummary(nodes);
  }

  function subjectOptions(state) {
    const select = $id('impSubject');
    const options = state.library.subjects.map((s) => new Option(s.name, s.name));
    if (!state.library.subjects.length || openCtx.type !== 'docs') options.push(new Option('新建科目…', '__new__'));
    select.replaceChildren(...options);
  }

  function refreshCourseOptions() {
    const state = ctx.store.get();
    const subjectName = $id('impSubject').value;
    const isNewSubject = subjectName === '__new__';
    $id('impNewSubjectField').classList.toggle('hidden', !isNewSubject);

    const courseField = $id('impCourseField');
    const courseSelect = $id('impCourse');
    courseField.classList.add('hidden');

    if (openCtx && openCtx.type === 'docs') {
      const all = [];
      for (const subject of state.library.subjects) for (const course of subject.courses) all.push({ subject, course });
      courseField.classList.toggle('hidden', all.length === 0);
      courseSelect.replaceChildren(...all.map(({ subject, course }) => new Option(`${subject.name} / ${course.name}`, course.key)));
    } else if (!isNewSubject) {
      const subject = state.library.subjects.find((x) => x.name === subjectName);
      const customs = subject ? subject.courses.filter((c) => c.custom) : [];
      courseField.classList.remove('hidden');
      courseSelect.replaceChildren(
        new Option('新建课程…', '__new__'),
        ...customs.map((c) => new Option(`${c.name}（已导入课程，追加）`, c.key)),
      );
      if (!customs.length) courseSelect.value = '__new__';
    }
    toggleNewCourseField();
  }

  function toggleNewCourseField() {
    const isNew = $id('impCourse').value === '__new__';
    const visible = !$id('impCourseField').classList.contains('hidden');
    $id('impNewCourseField').classList.toggle('hidden', !(isNew && visible));
    $id('impNewCourse').value = '';
  }

  function render(context, state) {
    $id('importTitle').textContent = TITLES[context.type] || '导入';
    renderSummary(context);
    subjectOptions(state);
    $id('impNewSubjectField').classList.add('hidden');
    $id('impNewSubject').value = '';
    refreshCourseOptions();
  }

  async function confirm() {
    if (busy || !openCtx) return;
    let subjectName = $id('impSubject').value;
    if (subjectName === '__new__') {
      subjectName = $id('impNewSubject').value.trim();
      if (!subjectName) {
        $id('impNewSubject').focus();
        return;
      }
    }
    const courseVisible = !$id('impCourseField').classList.contains('hidden');
    const courseKey = courseVisible ? $id('impCourse').value : '__new__';
    const courseName = courseKey === '__new__' ? $id('impNewCourse').value.trim() : '';
    if (openCtx.type === 'videos' && courseKey === '__new__' && !courseName) {
      $id('impNewCourse').focus();
      return;
    }

    busy = true;
    try {
      const ok = await ctx.store.dispatch('applyImport', openCtx, { subject: subjectName, courseKey, courseName });
      if (!ok) ctx.toast.show('导入失败：请检查科目与课程名称');
    } finally {
      busy = false;
    }
  }

  function onSelectChange(event) {
    if (event.target.id === 'impSubject') refreshCourseOptions();
    else if (event.target.id === 'impCourse') toggleNewCourseField();
  }

  function onDialogClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('#impCancel')) {
      ctx.store.dispatch('setModal', null);
      return;
    }
    if (target.closest('#impConfirm')) confirm();
  }

  function adopt(container) {
    const legacy = container;
    card = legacy.querySelector('.modal-card');
    dialogEl = h('dialog', {
      id: 'importModal',
      class: 'modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'importTitle',
    });
    if (card) dialogEl.append(card);
    legacy.replaceWith(dialogEl);
    dialogEl.classList.remove('hidden');
    dialog = ctx.ui.createDialog(dialogEl, {
      closeOnBackdrop: true,
      initialFocus: '#impSubject',
      returnFocus: '#btnImport',
      onClose: () => {
        if (ctx.store.get().ui.modal === 'import') ctx.store.dispatch('setModal', null);
      },
    });
  }

  function mount(container, context) {
    ctx = context;
    adopt(container);
    dialogEl.addEventListener('click', onDialogClick);
    dialogEl.addEventListener('change', onSelectChange);
    return { update, destroy };
  }

  function update(state) {
    const context = state.ui.modal === 'import' ? state.ui.importCtx : null;
    const open = !!context;
    if (open) {
      if (!isOpen || context !== openCtx) {
        openCtx = context;
        render(context, state);
      }
      isOpen = true;
      if (!dialog.isOpen()) dialog.show();
    } else {
      if (isOpen) dialog.close();
      openCtx = null;
      isOpen = false;
    }
  }

  function destroy() {
    dialogEl?.removeEventListener('click', onDialogClick);
    dialogEl?.removeEventListener('change', onSelectChange);
    dialog = null;
    dialogEl?.remove();
    dialogEl = null;
  }

  return { mount, update, destroy };
}
