import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { paragraphsFromSelection, sentencesOf } from '../../extension/src/speak-text.js';

describe('выделенный на сайте текст → абзацы', () => {
  it('блоки страницы — отдельными абзацами', () => {
    assert.deepEqual(paragraphsFromSelection('Заголовок статьи\nПервый абзац текста.\n\nВторой абзац.'), [
      'Заголовок статьи',
      'Первый абзац текста.',
      'Второй абзац.',
    ]);
  });

  it('строки по ширине колонки склеиваются, переносы по слогам убираются', () => {
    const copied = 'Выдвигаемые аргументы часто по-настоящему оригиналь-\nны, и не только в разработке\nновых вариаций старых тем.\nНовый абзац.';
    assert.deepEqual(paragraphsFromSelection(copied), [
      'Выдвигаемые аргументы часто по-настоящему оригинальны, и не только в разработке новых вариаций старых тем.',
      'Новый абзац.',
    ]);
  });

  it('пробелы, неразрывные пробелы и мягкие переносы', () => {
    assert.deepEqual(paragraphsFromSelection('  Сло­во и   ещё\t слово \r\n\r\n\r\n'), ['Слово и ещё слово']);
    assert.deepEqual(paragraphsFromSelection(''), []);
    assert.deepEqual(paragraphsFromSelection(null), []);
  });

  it('предложения знают свой абзац и место в нём', () => {
    const sentences = sentencesOf(['Первое предложение. Второе!', 'Третье?']);
    assert.deepEqual(
      sentences.map(({ text, paragraph }) => [paragraph, text]),
      [
        [0, 'Первое предложение.'],
        [0, 'Второе!'],
        [1, 'Третье?'],
      ]
    );
    assert.equal('Первое предложение. Второе!'.slice(sentences[1].start, sentences[1].end), 'Второе!');
  });
});
