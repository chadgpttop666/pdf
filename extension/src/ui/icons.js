// Иконки интерфейса. Рисуем их сами в одном стиле (24×24, линия 2px), а не
// эмодзи: эмодзи в Windows выглядят по-разному и выбиваются из интерфейса.
// SVG собирается через DOM, без innerHTML — так требует проверка AMO.

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILLED = { fill: 'currentColor', stroke: 'none' };
const BOOKMARK_PATH = 'M7 3.5h10a1 1 0 0 1 1 1V21l-6-4-6 4V4.5a1 1 0 0 1 1-1z';

/** Каждая иконка — список элементов SVG с их атрибутами. */
const ICONS = {
  sidebar: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }], ['path', { d: 'M9.5 4v16' }]],
  open: [
    ['path', { d: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z' }],
  ],
  chevronLeft: [['path', { d: 'M15 18l-6-6 6-6' }]],
  chevronRight: [['path', { d: 'M9 18l6-6-6-6' }]],
  chevronDown: [['path', { d: 'M6 9l6 6 6-6' }]],
  minus: [['path', { d: 'M5 12h14' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  autoscroll: [['path', { d: 'M7 5l5 5 5-5M7 12l5 5 5-5' }]],
  speak: [
    ['path', { d: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z' }],
    ['path', { d: 'M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11' }],
  ],
  search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'M20 20l-4.2-4.2' }]],
  bookmark: [['path', { d: BOOKMARK_PATH }]],
  bookmarkPlus: [['path', { d: BOOKMARK_PATH }], ['path', { d: 'M12 7.5v6M9 10.5h6' }]],
  bookmarkFilled: [['path', { d: BOOKMARK_PATH, ...FILLED }]],
  appearance: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 3.5a8.5 8.5 0 0 1 0 17z', ...FILLED }]],
  settings: [
    ['path', { d: 'M4 7h8.5M16.5 7H20M4 17h3.5M11.5 17H20' }],
    ['circle', { cx: 14.5, cy: 7, r: 2 }],
    ['circle', { cx: 9.5, cy: 17, r: 2 }],
  ],
  help: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M9.7 9.3a2.4 2.4 0 0 1 4.6.9c0 1.6-2.3 2-2.3 3.5' }],
    ['path', { d: 'M12 16.8v.2' }],
  ],
  lock: [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }]],
  unlock: [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 10.5V8a4 4 0 0 1 7.7-1.5' }]],
  play: [['path', { d: 'M8 5.5v13l10.5-6.5z', ...FILLED }]],
  pause: [
    ['rect', { x: 6.5, y: 5.5, width: 4, height: 13, rx: 1, ...FILLED }],
    ['rect', { x: 13.5, y: 5.5, width: 4, height: 13, rx: 1, ...FILLED }],
  ],
  stop: [['rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 1.5, ...FILLED }]],
  skipBack: [['path', { d: 'M18 6v12l-8.5-6z', ...FILLED }], ['path', { d: 'M6.5 6v12' }]],
  skipForward: [['path', { d: 'M6 6v12l8.5-6z', ...FILLED }], ['path', { d: 'M17.5 6v12' }]],
  close: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
  trash: [['path', { d: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5' }]],
};

const SVG_ATTRIBUTES = {
  viewBox: '0 0 24 24',
  width: 18,
  height: 18,
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
  class: 'icon-svg',
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries(SVG_ATTRIBUTES)) svg.setAttribute(key, String(value));
  for (const [tag, attributes] of ICONS[name] || []) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, String(value));
    svg.append(child);
  }
  return svg;
}

/** Поставить или заменить иконку у кнопки, не трогая подпись рядом с ней. */
export function setIcon(element, name) {
  element.querySelector(':scope > .icon-svg')?.remove();
  element.prepend(icon(name));
  element.dataset.icon = name;
}

/** Расставить иконки всем элементам с data-icon. */
export function hydrateIcons(root = document) {
  for (const element of root.querySelectorAll('[data-icon]')) setIcon(element, element.dataset.icon);
}
