// Подпись: расписаться мышью, пером или пальцем — и поставить на страницу.
// В Firefox для этого своё окно; в сборке компонентов pdf.js его нет,
// поэтому окно — наше. На страницу подпись идёт линиями — рисунком от руки
// (Ink), а не картинкой: так она чёткая при любом масштабе и в файле.
// Сохранённые подписи лежат в библиотеке (IndexedDB): штрихи и картинка для
// списка. Подписи из 0.24.0 — только картинка, они ставятся картинкой.

import { $, on } from '../dom.js';
import * as library from '../library.js';
import { setIcon } from '../ui/icons.js';

const INK = '#1b2a6b'; // тёмно-синие «чернила», как у ручки
const LINE = 2.6; // толщина линии в CSS-пикселях
const MAX_SAVED = 5;

/**
 * Штрихи → подпись: точки относительно её левого верхнего угла (с запасом
 * на толщину линии), в CSS-пикселях поля.
 * @param strokes [[x0, y0, x1, y1, …], …]
 */
export function normalizeStrokes(strokes, line = LINE) {
  const drawn = strokes.filter((stroke) => stroke.length >= 2);
  if (!drawn.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of drawn) {
    for (let i = 0; i < stroke.length; i += 2) {
      minX = Math.min(minX, stroke[i]);
      maxX = Math.max(maxX, stroke[i]);
      minY = Math.min(minY, stroke[i + 1]);
      maxY = Math.max(maxY, stroke[i + 1]);
    }
  }
  const pad = line / 2;
  const round = (value) => Math.round(value * 100) / 100;
  return {
    strokes: drawn.map((stroke) => stroke.map((value, i) => round(value - (i % 2 ? minY : minX) + pad))),
    width: round(maxX - minX + line),
    height: round(maxY - minY + line),
    line,
    color: INK,
  };
}

/**
 * Обрезать рисунок по нарисованному и отдать PNG с прозрачным фоном.
 * @param bounds { minX, minY, maxX, maxY } в пикселях холста
 */
export function trimRect(bounds, width, height, margin) {
  const left = Math.max(0, Math.floor(bounds.minX - margin));
  const top = Math.max(0, Math.floor(bounds.minY - margin));
  const right = Math.min(width, Math.ceil(bounds.maxX + margin));
  const bottom = Math.min(height, Math.ceil(bounds.maxY + margin));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * @param onInsert ({ strokes, width, height, line, color, blob }) → поставить
 *   подпись на страницу; у подписей из 0.24.0 есть только blob (PNG)
 */
export function createSignatureDialog({ onInsert, hud }) {
  const dialog = $('signatureDialog');
  const canvas = $('sigPad');
  const savedBox = $('sigSaved');
  const remember = $('sigRemember');
  const context = canvas.getContext('2d');
  let bounds = null;
  let drawing = null;
  let strokes = []; // штрихи в CSS-пикселях поля: [x0, y0, x1, y1, …]
  const objectUrls = [];

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = INK;
    context.lineWidth = LINE;
    bounds = null;
    strokes = [];
    $('sigInsert').disabled = true;
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function grow({ x, y }) {
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const pad = LINE * ratio;
    const [px, py] = [x * ratio, y * ratio];
    bounds = bounds
      ? { minX: Math.min(bounds.minX, px - pad), minY: Math.min(bounds.minY, py - pad), maxX: Math.max(bounds.maxX, px + pad), maxY: Math.max(bounds.maxY, py + pad) }
      : { minX: px - pad, minY: py - pad, maxX: px + pad, maxY: py + pad };
  }

  on(canvas, 'pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const start = point(event);
    drawing = { last: start, mid: start };
    strokes.push([start.x, start.y]);
    context.beginPath();
    context.arc(start.x, start.y, LINE / 2, 0, Math.PI * 2);
    context.fillStyle = INK;
    context.fill();
    grow(start);
  });
  on(canvas, 'pointermove', (event) => {
    if (!drawing) return;
    const next = point(event);
    // Сглаживание: кривая через середины отрезков — без «углов» от редких событий мыши.
    const mid = { x: (drawing.last.x + next.x) / 2, y: (drawing.last.y + next.y) / 2 };
    context.beginPath();
    context.moveTo(drawing.mid.x, drawing.mid.y);
    context.quadraticCurveTo(drawing.last.x, drawing.last.y, mid.x, mid.y);
    context.stroke();
    drawing = { last: next, mid };
    strokes.at(-1)?.push(next.x, next.y);
    grow(next);
    $('sigInsert').disabled = false;
  });
  const finish = () => {
    drawing = null;
  };
  on(canvas, 'pointerup', finish);
  on(canvas, 'pointercancel', finish);

  /** Нарисованное — картинка для списка сохранённых, обрезанная по подписи. */
  async function drawnPng() {
    if (!bounds) return null;
    const rect = trimRect(bounds, canvas.width, canvas.height, 4);
    const out = document.createElement('canvas');
    out.width = rect.width;
    out.height = rect.height;
    out.getContext('2d').drawImage(canvas, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }

  async function renderSaved() {
    for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
    const saved = await library.listSignatures().catch(() => []);
    savedBox.replaceChildren();
    savedBox.hidden = !saved.length;
    for (const item of saved) {
      const url = URL.createObjectURL(item.blob);
      objectUrls.push(url);
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'sig-use';
      use.title = 'Поставить эту подпись';
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Сохранённая подпись';
      use.append(img);
      on(use, 'click', () => {
        dialog.close();
        onInsert(item);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon sig-remove';
      setIcon(remove, 'trash');
      remove.title = 'Удалить сохранённую подпись';
      remove.setAttribute('aria-label', 'Удалить сохранённую подпись');
      on(remove, 'click', async () => {
        await library.deleteSignature(item.id);
        renderSaved();
      });
      const cell = document.createElement('div');
      cell.className = 'sig-item';
      cell.append(use, remove);
      savedBox.append(cell);
    }
  }

  on($('sigClear'), 'click', resize);
  on($('sigInsert'), 'click', async () => {
    const drawn = normalizeStrokes(strokes);
    const blob = await drawnPng();
    if (!drawn || !blob) return;
    const signature = { ...drawn, blob };
    if (remember.checked) {
      const saved = await library.listSignatures().catch(() => []);
      // Не больше пяти: самая старая уступает место новой.
      for (const old of saved.slice(MAX_SAVED - 1)) await library.deleteSignature(old.id);
      await library.putSignature({ id: `sig-${Date.now()}`, ...signature, createdAt: Date.now() }).catch(() => hud?.show('Подпись не сохранилась — поставлю только сейчас'));
    }
    dialog.close();
    onInsert(signature);
  });

  return {
    async open() {
      dialog.showModal();
      resize();
      await renderSaved();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}
