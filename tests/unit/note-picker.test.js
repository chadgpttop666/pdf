import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectNotes, createNoteFilter, noteKey } from '../../extension/src/tts/note-picker.js';

describe('выбор примечаний (note-picker.js)', () => {
  it('ключ — по тексту, без регистра и лишних пробелов', () => {
    assert.equal(noteKey('  Микрофильм —\nфотокопия  '), 'микрофильм — фотокопия');
    assert.equal(noteKey(null), '');
    assert.equal(noteKey('а'.repeat(500)).length, 200);
  });

  it('выключенные хранятся в записи книги; без записи запомнить негде', async () => {
    let record = { id: 'book', mutedNotes: [] };
    const state = {
      get record() {
        return record;
      },
      async mutate(change, options) {
        assert.deepEqual(options, { silent: true });
        record = { ...record, ...change(record) };
        return record;
      },
    };
    const filter = createNoteFilter(() => state);
    assert.equal(filter.isMuted('Первое примечание'), false);
    assert.equal(await filter.set(['Первое  примечание', 'Второе'], true), true);
    assert.equal(filter.isMuted('первое примечание'), true);
    assert.equal(filter.count, 2);
    await filter.set(['Второе'], false);
    assert.deepEqual(record.mutedNotes, ['первое примечание']);
    assert.equal(await createNoteFilter(() => null).set(['x'], true), false);
  });

  it('все примечания книги по порядку, повторы — один раз', async () => {
    const pages = {
      1: { refs: [{ key: '1' }, { key: '2' }] },
      2: { refs: [{ key: '3' }] },
      3: { refs: [] },
    };
    const notes = { '1:1': 'Первое.', '1:2': 'Второе.', '2:3': 'Первое.' };
    const index = {
      numPages: 3,
      page: async (n) => pages[n],
      noteFor: async (n, ref) => notes[`${n}:${ref.key}`] ?? null,
    };
    const progress = [];
    const found = await collectNotes(index, { onProgress: (n, total) => progress.push(`${n}/${total}`) });
    assert.deepEqual(found, [
      { mark: '1', text: 'Первое.', page: 1 },
      { mark: '2', text: 'Второе.', page: 1 },
    ]);
    assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
    // Окно закрыли посреди просмотра — дальше не смотрим.
    let calls = 0;
    await collectNotes({ ...index, page: async (n) => (calls += 1, pages[n]) }, { isCancelled: () => calls >= 1 });
    assert.equal(calls, 1);
  });
});
