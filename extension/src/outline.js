// Оглавление документа. Пункты со вложенностью, сворачиваются кликом по
// треугольнику; переход — через PDFLinkService, он понимает и именованные,
// и явные назначения.

import { clear, el } from './dom.js';

export function createOutline(app) {
  const panel = document.getElementById('outlinePanel');

  function renderItems(items, container) {
    const list = el('ul', { class: 'outline-tree' });
    for (const item of items) {
      const li = el('li');
      const hasChildren = Boolean(item.items?.length);

      if (hasChildren) {
        li.classList.add('collapsed');
        li.append(
          el('span', {
            class: 'toggle',
            title: 'Развернуть',
            onclick: () => li.classList.toggle('collapsed'),
          }, '▸')
        );
      }

      li.append(
        el(
          'button',
          {
            title: item.title,
            onclick: () => goTo(item),
            style: [item.bold ? 'font-weight:600' : '', item.italic ? 'font-style:italic' : '']
              .filter(Boolean)
              .join(';'),
          },
          item.title || '(без названия)'
        )
      );

      if (hasChildren) renderItems(item.items, li);
      list.append(li);
    }
    container.append(list);
  }

  function goTo(item) {
    if (item.url) {
      window.open(item.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (item.dest) app.linkService.goToDestination(item.dest);
  }

  async function load(pdfDocument) {
    clear(panel);
    const outline = await pdfDocument?.getOutline?.().catch(() => null);
    if (!outline?.length) {
      panel.append(el('p', { class: 'panel-empty' }, 'В этом документе нет оглавления'));
      return false;
    }
    renderItems(outline, panel);
    return true;
  }

  app.eventBus.on('documentopened', ({ pdfDocument }) => {
    load(pdfDocument);
  });

  return { load };
}
