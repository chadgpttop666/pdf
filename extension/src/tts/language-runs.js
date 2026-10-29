// Куски фразы по языку: русский текст и английские вставки — названия
// журналов, книг, фамилии («Journal of Political Philosophy», «Ethics»).
// Русский системный голос читает латиницу плохо, поэтому такие вставки
// озвучивает английский голос системы.

// Латинское слово: буквы, апостроф, дефис, точка внутри («U.S.»), «&».
// Буквы — любые латинские, с диакритикой тоже: иначе «Müller» рвался на
// «Mü» русским голосом и «ller» английским.
const LATIN_RUN = /\p{Script=Latin}[\p{Script=Latin}'’\-&.]*(?:[  ]+\p{Script=Latin}[\p{Script=Latin}'’\-&.]*)*/gu;

/**
 * @returns {{ start: number, end: number, lang: 'ru'|'en' }[]} куски подряд, покрывают весь текст
 */
export function splitLanguageRuns(text) {
  const english = [];
  for (const match of text.matchAll(LATIN_RUN)) {
    // Одиночные буквы («1992a», «x») — не английский текст.
    if (!/\p{Script=Latin}{2}/u.test(match[0])) continue;
    english.push({ start: match.index, end: match.index + match[0].length });
  }

  const runs = [];
  let cursor = 0;
  for (const run of english) {
    if (run.start > cursor) runs.push({ start: cursor, end: run.start, lang: 'ru' });
    runs.push({ ...run, lang: 'en' });
    cursor = run.end;
  }
  if (cursor < text.length) runs.push({ start: cursor, end: text.length, lang: 'ru' });

  // Запятая или пробел между двумя английскими кусками («Cavalieri, Singer»)
  // — часть английской вставки, а не повод переключать голос туда и обратно.
  const merged = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    const gap = previous && run.lang === 'en' && merged.at(-2)?.lang === 'en' && previous.lang === 'ru';
    if (gap && !/[\p{L}\p{N}]/u.test(text.slice(previous.start, previous.end)) && previous.end - previous.start <= 3) {
      merged.pop();
      merged.at(-1).end = run.end;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}
