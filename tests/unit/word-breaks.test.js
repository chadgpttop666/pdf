import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPageText, cleanForSpeech } from '../../extension/src/text-index.js';
import { breakWords, classifyBreak, createWordJoiner, joinAt, looksLossy, wordsToCheck } from '../../extension/src/tts/word-breaks.js';

// Маленький «словарь ударений» для проверок.
const DICTIONARY = new Set(['сообщает', 'направленной', 'ленной', 'начало', 'чало', 'пример', 'мер', 'задушу', 'душу', 'потом', 'том', 'только', 'автор', 'книги', 'путь', 'пути', 'же']);
const lookup = async (words) => new Set(words.filter((word) => DICTIONARY.has(word)));

const item = (str, x, y, extra = {}) => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10, hasEOL: false, ...extra });

/** Страница, как её отдаёт TextIndex: текст, предложения, разрывы строк. */
function pageOf(lines) {
  let text = '';
  const softBreaks = [];
  lines.forEach((line, i) => {
    if (i) {
      softBreaks.push(text.length);
      text += ' ';
    }
    text += line;
  });
  return { text, softBreaks, sentences: [{ start: 0, end: text.length }] };
}

async function spoken(joiner, page) {
  const sentence = page.sentences[0];
  return (await joiner.join(page, sentence, cleanForSpeech(page.text.slice(sentence.start, sentence.end)))).text;
}

describe('перенос без знака', () => {
  it('склейка — слово, а обрывок — нет: склеить наверняка', () => {
    const known = new Set(['сообщает', 'ленной', 'направленной']);
    assert.equal(classifyBreak({ left: 'сооб', right: 'щает' }, known), 'join');
    assert.equal(classifyBreak({ left: 'Сооб', right: 'щает' }, known), 'join');
    assert.equal(classifyBreak({ left: 'направ', right: 'ленной' }, known), 'join');
  });

  it('и склейка, и оба обрывка — слова: «может быть»', () => {
    assert.equal(classifyBreak({ left: 'за', right: 'душу' }, new Set(['задушу', 'душу'])), 'maybe');
    assert.equal(classifyBreak({ left: 'на', right: 'чало' }, new Set(['начало', 'чало'])), 'maybe');
  });

  it('служебные слова — слова, даже если словарь о них молчит', () => {
    assert.equal(classifyBreak({ left: 'то', right: 'лько' }, new Set(['только'])), 'join');
    assert.deepEqual(wordsToCheck([{ left: 'то', right: 'лько' }]), ['лько', 'только']);
  });

  it('склейки нет в словаре — два слова', () => {
    assert.equal(classifyBreak({ left: 'автор', right: 'книги' }, new Set(['автор', 'книги'])), 'no');
    assert.equal(classifyBreak({ left: 'тот', right: 'же' }, new Set(['тотже'])), 'no');
    assert.equal(classifyBreak({ left: 'измени', right: 'ли' }, new Set(['изменили', 'измени'])), 'maybe');
  });

  it('разрывы — только между буквами кириллицы', () => {
    const text = 'Он сооб щает, что Big data там.';
    assert.deepEqual(breakWords(text, [text.indexOf(' щает')]), [{ at: 7, left: 'сооб', right: 'щает' }]);
    assert.deepEqual(breakWords(text, [text.indexOf(' data')]), []);
    assert.deepEqual(breakWords(text, [text.indexOf(' там')]), []); // перед пробелом — не буква
  });

  it('склейка убирает пробел и из текста, и из карты символов', () => {
    const raw = 'Он сооб щает.';
    const joined = joinAt(cleanForSpeech(raw), [7]);
    assert.equal(joined.text, 'Он сообщает.');
    assert.equal(joined.map.length, joined.text.length);
    assert.equal(raw[joined.map[7]], 'щ');
  });

  it('документ потерял дефисы — по доле однозначных склеек', () => {
    assert.equal(looksLossy({ sure: 0, seen: 30 }), false);
    assert.equal(looksLossy({ sure: 2, seen: 4 }), false);
    assert.equal(looksLossy({ sure: 5, seen: 30 }), true);
    assert.equal(looksLossy({ sure: 3, seen: 60 }), false);
  });

  it('обычный документ: однозначное склеено, «по том» и «на чало» — нет', async () => {
    let asked = 0;
    const joiner = createWordJoiner(async (words) => {
      asked += 1;
      return lookup(words);
    });
    const page = pageOf(['Он сооб', 'щает, что по', 'том же пути', 'направ', 'ленной и на', 'чало.']);
    assert.equal(await spoken(joiner, page), 'Он сообщает, что по том же пути направленной и на чало.');
    assert.equal(joiner.lossy, false);
    await spoken(joiner, page);
    assert.equal(asked, 1);
  });

  it('документ без дефисов: склеено и неоднозначное', async () => {
    const joiner = createWordJoiner(lookup);
    const page = pageOf(['Он сооб', 'щает, что то', 'лько направ', 'ленной кни', 'ги на', 'чало.']);
    assert.equal(await spoken(joiner, page), 'Он сообщает, что только направленной книги начало.');
    assert.equal(joiner.lossy, true);
    assert.equal(await joiner.joins('при', 'мер'), true);
  });

  it('словарь не готов — текст как есть, и ответ не запоминается', async () => {
    let ready = false;
    const joiner = createWordJoiner(async (words) => (ready ? lookup(words) : null));
    const page = pageOf(['Он сооб', 'щает.']);
    assert.equal(await spoken(joiner, page), 'Он сооб щает.');
    ready = true;
    assert.equal(await spoken(joiner, page), 'Он сообщает.');
  });

  it('стык страниц: «сооб» + «щает»', async () => {
    const joiner = createWordJoiner(lookup);
    assert.equal(await joiner.joins('сооб', 'щает'), true);
    assert.equal(await joiner.joins('автор', 'книги'), false);
    assert.equal(await joiner.joins('по', 'том'), false);
    assert.equal(await joiner.joins('data', 'там'), false);
  });

  it('buildPageText отмечает разрыв строки посреди слова без знака', () => {
    const items = [item('Автор сооб', 50, 700, { hasEOL: true }), item('щает, что начало', 50, 688, { hasEOL: true }), item('Новый абзац.', 50, 650)];
    const { text, softBreaks } = buildPageText(items);
    assert.ok(softBreaks.length >= 1, JSON.stringify({ text, softBreaks }));
    assert.equal(text.slice(softBreaks[0] - 4, softBreaks[0] + 5), 'сооб щает');
  });
});
