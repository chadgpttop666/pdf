// ONNX Runtime «на расстоянии»: сети ударений считает ускоритель, а
// ruaccent-models.js об этом не знает — у него тот же интерфейс
// (InferenceSession.create, session.run, Tensor), что у onnxruntime-web.
// Номера токенов уходят в ускоритель, логиты приходят обратно; в памяти
// вкладки нет ни ONNX Runtime, ни моделей (≈0,5 ГБ).

// Все входы, какие бывают у сетей ударений; лишние ускоритель отбросит сам —
// он знает, что объявлено в графе.
const INPUTS = ['input_ids', 'attention_mask', 'token_type_ids'];

/**
 * @param infer async (model, { имя: number[] }) => { dims: number[], data: Float32Array }
 */
export function createRemoteOrt(infer) {
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const InferenceSession = {
    /** model — имя модели у ускорителя (accentYo, accentOmograph, accentStress). */
    async create(model) {
      if (typeof model !== 'string') throw new Error('ускорителю нужна модель по имени');
      return {
        inputNames: INPUTS,
        async run(feeds) {
          const inputs = Object.fromEntries(Object.entries(feeds).map(([name, tensor]) => [name, Array.from(tensor.data, Number)]));
          const { dims, data } = await infer(model, inputs);
          return { logits: new Tensor('float32', data, dims) };
        },
      };
    },
  };
  return { Tensor, InferenceSession, remote: true };
}

/** Имя модели у ускорителя → часть пакета TeraTTS в браузере. */
export const HELPER_ACCENT_MODELS = { accentYo: 'yoModel', accentOmograph: 'omographModel', accentStress: 'accentModel' };
