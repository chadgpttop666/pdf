// Правка страниц — как во встроенной читалке Firefox: текст поверх страницы,
// рисунок от руки, картинка, подпись. Сами инструменты — редактор pdf.js
// (тот же, что в Firefox); здесь — панель, запоминание и сохранение:
// - правки сохраняются в библиотеке сами (IndexedDB, по ключу документа) и
//   возвращаются при следующем открытии — сам файл не меняется, поэтому
//   место чтения, выделения и заметки остаются при нём;
// - «Скачать» отдаёт PDF с правками внутри, а текстовым заметкам дописывает
//   оформление со шрифтом (freetext-appearance.js) — их видно и в других
//   программах.

import { $, on } from '../dom.js';
import * as library from '../library.js';
import { parseTtf } from '../books/ttf.js';
import { get as getSetting, updateSettings } from '../settings.js';
import { pdfjs } from '../viewer-setup.js';
import { addFreeTextAppearances } from './freetext-appearance.js';
import { createSignatureDialog } from './signature.js';

const { AnnotationEditorType: TYPE, AnnotationEditorParamsType: PARAM } = pdfjs;
const TOOLS = { text: TYPE.FREETEXT, draw: TYPE.INK, image: TYPE.STAMP };
const SAVE_DELAY_MS = 700;
// Ключ правки с ещё не показанной страницы на время «Скачать»: pdf.js
// записывает в файл только ключи вида «pdfjs_internal_editor_…».
const RESTORED_PREFIX = 'pdfjs_internal_editor_restored_';
// Ширина подписи на странице, пт (≈ 6 см).
const SIGNATURE_WIDTH = 170;
const CHANNEL = 'pdf-reader-edits';

let fontPromise = null;
function annotationFont() {
  fontPromise ??= fetch(new URL('../../vendor/fonts/PTSerif-Regular.ttf', import.meta.url))
    .then((response) => response.arrayBuffer())
    .then((buffer) => parseTtf(new Uint8Array(buffer)));
  return fontPromise;
}

/** Блоб → data: URL. */
function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Правка для библиотеки — в виде, в каком pdf.js копирует её в буфер обмена
 * (его же deserialize вернёт её на место). JSON превращает NaN в null — в
 * линиях рисунка это начала штрихов, при чтении их надо вернуть (restoreNaN).
 */
export function restoreNaN(item) {
  if (item?.annotationType !== TYPE.INK || !item.paths?.lines) return item;
  return { ...item, paths: { ...item.paths, lines: item.paths.lines.map((line) => line.map((value) => (value === null ? NaN : value))) } };
}

export function createEditing(app) {
  const bar = $('editBar');
  const toolButtons = { text: $('editText'), draw: $('editDraw'), image: $('editImage'), signature: $('editSignature') };
  const imagePicker = $('editImagePicker');
  const status = $('editStatus');
  let uiManager = null;
  let defaultsApplied = false;
  let docId = null;
  let lastSaved = '[]';
  let saveTimer = 0;
  let restoring = false;
  // Правки из библиотеки для страниц, слой которых pdf.js ещё не отрисовал.
  let pending = [];
  let generation = 0; // растёт при смене документа: старые сохранения и восстановления молчат
  const stampUrls = new WeakMap(); // картинка → { bitmapId, url }: картинку в data: URL — один раз
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  const tab = Math.random().toString(36).slice(2);

  const hud = (text, duration) => app.hud?.show(text, duration ? { duration } : undefined);
  const viewer = () => app.pdfViewer;
  const currentMode = () => (uiManager ? viewer().annotationEditorMode : TYPE.DISABLE);
  const storage = () => viewer().pdfDocument?.annotationStorage ?? null;

  // ── Режимы ─────────────────────────────────────────────────────────

  /** Переключить инструмент pdf.js и дождаться, пока он включится. */
  function setMode(mode) {
    if (!uiManager || !viewer().pdfDocument) return Promise.resolve(false);
    if (viewer().annotationEditorMode === mode) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = 0;
      const done = (ok) => {
        clearTimeout(timer);
        app.eventBus.off('annotationeditormodechanged', listener);
        resolve(ok);
      };
      const listener = ({ mode: changed }) => {
        if (changed === mode) done(true);
      };
      timer = setTimeout(() => done(viewer().annotationEditorMode === mode), 4000);
      app.eventBus.on('annotationeditormodechanged', listener);
      try {
        viewer().annotationEditorMode = { mode };
      } catch (error) {
        console.warn('Правка не включилась', error);
        done(false);
      }
    });
  }

  /** Править можно только страницы PDF: из «только текст» — сначала выйти. */
  async function ensureEditing(mode) {
    if (!uiManager || !viewer().pdfDocument) {
      hud('Сначала откройте документ');
      return false;
    }
    if (app.reflow?.active) await app.reflow.exit();
    showBar(true);
    const ok = await setMode(mode);
    // Цвет и размер для новых правок — из настроек; раньше включения инструмента pdf.js их не примет.
    if (ok && !defaultsApplied) {
      defaultsApplied = true;
      applyDefaults();
    }
    return ok;
  }

  function showBar(open) {
    bar.hidden = !open;
    $('btnEdit').classList.toggle('active', open);
    $('btnEdit').setAttribute('aria-pressed', String(open));
    if (!open) {
      uiManager?.commitOrRemove?.();
      setMode(TYPE.NONE).then(() => saveNow());
    }
    viewer().update?.();
  }

  function reflectMode(mode) {
    const active = mode > TYPE.NONE;
    app.el.classList.toggle('editing', active);
    for (const [tool, button] of Object.entries(toolButtons)) {
      const pressed = tool in TOOLS && TOOLS[tool] === mode;
      button.classList.toggle('active', pressed);
      button.setAttribute('aria-pressed', String(pressed));
    }
    $('editTextParams').hidden = mode !== TYPE.FREETEXT;
    $('editDrawParams').hidden = mode !== TYPE.INK;
    const hint = $('editHint');
    hint.textContent =
      mode === TYPE.FREETEXT
        ? 'Щёлкните на странице и пишите. Готовую надпись можно двигать и менять.'
        : mode === TYPE.INK
          ? 'Рисуйте мышью, пером или пальцем. Каждый штрих — отдельно, двигается и удаляется.'
          : mode === TYPE.STAMP
            ? 'Картинку и подпись можно двигать и растягивать за углы.'
            : 'Выберите инструмент.';
    hint.title = hint.textContent;
    if (active && !bar.hidden) return;
    if (active) showBar(true);
  }

  async function pickTool(tool) {
    const mode = TOOLS[tool];
    // Тот же инструмент ещё раз — выключить, страницы снова только для чтения.
    if (viewer().annotationEditorMode === mode) {
      await setMode(TYPE.NONE);
      return;
    }
    await ensureEditing(mode);
  }

  // ── Параметры: цвет, размер, толщина ─────────────────────────────────

  const params = {
    textColor: { input: $('editTextColor'), setting: 'editTextColor', type: PARAM.FREETEXT_COLOR, value: (v) => v },
    textSize: { input: $('editTextSize'), setting: 'editTextSize', type: PARAM.FREETEXT_SIZE, value: Number },
    inkColor: { input: $('editInkColor'), setting: 'editInkColor', type: PARAM.INK_COLOR, value: (v) => v },
    inkThickness: { input: $('editInkThickness'), setting: 'editInkThickness', type: PARAM.INK_THICKNESS, value: Number },
    inkOpacity: { input: $('editInkOpacity'), setting: 'editInkOpacity', type: PARAM.INK_OPACITY, value: (v) => Number(v) / 100 },
  };

  function showValue(param) {
    const output = $(`${param.input.id}Value`);
    if (!output) return;
    const value = Number(param.input.value);
    output.textContent = param === params.inkOpacity ? `${value}%` : param === params.textSize ? `${value} пт` : String(value);
  }

  function dispatchParam(param) {
    app.eventBus.dispatch('switchannotationeditorparams', { source: app, type: param.type, value: param.value(param.input.value) });
  }

  /** Поля панели — из настроек. */
  function fillInputs() {
    for (const param of Object.values(params)) {
      param.input.value = getSetting(param.setting);
      showValue(param);
    }
  }

  /** Значения по умолчанию для новых правок — из настроек; выбранной правки не трогаем. */
  function applyDefaults() {
    fillInputs();
    if (uiManager?.hasSelection) return;
    for (const param of Object.values(params)) dispatchParam(param);
  }

  for (const param of Object.values(params)) {
    on(param.input, 'input', () => {
      showValue(param);
      dispatchParam(param);
    });
    on(param.input, 'change', () => {
      const raw = param.input.type === 'color' ? param.input.value : Number(param.input.value);
      updateSettings({ [param.setting]: raw });
      schedule();
    });
  }

  // Выбрали правку — панель показывает её цвет и размер.
  app.eventBus.on('annotationeditorparamschanged', ({ details }) => {
    for (const [type, value] of details) {
      const param = Object.values(params).find((candidate) => candidate.type === type);
      if (!param || value == null) continue;
      param.input.value = param === params.inkOpacity ? Math.round(value * 100) : value;
      showValue(param);
    }
  });

  // ── Вставка картинки и подписи ───────────────────────────────────────

  async function insertImage(file) {
    if (!file || !/^image\//.test(file.type)) {
      hud('Это не картинка: подойдут PNG, JPEG, GIF, WebP, SVG');
      return;
    }
    if (!(await ensureEditing(TYPE.STAMP))) return;
    const layer = uiManager.currentLayer;
    if (!layer) {
      hud('Страница ещё не готова — попробуйте через секунду');
      return;
    }
    await layer.pasteEditor({ mode: TYPE.STAMP }, { bitmapFile: file });
    schedule();
  }

  /** Центр видимой части страницы — в пикселях страницы. */
  function visibleCenter(view) {
    const page = view.div.getBoundingClientRect();
    const box = app.container.getBoundingClientRect();
    const left = Math.max(page.left, box.left);
    const right = Math.min(page.right, box.right);
    const top = Math.max(page.top, box.top);
    const bottom = Math.min(page.bottom, box.bottom);
    const x = right > left ? (left + right) / 2 : page.left + page.width / 2;
    const y = bottom > top ? (top + bottom) / 2 : page.top + page.height / 2;
    return [x - page.left, y - page.top];
  }

  /**
   * Подпись — картинкой ровно нужного размера (≈ 6 см) посреди видимой части
   * страницы. Через deserialize, а не как обычную картинку: та ставится
   * «пиксель = пункт», и чёткая подпись заняла бы пол-листа.
   */
  async function insertSignature(blob) {
    if (!(await ensureEditing(TYPE.STAMP))) return;
    const pageIndex = viewer().currentPageNumber - 1;
    const layer = uiManager.getLayer?.(pageIndex) ?? uiManager.currentLayer;
    const view = layer && viewer().getPageView(layer.pageIndex);
    if (!layer || !view?.viewport) {
      hud('Страница ещё не готова — попробуйте через секунду');
      return;
    }
    const bitmap = await createImageBitmap(blob);
    const aspect = bitmap.height / bitmap.width;
    bitmap.close?.();
    const { viewport } = view;
    const [pageWidth] = viewport.viewBox.slice(2);
    const widthPt = Math.min(SIGNATURE_WIDTH, pageWidth * 0.45);
    const scale = viewport.scale;
    const [cx, cy] = visibleCenter(view);
    const half = [(widthPt * scale) / 2, (widthPt * aspect * scale) / 2];
    const corners = [
      viewport.convertToPdfPoint(cx - half[0], cy - half[1]),
      viewport.convertToPdfPoint(cx + half[0], cy + half[1]),
    ];
    const rect = [
      Math.min(corners[0][0], corners[1][0]),
      Math.min(corners[0][1], corners[1][1]),
      Math.max(corners[0][0], corners[1][0]),
      Math.max(corners[0][1], corners[1][1]),
    ];
    const editor = await layer.deserialize({
      annotationType: TYPE.STAMP,
      pageIndex: layer.pageIndex,
      rect,
      rotation: viewport.rotation,
      bitmapUrl: await dataUrl(blob),
      isCopy: true,
      accessibilityData: { altText: 'Подпись', decorative: false },
    });
    if (!editor) return;
    placeEditor(layer, editor, rect);
    layer.addUndoableEditor?.(editor);
    uiManager.setSelected?.(editor);
    schedule();
  }

  const signature = createSignatureDialog({ onInsert: insertSignature, hud: app.hud });

  /**
   * Поставить готовый редактор ровно на сохранённое место. pdf.js при
   * отрисовке сдвигает правку на «отступ + кегль» (так новая надпись встаёт
   * под курсор), а у вставок-копий потом этот сдвиг не отменяет —
   * поэтому двигаем, пока прямоугольник правки не совпадёт с сохранённым.
   */
  function placeEditor(layer, editor, rect) {
    editor.isClone = true; // не сдвигать, как вставку из буфера обмена
    layer.addOrRebuild(editor);
    // Пустой слой pdf.js прячет при отрисовке — а правки пришли позже.
    if (layer.div) layer.div.hidden = false;
    const current = editor.getPDFRect?.();
    if (!current || !rect) return;
    const [pageWidth, pageHeight] = editor.pageDimensions;
    const dx = rect[0] - current[0];
    const dy = rect[1] - current[1];
    if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) return;
    editor.x += dx / pageWidth;
    editor.y -= dy / pageHeight;
    editor.fixAndSetPosition();
  }

  // ── Сохранение в библиотеку ──────────────────────────────────────────

  /** Правка → данные для библиотеки; null — пустая или не наша. */
  function serializeEditor(editor) {
    if (editor.mode === TYPE.STAMP) {
      const base = editor.serialize(false);
      if (!base) return null;
      let cached = stampUrls.get(editor);
      if (!cached || cached.bitmapId !== base.bitmapId) {
        const copy = editor.serialize(true);
        if (!copy?.bitmapUrl) throw new Error('картинка ещё не загрузилась');
        cached = { bitmapId: base.bitmapId, url: copy.bitmapUrl };
        stampUrls.set(editor, cached);
      }
      const { bitmap, bitmapId, ...rest } = base;
      return { ...rest, bitmapUrl: cached.url, isCopy: true };
    }
    return editor.serialize(true);
  }

  /** Все правки документа: показанные редакторы и ещё не показанные вернувшиеся. */
  function snapshot() {
    const items = [];
    const store = storage();
    if (!store) return items;
    for (const [, value] of store) {
      if (typeof value?.serialize !== 'function') continue;
      // Правки аннотаций, которые были в самом файле, — не наши: их сохранит только «Скачать».
      if (value.annotationElementId || value.deleted) continue;
      const data = serializeEditor(value);
      if (data) items.push(data);
    }
    items.push(...pending);
    return items.sort((a, b) => a.pageIndex - b.pageIndex);
  }

  function schedule() {
    if (!docId || restoring) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!docId || restoring) return;
    const id = docId;
    let items;
    try {
      items = snapshot();
    } catch (error) {
      // Что-то ещё не готово (картинка грузится) — попробуем чуть позже, ничего не теряя.
      saveTimer = setTimeout(saveNow, 1500);
      return;
    }
    const json = JSON.stringify(items);
    if (json === lastSaved) return;
    lastSaved = json;
    try {
      await library.putEdits(id, items);
      channel?.postMessage({ id, tab });
    } catch (error) {
      console.warn('Правки не сохранились', error);
      hud('Правки не сохранились в библиотеке — скачайте PDF, чтобы не потерять их', 6000);
      lastSaved = '';
    }
    updateStatus(items.length);
  }

  function updateStatus(count) {
    const text = count ? `Правок: ${count}, сохранены` : 'Правок нет';
    status.textContent = text;
    $('editClear').disabled = !count;
  }

  // Изменения, которые проходят через хранилище pdf.js (новая, удалённая, изменённая правка).
  function watchStorage(store) {
    if (!store || store.__pdfReaderWatched) return;
    store.__pdfReaderWatched = true;
    const setValue = store.setValue.bind(store);
    const remove = store.remove.bind(store);
    store.setValue = (key, value) => {
      setValue(key, value);
      schedule();
    };
    store.remove = (key) => {
      remove(key);
      schedule();
    };
  }
  // Сдвинули, растянули, отменили — хранилище этого не видит.
  for (const type of ['pointerup', 'keyup']) {
    on(app.container, type, () => {
      if (currentMode() > TYPE.NONE) schedule();
    });
  }
  app.eventBus.on('editingstateschanged', ({ details }) => {
    $('editUndo').disabled = !details.hasSomethingToUndo;
    $('editRedo').disabled = !details.hasSomethingToRedo;
    $('editDelete').disabled = !details.hasSelectedEditor;
    schedule();
  });

  // ── Возврат правок при открытии ──────────────────────────────────────

  /** Правку из библиотеки — редактором на отрисованный слой страницы. */
  async function placeItem(layer, item, mine) {
    const editor = await layer.deserialize(item).catch((error) => console.warn('Правка не вернулась', error));
    if (!editor || mine !== generation) return;
    placeEditor(layer, editor, item.rect);
  }

  /**
   * Правки из библиотеки — на страницы. На отрисованную страницу — сразу
   * редактором; остальные ждут, пока pdf.js отрисует слой их страницы
   * (annotationeditorlayerrendered), — до тех пор они в pending.
   */
  async function restore(id) {
    const mine = generation;
    const record = await library.getEdits(id).catch(() => null);
    if (mine !== generation || !record?.items?.length) return;
    restoring = true;
    try {
      for (const raw of record.items) {
        const item = restoreNaN(raw);
        const layer = uiManager?.getLayer?.(item.pageIndex);
        if (layer?.div) await placeItem(layer, item, mine);
        else pending.push(item);
        if (mine !== generation) return;
      }
      lastSaved = JSON.stringify(record.items);
      updateStatus(record.items.length);
    } finally {
      restoring = false;
    }
  }

  // Страница с отложенными правками отрисована — поставить их.
  app.eventBus.on('annotationeditorlayerrendered', async ({ pageNumber, error }) => {
    if (error || !pending.length) return;
    const pageIndex = pageNumber - 1;
    const layer = uiManager?.getLayer?.(pageIndex);
    if (!layer?.div) return;
    const items = pending.filter((item) => item.pageIndex === pageIndex);
    if (!items.length) return;
    pending = pending.filter((item) => item.pageIndex !== pageIndex);
    const mine = generation;
    const wasRestoring = restoring;
    restoring = true; // правки те же, что в библиотеке, — переписывать незачем
    try {
      for (const item of items) await placeItem(layer, item, mine);
    } finally {
      restoring = wasRestoring;
    }
  });

  // Другая вкладка с той же книгой сохранила правки — показать их здесь, если тут своих несохранённых нет.
  channel?.addEventListener('message', async ({ data }) => {
    if (!data || data.tab === tab || data.id !== docId) return;
    clearTimeout(saveTimer);
    let mine;
    try {
      mine = JSON.stringify(snapshot());
    } catch {
      return;
    }
    if (mine !== lastSaved) return; // здесь свои правки — они и запишутся
    await removeAll();
    await restore(docId);
  });

  /** Убрать все правки со страниц (не из библиотеки). */
  async function removeAll() {
    pending = [];
    const store = storage();
    if (!store) return;
    restoring = true;
    try {
      for (const [, value] of [...store]) {
        if (typeof value?.remove === 'function' && !value.annotationElementId) value.remove();
      }
    } finally {
      restoring = false;
    }
  }

  // ── Скачать с правками ───────────────────────────────────────────────

  /** Есть ли что сохранять в файл. */
  function hasEdits() {
    if (pending.length) return true;
    const store = storage();
    if (!store) return false;
    for (const [, value] of store) {
      if (typeof value?.serialize === 'function' ? !value.isEmpty?.() : value?.deleted) return true;
    }
    return false;
  }

  /**
   * PDF с правками: pdf.js дописывает их обновлением в конец файла, мы —
   * оформление текстовых заметок со шрифтом.
   */
  async function editedPdf() {
    uiManager?.commitOrRemove?.();
    const doc = viewer().pdfDocument;
    const store = doc.annotationStorage;
    // Правки ещё не показанных страниц — в хранилище только на время записи:
    // pdf.js снимает его сразу при вызове saveDocument. Картинки у них —
    // data: URL, а pdf.js нужно само изображение.
    const extra = [];
    for (const [i, item] of pending.entries()) {
      const value = { ...item };
      if (value.annotationType === TYPE.STAMP && value.bitmapUrl) {
        value.bitmap = await createImageBitmap(await (await fetch(value.bitmapUrl)).blob());
        value.bitmapId = `${RESTORED_PREFIX}${i}-image`;
      }
      extra.push([`${RESTORED_PREFIX}${i}`, value]);
    }
    let saving;
    restoring = true;
    try {
      for (const [key, value] of extra) store.setValue(key, value);
      saving = doc.saveDocument();
    } finally {
      for (const [key] of extra) store.remove(key);
      restoring = false;
    }
    const bytes = await saving;
    try {
      return await addFreeTextAppearances(bytes, await annotationFont());
    } catch (error) {
      console.warn('Оформление текстовых заметок не дописалось — сохраняю как есть', error);
      return bytes;
    }
  }

  // ── Кнопки и события ─────────────────────────────────────────────────

  on($('btnEdit'), 'click', () => showBar(bar.hidden));
  on($('editDone'), 'click', () => showBar(false));
  on(toolButtons.text, 'click', () => pickTool('text'));
  on(toolButtons.draw, 'click', () => pickTool('draw'));
  // Выбор файла — прямо в обработчике щелчка, иначе браузер не откроет окно.
  on(toolButtons.image, 'click', () => imagePicker.click());
  on(imagePicker, 'change', async () => {
    const [file] = imagePicker.files || [];
    imagePicker.value = '';
    if (file) await insertImage(file);
  });
  on(toolButtons.signature, 'click', () => signature.open());
  const action = (name) => () => app.eventBus.dispatch('editingaction', { source: app, name });
  on($('editUndo'), 'click', action('undo'));
  on($('editRedo'), 'click', action('redo'));
  on($('editDelete'), 'click', action('delete'));
  on($('editClear'), 'click', async () => {
    if (!confirm('Убрать все правки из этого документа? Сам файл не изменится, но правки пропадут.')) return;
    await removeAll();
    await saveNow();
    hud('Правки убраны');
  });

  // pdf.js просит другой инструмент (двойной щелчок по правке, вставка из буфера).
  app.eventBus.on('switchannotationeditormode', (event) => {
    if (event.mode === viewer().annotationEditorMode && !event.editId) return;
    if (event.mode > TYPE.NONE) showBar(true);
    try {
      viewer().annotationEditorMode = event;
    } catch (error) {
      console.warn('Правка не включилась', error);
    }
  });
  app.eventBus.on('annotationeditormodechanged', ({ mode }) => reflectMode(mode));
  // «Только текст» — правок там нет: панель закрываем.
  app.eventBus.on('viewmodechanged', ({ mode }) => {
    if (mode === 'reflow' && !bar.hidden) showBar(false);
  });

  app.eventBus.on('annotationeditoruimanager', ({ uiManager: manager }) => {
    uiManager = manager;
    defaultsApplied = false;
    watchStorage(storage());
  });

  app.eventBus.on('documentopened', () => {
    generation += 1;
    clearTimeout(saveTimer);
    docId = null;
    lastSaved = '[]';
    pending = [];
    updateStatus(0);
    $('btnEdit').disabled = false;
    if (!bar.hidden) reflectMode(TYPE.NONE);
  });

  // Ключ документа известен — вернуть его правки, когда страницы готовы.
  app.readingState?.onChange((record) => {
    const id = record?.id ?? null;
    if (!id || id === docId) return;
    docId = id;
    const mine = generation;
    const start = () => mine === generation && restore(id);
    if (viewer().pagesCount) start();
    else app.eventBus.on('pagesinit', start, { once: true });
  });

  // Уходим со страницы — дописать несохранённое.
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  on(window, 'pagehide', () => saveNow());

  updateStatus(0);
  fillInputs();

  return {
    /** Включён инструмент правки — щелчки по странице принадлежат ему. */
    get active() {
      return currentMode() > TYPE.NONE;
    },
    get open() {
      return !bar.hidden;
    },
    toggle() {
      if (!viewer().pdfDocument) {
        hud('Сначала откройте документ');
        return;
      }
      showBar(bar.hidden);
    },
    close() {
      if (!bar.hidden) showBar(false);
    },
    hasEdits,
    editedPdf,
    insertImage,
    /** Для проверок. */
    saveNow,
    snapshot,
    get signatureOpen() {
      return signature.isOpen;
    },
  };
}
