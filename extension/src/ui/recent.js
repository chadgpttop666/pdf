// Недавние документы: список на стартовом экране и во вкладке боковой панели.
// Файл берётся из локальной базы, поэтому открывается одним щелчком, без
// повторного выбора в проводнике.

import { $, clear, el, formatBytes, formatDate } from '../dom.js';
import * as library from '../library.js';

export function createRecent(app) {
  const panelList = $('recentPanel');
  const welcomeList = $('welcomeRecent');

  async function open(record) {
    const blob = await library.loadFile(record.id);
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await app.openBytesFromLibrary(bytes, record);
      return;
    }
    if (record.url) {
      await app.openUrl(record.url, { name: record.name });
      return;
    }
    app.hud.show('Файл не сохранён в библиотеке — откройте его заново', { duration: 4000 });
  }

  async function forget(record) {
    await library.deleteDocument(record.id);
    await render();
  }

  function entry(record, { withDelete }) {
    const meta = [record.numPages ? `${record.numPages} с.` : '', formatBytes(record.size), formatDate(record.openedAt)]
      .filter(Boolean)
      .join(' · ');

    const button = el('button', { title: record.name, onclick: () => open(record) }, [
      el('span', { class: 'name' }, record.title || record.name),
      el('span', { class: 'meta' }, meta),
    ]);

    const children = [button];
    if (withDelete) {
      children.push(el('button', { class: 'icon', title: 'Убрать из списка', onclick: () => forget(record) }, '✕'));
    }
    return el('li', {}, children);
  }

  async function render() {
    let records = [];
    try {
      records = await library.listRecent(20);
    } catch (error) {
      console.warn('Не удалось прочитать список недавних', error);
    }

    clear(panelList);
    clear(welcomeList);

    if (!records.length) {
      panelList.append(el('p', { class: 'panel-empty' }, 'Здесь появятся документы, которые вы открывали'));
      return;
    }

    const panelUl = el('ul', { class: 'recent-list' });
    for (const record of records) panelUl.append(entry(record, { withDelete: true }));
    panelList.append(panelUl);

    for (const record of records.slice(0, 5)) welcomeList.append(entry(record, { withDelete: false }));
  }

  app.eventBus.on('documentopened', () => {
    // Список обновляем после того, как запись документа успела сохраниться.
    setTimeout(render, 300);
  });

  return { render, open };
}
