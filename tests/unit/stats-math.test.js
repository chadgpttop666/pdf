import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  charsBetween,
  dayKey,
  formatCount,
  formatDuration,
  formatEta,
  hasActivity,
  lastDays,
  mergeDays,
  plausibleReading,
  remainingChars,
  speedOf,
  streakDays,
} from '../../extension/src/stats-math.js';

const MINUTE = 60 * 1000;
const pageChars = async () => 2000;

describe('прочитанный текст', () => {
  it('в пределах страницы — доля её знаков', async () => {
    const chars = await charsBetween({ pageNumber: 3, offsetRatio: 0.25 }, { pageNumber: 3, offsetRatio: 0.5 }, pageChars);
    assert.equal(chars, 500);
  });

  it('через страницы — остаток, целые страницы и начало последней', async () => {
    const chars = await charsBetween({ pageNumber: 3, offsetRatio: 0.5 }, { pageNumber: 5, offsetRatio: 0.25 }, pageChars);
    assert.equal(chars, 1000 + 2000 + 500);
  });

  it('назад и на месте — ноль, далёкий прыжок — null', async () => {
    assert.equal(await charsBetween({ pageNumber: 5, offsetRatio: 0.5 }, { pageNumber: 4, offsetRatio: 0.9 }, pageChars), 0);
    assert.equal(await charsBetween({ pageNumber: 5, offsetRatio: 0.5 }, { pageNumber: 5, offsetRatio: 0.5 }, pageChars), 0);
    assert.equal(await charsBetween({ pageNumber: 5, offsetRatio: 0 }, { pageNumber: 40, offsetRatio: 0 }, pageChars), null);
  });

  it('отрицательная доля (страница ниже верха экрана) считается началом страницы', async () => {
    const chars = await charsBetween({ pageNumber: 2, offsetRatio: -0.3 }, { pageNumber: 2, offsetRatio: 0.1 }, pageChars);
    assert.equal(chars, 200);
  });

  it('пролистывание отличается от чтения по скорости', () => {
    assert.equal(plausibleReading(1500, MINUTE), true); // экран за минуту
    assert.equal(plausibleReading(1500, 5000), false); // экран за 5 секунд
    assert.equal(plausibleReading(0, MINUTE), false);
  });
});

describe('скорость и остаток', () => {
  it('скорость — по сумме дней, при малом объёме данных нет', () => {
    const days = [
      { readMs: 10 * MINUTE, readChars: 12000 },
      { readMs: 20 * MINUTE, readChars: 30000 },
    ];
    assert.equal(speedOf(days, { msKey: 'readMs', charsKey: 'readChars' }), 1400);
    assert.equal(speedOf([{ readMs: MINUTE, readChars: 900 }], { msKey: 'readMs', charsKey: 'readChars' }), null);
  });

  it('остаток: точный остаток страницы плюс средние страницы', () => {
    assert.equal(remainingChars({ pageNumber: 10, offsetRatio: 0.5, currentChars: 1800, endPage: 12, averageChars: 2000 }), 900 + 4000);
    assert.equal(remainingChars({ pageNumber: 10, offsetRatio: 0, currentChars: 1800, endPage: 9, averageChars: 2000 }), 0);
  });

  it('дни подряд: сегодняшний день ещё может начаться', () => {
    const today = new Date(2026, 9, 28);
    const day = (d, ms) => [dayKey(new Date(2026, 9, d)), { readMs: ms, listenMs: 0 }];
    const byDay = new Map([day(25, 5 * MINUTE), day(26, 5 * MINUTE), day(27, 2 * MINUTE)]);
    assert.equal(streakDays(byDay, today), 3);
    byDay.set(...day(28, 10 * MINUTE));
    assert.equal(streakDays(byDay, today), 4);
    byDay.set(...day(26, 10 * 1000)); // меньше минуты — разрыв
    assert.equal(streakDays(byDay, today), 2);
  });

  it('ключи дней — местные даты, по порядку', () => {
    assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
    assert.deepEqual(lastDays(3, new Date(2026, 2, 1)), ['2026-02-27', '2026-02-28', '2026-03-01']);
  });
});

describe('записи дней', () => {
  it('приращения вкладок складываются, а не затирают друг друга', () => {
    const stored = { day: '2026-10-28', readMs: 60000, readChars: 1200, listenMs: 0, listenChars: 0, docs: { a: { ms: 60000, chars: 1200, title: 'Книга' } } };
    const delta = { day: '2026-10-28', readMs: 5000, readChars: 100, listenMs: 30000, listenChars: 400, noTextMs: 0, docs: { a: { ms: 5000, chars: 100 }, b: { ms: 30000, chars: 400, title: 'Другая' } } };
    const merged = mergeDays(stored, delta);
    assert.equal(merged.readMs, 65000);
    assert.equal(merged.listenChars, 400);
    assert.deepEqual(merged.docs.a, { ms: 65000, chars: 1300, title: 'Книга' });
    assert.deepEqual(merged.docs.b, { ms: 30000, chars: 400, title: 'Другая' });
    assert.equal(stored.readMs, 60000, 'исходная запись не меняется');
  });

  it('пустое приращение сохранять незачем', () => {
    assert.equal(hasActivity({ day: 'x', readMs: 0, docs: {} }), false);
    assert.equal(hasActivity({ day: 'x', listenChars: 10 }), true);
  });
});

describe('форматирование', () => {
  it('длительности', () => {
    assert.equal(formatDuration(20 * 1000), 'меньше минуты');
    assert.equal(formatDuration(12 * MINUTE), '12 мин');
    assert.equal(formatDuration(220 * MINUTE), '3 ч 40 мин');
    assert.equal(formatDuration(120 * MINUTE), '2 ч');
    assert.equal(formatEta(20 * 1000), '1 мин');
    assert.equal(formatEta(725 * MINUTE), '12 ч');
  });

  it('числа', () => {
    assert.equal(formatCount(1284).replace(/\s/g, ' '), '1 284');
    assert.equal(formatCount(25300), '25,3 тыс.');
  });
});
