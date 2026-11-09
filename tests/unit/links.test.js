import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findLinks, stripLinks } from '../../extension/src/tts/links.js';
import { cleanForSpeech } from '../../extension/src/text-index.js';

const spoken = (text) => stripLinks(text).text;

describe('интернет-ссылки не читаются (links.js)', () => {
  it('адреса со схемой, www, без схемы, почта, DOI', () => {
    assert.equal(spoken('Подробнее на https://example.com/a/b?x=1&y=2 и в книге.'), 'Подробнее на и в книге.');
    assert.equal(spoken('Сайт www.gramota.ru, где всё объяснено.'), 'Сайт, где всё объяснено.');
    assert.equal(spoken('Группа vk.com/club123 и канал t.me/reader выросли.'), 'Группа и канал выросли.');
    assert.equal(spoken('Пишите на reader@mail.ru.'), 'Пишите на.');
    assert.equal(spoken('Статья в журнале (DOI: 10.1000/182) вышла давно.'), 'Статья в журнале вышла давно.');
    assert.equal(spoken('Портал кремль.рф открыт.'), 'Портал открыт.');
  });

  it('библиографическая запись: «URL:» и «Режим доступа:» уходят вместе с адресом', () => {
    assert.equal(
      spoken('Иванов И. Чтение. — URL: https://cyberleninka.ru/article/n/chtenie (дата обращения: 12.03.2020).'),
      'Иванов И. Чтение. — (дата обращения: 12.03.2020).'
    );
    assert.equal(spoken('Режим доступа: http://lib.ru/book.txt.'), '');
  });

  it('скобка и точка после адреса остаются фразе, скобки внутри адреса — адресу', () => {
    assert.deepEqual(findLinks('см. (https://ru.wikipedia.org/wiki/Конт_(значения)).').length, 1);
    assert.equal(spoken('см. https://ru.wikipedia.org/wiki/Конт_(значения).'), 'см.');
    assert.equal(spoken('Текст (см. https://x.org/a), дальше.'), 'Текст (см.), дальше.');
  });

  it('не ссылки — остаются: файлы, сокращения, версии, ASP.NET', () => {
    for (const text of ['Откройте index.html и Node.js.', 'И т.д. и т.п.', 'Версия 1.2.3 вышла.', 'Платформа ASP.NET стара.', 'Сумма 3.ru-', 'Г.Москва']) {
      assert.equal(spoken(text), text, text);
    }
  });

  it('адрес, разорванный переносом строки, — целиком', () => {
    const { text } = cleanForSpeech('Источник: https://cyberleninka.ru/article/n/\nchtenie-s-ekrana. Дальше');
    assert.equal(spoken(text), 'Источник. Дальше');
  });

  it('карта позиций — в исходный текст: подсветка не съезжает', () => {
    const raw = 'Смотри https://a.ru/x тут';
    const cleaned = cleanForSpeech(raw);
    const result = stripLinks(cleaned);
    assert.equal(result.text, 'Смотри тут');
    assert.equal(result.map.length, result.text.length);
    const at = result.text.indexOf('тут');
    assert.equal(raw.slice(result.map[at], result.map[at] + 3), 'тут');
    assert.equal(stripLinks('без ссылок').removed, 0);
  });
});
