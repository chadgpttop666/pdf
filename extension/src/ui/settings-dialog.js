// Диалог настроек целиком строится из схемы: добавили настройку в
// settings.js — она сама появилась здесь, без второго описания.

import { $, clear, el, formatBytes, on } from '../dom.js';
import { SETTINGS_SCHEMA, get as getSetting, updateSettings } from '../settings.js';
import * as library from '../library.js';

export function createSettingsDialog(app) {
  const dialog = $('settingsDialog');
  const grid = $('settingsGrid');

  function control(item) {
    const apply = async (value) => {
      await updateSettings({ [item.key]: value });
      render();
    };

    if (item.type === 'bool') {
      const input = el('input', { type: 'checkbox' });
      input.checked = Boolean(getSetting(item.key));
      on(input, 'change', () => apply(input.checked));
      return input;
    }

    if (item.type === 'select') {
      const select = el('select', {});
      for (const [value, label] of item.options) select.append(el('option', { value }, label));
      select.value = String(getSetting(item.key));
      on(select, 'change', () => apply(select.value));
      return select;
    }

    if (item.type === 'text') {
      const input = el('input', { type: 'text', placeholder: item.placeholder || '' });
      input.value = getSetting(item.key) ?? '';
      on(input, 'change', () => apply(input.value.trim()));
      return input;
    }

    const wrap = el('div', { class: 'range-control' });
    const input = el('input', {
      type: 'range',
      min: String(item.min),
      max: String(item.max),
      step: String(item.step),
    });
    input.value = String(getSetting(item.key));
    const value = el('span', { class: 'value' }, `${getSetting(item.key)}${item.unit || ''}`);
    on(input, 'input', () => {
      value.textContent = `${input.value}${item.unit || ''}`;
    });
    on(input, 'change', () => apply(Number(input.value)));
    wrap.append(value, input);
    return wrap;
  }

  async function renderLibrarySection() {
    const section = el('div', { class: 'setting' });
    let usage = { count: 0, bytes: 0 };
    try {
      usage = await library.storageUsage();
    } catch {
      /* база может быть недоступна — покажем нули */
    }

    section.append(
      el('span', { class: 'label' }, [
        el('span', {}, 'Хранилище библиотеки'),
        el('span', { class: 'hint' }, `${usage.count} файлов, ${formatBytes(usage.bytes)}`),
      ]),
      el(
        'button',
        {
          type: 'button',
          onclick: async () => {
            await library.clearLibrary();
            await app.recent.render();
            render();
            app.hud.show('Библиотека очищена');
          },
        },
        'Очистить'
      )
    );
    grid.append(section);
  }

  function render() {
    clear(grid);
    for (const item of SETTINGS_SCHEMA) {
      if (item.group) {
        grid.append(el('div', { class: 'group-title' }, item.group));
        continue;
      }
      if (item.type === 'hidden') continue;

      grid.append(
        el('div', { class: 'setting' }, [
          el('span', { class: 'label' }, [
            el('span', {}, item.label),
            item.hint ? el('span', { class: 'hint' }, item.hint) : null,
          ]),
          control(item),
        ])
      );
    }
    renderLibrarySection();
  }

  on($('btnSettings'), 'click', () => {
    render();
    dialog.showModal();
  });

  return {
    open() {
      render();
      dialog.showModal();
    },
    close() {
      dialog.close();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}
