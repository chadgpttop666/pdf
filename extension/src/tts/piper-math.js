// Чистые расчёты для нейроголоса Piper — без WASM и DOM, чтобы их можно было
// проверить юнит-тестами.

// Маркер начала фразы в словаре фонем Piper («^»).
const BOS = 1;

/**
 * Фонемизатор отдаёт фразы одним списком: «^ … $ ^ … $». Сам Piper
 * озвучивает каждую фразу отдельно — так и делаем.
 */
export function splitPhrases(ids) {
  const phrases = [];
  let current = [];
  for (const id of ids) {
    if (id === BOS && current.length) {
      phrases.push(current);
      current = [];
    }
    current.push(id);
  }
  if (current.length) phrases.push(current);
  return phrases;
}

/**
 * Границ слов Piper не сообщает. Оцениваем их по доле букв, произнесённых к
 * началу слова: голос говорит довольно ровно, так что подсветка слова идёт
 * близко к звуку. ⚠️ Это оценка, а не точная разметка.
 * @returns {{ charIndex: number, charLength: number, at: number }[]} at — доля длительности 0…1
 */
export function estimateWordTimings(text) {
  const words = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu)];
  const weight = (word) => word.replace(/[^\p{L}\p{N}]/gu, '').length;
  const total = words.reduce((sum, match) => sum + weight(match[0]), 0);
  if (!total) return [];
  let spoken = 0;
  return words.map((match) => {
    const timing = { charIndex: match.index, charLength: match[0].length, at: spoken / total };
    spoken += weight(match[0]);
    return timing;
  });
}
