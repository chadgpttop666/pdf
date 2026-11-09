// Полоса скачивания (downloads.js): процент, «123 из 498 МБ», скорость,
// сколько осталось. И значок в углу окна — пока окно настроек закрыто,
// видно, что голоса ещё качаются и сколько ждать.

import { $, el } from '../dom.js';
import { active, describe, forget, get, subscribe } from '../downloads.js';

// Готово или ошибка — значок ещё столько виден, потом прячется.
const SETTLED_CHIP_MS = 6000;

/**
 * Полоса для скачивания id. Пока ничего не качается — строка idle (или ничего).
 * Подписка снимается сама, когда узел ушёл со страницы (окно перестроили).
 */
export function progressView(id, { idle = '', textClass = '' } = {}) {
  const fill = el('div', { class: 'dl-fill' });
  const bar = el('div', { class: 'dl-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const text = el('span', { class: `dl-text ${textClass}`.trim(), 'aria-live': 'polite' });
  const root = el('div', { class: 'dl-progress' }, [bar, text]);
  let attached = false;
  const render = () => {
    if (root.isConnected) attached = true;
    else if (attached) {
      off();
      return;
    }
    const item = get(id);
    const idleText = typeof idle === 'function' ? idle() : idle;
    root.dataset.status = item?.status ?? 'idle';
    if (!item) {
      bar.hidden = true;
      text.textContent = idleText;
      root.hidden = !idleText;
      return;
    }
    const { percent, line } = describe(item);
    root.hidden = false;
    bar.hidden = item.status === 'error';
    bar.classList.toggle('indeterminate', percent === null && item.status === 'active');
    fill.style.width = `${percent ?? 0}%`;
    if (percent === null) bar.removeAttribute('aria-valuenow');
    else bar.setAttribute('aria-valuenow', String(percent));
    text.textContent = line;
  };
  const off = subscribe((changed) => changed === id && render());
  render();
  return root;
}

/**
 * Значок «⬇ Голоса TeraTTS · 45 % · осталось ≈ 2 мин» в углу, пока окно
 * настроек закрыто. Щелчок — открыть настройки на этом голосе.
 * @param openSettings (id) => void
 * @param isSettingsOpen () => boolean
 */
export function createDownloadChip({ openSettings, isSettingsOpen }) {
  const chip = el('button', { type: 'button', id: 'downloadChip', class: 'download-chip', hidden: '' });
  $('app').append(chip);
  let shown = null; // id, который показывает значок
  let hideTimer = 0;

  function render() {
    const running = active();
    const item = running[0] ?? (shown && get(shown)) ?? null;
    if (!item || isSettingsOpen()) {
      chip.hidden = true;
      return;
    }
    shown = item.id;
    const { percent, line } = describe(item);
    chip.dataset.status = item.status;
    chip.style.setProperty('--done', `${percent ?? 0}%`);
    const more = running.length > 1 ? ` (и ещё ${running.length - 1})` : '';
    chip.textContent =
      item.status === 'active' ? `⬇ ${item.title}${more}: ${line}` : item.status === 'done' ? `✓ ${line}` : `⚠ ${item.title}: ${line}`;
    chip.title = 'Открыть настройки';
    chip.hidden = false;
    // Над нижними панелями (озвучка, автопрокрутка) — не закрывать их кнопки.
    const box = $('app').getBoundingClientRect();
    const bars = [...document.querySelectorAll('#app > .bar')].filter((bar) => !bar.hidden && bar.offsetHeight);
    const top = bars.length ? Math.min(...bars.map((bar) => bar.getBoundingClientRect().top)) : box.bottom;
    chip.style.bottom = `${Math.max(12, box.bottom - top + 10)}px`;
    clearTimeout(hideTimer);
    if (item.status !== 'active') {
      hideTimer = setTimeout(() => {
        if (get(item.id)?.status !== 'active') {
          shown = null;
          chip.hidden = true;
        }
      }, SETTLED_CHIP_MS);
    }
  }

  chip.addEventListener('click', () => {
    const id = shown;
    chip.hidden = true;
    openSettings(id);
  });
  subscribe(render);
  return { render, forget };
}
