// Поиск по документу. Вся тяжёлая работа — в PDFFindController из pdf.js,
// здесь только панель и разбор его событий.

import { $, on } from './dom.js';
import { FindState } from '../vendor/pdf_viewer.mjs';

export function createFind(app) {
  const bar = $('findBar');
  const input = $('findInput');
  const status = $('findStatus');

  function options(type) {
    return {
      source: app,
      type,
      query: input.value,
      caseSensitive: $('findMatchCase').checked,
      entireWord: $('findWholeWords').checked,
      highlightAll: $('findHighlightAll').checked,
      findPrevious: false,
      matchDiacritics: false,
    };
  }

  function dispatch(type, extra = {}) {
    if (!app.loader.pdfDocument) return;
    app.eventBus.dispatch('find', { ...options(type), ...extra });
  }

  function open() {
    bar.hidden = false;
    input.focus();
    input.select();
  }

  function close() {
    if (bar.hidden) return;
    bar.hidden = true;
    app.eventBus.dispatch('findbarclose', { source: app });
    status.textContent = '';
  }

  function again(direction = 1) {
    if (bar.hidden) {
      open();
      return;
    }
    dispatch('again', { findPrevious: direction < 0 });
  }

  on($('btnFind'), 'click', () => (bar.hidden ? open() : close()));
  on($('findClose'), 'click', close);
  on($('findNext'), 'click', () => again(1));
  on($('findPrev'), 'click', () => again(-1));
  on(input, 'input', () => dispatch(''));
  on(input, 'keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      again(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  on($('findHighlightAll'), 'change', () => dispatch('highlightallchange'));
  on($('findMatchCase'), 'change', () => dispatch('casesensitivitychange'));
  on($('findWholeWords'), 'change', () => dispatch('entirewordchange'));

  app.eventBus.on('updatefindmatchescount', ({ matchesCount }) => {
    status.textContent = describe(matchesCount);
  });
  app.eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
    if (state === FindState.NOT_FOUND) status.textContent = 'ничего не найдено';
    else if (state === FindState.PENDING) status.textContent = 'ищу…';
    else status.textContent = describe(matchesCount, state === FindState.WRAPPED);
  });

  function describe(matchesCount, wrapped = false) {
    if (!matchesCount?.total) return input.value ? 'ничего не найдено' : '';
    const suffix = wrapped ? ' (с начала)' : '';
    return `${matchesCount.current} из ${matchesCount.total}${suffix}`;
  }

  return { open, close, again, get isOpen() { return !bar.hidden; } };
}
