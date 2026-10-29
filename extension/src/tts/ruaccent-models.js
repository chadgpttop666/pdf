// Нейросети RUAccent поверх ONNX Runtime — для ruaccent.js:
//   • «ё»: для каждого слова фразы — нужна ли «ё» (DistilBERT);
//   • омографы: какой вариант ударения подходит к фразе (DeBERTa, пары
//     «фраза с <w>словом</w>» + «вариант»);
//   • незнакомые слова: где ударение — по буквам (RoFormer).
// ONNX Runtime и токенизатор передаются снаружи: в расширении — из vendor,
// в проверочных скриптах на Node — из node_modules.

import { groupWordPieces } from './ruaccent.js';

function softmax(values) {
  const max = Math.max(...values);
  const exp = values.map((value) => Math.exp(value - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((value) => value / sum);
}

/** Строка логитов [.., n] → массив строк вероятностей. */
function rows(tensor) {
  const width = tensor.dims.at(-1);
  const out = [];
  for (let i = 0; i < tensor.data.length; i += width) out.push(softmax(Array.from(tensor.data.slice(i, i + width))));
  return out;
}

const argmax = (values) => values.reduce((best, value, i) => (value > values[best] ? i : best), 0);

/**
 * @param ort модуль onnxruntime-web
 * @param Tokenizer класс из @huggingface/tokenizers
 * @param files {
 *   yoModel, omographModel, accentModel: Uint8Array|ArrayBuffer,
 *   yoTokenizer, yoTokenizerConfig, omographTokenizer, omographTokenizerConfig: объекты JSON,
 *   yoLabels: { [номер]: метка }, accentVocab: string (vocab.txt), accentLabels: { [номер]: метка }
 * }
 */
export async function createAccentModels(ort, Tokenizer, files) {
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const bytes = (data) => (data instanceof Uint8Array ? data : new Uint8Array(data));
  const [yo, omograph, accent] = await Promise.all([
    ort.InferenceSession.create(bytes(files.yoModel), options),
    ort.InferenceSession.create(bytes(files.omographModel), options),
    ort.InferenceSession.create(bytes(files.accentModel), options),
  ]);
  const yoTokenizer = new Tokenizer(files.yoTokenizer, files.yoTokenizerConfig);
  const omographTokenizer = new Tokenizer(files.omographTokenizer, files.omographTokenizerConfig);
  const vocab = new Map(
    files.accentVocab
      .split('\n')
      .map((token) => token.replace(/\r$/, ''))
      .map((token, i) => [token, i])
  );
  const special = (name) => vocab.get(name) ?? 0;

  const int64 = (values) => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length]);
  /** Только те входы, что объявлены в графе: у моделей они разные. */
  function feeds(session, ids, typeIds) {
    const all = {
      input_ids: int64(ids),
      attention_mask: int64(ids.map(() => 1)),
      token_type_ids: int64(typeIds ?? ids.map(() => 0)),
    };
    return Object.fromEntries(session.inputNames.map((name) => [name, all[name]]));
  }

  return {
    /** Метка для каждого слова фразы (как в bertWordSpans): YO, NO_YO, PUNCT. */
    async yoLabels(text) {
      const encoded = yoTokenizer.encode(text);
      const { logits } = await yo.run(feeds(yo, encoded.ids));
      // Без [CLS] в начале и [SEP] в конце.
      const scores = rows(logits).slice(1, -1);
      const groups = groupWordPieces(encoded.tokens.slice(1, -1));
      const sums = [];
      groups.forEach((group, i) => {
        sums[group] ||= { total: scores[i].map(() => 0), count: 0 };
        scores[i].forEach((value, k) => (sums[group].total[k] += value));
        sums[group].count += 1;
      });
      return sums.map(({ total }) => files.yoLabels[argmax(total)]);
    },

    /** Вариант ударения омографа, наиболее подходящий к фразе. */
    async chooseOmograph(context, variants) {
      let best = variants[0];
      let bestScore = -1;
      for (const variant of variants) {
        const encoded = omographTokenizer.encode(context, { text_pair: variant, return_token_type_ids: true });
        const { logits } = await omograph.run(feeds(omograph, encoded.ids, encoded.token_type_ids));
        const score = rows(logits)[0][1];
        if (score > bestScore) {
          best = variant;
          bestScore = score;
        }
      }
      return best;
    },

    /** Незнакомое слово: «+» перед буквами, которые нейросеть считает ударными. */
    async accentWord(word) {
      const chars = [...word.toLowerCase()];
      if (chars.length > 56) return null;
      const ids = [special('[bos]'), ...chars.map((char) => vocab.get(char) ?? special('[unk]')), special('[eos]')];
      const { logits } = await accent.run(feeds(accent, ids));
      const scores = rows(logits);
      let marked = false;
      const out = chars.map((char, i) => {
        const row = scores[i + 1];
        const label = files.accentLabels[argmax(row)];
        if (label === 'NO' || label === 'STRESS_SECONDARY' || Math.max(...row) < 0.55) return char;
        marked = true;
        return `+${char}`;
      });
      return marked ? out.join('') : null;
    },
  };
}
