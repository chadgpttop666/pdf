// Глобальные настройки читалки. Схема одновременно описывает значения по
// умолчанию и то, как настройка выглядит в диалоге — второй список городить
// не нужно. Всё, что зависит от конкретного документа (масштаб, обрезка,
// позиция), живёт не здесь, а в library.js.

import { storage } from './platform.js';

const STORAGE_KEY = 'settings.v1';

export const SETTINGS_SCHEMA = [
  { group: 'Прокрутка' },
  {
    key: 'screenOverlapPercent',
    type: 'range',
    def: 8,
    min: 0,
    max: 30,
    step: 1,
    unit: '%',
    label: 'Нахлёст при прокрутке на экран',
    hint: 'Сколько нижней части экрана остаётся видимым после шага вниз',
  },
  {
    key: 'smoothScreenScroll',
    type: 'bool',
    def: true,
    label: 'Плавная прокрутка по экрану',
    hint: 'Выключите, если предпочитаете мгновенный скачок',
  },
  {
    key: 'scrollAnimationMs',
    type: 'range',
    def: 220,
    min: 60,
    max: 600,
    step: 10,
    unit: ' мс',
    label: 'Длительность плавной прокрутки',
  },
  {
    key: 'clickZones',
    type: 'bool',
    def: false,
    label: 'Листать кликом по краю экрана',
    hint: 'Клик по нижней трети — вперёд, по верхней — назад',
  },
  { group: 'Автопрокрутка' },
  {
    key: 'autoScrollMode',
    type: 'select',
    def: 'continuous',
    options: [
      ['continuous', 'плавно, с постоянной скоростью'],
      ['step', 'шагами через паузу'],
    ],
    label: 'Режим',
  },
  {
    key: 'autoScrollSpeed',
    type: 'range',
    def: 40,
    min: 1,
    max: 400,
    step: 1,
    unit: ' px/с',
    label: 'Скорость плавного режима',
  },
  {
    key: 'autoScrollStepPercent',
    type: 'range',
    def: 90,
    min: 10,
    max: 100,
    step: 5,
    unit: '% экрана',
    label: 'Величина шага',
  },
  {
    key: 'autoScrollIntervalSec',
    type: 'range',
    def: 20,
    min: 2,
    max: 120,
    step: 1,
    unit: ' с',
    label: 'Пауза между шагами',
  },
  {
    key: 'autoScrollStopOnInput',
    type: 'bool',
    def: true,
    label: 'Останавливать при ручной прокрутке',
  },
  { group: 'Озвучка' },
  {
    key: 'ttsProvider',
    type: 'select',
    def: 'web-speech',
    options: [
      ['web-speech', 'голоса системы (Web Speech API)'],
      ['http', 'внешний движок по HTTP'],
    ],
    label: 'Движок для голосов системы',
    hint: 'Нейроголоса TeraTTS и Piper выбираются прямо в списке голосов на панели озвучки',
  },
  {
    key: 'ttsHttpUrl',
    type: 'text',
    def: '',
    label: 'Адрес внешнего движка',
    hint: 'Например http://127.0.0.1:5000/tts — см. docs/tts-http-provider.md',
  },
  { key: 'ttsRate', type: 'range', def: 1, min: 0.5, max: 3, step: 0.1, unit: '×', label: 'Скорость речи' },
  { key: 'ttsPitch', type: 'range', def: 1, min: 0.5, max: 1.5, step: 0.05, label: 'Тон' },
  { key: 'ttsVolume', type: 'range', def: 1, min: 0, max: 1, step: 0.05, label: 'Громкость' },
  { key: 'ttsVoiceUri', type: 'hidden', def: '' },
  {
    key: 'ttsBufferMinutes',
    type: 'select',
    def: '2',
    options: [
      ['0.5', 'полминуты'],
      ['2', '2 минуты'],
      ['5', '5 минут'],
      ['10', '10 минут'],
      ['20', '20 минут'],
    ],
    label: 'Нейроголос готовит речь вперёд',
    hint:
      'Пока звучит фраза и на паузе, следующие синтезируются заранее — как подгрузка видео: после паузы чтение идёт без ожидания. ' +
      'Больше запас — больше памяти (у TeraTTS ≈10 МБ на минуту речи). Голосам системы подготовка не нужна',
  },
  {
    key: 'ttsMixLanguages',
    type: 'bool',
    def: true,
    label: 'Английские вставки — английским голосом',
    hint: 'Названия вроде «Journal of Political Philosophy» в русском тексте читает английский голос системы. Нейроголос произносит их по-английски сам',
  },
  {
    key: 'ttsSkipFurniture',
    type: 'bool',
    def: true,
    label: 'Не читать колонтитулы, номера страниц и сноски',
    hint: 'Колонтитулы узнаются по повтору вверху и внизу страниц, сноски — по мелкому шрифту',
  },
  {
    key: 'ttsFootnotes',
    type: 'select',
    def: 'inline',
    options: [
      ['inline', 'сразу после фразы со ссылкой'],
      ['skip', 'не читать'],
    ],
    label: 'Примечания и сноски',
    hint: 'Дочитав фразу со знаком сноски («Конт³»), голос читает «Примечание: …» и продолжает. Пока оно звучит, его текст виден в окошке над панелью озвучки; «Пропустить» или «.» — сразу дальше, «Не читать это» — больше никогда (у этой книги). Текст берётся внизу страницы (с продолжением на следующей) или из раздела «Примечания» в конце книги. Работает, когда колонтитулы и сноски не читаются подряд',
  },
  { custom: 'notesPick' },
  {
    key: 'ttsReadLinks',
    type: 'bool',
    def: false,
    label: 'Читать интернет-ссылки',
    hint: 'Выключено — голос пропускает адреса сайтов и почты (https://…, www.…, site.ru/…, name@mail.ru, DOI) вместе с подписью «URL:»; на странице и в окошке примечания они остаются. Примечание из одной ссылки не читается вовсе. Так же — в аудиокниге и при озвучке выделенного на сайтах',
  },
  {
    key: 'ttsMediaKeys',
    type: 'bool',
    def: true,
    label: 'Кнопки наушников и медиаклавиши',
    hint: 'Пауза, следующее и предыдущее предложение — кнопками гарнитуры и клавиатуры, даже когда окно свёрнуто. Во время примечания «громче» и «следующий трек» (у гарнитур обычно двойное нажатие) пропускают его. Кнопку «громче» браузер сам не получает — её забирает Windows; ловит её ускоритель TeraTTS (1.6.0+): только пока звучит примечание, и громкость при этом не меняется. Без ускорителя «громче» работает, лишь если окно читалки активно',
  },
  {
    key: 'ttsFollowScroll',
    type: 'bool',
    def: true,
    label: 'Прокручивать за озвучкой',
  },
  {
    key: 'ttsHighlightWords',
    type: 'bool',
    def: true,
    label: 'Подсвечивать слово целиком',
    hint: 'Работает, если голос сообщает границы слов',
  },
  {
    key: 'ttsSentencePauseMs',
    type: 'range',
    def: 0,
    min: 0,
    max: 1500,
    step: 50,
    unit: ' мс',
    label: 'Пауза между предложениями',
  },
  {
    key: 'ocrAuto',
    type: 'bool',
    def: true,
    label: 'Распознавать сканы при озвучке',
    hint: 'Страница без текста распознаётся перед чтением, следующая — заранее',
  },
  // Списки нейроголосов строятся в settings-dialog.js: это не настройки, а
  // управление скачанными файлами.
  { group: 'Голоса и модели' },
  { custom: 'teraVoices' },
  // Ускоритель — тоже не настройка, а установка программы: helper-install.js.
  { custom: 'teraHelper' },
  { custom: 'userStress' },
  {
    key: 'teraUseHelper',
    type: 'bool',
    def: true,
    label: 'TeraTTS: синтез ускорителем',
    hint: 'Когда ускоритель установлен. Выключите, чтобы синтезировать в браузере',
  },
  {
    key: 'teraQuality',
    type: 'select',
    def: 'max',
    options: [
      ['max', 'исходная — лучший звук'],
      ['steps6', '6 шагов синтеза — на ≈20 % легче'],
      ['fast', '6 шагов и 8 бит — на ≈35 % легче, в паузах шипение'],
    ],
    label: 'TeraTTS: модель',
    hint: 'Облегчённые варианты делаются из скачанной модели один раз, за несколько секунд. Модель ударений облегчена всегда — на звук она не влияет. Ускоритель всегда синтезирует исходной моделью',
  },
  {
    key: 'teraThreads',
    type: 'select',
    def: 'auto',
    options: [
      ['auto', 'сами по скорости чтения'],
      ['1', 'один'],
      ['2', 'два (+≈1 ГБ памяти)'],
      ['3', 'три (+≈2 ГБ памяти)'],
    ],
    label: 'TeraTTS: потоки синтеза',
    hint: 'Речь синтезируется на обычной скорости, поэтому на 2× синтез должен успевать вдвое быстрее. «Сами» — второй поток включается от 1,3× и если между фразами паузы. С ускорителем не нужно: он успевает и так',
  },
  { custom: 'piperVoices' },
  { group: 'Вид' },
  {
    key: 'uiTheme',
    type: 'select',
    def: 'dark',
    options: [
      ['dark', 'тёмная'],
      ['light', 'светлая'],
    ],
    label: 'Тема интерфейса',
  },
  {
    key: 'pageTheme',
    type: 'select',
    def: 'normal',
    options: [
      ['normal', 'как есть'],
      ['invert', 'инверсия'],
      ['sepia', 'сепия'],
      ['dim', 'приглушить'],
    ],
    label: 'Режим страницы',
  },
  { key: 'brightness', type: 'range', def: 100, min: 40, max: 130, step: 1, unit: '%', label: 'Яркость' },
  { key: 'contrast', type: 'range', def: 100, min: 60, max: 180, step: 1, unit: '%', label: 'Контраст' },
  {
    key: 'cropEnabled',
    type: 'bool',
    def: false,
    label: 'Обрезать поля страницы',
  },
  {
    key: 'cropAuto',
    type: 'bool',
    def: true,
    label: 'Определять поля автоматически',
    hint: 'Поля считаются по выборке страниц один раз при открытии',
  },
  { group: 'Только текст (клавиша T)' },
  {
    key: 'reflowTheme',
    type: 'select',
    def: 'auto',
    options: [
      ['auto', 'как интерфейс'],
      ['paper', 'бумага'],
      ['sepia', 'сепия'],
      ['night', 'ночь'],
    ],
    label: 'Цвета',
  },
  {
    key: 'reflowFont',
    type: 'select',
    def: 'serif',
    options: [
      ['serif', 'с засечками (как в книге)'],
      ['sans', 'без засечек'],
    ],
    label: 'Шрифт',
  },
  { key: 'reflowSize', type: 'range', def: 22, min: 12, max: 48, step: 1, unit: ' px', label: 'Размер шрифта', hint: 'Ctrl + / Ctrl − в режиме текста' },
  { key: 'reflowLineHeight', type: 'range', def: 1.6, min: 1.2, max: 2.2, step: 0.05, label: 'Межстрочный интервал' },
  { key: 'reflowWidth', type: 'range', def: 68, min: 30, max: 140, step: 2, unit: ' знаков', label: 'Ширина колонки' },
  {
    key: 'reflowAlign',
    type: 'select',
    def: 'justify',
    options: [
      ['justify', 'по ширине'],
      ['left', 'по левому краю'],
    ],
    label: 'Выравнивание',
  },
  { group: 'Книги FB2 и EPUB' },
  {
    key: 'bookNoHyphens',
    type: 'bool',
    def: false,
    label: 'Без переносов слов',
    hint: 'Поставьте галочку — слова на краю строки не разрываются дефисом (пробелы между словами местами шире). Открытая книга переверстается сразу, место чтения останется; книга из «Недавних» тоже верстается по этой настройке'
  },
  { group: 'Обновления' },
  // Версия, состояние и кнопка «Проверить / Обновить сейчас»: updates.js.
  { custom: 'updates' },
  {
    key: 'autoUpdate',
    type: 'bool',
    def: true,
    label: 'Обновлять читалку автоматически',
    hint: 'Новая версия скачивается и ставится сама, без вопросов — когда вкладки читалки закрыты, чтобы не прерывать чтение. Без галочки читалка только скажет о новой версии, а поставит её кнопка «Обновить сейчас» (Firefox всё равно поставит её при следующем запуске — запретить ему это может только about:addons). В Chrome обновляет ускоритель — он нужен и для этого',
  },
  { group: 'Прочее' },
  {
    key: 'interceptPdfLinks',
    type: 'bool',
    def: true,
    label: 'Открывать PDF-ссылки в этой читалке',
    hint: 'Иначе останется встроенный просмотр браузера',
  },
  {
    key: 'rememberPosition',
    type: 'bool',
    def: true,
    label: 'Запоминать место чтения',
  },
  {
    key: 'keepTabLoaded',
    type: 'bool',
    def: true,
    label: 'Не выгружать вкладку читалки',
    hint: 'Когда памяти мало, браузер выгружает фоновые вкладки, а при возврате загружает их заново — документ, место, голос. Вкладку с книгой он оставит как была',
  },
  {
    key: 'storeFilesInLibrary',
    type: 'bool',
    def: true,
    label: 'Хранить открытые файлы для списка недавних',
    hint: 'Файлы лежат в локальной базе браузера и никуда не отправляются',
  },
  {
    key: 'maxStoredFileMb',
    type: 'range',
    def: 60,
    min: 5,
    max: 300,
    step: 5,
    unit: ' МБ',
    label: 'Не хранить файлы крупнее',
  },
  {
    key: 'statsEnabled',
    type: 'bool',
    def: true,
    label: 'Вести статистику чтения',
    hint: 'Время, скорость и оценка «сколько осталось» — только в этом браузере',
  },
  {
    key: 'keepScreenAwake',
    type: 'bool',
    def: true,
    label: 'Не гасить экран при автопрокрутке и озвучке',
  },
  { key: 'sidebarOpen', type: 'hidden', def: false },
  // Правка страниц: последние выбранные цвет и размеры (editing/editing.js).
  { key: 'editTextColor', type: 'hidden', def: '#000000' },
  { key: 'editTextSize', type: 'hidden', def: 12 },
  { key: 'editInkColor', type: 'hidden', def: '#0b5cd5' },
  { key: 'editInkThickness', type: 'hidden', def: 2 },
  { key: 'editInkOpacity', type: 'hidden', def: 100 },
  { key: 'defaultZoom', type: 'select', def: 'page-width', options: [
    ['auto', 'авто'],
    ['page-width', 'по ширине'],
    ['page-fit', 'страница целиком'],
    ['1', '100%'],
  ], label: 'Масштаб по умолчанию' },
];

export const DEFAULTS = Object.fromEntries(
  SETTINGS_SCHEMA.filter((item) => item.key).map((item) => [item.key, item.def])
);

let current = { ...DEFAULTS };
const listeners = new Set();

export async function loadSettings() {
  const stored = await storage.get(STORAGE_KEY);
  const saved = stored?.[STORAGE_KEY] || {};
  current = { ...DEFAULTS, ...saved };
  // Был флажок «второй поток» — включённый становится двумя потоками.
  if (saved.teraSecondThread && !saved.teraThreads) current.teraThreads = '2';
  delete current.teraSecondThread;
  // Был флажок «Переносить слова» (0.28) — снятый становится «Без переносов».
  if (saved.bookHyphens === false && saved.bookNoHyphens === undefined) current.bookNoHyphens = true;
  delete current.bookHyphens;
  return current;
}

export function getSettings() {
  return current;
}

export function get(key) {
  return current[key];
}

/** Сохраняет изменения и уведомляет подписчиков только об изменившихся ключах. */
export async function updateSettings(patch) {
  const changed = {};
  for (const [key, value] of Object.entries(patch)) {
    if (current[key] !== value) changed[key] = value;
  }
  if (!Object.keys(changed).length) return current;
  current = { ...current, ...changed };
  await storage.set({ [STORAGE_KEY]: current });
  for (const listener of listeners) listener(current, changed);
  return current;
}

export function onSettingsChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
