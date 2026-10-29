import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bertWordSpans, createAccentuator, fixCapital, groupWordPieces, omographContext, tokens } from '../../extension/src/tts/ruaccent.js';

const DICTIONARY = {
  старый: 'ст+арый', стоял: 'сто+ял', холме: 'холм+е', запер: 'з+апер', дверь: 'дв+ерь', все: 'вс+е', всё: 'вс+ё',
  это: '+это', было: 'б+ыло', зря: 'зр+я', учёные: 'уч+ёные', спорили: 'сп+орили', правах: 'прав+ах', ещё: 'ещ+ё', на: 'н+а',
};
const stress = { accent: (word) => DICTIONARY[word] ?? null };

function accentuator(models = {}) {
  return createAccentuator(
    {
      stress,
      yoWords: new Map([['ученые', 'учёные'], ['еще', 'ещё']]),
      yoHomographs: new Map([['все', 'всё']]),
      omographs: new Map([['замок', ['з+амок', 'зам+ок']]]),
    },
    models
  );
}

describe('ударения RUAccent: вспомогательное', () => {
  it('регистр переносится и через «+»', () => {
    assert.equal(fixCapital('Замок', 'зам+ок'), 'Зам+ок');
    assert.equal(fixCapital('ЗАМОК', 'з+амок'), 'З+АМОК');
    assert.equal(fixCapital('Ученые', 'учёные'), 'Учёные');
    assert.equal(fixCapital('дом', 'домик'), 'домик', 'другая длина — как есть');
  });

  it('слова и знаки — как у RUAccent', () => {
    assert.deepEqual(
      tokens('Он запер, «дверь»...').map((token) => token.text),
      ['Он', 'запер', ',', '«', 'дверь', '»...']
    );
  });

  it('границы слов BERT: каждый знак — отдельно', () => {
    const text = 'все это, «зря»!';
    assert.deepEqual(
      bertWordSpans(text).map(({ start, end }) => text.slice(start, end)),
      ['все', 'это', ',', '«', 'зря', '»', '!']
    );
  });

  it('куски WordPiece собираются в слова', () => {
    assert.deepEqual(groupWordPieces(['неу', '##жели', 'всё', '?', 'спо', '##ры']), [0, 0, 1, 2, 3, 3]);
  });

  it('контекст омографа — как в обучении модели', () => {
    assert.equal(omographContext(['Старый', 'замок', 'стоял', '.'], 1), 'Старый  <w>замок</w>  стоял.');
  });
});

describe('ударения RUAccent: разметка фразы', () => {
  it('словарь, «ё», служебные слова без ударения, знаки не трогаются', async () => {
    const out = await accentuator().process('Ученые спорили о правах, еще — на холме!');
    assert.equal(out, 'Уч+ёные сп+орили о прав+ах, ещ+ё — на холм+е!');
  });

  it('омограф выбирает нейросеть по контексту', async () => {
    const seen = [];
    const out = await accentuator({
      chooseOmograph: async (context, variants) => {
        seen.push(context);
        return context.includes('дверь') ? variants[1] : variants[0];
      },
    }).process('Он запер дверь на замок. Старый замок стоял.');
    assert.equal(out, 'Он з+апер дв+ерь на зам+ок. Ст+арый з+амок сто+ял.');
    // Контекст — своё предложение, а не весь текст.
    assert.deepEqual(seen, ['Он запер дверь на  <w>замок</w>.', 'Старый  <w>замок</w>  стоял.']);
  });

  it('второй омограф в предложении видит уже размеченный первый', async () => {
    const seen = [];
    await accentuator({
      chooseOmograph: async (context, variants) => {
        seen.push(context);
        return variants[1];
      },
    }).process('Замок и замок.');
    assert.deepEqual(seen, [' <w>Замок</w>  и замок.', 'зам+ок и  <w>замок</w>.']);
  });

  it('все/всё решает нейросеть «ё»; без неё — как написано', async () => {
    const yoLabels = async (text) => bertWordSpans(text).map(({ start, end }) => (text.slice(start, end) === 'все' && text.includes('зря') ? 'YO' : 'NO_YO'));
    assert.equal(await accentuator({ yoLabels }).process('Все это было зря.'), 'Вс+ё +это б+ыло зр+я.');
    assert.equal(await accentuator({ yoLabels }).process('Все это было.'), 'Вс+е +это б+ыло.');
    assert.equal(await accentuator().process('Все это было зря.'), 'Вс+е +это б+ыло зр+я.');
  });

  it('незнакомое слово — нейросеть по буквам, односложное не трогаем', async () => {
    const asked = [];
    const out = await accentuator({
      accentWord: async (word) => {
        asked.push(word);
        return word === 'кимлика' ? 'к+имлика' : null;
      },
    }).process('Кимлика и Ролз, и Ward.');
    assert.equal(out, 'К+имлика и Ролз, и Ward.');
    assert.deepEqual(asked, ['кимлика']);
  });

  it('ручное ударение главнее словаря', async () => {
    assert.equal(await accentuator().process('Старый з+амок'), 'Ст+арый з+амок');
  });
});
