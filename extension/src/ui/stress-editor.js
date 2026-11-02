// Исправить ударение в слове прямо в книге: буквы слова, гласные — кнопки.
// Для «е» — ещё кнопка «ё» («все» → «всё»). Исправление — во всех книгах
// или только в этой (омографы: «мук+у» в одной, «м+уку» в другой).

import { $, clear, el, on } from '../dom.js';
import { removeUserStress, setUserStress, showStress, stressKey, userStressFor } from '../tts/user-stress.js';

const VOWELS = 'аеёиоуыэюя';

/** Одно ли это слово, в котором есть что ударять. */
export function stressableWord(text) {
  const word = text.trim();
  return /^[\p{L}-]{2,40}$/u.test(word) && [...word.toLowerCase()].some((char) => VOWELS.includes(char)) ? word : null;
}

/**
 * @param app контекст читалки (hud, readingState)
 * @param onSaved вызывается после сохранения — например, прослушать слово
 */
export function createStressEditor(app, { onSaved } = {}) {
  const panel = $('markStressPanel');
  const box = $('markStressWord');
  const thisBook = $('markStressThisBook');
  const saveButton = $('markStressSave');
  const removeButton = $('markStressRemove');
  let word = null;
  let chosen = null; // { index, yo }

  function stressed() {
    if (!word || !chosen) return null;
    const letters = [...word.toLowerCase()];
    if (chosen.yo) letters[chosen.index] = 'ё';
    letters.splice(chosen.index, 0, '+');
    return letters.join('');
  }

  function render() {
    clear(box);
    [...word].forEach((char, index) => {
      const lower = char.toLowerCase();
      if (!VOWELS.includes(lower)) {
        box.append(el('span', { class: 'letter' }, char));
        return;
      }
      const active = chosen?.index === index;
      const shown = active && chosen.yo ? (char === lower ? 'ё' : 'Ё') : char;
      const pick = el('button', { type: 'button', class: active && !chosen.yo ? 'active' : '', title: `Ударение на «${shown}»` }, shown);
      on(pick, 'click', () => choose(index, false));
      const column = el('span', { class: 'vowel' }, [pick]);
      if (lower === 'е') {
        const yo = el('button', { type: 'button', class: `yo${active && chosen.yo ? ' active' : ''}`, title: 'Здесь «ё»' }, 'ё');
        on(yo, 'click', () => choose(index, true));
        column.append(yo);
      }
      box.append(column);
    });
    saveButton.disabled = !chosen;
    saveButton.textContent = chosen ? `Сохранить «${showStress(stressed())}» и прослушать` : 'Сохранить и прослушать';
  }

  function choose(index, yo) {
    chosen = { index, yo };
    render();
  }

  /** Открыть для слова; уже исправленное — с его ударением. */
  function open(selected) {
    word = selected;
    const existing = userStressFor(word, app.readingState?.documentId);
    chosen = null;
    if (existing) {
      const plus = existing.stressed.indexOf('+');
      chosen = { index: plus, yo: existing.stressed[plus + 1] === 'ё' };
    }
    thisBook.checked = Boolean(existing?.docId);
    thisBook.disabled = !app.readingState?.documentId;
    removeButton.hidden = !existing;
    render();
    panel.hidden = false;
  }

  function close() {
    panel.hidden = true;
    word = null;
    chosen = null;
  }

  on(saveButton, 'click', async () => {
    const form = stressed();
    if (!form) return;
    const docId = thisBook.checked ? app.readingState?.documentId ?? null : null;
    try {
      await setUserStress(word, form, docId);
    } catch (error) {
      app.hud.show(error.message);
      return;
    }
    app.hud.show(`Ударение: ${showStress(form)} — ${docId ? 'в этой книге' : 'во всех книгах'}`, { duration: 3000 });
    const saved = word;
    close();
    onSaved?.(saved, form);
  });

  on(removeButton, 'click', async () => {
    const existing = userStressFor(word, app.readingState?.documentId);
    if (existing) await removeUserStress(stressKey(word), existing.docId);
    app.hud.show(`Ударение в слове «${word}» — снова как в словаре`, { duration: 3000 });
    close();
    onSaved?.(null, null);
  });

  return {
    open,
    close,
    get isOpen() {
      return !panel.hidden;
    },
  };
}
