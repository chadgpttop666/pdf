import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TextIndex, noteText } from '../../extension/src/text-index.js';

function item(str, { x = 72, y = 700, size = 14, width = null, eol = true } = {}) {
  return { str, transform: [size, 0, 0, size, x, y], width: width ?? str.length * size * 0.5, height: size, hasEOL: eol };
}

/** Документ из страниц-наборов кусков текста — как отдаёт pdf.js. */
function fakeDocument(pages) {
  return {
    numPages: pages.length,
    async getPage(number) {
      return { view: [0, 0, 595, 842], getTextContent: async () => ({ items: pages[number - 1] }) };
    },
  };
}

const body = (text, y) => item(text, { y, width: 450 });
const header = (n) => [item('Агностицизм', { x: 230, y: 800, size: 11 }), item(String(n), { x: 290, y: 30, size: 11 })];

describe('примечания для озвучки', () => {
  it('текст сноски без номера и с переносами, склеенными обратно', () => {
    const items = [item('3', { x: 72, y: 100, size: 7, eol: false }), item('Огюст Конт — француз-', { x: 78, y: 100, size: 10 }), item('ский философ.', { y: 88, size: 10 })];
    assert.equal(noteText(items, '3'), 'Огюст Конт — французский философ.');
  });

  it('сноска внизу страницы, продолжение — внизу следующей', async () => {
    const pages = [
      [
        ...header(1),
        body('Длинная строка основного текста книги, набранная по ширине полосы.', 700),
        { ...body('Её поддержал Уэйс', 680), width: 200, hasEOL: false },
        item('4', { x: 272, y: 685, size: 8, width: 4, eol: false }),
        item('. Конец.', { x: 278, y: 680, width: 60 }),
        item('4', { x: 72, y: 100, size: 7, eol: false }),
        item('Генри Уэйс (1836–1924) — директор', { x: 78, y: 100, size: 10 }),
      ],
      [...header(2), body('Длинная строка основного текста следующей страницы, тоже широкая.', 700), item('королевского колледжа.', { y: 100, size: 10 })],
      [...header(3), body('Ещё одна длинная строка основного текста, чтобы набрать профиль.', 700)],
    ];
    const index = new TextIndex(fakeDocument(pages), { skipFurniture: true });
    const page = await index.page(1);
    const sentence = page.sentences.findIndex((s) => page.text.slice(s.start, s.end).includes('Уэйс'));
    const [ref] = index.refsOfSentence(page, sentence);
    assert.equal(ref?.key, '4');
    assert.equal(await index.noteFor(1, ref), 'Генри Уэйс (1836–1924) — директор королевского колледжа.');
    assert.ok(!(await index.page(2)).text.includes('королевского'));
  });

  it('примечание из раздела в конце книги; нумерация по главам — по счёту', async () => {
    const chapter = (n, words) => [...header(n), body(`${words} — длинная строка основного текста, набранная по ширине.`, 700), { ...body('См. источник', 680), width: 120, hasEOL: false }, item('1', { x: 192, y: 685, size: 8, width: 4, eol: false }), item('.', { x: 196, y: 680, width: 4 })];
    const pages = [
      chapter(1, 'Глава первая'),
      chapter(2, 'Глава вторая'),
      [...header(3), item('Примечания', { x: 250, y: 760, size: 16 }), body('1. Первая глава: письмо Гексли к Уэйсу.', 700), body('1. Вторая глава: отчёт Церковного конгресса.', 640)],
    ];
    const index = new TextIndex(fakeDocument(pages), { skipFurniture: true });
    const first = await index.page(1);
    const second = await index.page(2);
    assert.equal(await index.noteFor(1, first.refs[0]), 'Первая глава: письмо Гексли к Уэйсу.');
    assert.equal(await index.noteFor(2, second.refs[0]), 'Вторая глава: отчёт Церковного конгресса.');
  });
});
