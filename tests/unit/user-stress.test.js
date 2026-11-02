import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyUserStress,
  removeUserStress,
  setStressDocument,
  setUserStress,
  showStress,
  stressKey,
  userStressFor,
  validStress,
} from '../../extension/src/tts/user-stress.js';
import { stressableWord } from '../../extension/src/ui/stress-editor.js';

describe('свой словарь ударений', () => {
  it('исправление проверяется: те же буквы, одно «+» перед гласной', () => {
    assert.ok(validStress('философ', 'фил+ософ'));
    assert.ok(validStress('все', 'вс+ё'), '«ё» вместо «е» — то же слово');
    assert.ok(!validStress('философ', 'ф+ил+ософ'));
    assert.ok(!validStress('философ', 'фи+лософ'), '«+» перед согласной');
    assert.ok(!validStress('философ', 'фил+осо'));
    assert.equal(stressKey('Всё'), 'все');
    assert.equal(showStress('фил+ософ'), 'фило́соф');
  });

  it('применяется до RUAccent: регистр слова, «ё», ручное «+» не трогается', async () => {
    await setUserStress('философ', 'фил+ософ');
    await setUserStress('все', 'вс+ё');
    assert.equal(
      applyUserStress('Философ сказал: ВСЕ философы, а не фил+ософ, знают всё.'),
      'Фил+ософ сказал: ВС+Ё философы, а не фил+ософ, знают вс+ё.'
    );
    await removeUserStress('все');
    assert.equal(applyUserStress('все'), 'все');
  });

  it('исправление книги главнее общего; в другой книге — общее', async () => {
    await setUserStress('муку', 'мук+у');
    await setUserStress('муку', 'м+уку', 'book-a');
    setStressDocument('book-a');
    assert.equal(applyUserStress('терпеть муку'), 'терпеть м+уку');
    setStressDocument('book-b');
    assert.equal(applyUserStress('смолоть муку'), 'смолоть мук+у');
    assert.equal(userStressFor('Муку', 'book-a').docId, 'book-a');
    setStressDocument(null);
  });

  it('кнопка «А́» — только для одного слова с гласной', () => {
    assert.equal(stressableWord(' философ '), 'философ');
    assert.equal(stressableWord('северо-западный'), 'северо-западный');
    assert.equal(stressableWord('два слова'), null);
    assert.equal(stressableWord('вкл'), null);
    assert.equal(stressableWord('1888'), null);
  });
});
