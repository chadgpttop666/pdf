import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitLanguageRuns } from '../../extension/src/tts/language-runs.js';

const pieces = (text) => splitLanguageRuns(text).map((run) => [run.lang, text.slice(run.start, run.end)]);

describe('русский текст и английские вставки', () => {
  it('названия на английском — отдельными кусками', () => {
    assert.deepEqual(pieces('журналы «Journal of Political Philosophy» и «Ethics» и др.'), [
      ['ru', 'журналы «'],
      ['en', 'Journal of Political Philosophy'],
      ['ru', '» и «'],
      ['en', 'Ethics'],
      ['ru', '» и др.'],
    ]);
  });

  it('запятая между английскими словами не дробит вставку, числа — русские', () => {
    assert.deepEqual(pieces('[Cavalieri, Singer 1993]'), [
      ['ru', '['],
      ['en', 'Cavalieri, Singer'],
      ['ru', ' 1993]'],
    ]);
  });

  it('одиночные латинские буквы не считаются английским', () => {
    assert.deepEqual(pieces('Goodin 1992a и пункт x'), [
      ['en', 'Goodin'],
      ['ru', ' 1992a и пункт x'],
    ]);
    assert.deepEqual(pieces('Только русский текст.'), [['ru', 'Только русский текст.']]);
  });

  it('куски покрывают весь текст без пропусков', () => {
    const text = 'Проект (Great Ape Project), движение [Cavalieri, Singer 1993].';
    const runs = splitLanguageRuns(text);
    assert.equal(runs[0].start, 0);
    assert.equal(runs.at(-1).end, text.length);
    runs.slice(1).forEach((run, i) => assert.equal(run.start, runs[i].end));
  });
});
