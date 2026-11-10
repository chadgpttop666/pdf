import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectNotes, createNoteFilter, noteCode, noteKey, notesForAi, parseAiAnswer } from '../../extension/src/tts/note-picker.js';

/** Запись книги и readingState как в читалке: mutate меняет поля записи. */
function bookState(mutedNotes = []) {
  const state = {
    record: { id: 'book', mutedNotes },
    async mutate(change, options) {
      assert.deepEqual(options, { silent: true });
      state.record = { ...state.record, ...change(state.record) };
      return state.record;
    },
  };
  return state;
}

const NOTES = [
  { mark: '1', page: 3, text: 'Микрофильм — фотокопия документа на плёнке в сильном уменьшении.' },
  { mark: '2', page: 5, text: 'Там же. С. 45.' },
  { mark: '3', page: 8, text: 'Перевод с латыни: «Познай самого себя».' },
];

describe('выбор примечаний (note-picker.js)', () => {
  it('ключ — буквы и цифры начала текста: переносы, пробелы, «ё» и знаки не мешают', () => {
    assert.equal(noteKey('Микрофильм — фото-\nкопия, на плёнке'), noteKey('микрофильм фотокопия на пленке'));
    assert.equal(noteKey(null), '');
    assert.equal(noteKey('а'.repeat(500)).length, 120);
    assert.match(noteCode(NOTES[0].text), /^[0-9a-z]{5}$/);
    assert.equal(noteCode('Там же. С. 45.'), noteCode('там же, с. 45'));
  });

  it('выключенные хранятся в записи книги; старые ключи (0.28) понимаются; без записи запомнить негде', async () => {
    // Так ключ хранила 0.28: строчные, пробелы схлопнуты.
    const state = bookState(['микрофильм — фотокопия документа на плёнке в сильном уменьшении.']);
    const filter = createNoteFilter(() => state);
    assert.equal(filter.isMuted(NOTES[0].text), true);
    assert.equal(await filter.set([NOTES[1].text], true), true);
    assert.equal(filter.count, 2);
    const saved = filter.snapshot();
    await filter.apply({ mute: [NOTES[2].text], unmute: [NOTES[0].text] });
    assert.deepEqual(NOTES.map((note) => filter.isMuted(note.text)), [false, true, true]);
    await filter.restore(saved);
    assert.deepEqual(NOTES.map((note) => filter.isMuted(note.text)), [true, true, false]);
    assert.equal(await createNoteFilter(() => null).set(['x'], true), false);
  });

  it('все примечания книги по порядку, повторы — один раз', async () => {
    const pages = { 1: { refs: [{ key: '1' }, { key: '2' }] }, 2: { refs: [{ key: '3' }] }, 3: { refs: [] } };
    const texts = { '1:1': 'Первое.', '1:2': 'Второе.', '2:3': 'Первое' };
    const index = { numPages: 3, page: async (n) => pages[n], noteFor: async (n, ref) => texts[`${n}:${ref.key}`] ?? null };
    const progress = [];
    const found = await collectNotes(index, { onProgress: (n, total) => progress.push(`${n}/${total}`) });
    assert.deepEqual(found, [
      { mark: '1', text: 'Первое.', page: 1 },
      { mark: '2', text: 'Второе.', page: 1 },
    ]);
    assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
    let calls = 0;
    await collectNotes({ ...index, page: async (n) => ((calls += 1), pages[n]) }, { isCancelled: () => calls >= 1 });
    assert.equal(calls, 1);
  });

  it('выгрузка для нейросети: задание и строки «[x] номер {код} стр.: текст»', () => {
    const text = notesForAi(NOTES, { title: 'Книга', isMuted: (note) => note.startsWith('Там же') });
    assert.match(text, /^Примечания книги «Книга» — всего 3\./);
    assert.match(text, /\[x\] — читать, \[ \] — пропустить/);
    const lines = text.split('\n').filter((line) => line.startsWith('['));
    assert.equal(lines.length, 3);
    assert.equal(lines[1], `[ ] 2 {${noteCode(NOTES[1].text)}} стр. 5: Там же. С. 45.`);
  });

  it('ответ нейросети с пометками: по коду, по номеру, в разметке Markdown; без пометки — не трогаем', () => {
    const [a, b, c] = NOTES.map((note) => noteCode(note.text));
    const answer = [
      'Вот список:',
      `- [ ] 1 {${a}} стр. 3: Микрофильм — …`,
      `**[x]** 2 {${b}} стр. 5: Там же`, // код важнее номера
      `[х] 7 {zzzzz} — такого нет`, // кириллическая «х»
      '',
    ].join('\n');
    const parsed = parseAiAnswer(answer, NOTES);
    assert.equal(parsed.mode, 'marks');
    assert.deepEqual(parsed.read.map((note) => note.mark), ['2']);
    assert.deepEqual(parsed.muted.map((note) => note.mark), ['1']);
    assert.equal(parsed.unknown, 1);
    // Код потерян — по номеру.
    assert.deepEqual(parseAiAnswer('[x] 3 Перевод с латыни', NOTES).read.map((note) => note.mark), ['3']);
    assert.ok(c);
  });

  it('ответ просто номерами: читать эти, остальные — нет; пустой ответ — ничего', () => {
    const parsed = parseAiAnswer('Читать стоит: 1, 3 (и ещё 9).', NOTES);
    assert.equal(parsed.mode, 'numbers');
    assert.deepEqual(parsed.read.map((note) => note.mark), ['1', '3']);
    assert.deepEqual(parsed.muted.map((note) => note.mark), ['2']);
    assert.equal(parsed.unknown, 1);
    assert.deepEqual(parseAiAnswer('2–3', NOTES).read.map((note) => note.mark), ['2', '3']);
    assert.equal(parseAiAnswer('ничего не подходит', NOTES).mode, 'none');
  });
});
