// Скачивания голосов и моделей — общий учёт: сколько скачано, с какой
// скоростью, сколько осталось. Его показывают окно настроек (полоса у
// каждого голоса), строка панели озвучки и значок в углу, пока окно
// настроек закрыто: полгигабайта качаются минуты, и окно закрывают.
//
// id — что качается: 'tera-pack', 'piper:<голос>', 'helper-installer',
// 'helper-models', 'whisper-model'.

import { formatBytes } from './dom.js';

// Скорость — по последним секундам: в начале и при обрывах сети она скачет.
const SPEED_WINDOW_MS = 5000;
const SAMPLE_EVERY_MS = 250;
// Готовое и ошибки видны ещё немного, потом строка возвращается к обычной.
const items = new Map();
const listeners = new Set();

function notify(id) {
  for (const listener of listeners) listener(id, items.get(id) ?? null);
}

/** Байт в секунду по замерам { at, loaded } за последние секунды. */
export function speedOf(samples) {
  if (samples.length < 2) return 0;
  const last = samples.at(-1);
  const first = samples.find((sample) => sample.at >= last.at - SPEED_WINDOW_MS) ?? samples[0];
  const seconds = (last.at - first.at) / 1000;
  return seconds >= 0.5 ? Math.max(0, (last.loaded - first.loaded) / seconds) : 0;
}

/** «≈ 40 с», «≈ 3 мин», «≈ 1 ч 05 мин». */
export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `≈ ${Math.max(5, Math.round(seconds / 5) * 5)} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `≈ ${minutes} мин`;
  return `≈ ${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

/**
 * Что показать: процент (null — сколько всего, неизвестно) и строку.
 * @param item { status: 'active'|'done'|'error', loaded, total, stage, samples, message }
 */
export function describe(item) {
  if (!item) return { percent: null, line: '' };
  if (item.status === 'done') return { percent: 100, line: item.message || 'Готово' };
  if (item.status === 'error') return { percent: null, line: `Не получилось: ${item.message}` };
  // Не скачивание, а работа после него (словарь ударений, сборка модели) — без процентов.
  if (item.stage) return { percent: null, line: item.stage };
  const { loaded = 0, total = 0 } = item;
  if (!total) return { percent: null, line: loaded ? `Скачано ${formatBytes(loaded)}` : 'Начинаю…' };
  const percent = Math.min(100, Math.floor((loaded / total) * 100));
  const speed = speedOf(item.samples ?? []);
  const parts = [`${percent} %`, `${formatBytes(loaded)} из ${formatBytes(total)}`];
  if (speed > 0) {
    parts.push(`${formatBytes(speed)}/с`);
    const eta = formatEta((total - loaded) / speed);
    if (eta && loaded < total) parts.push(`осталось ${eta}`);
  }
  return { percent, line: parts.join(' · ') };
}

/**
 * Начать учёт скачивания.
 * @param title что качается — для значка в углу: «Голоса TeraTTS»
 * @returns {{ onProgress(loaded, total, stage?), done(message?), fail(error) }}
 *   stage — подпись работы после скачивания (словарь, сборка), без процентов
 */
export function track(id, title) {
  const item = { id, title, status: 'active', loaded: 0, total: 0, stage: '', samples: [], startedAt: Date.now(), message: '' };
  items.set(id, item);
  notify(id);
  return {
    onProgress(loaded, total, stage = '') {
      if (items.get(id) !== item || item.status !== 'active') return;
      item.loaded = loaded;
      item.total = total || item.total;
      item.stage = stage;
      const now = Date.now();
      if (!item.samples.length || now - item.samples.at(-1).at >= SAMPLE_EVERY_MS) {
        item.samples.push({ at: now, loaded });
        while (item.samples.length > 2 && item.samples[0].at < now - SPEED_WINDOW_MS * 2) item.samples.shift();
      }
      notify(id);
    },
    done(message = '') {
      if (items.get(id) !== item) return;
      item.status = 'done';
      item.message = message;
      notify(id);
    },
    fail(error) {
      if (items.get(id) !== item) return;
      item.status = 'error';
      item.message = error?.message || String(error);
      notify(id);
    },
  };
}

export const get = (id) => items.get(id) ?? null;

/** Что качается прямо сейчас. */
export const active = () => [...items.values()].filter((item) => item.status === 'active');

/** Забыть законченное (строка вернётся к обычной). */
export function forget(id) {
  if (!items.has(id)) return;
  items.delete(id);
  notify(id);
}

/** listener(id, item) — при каждом изменении. @returns отписка */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
