// Диалог настроек целиком строится из схемы: добавили настройку в
// settings.js — она сама появилась здесь, без второго описания.

import { $, clear, closeOnBackdropClick, el, formatBytes, on } from '../dom.js';
import { SETTINGS_SCHEMA, get as getSetting, updateSettings } from '../settings.js';
import * as library from '../library.js';
import { createHelperFlow, describeHelper, helperButton } from '../tts/helper-install.js';
import { downloadVoice } from '../tts/engines.js';
import { forget as forgetDownload } from '../downloads.js';
import { createDownloadChip, progressView } from './progress.js';
import { canInstall, describeUpdate, isChromeExtension, readState as readUpdateState, STATE_KEY as UPDATE_STATE_KEY } from '../updates.js';
import { loadUserStress, onUserStressChange, removeUserStress, showStress, userStressEntries } from '../tts/user-stress.js';

export function createSettingsDialog(app) {
  const dialog = $('settingsDialog');
  closeOnBackdropClick(dialog);
  const grid = $('settingsGrid');

  function control(item) {
    // Окно не перестраиваем: переключатель уже показывает новое значение, а
    // полная перестройка сбивала прокрутку и заново подгружала разделы
    // голосов и библиотеки — казалось, что что-то добавилось.
    const apply = async (value) => {
      await updateSettings({ [item.key]: value });
      if (item.key === 'teraUseHelper') helperFlow?.refresh();
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

  /** TeraTTS: один пакет на все голоса — скачать, отменить, удалить; полоса скачивания. */
  async function renderTeraVoices(container) {
    const tera = app.tts?.tera;
    if (!tera?.available) return;
    const installed = await tera.isInstalled().catch(() => false);
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
            forgetDownload('tera-pack');
            teraMessage = 'Голоса TeraTTS удалены';
            await tera.removeVoice().catch((error) => (teraMessage = error.message));
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
          class: 'primary',
          onclick: async () => {
            const voiceId = (await tera.voices())[0].id;
            teraMessage = '';
            const download = downloadVoice(app.tts.engines, voiceId);
            render(); // кнопка «Отменить»
            try {
              if (await download) await updateSettings({ ttsVoiceUri: voiceId });
              else teraMessage = 'Загрузка отменена';
            } catch {
              /* ошибку показывает полоса */
            }
            await refresh();
          },
        },
        `Скачать ≈${tera.sizeMb} МБ`
      );
    }

    container.append(
      el('span', { class: 'label' }, [
        el('span', {}, ['Нейроголоса TeraTTS', installed ? el('span', { class: 'badge ok' }, 'скачаны') : null]),
        el(
          'span',
          { class: 'hint' },
          'Лучшее качество: ударения и «ё» по словарям и нейросетям, английские названия — по-английски. ' +
            'Четыре голоса одним пакетом, скачивается один раз с HuggingFace. Во время чтения нужно около 1,5 ГБ памяти. ' +
            'Модель — TeraTTSv2 от TeraSpace (OpenRAIL-M), ударения — RUAccent (MIT).'
        ),
      ]),
      el('div', { class: 'piper-actions' }, [action]),
      progressView('tera-pack', { idle: () => teraMessage, textClass: 'tera-status' }),
      // Переозвученные фразы (R на панели): свой начальный шум — можно вернуть обычный.
      ...(installed && tera.revoiced
        ? [el('div', { class: 'piper-actions' }, [
            el('span', { class: 'hint' }, `Переозвучено фраз: ${tera.revoiced}`),
            el(
              'button',
              {
                type: 'button',
                class: 'ghost',
                onclick: async () => {
                  await tera.forgetRevoiced();
                  render();
                },
              },
              'Вернуть обычное звучание'
            ),
          ])]
        : [])
    );
  }

  let helperFlow = null; // переживает перерисовку: установка идёт и при закрытом окне

  /** Ускоритель TeraTTS: установить, запустить установщик, удалить. */
  function renderTeraHelper(section) {
    const state = helperFlow.state;
    if (state.step === 'unsupported') {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const button = helperButton(state);
    section.replaceChildren(
      el('span', { class: 'label' }, [
        el('span', {}, `Ускоритель TeraTTS${state.step === 'working' ? ' · работает' : ''}`),
        el(
          'span',
          { class: 'hint' },
          'Небольшая программа синтезирует речь вне браузера: в 4–5 раз быстрее, процессор почти свободен, памяти — на гигабайт меньше. ' +
            (isChromeExtension()
              ? 'Ставится отсюда: «Установить» → запустить скачанный файл. Прав администратора и настройки не нужно, обновляется сама. В Chrome она же обновляет и саму читалку. '
              : 'Ставится отсюда: «Установить» → разрешить → запустить скачанный файл. Прав администратора и настройки не нужно, обновляется сама. ') +
            'Без неё TeraTTS работает в браузере, как раньше.'
        ),
      ]),
      el('div', { class: 'piper-actions' }, [
        button ? el('button', { type: 'button', class: button.act === 'install' ? 'primary' : '', onclick: () => helperFlow[button.act]() }, button.label) : null,
        el('span', { class: 'hint' }, describeHelper(state)),
      ]),
      // Установщик качается, модели передаются — полосой, как скачивание голосов.
      ...(state.step === 'downloading' ? [progressView('helper-installer')] : []),
      ...(state.step === 'syncing' ? [progressView('helper-models')] : [])
    );
  }

  /** Версия, состояние обновления и кнопка (updates.js). */
  async function renderUpdates(section) {
    const api = globalThis.browser;
    const current = api.runtime.getManifest().version;
    const state = await readUpdateState().catch(() => ({}));
    const install = canInstall(state);
    const button = el(
      'button',
      {
        type: 'button',
        onclick: async () => {
          button.disabled = true;
          button.textContent = install ? 'Обновляю…' : 'Проверяю…';
          await api.runtime.sendMessage({ type: install ? 'pdf-reader-install-update' : 'pdf-reader-check-update' }).catch(() => {});
          renderUpdates(section);
        },
      },
      install ? 'Обновить сейчас' : 'Проверить обновления'
    );
    section.replaceChildren(
      el('span', { class: 'label' }, [
        el('span', {}, `PDF-читалка ${current}`),
        el(
          'span',
          { class: 'hint' },
          isChromeExtension()
            ? 'Chrome сам обновляет только расширения из своего магазина. Эту читалку обновляет ускоритель: скачивает новую версию с GitHub, сверяет её и ставит в папку расширения. Закладки и заметки остаются.'
            : 'Обновления скачивает Firefox — подписанные Mozilla, из релизов на GitHub. Закладки и заметки остаются.'
        ),
      ]),
      el('div', { class: 'piper-actions' }, [button, el('span', { class: 'hint' }, describeUpdate(state, current, { auto: getSetting('autoUpdate') }))])
    );
  }
  if (globalThis.browser?.runtime?.id) {
    globalThis.browser.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes[UPDATE_STATE_KEY]) document.querySelectorAll('.updates').forEach(renderUpdates);
    });
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
      const downloadId = `piper:${voice.id}`;
      const action = voice.installed
        ? el(
            'button',
            {
              type: 'button',
              onclick: async () => {
                forgetDownload(downloadId);
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
                button.textContent = 'Скачиваю…';
                try {
                  if (await downloadVoice(app.tts.engines, voice.id)) await refresh();
                } catch {
                  /* ошибку показывает полоса */
                  button.disabled = false;
                  button.textContent = 'Скачать ещё раз';
                }
              },
            },
            `Скачать ≈${voice.sizeMb} МБ`
          );
      list.append(
        el('li', {}, [
          el('div', { class: 'piper-row' }, [
            el('span', {}, [voice.name, el('span', { class: 'hint' }, ` ${voice.lang || ''}`), voice.installed ? el('span', { class: 'badge ok' }, 'скачан') : null]),
            action,
          ]),
          progressView(downloadId),
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

  /** Свои ударения: что исправлено, где действует, убрать. */
  async function renderUserStress(section) {
    await loadUserStress();
    clear(section);
    const entries = [...userStressEntries()].sort((a, b) => a.key.localeCompare(b.key, 'ru'));
    section.append(
      el('span', { class: 'label' }, [
        el('span', {}, 'Мои ударения'),
        el('span', { class: 'hint' }, 'Выделите слово в книге и нажмите «А́» — голос TeraTTS будет читать его так. Исправление главнее словаря'),
      ])
    );
    if (!entries.length) {
      section.append(el('span', { class: 'hint' }, 'Пока ни одного.'));
      return;
    }
    const list = el('ul', { class: 'user-stress-list' });
    for (const entry of entries) {
      const remove = el('button', { type: 'button', class: 'ghost', title: 'Убрать — читать как в словаре' }, 'Убрать');
      on(remove, 'click', () => removeUserStress(entry.key, entry.docId));
      list.append(
        el('li', {}, [
          el('span', {}, [showStress(entry.stressed), ' ', el('span', { class: 'stress-scope-label' }, entry.docId ? '· в одной книге' : '· во всех книгах')]),
          remove,
        ])
      );
    }
    section.append(list);
  }
  onUserStressChange(() => document.querySelectorAll('.user-stress').forEach(renderUserStress));

  function render() {
    // Перестройка (очистили библиотеку, скачали голос) — на том же месте прокрутки.
    const scrollTop = dialog.scrollTop;
    requestAnimationFrame(() => {
      dialog.scrollTop = scrollTop;
    });
    clear(grid);
    const nav = $('settingsNav');
    clear(nav);
    for (const item of SETTINGS_SCHEMA) {
      if (item.group) {
        const title = el('div', { class: 'group-title', id: groupId(item.group) }, item.group);
        grid.append(title);
        // Разделы — кнопками в шапке: окно длинное, нужное не искать прокруткой.
        nav.append(el('button', { type: 'button', dataset: { group: item.group }, onclick: () => showGroup(item.group) }, shortGroup(item.group)));
        continue;
      }
      if (item.custom === 'teraVoices') {
        const section = el('div', { class: 'setting piper-voices tera-voices' });
        grid.append(section);
        renderTeraVoices(section);
        continue;
      }
      if (item.custom === 'teraHelper') {
        const tera = app.tts?.tera;
        if (!tera?.available) continue;
        if (!helperFlow) {
          helperFlow = createHelperFlow(tera);
          helperFlow.onChange(() => document.querySelectorAll('.tera-helper').forEach(renderTeraHelper));
        }
        const section = el('div', { class: 'setting piper-voices tera-helper' });
        grid.append(section);
        renderTeraHelper(section);
        continue;
      }
      if (item.custom === 'notesPick') {
        if (!app.tts?.pickNotes) continue;
        const muted = app.tts.notes?.count ?? 0;
        grid.append(
          el('div', { class: 'setting' }, [
            el('span', { class: 'label' }, [
              el('span', {}, 'Какие примечания читать'),
              el(
                'span',
                { class: 'hint' },
                `Все примечания открытой книги списком: снимите галочки у тех, что слушать не нужно, — голос их пропустит, и в аудиокниге тоже. Выбор у каждой книги свой.${muted ? ` Сейчас выключено: ${muted}.` : ''}`
              ),
            ]),
            el('button', { type: 'button', id: 'pickNotes', onclick: () => app.tts.pickNotes() }, 'Выбрать…'),
          ])
        );
        continue;
      }
      if (item.custom === 'updates') {
        // Вьюер, открытый как веб-страница (режим отладки), — не расширение: обновлять нечего.
        if (!globalThis.browser?.runtime?.id) continue;
        const section = el('div', { class: 'setting piper-voices updates' });
        grid.append(section);
        renderUpdates(section);
        continue;
      }
      if (item.custom === 'userStress') {
        const section = el('div', { class: 'setting piper-voices user-stress' });
        grid.append(section);
        renderUserStress(section);
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

  const VOICES_GROUP = 'Голоса и модели';
  const groupId = (group) => `settings-${SETTINGS_SCHEMA.filter((item) => item.group).findIndex((item) => item.group === group)}`;
  const shortGroup = (group) => group.replace(/\s*\(.*\)$/, '');

  /** Прокрутить окно к разделу. */
  function showGroup(group) {
    document.getElementById(groupId(group))?.scrollIntoView({ block: 'start' });
    for (const button of $('settingsNav').children) button.classList.toggle('current', button.dataset.group === group);
  }

  /**
   * Открыть настройки.
   * @param target раздел или то, что качается (id из downloads.js), — окно
   *   откроется на нём: щёлкнули по значку скачивания — видна его полоса
   */
  function open(target = null) {
    piperMessage = '';
    render();
    helperFlow?.refresh();
    dialog.showModal();
    chip.render();
    const group = typeof target === 'string' ? (SETTINGS_SCHEMA.some((item) => item.group === target) ? target : VOICES_GROUP) : null;
    if (group) requestAnimationFrame(() => showGroup(group));
  }

  // Значок скачивания в углу — пока окно закрыто.
  const chip = createDownloadChip({ openSettings: (id) => open(id), isSettingsOpen: () => dialog.open });
  on(dialog, 'close', () => chip.render());

  on($('btnSettings'), 'click', () => open());

  return {
    open,
    close() {
      dialog.close();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}
