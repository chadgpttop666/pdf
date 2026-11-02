// Свой словарь ударений: исправления читателя главнее RUAccent. Слово, в
// котором уже стоит «+», RUAccent не трогает, поэтому исправление — это просто
// «+» перед нужной гласной до разметки ударений.
//
// Запись: { key, stressed, docId } — key: слово строчными, «ё» как «е»;
// stressed: «фил+ософ», «вс+ё»; docId: null — во всех книгах, иначе только в
// этой (так решаются омографы: «мук+у» в одной книге, «м+уку» в другой).

import { storage } from '../platform.js';

const KEY = 'userStress';
const VOWELS = 'аеёиоуыэюя';

let entries = [];
let loading = null;
let currentDoc = null;
const listeners = new Set();

/** Ключ слова: строчные, «ё» — как «е». */
export const stressKey = (word) => word.toLowerCase().replace(/ё/g, 'е');

function notify() {
  for (const listener of listeners) listener(entries);
}

export function loadUserStress() {
  loading ??= Promise.resolve(storage.get(KEY))
    .then((stored) => {
      entries = Array.isArray(stored?.[KEY]) ? stored[KEY] : [];
      notify();
    })
    .catch(() => {});
  return loading;
}

// Поправили в другой вкладке — здесь тоже.
globalThis.browser?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !changes[KEY]) return;
  entries = changes[KEY].newValue ?? [];
  notify();
});

async function save() {
  await storage.set({ [KEY]: entries });
  notify();
}

/** Книга, которая сейчас открыта: её исправления главнее общих. */
export function setStressDocument(docId) {
  currentDoc = docId ?? null;
}

export function userStressEntries() {
  return entries;
}

export function onUserStressChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** «фил+ософ» → «фило́соф»: так ударение видно в списке. */
export function showStress(stressed) {
  return stressed.replace(/\+(.)/gu, '$1́');
}

/** Годится ли исправление: те же буквы (с точностью до ё), ровно одно «+» перед гласной. */
export function validStress(word, stressed) {
  const plus = stressed.indexOf('+');
  if (plus < 0 || stressed.indexOf('+', plus + 1) >= 0) return false;
  if (!VOWELS.includes((stressed[plus + 1] || '').toLowerCase())) return false;
  return stressKey(stressed.replace('+', '')) === stressKey(word);
}

/** Записать исправление. docId — только для этой книги; null — везде. */
export async function setUserStress(word, stressed, docId = null) {
  await loadUserStress();
  const normalized = stressed.toLowerCase();
  if (!validStress(word, normalized)) throw new Error('Ударение должно стоять перед гласной этого слова');
  const key = stressKey(word);
  entries = [...entries.filter((entry) => !(entry.key === key && entry.docId === docId)), { key, stressed: normalized, docId, at: Date.now() }];
  await save();
}

export async function removeUserStress(key, docId = null) {
  await loadUserStress();
  entries = entries.filter((entry) => !(entry.key === key && entry.docId === docId));
  await save();
}

/** Исправление для слова: сначала этой книги, потом общее. */
export function userStressFor(word, docId = currentDoc) {
  const key = stressKey(word);
  return (
    entries.find((entry) => entry.key === key && docId && entry.docId === docId) ?? entries.find((entry) => entry.key === key && !entry.docId) ?? null
  );
}

/** Регистр исходного слова — на исправление: «Философ» → «Фил+ософ». */
function matchCase(original, stressed) {
  if (original === original.toUpperCase() && original.length > 1) return stressed.toUpperCase();
  const letters = [...stressed];
  const first = letters.findIndex((char) => char !== '+');
  if (original[0] === original[0].toUpperCase()) letters[first] = letters[first].toUpperCase();
  return letters.join('');
}

/**
 * Расставить ударения из своего словаря. Слова, где «+» уже стоит, не
 * трогаем. Буква «ё» из исправления переходит в текст: «все» → «вс+ё».
 */
export function applyUserStress(text, docId = currentDoc) {
  if (!entries.length) return text;
  return text.replace(/[\p{L}+]+/gu, (word) => {
    if (word.includes('+')) return word;
    const entry = userStressFor(word, docId);
    return entry ? matchCase(word, entry.stressed) : word;
  });
}
