// Боковая панель с вкладками. Контейнер просмотра позиционирован абсолютно
// (требование PDFViewer), поэтому место под панель освобождаем отступом.

import { $, $$, on } from '../dom.js';
import { get as getSetting, updateSettings } from '../settings.js';

export function createSidebar(app) {
  const sidebar = $('sidebar');
  const body = $('body');
  const tabs = $$('#sidebar .tabs button');
  const listeners = new Set();

  function applyOffset(open) {
    body.style.setProperty('--sidebar-offset', open ? `${sidebar.offsetWidth || 260}px` : '0px');
  }

  function apply(open) {
    sidebar.hidden = !open;
    applyOffset(open);
    $('btnSidebar').setAttribute('aria-pressed', String(open));
    $('btnSidebar').classList.toggle('active', open);
    // Ширина области изменилась — масштаб «по ширине» надо пересчитать.
    if (app.pdfViewer?.pdfDocument) app.pdfViewer.update();
    if (open) notify(activeTab());
  }

  function activeTab() {
    return tabs.find((tab) => tab.classList.contains('active'))?.dataset.tab || 'outline';
  }

  function notify(tab) {
    for (const listener of listeners) listener(tab);
  }

  function selectTab(name) {
    for (const tab of tabs) tab.classList.toggle('active', tab.dataset.tab === name);
    for (const panel of $$('#sidebar .panel')) panel.classList.toggle('active', panel.dataset.panel === name);
    notify(name);
  }

  for (const tab of tabs) {
    on(tab, 'click', () => {
      selectTab(tab.dataset.tab);
      if (sidebar.hidden) toggle(true);
    });
  }

  function toggle(force) {
    const open = force ?? sidebar.hidden;
    updateSettings({ sidebarOpen: open });
    apply(open);
  }

  on($('btnSidebar'), 'click', () => toggle());
  on(window, 'resize', () => applyOffset(!sidebar.hidden));

  apply(getSetting('sidebarOpen'));

  return {
    toggle,
    selectTab,
    open(tab) {
      if (tab) selectTab(tab);
      toggle(true);
    },
    get isOpen() {
      return !sidebar.hidden;
    },
    get activeTab() {
      return activeTab();
    },
    onTabChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
