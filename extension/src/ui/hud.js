// Всплывающая подсказка в углу: скорость автопрокрутки, номер страницы при
// перемотке, короткие сообщения об ошибках.

export function createHud(node) {
  let timer = 0;
  let sticky = false;

  function hide() {
    clearTimeout(timer);
    sticky = false;
    node.hidden = true;
  }

  function show(text, { duration = 1200, keep = false } = {}) {
    clearTimeout(timer);
    node.textContent = text;
    node.hidden = false;
    sticky = keep;
    if (!keep) timer = setTimeout(hide, duration);
  }

  return {
    show,
    hide,
    /** Обновить текст, не сбивая «прилипший» показ (например, во время автоскролла). */
    update(text) {
      if (sticky) node.textContent = text;
      else show(text);
    },
    get isSticky() {
      return sticky;
    },
  };
}
