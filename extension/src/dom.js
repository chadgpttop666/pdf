// Микро-хелперы вместо фреймворка: вьюер целиком состоит из статической
// разметки viewer.html, поэтому нужно только находить узлы и вешать события.

export const $ = (id) => document.getElementById(id);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function on(target, type, handler, options) {
  target?.addEventListener(type, handler, options);
  return () => target?.removeEventListener(type, handler, options);
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node?.firstChild) node.firstChild.remove();
  return node;
}

/**
 * Не даёт горячим клавишам срабатывать, когда пользователь печатает.
 * Ползунки, флажки и кнопки — не ввод текста: после того как подвинули
 * скорость, S и пробел должны работать.
 */
export function isTypingTarget(target) {
  const node = target instanceof Element ? target : null;
  if (!node) return false;
  const nonText = ['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image'];
  if (node.matches('input')) return !nonText.includes(node.type);
  return node.matches('textarea, select, [contenteditable="true"]');
}

/**
 * Модальное окно закрывается щелчком мимо него. Нажали внутри, а отпустили
 * снаружи (выделяли текст) — не считается.
 */
export function closeOnBackdropClick(dialog) {
  const outside = (event) => {
    if (event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (event) => {
    pressedOutside = outside(event);
  });
  dialog.addEventListener('click', (event) => {
    if (pressedOutside && outside(event)) dialog.close();
    pressedOutside = false;
  });
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Имя файла без символов, которые Windows не разрешает. */
export function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'документ';
}

/**
 * Сохранить файл на компьютер. Обычная ссылка с атрибутом download не
 * требует отдельного разрешения: Firefox кладёт файл в «Загрузки» или
 * спрашивает, куда сохранить, — как настроено в браузере.
 */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Сразу отзывать нельзя: загрузка стартует уже после щелчка.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
