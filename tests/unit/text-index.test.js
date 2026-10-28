import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPageText,
  cleanForSpeech,
  detectLanguage,
  segmentSentences,
} from '../../extension/src/text-index.js';

/** Кусок текстового слоя PDF: строка на позиции (x, y) с высотой шрифта. */
function item(str, { x = 72, y = 700, size = 11, width = null, hasEOL = true } = {}) {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: width ?? str.length * size * 0.5,
    height: size,
    hasEOL,
  };
}

describe('buildPageText', () => {
  it('склеивает строки одного абзаца пробелом, а не переводом строки', () => {
    const { text } = buildPageText([
      item('Первая строка абзаца,', { y: 700 }),
      item('его продолжение.', { y: 684 }),
    ]);
    assert.equal(text, 'Первая строка абзаца, его продолжение.');
  });

  it('распознаёт новый абзац по увеличенному шагу между строками', () => {
    const { text } = buildPageText([
      item('Строка один.', { y: 700 }),
      item('Строка два.', { y: 684 }),
      item('Новый абзац.', { y: 640 }),
    ]);
    assert.equal(text, 'Строка один. Строка два.\nНовый абзац.');
  });

  it('ведёт карту символов на спаны текстового слоя', () => {
    const { text, entries } = buildPageText([item('Раз', { y: 700 }), item('два', { y: 684 })]);
    assert.deepEqual(entries, [
      { spanIndex: 0, start: 0, end: 3 },
      { spanIndex: 1, start: 4, end: 7 },
    ]);
    assert.equal(text.slice(entries[1].start, entries[1].end), 'два');
  });

  it('не считает пустые куски: pdf.js не вставляет для них спаны, иначе подсветка съезжает', () => {
    // Так выглядит книжная вёрстка: после каждой строки идёт пустой кусок.
    const { entries } = buildPageText([
      item('Первая строка', { y: 700, hasEOL: false }),
      item('', { y: 700 }),
      item('вторая строка', { y: 684, hasEOL: false }),
      item('', { y: 684 }),
      item('третья.', { y: 668 }),
    ]);
    assert.deepEqual(
      entries.map((entry) => entry.spanIndex),
      [0, 1, 2]
    );
  });

  it('видит конец абзаца по короткой строке перед новой фразой', () => {
    const lines = [
      item('Длинная строка абзаца, растянутая по всей ширине', { y: 700, width: 400 }),
      item('и ещё одна такая же длинная строка текста, до края', { y: 684, width: 400 }),
      item('короткий хвост.', { y: 668, width: 120 }),
      item('Новый абзац начинается здесь и тоже идёт до края', { y: 652, width: 400 }),
    ];
    const { text } = buildPageText(lines);
    assert.match(text, /хвост\.\nНовый/);
    assert.match(text, /абзаца, растянутая по всей ширине и ещё/);
  });

  it('видит новый абзац по красной строке', () => {
    const { text } = buildPageText([
      item('Строка до самого края страницы, конец фразы.', { x: 72, y: 700, width: 400 }),
      item('Текст продолжается в той же манере, ровно.', { x: 72, y: 684, width: 400 }),
      item('С отступом начинается новый абзац.', { x: 108, y: 668, width: 364 }),
    ]);
    assert.match(text, /ровно\.\nС отступом/);
  });

  it('отделяет разделитель «* * *» от следующего абзаца', () => {
    const { text } = buildPageText([
      item('* * *', { x: 280, y: 720, width: 30 }),
      item('Эта книга написана для тех, кто читает с экрана', { y: 700, width: 400 }),
      item('подолгу и устаёт не от смысла, а от механики.', { y: 684, width: 400 }),
    ]);
    assert.ok(text.startsWith('* * *\nЭта книга'), JSON.stringify(text));
  });

  it('ставит пробел между кусками одной строки, разделёнными на письме', () => {
    const { text } = buildPageText([
      item('первый', { x: 72, y: 700, width: 40, hasEOL: false }),
      item('второй', { x: 130, y: 700, hasEOL: false }),
    ]);
    assert.equal(text, 'первый второй');
  });

  it('не разрывает слово, разложенное на несколько кусков вплотную', () => {
    const { text } = buildPageText([
      item('сло', { x: 72, y: 700, width: 20, hasEOL: false }),
      item('во', { x: 92, y: 700, hasEOL: false }),
    ]);
    assert.equal(text, 'слово');
  });
});

describe('segmentSentences', () => {
  it('делит текст по предложениям', () => {
    const text = 'Первое предложение. Второе предложение! Третье?';
    const parts = segmentSentences(text, 'ru').map((range) => text.slice(range.start, range.end));
    assert.deepEqual(parts, ['Первое предложение.', 'Второе предложение!', 'Третье?']);
  });

  it('не рвёт фразу на сокращениях и инициалах', () => {
    const text = 'Он учился у проф. Франца Оппенхаймера. Читал А. С. Пушкина. Т. е. всё ясно.';
    const parts = segmentSentences(text, 'ru').map((range) => text.slice(range.start, range.end));
    assert.deepEqual(parts, ['Он учился у проф. Франца Оппенхаймера.', 'Читал А. С. Пушкина.', 'Т. е. всё ясно.']);
  });

  it('считает «и т. д.» перед заглавной концом фразы', () => {
    const text = 'Яблоки, груши и т. д. Потом пришла зима.';
    const parts = segmentSentences(text, 'ru').map((range) => text.slice(range.start, range.end));
    assert.deepEqual(parts, ['Яблоки, груши и т. д.', 'Потом пришла зима.']);
  });

  it('не отрывает номер главы от заголовка', () => {
    const text = 'Глава 1. Как читать';
    const parts = segmentSentences(text, 'ru').map((range) => text.slice(range.start, range.end));
    assert.deepEqual(parts, ['Глава 1. Как читать']);
  });

  it('сохраняет позиции в исходном тексте при слоговом переносе', () => {
    const text = 'Это пере-\nнос слова.';
    const [range] = segmentSentences(text, 'ru');
    assert.equal(range.start, 0);
    assert.equal(text.slice(range.start, range.end), text);
  });

  it('режет слишком длинные куски по знакам препинания', () => {
    const text = `${'слово '.repeat(60)}, ${'ещё '.repeat(60)}`;
    const ranges = segmentSentences(text, 'ru');
    assert.ok(ranges.length > 1, 'длинный кусок должен быть разбит');
    for (const range of ranges) assert.ok(range.end - range.start <= 320);
  });
});

describe('cleanForSpeech', () => {
  it('склеивает слово, разорванное переносом', () => {
    const { text } = cleanForSpeech('пере-\nнос слова');
    assert.equal(text, 'перенос слова');
  });

  it('схлопывает пробелы и переводы строк', () => {
    const { text } = cleanForSpeech('первая\n  вторая\tтретья');
    assert.equal(text, 'первая вторая третья');
  });

  it('карта ведёт в исходные позиции — по ней подсвечивается слово', () => {
    const raw = 'первая\nвторая';
    const { text, map } = cleanForSpeech(raw);
    assert.equal(text, 'первая вторая');
    assert.equal(map.length, text.length);
    assert.equal(raw[map[text.indexOf('вторая')]], 'в');
  });

  it('не оставляет хвостовых пробелов', () => {
    const { text, map } = cleanForSpeech('текст  \n');
    assert.equal(text, 'текст');
    assert.equal(map.length, 5);
  });
});

describe('detectLanguage', () => {
  it('различает русский и английский', () => {
    assert.equal(detectLanguage('Совершенно русский текст про чтение'), 'ru');
    assert.equal(detectLanguage('A plain english sentence'), 'en');
  });
});

describe('абзацы и стык страниц', () => {
  it('строка с запятой и продолжение со строчной — один абзац, даже с большим шагом', async () => {
    const { buildPageText } = await import('../../extension/src/text-index.js');
    const items = [
      item('Более того, мне кажется, она объясняет,', { y: 700, width: 400 }),
      item('почему эти темы и подходы стали предметом', { y: 670, width: 400 }),
      item('дискуссии. Я надеюсь, что читатель узнает,', { y: 640, width: 400 }),
      item('почему некоторые темы рассматриваются', { y: 580, width: 400 }),
    ];
    const { text } = buildPageText(items);
    assert.ok(!text.includes('\n'), JSON.stringify(text));
  });

  it('страница обрывается посреди фразы и следующая продолжает её', async () => {
    const { pageEdges } = await import('../../extension/src/text-index.js');
    assert.deepEqual(pageEdges('Вскоре он возглавил отдел, которому была'), { runsOn: true, runsIn: false });
    assert.deepEqual(pageEdges('поручена разработка реформы.'), { runsOn: false, runsIn: true });
    assert.deepEqual(pageEdges('Конец главы.'), { runsOn: false, runsIn: false });
    assert.deepEqual(pageEdges(''), { runsOn: false, runsIn: false });
  });
});

describe('заголовок капсом', () => {
  it('строка капсом не склеивается с текстом под ней, даже если тот со строчной', async () => {
    const { buildPageText } = await import('../../extension/src/text-index.js');
    const items = [
      item('ПРЕДИСЛОВИЕ КО ВТОРОМУ ИЗДАНИЮ', { y: 760, width: 300 }),
      item('вершенно новым темам, почти не замечавшимся', { y: 700, width: 400 }),
    ];
    assert.ok(buildPageText(items).text.includes('\n'));
  });
});
