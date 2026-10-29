// Диалог настроек целиком строится из схемы: добавили настройку в
// settings.js — она сама появилась здесь, без второго описания.

import { $, clear, closeOnBackdropClick, el, formatBytes, on } from '../dom.js';
import { SETTINGS_SCHEMA, get as getSetting, updateSettings } from '../settings.js';
import * as library from '../library.js';

export function createSettingsDialog(app) {
  const dialog = $('settingsDialog');
  closeOnBackdropClick(dialog);
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

  let piperMessage = ''; // переживает перерисовку диалога после загрузки голоса
  let teraMessage = '';

  /** TeraTTS: один пакет на все голоса — скачать, отменить, удалить. */
  async function renderTeraVoices(container) {
    const tera = app.tts?.tera;
    if (!tera?.available) return;
    const installed = await tera.isInstalled().catch(() => false);
    const say = (text) => {
      teraMessage = text;
      // Диалог мог перерисоваться, пока шла загрузка: пишем в текущий.
      for (const node of document.querySelectorAll('.tera-status')) node.textContent = text;
    };
    const refresh = async () => {
      await app.tts.refreshVoices();
      render();
    };

    let action;
    if (tera.downloading) {
      action = el('button', { type: 'button', onclick: () => tera.cancelDownload() }, 'Отменить загрузку');
    } else if (installed) {
      action = el(
        'button',
        {
          type: 'button',
          onclick: async () => {
            await tera.removeVoice().catch((error) => say(error.message));
            say('Голоса TeraTTS удалены');
            await refresh();
          },
        },
        'Удалить'
      );
    } else {
      action = el(
        'button',
        {
          type: 'button',
          onclick: async () => {
            const voiceId = (await tera.voices())[0].id;
            const download = tera.downloadVoice(voiceId, (loaded, total, stage) => {
              say(stage === 'index' ? 'Готовлю словарь ударений — это меньше минуты…' : `Скачано ${formatBytes(loaded)} из ${formatBytes(total)}`);
            });
            render(); // кнопка «Отменить»
            try {
              await download;
              say('Голоса TeraTTS скачаны — выберите один на панели озвучки');
              await updateSettings({ ttsVoiceUri: voiceId });
            } catch (error) {
              say(`Не скачалось: ${error.message || error}`);
            }
            await refresh();
          },
        },
        `Скачать ≈${tera.sizeMb} МБ`
      );
    }

    container.append(
      el('span', { class: 'label' }, [
        el('span', {}, `Нейроголоса TeraTTS${installed ? ' · скачаны' : ''}`),
        el(
          'span',
          { class: 'hint' },
          'Лучшее качество: ударения и «ё» по словарям и нейросетям, английские названия — по-английски. ' +
            'Четыре голоса одним пакетом, скачивается один раз с HuggingFace. Во время чтения нужно около 1,5 ГБ памяти. ' +
            'Модель — TeraTTSv2 от TeraSpace (OpenRAIL-M), ударения — RUAccent (MIT).'
        ),
      ]),
      el('div', { class: 'piper-actions' }, [action, el('span', { class: 'hint tera-status' }, teraMessage)])
    );
  }

  /** Нейроголоса Piper: скачать, удалить, загрузить из файлов. */
  async function renderPiperVoices(container) {
    const piper = app.tts?.piper;
    if (!piper?.available) {
      container.append(el('p', { class: 'hint' }, 'Нейроголоса в этом браузере недоступны.'));
      return;
    }
    const voices = await piper.voices();
    const status = el('span', { class: 'hint piper-status' }, piperMessage);
    const say = (text) => {
      piperMessage = text;
      status.textContent = text;
    };
    const refresh = async () => {
      await app.tts.refreshVoices();
      render();
    };
    const fail = (error) => say(error.message || String(error));

    const list = el('ul', { class: 'piper-list' });
    for (const voice of voices) {
      const action = voice.installed
        ? el(
            'button',
            {
              type: 'button',
              onclick: async () => {
                await piper.removeVoice(voice.id).catch(fail);
                await refresh();
              },
            },
            'Удалить'
          )
        : el(
            'button',
            {
              type: 'button',
              onclick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                try {
                  await piper.downloadVoice(voice.id, (loaded, total) => {
                    status.textContent = `«${voice.name}»: ${formatBytes(loaded)} из ${formatBytes(total)}`;
                  });
                  say(`Голос «${voice.name}» скачан — выберите его на панели озвучки`);
                  await refresh();
                } catch (error) {
                  fail(error);
                  button.disabled = false;
                }
              },
            },
            `Скачать ≈${voice.sizeMb} МБ`
          );
      list.append(
        el('li', {}, [
          el('span', {}, [voice.name, el('span', { class: 'hint' }, ` ${voice.lang || ''}${voice.installed ? ' · скачан' : ''}`)]),
          action,
        ])
      );
    }

    const picker = el('input', { type: 'file', accept: '.onnx,.json', multiple: '', hidden: '' });
    on(picker, 'change', async () => {
      try {
        const id = await piper.importVoice(picker.files);
        say('Голос загружен и выбран для озвучки');
        await updateSettings({ ttsVoiceUri: id });
        await refresh();
      } catch (error) {
        fail(error);
      }
      picker.value = '';
    });

    container.append(
      el('span', { class: 'label' }, [
        el('span', {}, 'Нейроголоса Piper'),
        el(
          'span',
          { class: 'hint' },
          'Голос скачивается один раз (≈60 МБ) и дальше работает без интернета. Если HuggingFace недоступен, ' +
            'скачайте файлы .onnx и .onnx.json голоса где-нибудь ещё и загрузите их кнопкой ниже.'
        ),
      ]),
      list,
      el('div', { class: 'piper-actions' }, [
        el('button', { type: 'button', onclick: () => picker.click() }, 'Загрузить голос из файлов…'),
        picker,
        status,
      ])
    );
  }

  function render() {
    clear(grid);
    for (const item of SETTINGS_SCHEMA) {
      if (item.group) {
        grid.append(el('div', { class: 'group-title' }, item.group));
        continue;
      }
      if (item.custom === 'teraVoices') {
        const section = el('div', { class: 'setting piper-voices tera-voices' });
        grid.append(section);
        renderTeraVoices(section);
        continue;
      }
      if (item.custom === 'piperVoices') {
        const section = el('div', { class: 'setting piper-voices' });
        grid.append(section);
        renderPiperVoices(section);
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
    piperMessage = '';
    render();
    dialog.showModal();
  });

  return {
    open() {
      piperMessage = '';
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
