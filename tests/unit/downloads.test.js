import assert from 'node:assert/strict';
import { describe as group, it } from 'node:test';
import { active, describe, forget, formatEta, get, speedOf, subscribe, track } from '../../extension/src/downloads.js';

const MB = 1024 * 1024;

group('учёт скачиваний (downloads.js)', () => {
  it('скорость — по последним секундам', () => {
    assert.equal(speedOf([]), 0);
    assert.equal(speedOf([{ at: 0, loaded: 0 }]), 0);
    // 2 МБ за 2 с — 1 МБ/с.
    assert.equal(speedOf([{ at: 0, loaded: 0 }, { at: 1000, loaded: MB }, { at: 2000, loaded: 2 * MB }]), MB);
    // Давние замеры не тянут скорость вниз: считаются последние 5 с.
    assert.equal(speedOf([{ at: 0, loaded: 0 }, { at: 20000, loaded: MB }, { at: 22000, loaded: 5 * MB }]), 2 * MB);
  });

  it('сколько осталось — по-человечески', () => {
    assert.equal(formatEta(32), '≈ 30 с');
    assert.equal(formatEta(2), '≈ 5 с');
    assert.equal(formatEta(170), '≈ 3 мин');
    assert.equal(formatEta(3900), '≈ 1 ч 05 мин');
    assert.equal(formatEta(Infinity), '');
  });

  it('строка: процент, объём, скорость, сколько осталось; работа после скачивания — без процентов', () => {
    const now = Date.now();
    const item = { status: 'active', loaded: 100 * MB, total: 400 * MB, stage: '', samples: [{ at: now - 2000, loaded: 96 * MB }, { at: now, loaded: 100 * MB }] };
    const shown = describe(item);
    assert.equal(shown.percent, 25);
    assert.match(shown.line, /^25 % · 100 МБ из 400 МБ · 2\.0 МБ\/с · осталось ≈ 3 мин$/);
    assert.deepEqual(describe({ ...item, stage: 'Готовлю словарь ударений…' }), { percent: null, line: 'Готовлю словарь ударений…' });
    assert.equal(describe({ status: 'active', loaded: 0, total: 0, samples: [] }).line, 'Начинаю…');
    assert.equal(describe({ status: 'done', message: 'Скачано' }).line, 'Скачано');
    assert.equal(describe({ status: 'error', message: 'нет сети' }).line, 'Не получилось: нет сети');
  });

  it('track: изменения видны подписчикам, законченное можно забыть', () => {
    const seen = [];
    const off = subscribe((id, item) => seen.push([id, item?.status ?? null, item?.loaded ?? null]));
    const download = track('test-voice', 'Голос');
    download.onProgress(10, 100);
    assert.equal(get('test-voice').loaded, 10);
    assert.deepEqual(active().map((item) => item.id), ['test-voice']);
    download.done('Готово');
    assert.equal(get('test-voice').status, 'done');
    assert.deepEqual(active(), []);
    // После done прогресс того же скачивания уже ничего не меняет.
    download.onProgress(50, 100);
    assert.equal(get('test-voice').loaded, 10);
    forget('test-voice');
    assert.equal(get('test-voice'), null);
    off();
    assert.deepEqual(seen, [
      ['test-voice', 'active', 0],
      ['test-voice', 'active', 10],
      ['test-voice', 'done', 10],
      ['test-voice', null, null],
    ]);
  });
});
