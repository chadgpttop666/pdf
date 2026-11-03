import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bertWordSpans, contextStress, createAccentuator, fixCapital, groupWordPieces, omographContext, tokens, yoByContext } from '../../extension/src/tts/ruaccent.js';

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

  it('тире «–» и годы между словами не снимают ударения со всей фразы', async () => {
    // Раньше «–» выбрасывался, «1796–1857» склеивалось в одно слово, слова не
    // совпадали — и фраза шла без ударений («фИлософ» вместо «филОсоф»).
    const out = await accentuator().process('Старый (1796–1857) стоял на холме, дверь–запер.');
    assert.equal(out, 'Ст+арый (1796–1857) сто+ял на холм+е, дв+ерь–з+апер.');
  });

  it('ударение знаком над гласной — как ручное «+»', async () => {
    assert.equal(await accentuator().process('Старый за\u0301мок'), 'Ст+арый з+амок');
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

  it('норма, а не просторечие: «звонит», «щавель» — без нейросети, по орфоэпическому словарю', async () => {
    let asked = 0;
    const acc = createAccentuator(
      { stress, yoWords: new Map(), yoHomographs: new Map(), omographs: new Map([['звонит', ['зв+онит', 'звон+ит']]]) },
      {
        chooseOmograph: async (context, variants) => {
          asked += 1;
          return variants[0];
        },
      }
    );
    assert.equal(await acc.process('Кто звонит? Щавель!'), 'Кто звон+ит? Щав+ель!');
    assert.equal(asked, 0);
    // «Века» после «двадцатого» — единственное число.
    assert.equal(await acc.process('начала двадцатого века'), 'начала двадцатого в+ека');
  });

  it('редкий вариант омографа не выбирается: «была́», «своему́», «душа́» — без сети', async () => {
    let asked = 0;
    const acc = createAccentuator(
      { stress, yoWords: new Map(), yoHomographs: new Map(), omographs: new Map([['была', ['б+ыла', 'был+а']], ['своему', ['св+оему', 'своем+у']], ['душа', ['д+уша', 'душ+а']]]) },
      {
        chooseOmograph: async (context, variants) => {
          asked += 1;
          return variants[0];
        },
      }
    );
    assert.equal(await acc.process('Душа была рада своему делу.'), 'Душ+а был+а рада своем+у делу.');
    assert.equal(asked, 0);
  });

  it('«уже» и «начала» — по соседним словам', () => {
    assert.equal(contextStress('уже', 'сегодня', 'нет'), 'уж+е');
    assert.equal(contextStress('уже', 'всё', 'и'), '+уже');
    assert.equal(contextStress('уже', 'стала', 'чем'), '+уже');
    assert.equal(contextStress('уже', 'дорога', 'чем'), '+уже');
    assert.equal(contextStress('начала', 'работница', 'понимать'), 'начал+а');
    assert.equal(contextStress('начала', 'после', 'войны'), 'нач+ала');
    assert.equal(contextStress('начало', 'дверей', 'представляться'), 'н+ачало');
    assert.equal(contextStress('начала', 'конференции', 'войны'), undefined);
    assert.equal(contextStress('замок', 'старый', 'на'), undefined);
  });

  it('«ё» по соседним словам — до сети: «все замерли», «много лет», «о нём»', async () => {
    assert.equal(yoByContext('все', '', 'замерли', ''), false);
    assert.equal(yoByContext('все', 'и', 'дружно', 'закричали'), false);
    assert.equal(yoByContext('все', '', 'мы', 'должны'), false);
    assert.equal(yoByContext('все', 'быть', '', '', true), undefined, '«как» нет — решает сеть');
    assert.equal(yoByContext('все', 'как', '', '', true), false);
    assert.equal(yoByContext('все', 'заказали', 'кроме', 'дмитрия'), false);
    assert.equal(yoByContext('все', 'бросив', 'кроме', 'чемоданов'), undefined);
    assert.equal(yoByContext('все', '', 'равно', 'ушли'), undefined, '«всё равно» — сеть');
    assert.equal(yoByContext('все', 'он', 'еще', 'ждал'), undefined, '«всё ещё» — сеть');
    assert.equal(yoByContext('все', 'вспоминала', 'новые', 'и'), undefined);
    assert.equal(yoByContext('лет', 'много', '', ''), false);
    assert.equal(yoByContext('небо', 'ясное', '', ''), false);
    assert.equal(yoByContext('нем', 'о', 'говорили', ''), true);
    assert.equal(yoByContext('нем', 'был', 'как', 'рыба'), false);
    assert.equal(yoByContext('чем', 'лучше', 'вчера', ''), false);
    assert.equal(yoByContext('полет', 'долгий', '', ''), true);
    assert.equal(yoByContext('берет', 'он', '', ''), undefined);

    // Решённое правилами в сеть не идёт; остальное — как раньше.
    const asked = [];
    const yoLabels = async (text) => {
      asked.push(text);
      return bertWordSpans(text).map(() => 'YO');
    };
    assert.equal(await accentuator({ yoLabels }).process('Все замерли.'), 'Вс+е замерли.');
    assert.deepEqual(asked, []);
    assert.equal(await accentuator({ yoLabels }).process('Все это было зря.'), 'Вс+ё +это б+ыло зр+я.');
    assert.equal(asked.length, 1);
  });
});
