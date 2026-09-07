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

/** Не даёт горячим клавишам срабатывать, когда пользователь печатает. */
export function isTypingTarget(target) {
  const node = target instanceof Element ? target : null;
  if (!node) return false;
  return node.matches('input, textarea, select, [contenteditable="true"]');
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
