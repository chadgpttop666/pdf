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
 *
 * segments — куски исходного текста, которые произносятся иначе («1928» →
 * «тысяча девятьсот двадцать восьмом»): их вес — длина произносимого.
 * @returns {{ charIndex: number, charLength: number, at: number }[]} at — доля длительности 0…1
 */
export function estimateWordTimings(text, segments = []) {
  const letters = (value) => value.replace(/[^\p{L}\p{N}]/gu, '').length;
  const units = segments.map(({ start, end, spoken }) => ({ charIndex: start, charLength: end - start, weight: letters(spoken) }));
  const inSegment = (index) => segments.some(({ start, end }) => index >= start && index < end);
  for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu)) {
    if (inSegment(match.index)) continue;
    units.push({ charIndex: match.index, charLength: match[0].length, weight: letters(match[0]) });
  }
  units.sort((a, b) => a.charIndex - b.charIndex);
  const total = units.reduce((sum, unit) => sum + unit.weight, 0);
  if (!total) return [];
  let spoken = 0;
  return units.map(({ charIndex, charLength, weight }) => {
    const timing = { charIndex, charLength, at: spoken / total };
    spoken += weight;
    return timing;
  });
}
