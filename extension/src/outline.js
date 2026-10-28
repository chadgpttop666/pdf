// Оглавление документа: дерево с номерами страниц и подсветкой раздела, в
// котором сейчас читатель. Переход — через PDFLinkService, он понимает и
// именованные, и явные назначения.

import { clear, el } from './dom.js';
import { icon } from './ui/icons.js';

const normalizeTitle = (title) => (title || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Книги, сконвертированные из FB2 и Word, часто повторяют один и тот же
 * заголовок на нескольких уровнях: «Предисловие → Предисловие → Предисловие».
 * Такие цепочки из единственного одноимённого потомка схлопываем в один пункт.
 */
export function simplifyOutline(items = []) {
  return items.map((item) => {
    let node = { ...item, items: simplifyOutline(item.items || []) };
    while (node.items.length === 1 && normalizeTitle(node.items[0].title) === normalizeTitle(node.title)) {
      const [child] = node.items;
      node = { ...node, dest: node.dest ?? child.dest, url: node.url ?? child.url, items: child.items };
    }
    return node;
  });
}

async function pageNumberOf(pdfDocument, dest) {
  try {
    const explicit = typeof dest === 'string' ? await pdfDocument.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return null;
    const [target] = explicit;
    if (Number.isInteger(target)) return target + 1;
    if (target && typeof target === 'object') return (await pdfDocument.getPageIndex(target)) + 1;
  } catch {
    /* битое назначение — просто без номера */
  }
  return null;
}

export function createOutline(app) {
  const panel = document.getElementById('outlinePanel');
  let rows = []; // { row, li, pageNumber, depth } в порядке документа
  let chapterDepth = 0; // уровень, на котором в документе лежат главы
  let loadToken = 0;

  function goTo(item) {
    if (item.url) {
      window.open(item.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (item.dest) app.linkService.goToDestination(item.dest);
  }

  function renderItems(items, depth, expandDepth) {
    const list = el('ul', { class: 'outline-tree' });
    for (const item of items) {
      const hasChildren = item.items.length > 0;
      const li = el('li', { class: hasChildren && depth >= expandDepth ? 'collapsed' : '' });
      const row = el('div', { class: 'outline-row' });
      row.style.setProperty('--depth', String(depth));

      if (hasChildren) {
        const toggle = el('button', {
          class: 'outline-toggle',
          'aria-label': 'Свернуть или развернуть',
          onclick: () => li.classList.toggle('collapsed'),
        });
        toggle.append(icon('chevronDown'));
        row.append(toggle);
      } else {
        row.append(el('span', { class: 'outline-toggle-spacer' }));
      }

      const title = el('button', { class: 'outline-title', title: item.title, onclick: () => goTo(item) }, item.title || '(без названия)');
      if (item.bold) title.style.fontWeight = '600';
      if (item.italic) title.style.fontStyle = 'italic';
      const page = el('span', { class: 'outline-page' });
      row.append(title, page);
      li.append(row);

      const entry = { row, li, page, item, depth, pageNumber: null };
      rows.push(entry);
      if (hasChildren) li.append(renderItems(item.items, depth + 1, expandDepth));
      list.append(li);
    }
    return list;
  }

  /** Раздел, в котором читатель: последний пункт, начинающийся не позже текущей страницы. */
  function markCurrent(pageNumber) {
    let current = null;
    for (const entry of rows) {
      if (entry.pageNumber && entry.pageNumber <= pageNumber) current = entry;
    }
    for (const entry of rows) {
      entry.row.classList.toggle('current', entry === current);
      entry.li.classList.toggle('has-current', Boolean(current && entry !== current && entry.li.contains(current.li)));
    }
  }

  async function load(pdfDocument) {
    const token = (loadToken += 1);
    clear(panel);
    rows = [];
    const raw = await pdfDocument?.getOutline?.().catch(() => null);
    if (token !== loadToken) return false;
    if (!raw?.length) {
      panel.append(el('p', { class: 'panel-empty' }, 'В этом документе нет оглавления'));
      return false;
    }

    const outline = simplifyOutline(raw);
    // Если наверху один-два пункта (название книги, автор), сразу раскрываем
    // следующий уровень — иначе главы спрятаны за лишним щелчком.
    const expandDepth = outline.length <= 3 ? 1 : 0;
    chapterDepth = expandDepth;
    panel.append(renderItems(outline, 0, expandDepth));

    // Номера страниц подставляем по мере вычисления, не задерживая показ.
    await Promise.all(
      rows.map(async (entry) => {
        entry.pageNumber = await pageNumberOf(pdfDocument, entry.item.dest);
        if (token === loadToken && entry.pageNumber) entry.page.textContent = String(entry.pageNumber);
      })
    );
    if (token === loadToken) markCurrent(app.pdfViewer.currentPageNumber || 1);
    return true;
  }

  app.eventBus.on('documentopened', ({ pdfDocument }) => {
    load(pdfDocument);
  });
  app.eventBus.on('pagechanging', ({ pageNumber }) => markCurrent(pageNumber));

  /**
   * Страница, с которой начинается следующая глава, — для таймера сна «до
   * конца главы». Глава — пункт того уровня, который раскрыт сразу.
   * @returns {number|null} null — глав дальше нет, читать до конца книги
   */
  function nextChapterStart(pageNumber) {
    const starts = rows
      .filter((entry) => entry.depth === chapterDepth && entry.pageNumber)
      .map((entry) => entry.pageNumber)
      .sort((a, b) => a - b);
    return starts.find((start) => start > pageNumber) ?? null;
  }

  return { load, markCurrent, nextChapterStart };
}
