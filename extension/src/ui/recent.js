// Недавние документы: список на стартовом экране и во вкладке боковой панели.
// Файл берётся из локальной базы, поэтому открывается одним щелчком, без
// повторного выбора в проводнике.

import { $, clear, el, formatBytes, formatDate } from '../dom.js';
import * as library from '../library.js';
import { get as getSetting } from '../settings.js';
import { OWN_PRODUCER } from '../text-index.js';
import { icon } from './icons.js';

export function createRecent(app) {
  const panelList = $('recentPanel');
  const welcomeList = $('welcomeRecent');

  async function open(record) {
    const stored = await library.loadFileEntry(record.id);
    if (stored?.blob) {
      const bytes = new Uint8Array(await stored.blob.arrayBuffer());
      // Книга FB2/EPUB — верстается заново: по нынешним настройкам (переносы).
      if (stored.kind === 'book') await app.openBookFromLibrary(bytes, stored.name, record);
      else {
        await app.openBytesFromLibrary(bytes, record);
        // Книга, сохранённая до 0.28.3 уже свёрстанной: переверстать её не из чего.
        const meta = getSetting('bookNoHyphens') ? await app.loader.pdfDocument?.getMetadata().catch(() => null) : null;
        if (meta?.info?.Producer === OWN_PRODUCER) {
          app.hud.show('Эта книга сохранена в «Недавних» прежней версией — уже свёрстанной, с переносами. Откройте её файл FB2/EPUB через «Открыть» один раз — дальше и отсюда она будет без переносов', {
            duration: 9000,
          });
        }
      }
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
      const remover = el('button', { class: 'icon', title: 'Убрать из списка', onclick: () => forget(record) });
      remover.append(icon('close'));
      children.push(remover);
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
