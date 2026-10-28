// Горячие клавиши. Сопоставление идёт по event.code, а не по event.key:
// иначе в русской раскладке «A» превращается в «ф» и ничего не работает.
// Из этой же таблицы строится окно справки — второго списка нет.

import { isTypingTarget } from './dom.js';

export function comboFromEvent(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(event.code);
  return parts.join('+');
}

const CODE_LABELS = {
  Space: 'Пробел',
  PageDown: 'Page Down',
  PageUp: 'Page Up',
  ArrowDown: '↓',
  ArrowUp: '↑',
  ArrowLeft: '←',
  ArrowRight: '→',
  Home: 'Home',
  End: 'End',
  Escape: 'Esc',
  Enter: 'Enter',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Equal: '=',
  Minus: '−',
  Digit0: '0',
  Slash: '/',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  Numpad0: 'Num 0',
};

export function displayCombo(combo) {
  return combo
    .split('+')
    .map((part) => CODE_LABELS[part] || part.replace(/^Key/, '').replace(/^Digit/, ''))
    .join(' + ');
}

const pdfMode = (app) => !app.reflow?.active;

/** Таблица действий. Модули могут быть ещё не подключены, поэтому всё через ?. */
export const BINDINGS = [
  { section: 'Чтение' },
  { combos: ['Space', 'PageDown', 'ArrowRight', 'KeyJ'], label: 'Вниз на экран', run: (app) => app.screenNav.screenDown() },
  { combos: ['Shift+Space', 'PageUp', 'ArrowLeft', 'KeyK'], label: 'Вверх на экран', run: (app) => app.screenNav.screenUp() },
  { combos: ['ArrowDown'], label: 'Немного вниз', run: (app) => app.screenNav.lineDown() },
  { combos: ['ArrowUp'], label: 'Немного вверх', run: (app) => app.screenNav.lineUp() },
  { combos: ['Home'], label: 'В начало документа', run: (app) => app.screenNav.toStart() },
  { combos: ['End'], label: 'В конец документа', run: (app) => app.screenNav.toEnd() },
  { combos: ['KeyG'], label: 'Перейти к странице', run: () => document.getElementById('pageNumber').select() },

  { section: 'Автопрокрутка' },
  { combos: ['KeyA'], label: 'Пуск / стоп', run: (app) => app.autoScroll.toggle() },
  { combos: ['BracketRight'], label: 'Быстрее', run: (app) => app.autoScroll.adjustSpeed(1) },
  { combos: ['BracketLeft'], label: 'Медленнее', run: (app) => app.autoScroll.adjustSpeed(-1) },
  { combos: ['KeyM'], label: 'Плавно / шагами', run: (app) => app.toggleAutoScrollMode?.() },

  { section: 'Озвучка' },
  { combos: ['KeyS'], label: 'Читать / пауза', run: (app) => app.tts?.toggle() },
  { combos: ['Shift+KeyS'], label: 'Остановить чтение', run: (app) => app.tts?.stop() },
  { combos: ['Period'], label: 'Следующее предложение', run: (app) => app.tts?.next() },
  { combos: ['Comma'], label: 'Предыдущее предложение', run: (app) => app.tts?.previous() },
  { combos: ['Shift+Period'], label: 'Читать быстрее', run: (app) => app.tts?.adjustRate(0.1) },
  { combos: ['Shift+Comma'], label: 'Читать медленнее', run: (app) => app.tts?.adjustRate(-0.1) },

  { section: 'Вид' },
  { combos: ['KeyT'], label: 'Режим «только текст»', run: (app) => app.reflow?.toggle() },
  { combos: ['KeyI'], label: 'Инверсия страницы', run: (app) => app.appearance?.toggleInvert() },
  { combos: ['KeyC'], label: 'Обрезка полей', run: (app) => app.appearance?.toggleCrop() },
  { combos: ['KeyV'], label: 'Панель вида', run: (app) => app.appearance?.togglePanel() },
  { combos: ['KeyF'], label: 'Скрыть панели', run: (app) => app.toggleChrome() },
  { combos: ['Ctrl+Equal', 'Ctrl+NumpadAdd'], label: 'Крупнее', run: (app) => app.toolbar.zoomBy(1) },
  { combos: ['Ctrl+Minus', 'Ctrl+NumpadSubtract'], label: 'Мельче', run: (app) => app.toolbar.zoomBy(-1) },
  { combos: ['Ctrl+Digit0', 'Ctrl+Numpad0'], label: 'Масштаб по ширине', run: (app) => app.setZoom('page-width', { fromUser: true }) },
  { combos: ['KeyL'], label: 'Закрепить масштаб и положение', run: (app) => app.viewLock.toggle() },
  { combos: ['Shift+ArrowLeft'], label: 'Сдвинуть вид влево', run: (app) => app.viewLock.nudge(-1) },
  { combos: ['Shift+ArrowRight'], label: 'Сдвинуть вид вправо', run: (app) => app.viewLock.nudge(1) },

  { section: 'Навигация и файлы' },
  { combos: ['F4'], label: 'Боковая панель', run: (app) => app.toggleSidebar() },
  { combos: ['Ctrl+KeyO'], label: 'Открыть файл', run: () => document.getElementById('filePicker').click() },
  // Иначе Firefox сохранит страницу самого вьюера, а не документ.
  { combos: ['Ctrl+KeyS'], label: 'Скачать PDF на компьютер', run: (app) => app.downloadPdf() },
  // В режиме «только текст» это обычная страница — там работает поиск самого Firefox.
  { combos: ['Ctrl+KeyF', 'Slash'], label: 'Поиск по документу', run: (app) => app.find?.open(), when: pdfMode },
  { combos: ['F3'], label: 'Следующее совпадение', run: (app) => app.find?.again(1), when: pdfMode },
  { combos: ['Shift+F3'], label: 'Предыдущее совпадение', run: (app) => app.find?.again(-1), when: pdfMode },
  { combos: ['KeyB'], label: 'Закладка на этом месте', run: (app) => app.bookmarks?.addHere() },
  { combos: ['KeyH'], label: 'Выделить маркером то, что выделено мышью', run: (app) => app.highlights?.markSelection() },
  { combos: ['F1'], label: 'Эта справка', run: (app) => app.help.toggle() },
  { combos: ['Escape'], label: 'Закрыть панели, остановить всё', run: (app) => app.escape(), allowWhileTyping: true },
];

export function bindKeyboard(app) {
  const map = new Map();
  for (const binding of BINDINGS) {
    for (const combo of binding.combos || []) {
      map.set(combo, binding);
    }
  }

  document.addEventListener('keydown', (event) => {
    const binding = map.get(comboFromEvent(event));
    if (!binding) return;
    if (isTypingTarget(event.target) && !binding.allowWhileTyping) return;
    if (event.defaultPrevented) return;
    if (binding.when && !binding.when(app)) return; // клавишу забирает браузер

    // Прокрутку и прочие действия перехватываем целиком: иначе браузер
    // прокрутит контейнер по-своему поверх нашей анимации.
    event.preventDefault();
    try {
      binding.run(app);
    } catch (error) {
      console.error('Ошибка обработчика клавиши', binding.label, error);
    }
  });

  return { map };
}
