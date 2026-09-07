// Внешний вид страницы: цветовые режимы, яркость с контрастом и обрезка полей.
// Фильтр вешаем на каждую страницу, а не на весь слой прокрутки — так браузер
// растрирует небольшие независимые области и прокрутка остаётся плавной.

import { $, on } from './dom.js';
import { get as getSetting, onSettingsChanged, updateSettings } from './settings.js';
import { createCrop } from './crop.js';

const SIDES = ['left', 'right', 'top', 'bottom'];
const SIDE_INPUTS = { left: 'cropLeft', right: 'cropRight', top: 'cropTop', bottom: 'cropBottom' };

export function createAppearance(app) {
  const panel = $('appearancePanel');
  const crop = createCrop(app);

  function filterValue() {
    const parts = [];
    switch (getSetting('pageTheme')) {
      case 'invert':
        // Поворот оттенка после инверсии возвращает картинкам примерно их цвета.
        parts.push('invert(1)', 'hue-rotate(180deg)');
        break;
      case 'sepia':
        parts.push('sepia(0.45)', 'saturate(0.9)', 'brightness(0.98)');
        break;
      case 'dim':
        parts.push('brightness(0.82)');
        break;
      default:
        break;
    }
    const brightness = getSetting('brightness');
    const contrast = getSetting('contrast');
    if (brightness !== 100) parts.push(`brightness(${(brightness / 100).toFixed(2)})`);
    if (contrast !== 100) parts.push(`contrast(${(contrast / 100).toFixed(2)})`);
    return parts.join(' ') || 'none';
  }

  function applyFilter() {
    app.viewerEl.style.setProperty('--page-filter', filterValue());
  }

  /** При обрезанных полях «по ширине» должно считаться от видимой части страницы. */
  function applyCropAwareZoom() {
    if (!crop.enabled) return;
    const value = app.pdfViewer.currentScaleValue;
    if (value !== 'page-width' && value !== 'auto') return;
    const usable = 1 - crop.box.left - crop.box.right;
    if (usable < 0.4 || usable >= 1) return;
    app.pdfViewer.currentScale = app.pdfViewer.currentScale / usable;
  }

  function syncPanel() {
    $('pageTheme').value = getSetting('pageTheme');
    $('uiTheme').value = getSetting('uiTheme');
    $('brightness').value = String(getSetting('brightness'));
    $('contrast').value = String(getSetting('contrast'));
    $('brightnessValue').textContent = `${getSetting('brightness')}%`;
    $('contrastValue').textContent = `${getSetting('contrast')}%`;
    $('cropEnabled').checked = crop.enabled;
    for (const side of SIDES) {
      const percent = Number((crop.box[side] * 100).toFixed(1));
      $(SIDE_INPUTS[side]).value = String(percent);
      $(`${SIDE_INPUTS[side]}Value`).textContent = `${percent}%`;
    }
  }

  function readSideInputs() {
    const next = {};
    for (const side of SIDES) next[side] = Number($(SIDE_INPUTS[side]).value) / 100;
    return next;
  }

  async function setCropEnabled(value, { autoDetect = true } = {}) {
    crop.setEnabled(value);
    await updateSettings({ cropEnabled: value });
    if (value && autoDetect && getSetting('cropAuto') && !hasManualBox()) {
      await crop.autoDetect();
    }
    applyCropAwareZoom();
    syncPanel();
  }

  function hasManualBox() {
    return SIDES.some((side) => crop.box[side] > 0);
  }

  on($('btnAppearance'), 'click', () => togglePanel());
  on($('pageTheme'), 'change', async () => {
    await updateSettings({ pageTheme: $('pageTheme').value });
    applyFilter();
  });
  on($('uiTheme'), 'change', async () => {
    await updateSettings({ uiTheme: $('uiTheme').value });
  });
  for (const id of ['brightness', 'contrast']) {
    on($(id), 'input', async () => {
      await updateSettings({ [id]: Number($(id).value) });
      applyFilter();
      syncPanel();
    });
  }
  on($('cropEnabled'), 'change', () => setCropEnabled($('cropEnabled').checked));
  on($('cropAuto'), 'click', async () => {
    if (!crop.enabled) await setCropEnabled(true, { autoDetect: false });
    await crop.autoDetect();
    applyCropAwareZoom();
    syncPanel();
  });
  on($('cropReset'), 'click', () => {
    crop.reset();
    applyCropAwareZoom();
    syncPanel();
  });
  for (const side of SIDES) {
    on($(SIDE_INPUTS[side]), 'input', () => {
      crop.setBox(readSideInputs());
      syncPanel();
    });
  }

  // Панель закрывается кликом мимо неё — это popover, а не модальное окно.
  on(document, 'pointerdown', (event) => {
    if (panel.hidden) return;
    if (panel.contains(event.target) || event.target.closest('#btnAppearance')) return;
    panel.hidden = true;
  });

  app.eventBus.on('scalechanging', () => {
    crop.apply();
    applyCropAwareZoom();
  });
  app.eventBus.on('pagesinit', () => crop.apply());
  app.eventBus.on('pagerendered', () => crop.apply());

  let resizeTimer = 0;
  on(window, 'resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (crop.enabled && ['page-width', 'auto'].includes(app.zoomIntent)) app.setZoom(app.zoomIntent);
      crop.apply();
    }, 150);
  });

  onSettingsChanged((_all, changed) => {
    if ('pageTheme' in changed || 'brightness' in changed || 'contrast' in changed) applyFilter();
  });

  function togglePanel(force) {
    panel.hidden = force ?? !panel.hidden;
    if (!panel.hidden) syncPanel();
  }

  applyFilter();
  syncPanel();

  return {
    crop,
    applyFilter,
    applyCropAwareZoom,
    syncPanel,
    togglePanel,
    closePanel() {
      panel.hidden = true;
    },
    async toggleInvert() {
      const next = getSetting('pageTheme') === 'invert' ? 'normal' : 'invert';
      await updateSettings({ pageTheme: next });
      applyFilter();
      syncPanel();
      app.hud.show(next === 'invert' ? 'Инверсия включена' : 'Инверсия выключена');
    },
    async toggleCrop() {
      await setCropEnabled(!crop.enabled);
      app.hud.show(crop.enabled ? 'Поля обрезаны' : 'Поля показаны полностью');
    },
    /** Восстановление состояния документа: поля и флаг обрезки. */
    restore({ cropBox, cropEnabled } = {}) {
      if (cropBox) crop.setBox(cropBox, { apply: false });
      crop.setEnabled(Boolean(cropEnabled));
      applyCropAwareZoom();
      syncPanel();
    },
    async applyDocumentDefaults() {
      if (getSetting('cropEnabled')) await setCropEnabled(true);
    },
  };
}
