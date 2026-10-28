// Перемотка экранами вместо страниц: шаг равен высоте видимой области минус
// нахлёст, чтобы последняя прочитанная строка оставалась перед глазами.
// Работает с той областью, что сейчас видна: страницы PDF или «только текст».

import { get as getSetting } from './settings.js';

export function createScreenNav(app) {
  const viewport = () => app.activeContainer;

  function screenStep() {
    const height = viewport().clientHeight;
    const overlap = (getSetting('screenOverlapPercent') / 100) * height;
    return Math.max(40, height - overlap);
  }

  function scrollOptions() {
    return {
      smooth: getSetting('smoothScreenScroll'),
      duration: getSetting('scrollAnimationMs'),
    };
  }

  function announceEdge(atEdge, text) {
    if (atEdge) app.hud.show(text);
  }

  const nav = {
    screenStep,
    screenDown() {
      announceEdge(app.scroller.atBottom, 'Конец документа');
      return app.scroller.scrollBy(screenStep(), scrollOptions());
    },
    screenUp() {
      announceEdge(app.scroller.atTop, 'Начало документа');
      return app.scroller.scrollBy(-screenStep(), scrollOptions());
    },
    lineDown() {
      return app.scroller.scrollBy(Math.round(viewport().clientHeight * 0.12), { smooth: true, duration: 120 });
    },
    lineUp() {
      return app.scroller.scrollBy(-Math.round(viewport().clientHeight * 0.12), { smooth: true, duration: 120 });
    },
    toStart() {
      return app.scroller.scrollTo(0, scrollOptions());
    },
    toEnd() {
      return app.scroller.scrollTo(app.scroller.maxTop(), scrollOptions());
    },
  };

  // Клик по краю экрана — как в читалках: низ листает вперёд, верх назад.
  function onClick(event) {
    if (!getSetting('clickZones')) return;
    if (event.target.closest('a, button, input, .textLayer .highlight')) return;
    // Щелчок по тексту при открытой панели озвучки выбирает место чтения.
    if (app.tts?.pickMode && event.target.closest('.textLayer, .rf-s')) return;
    if (window.getSelection()?.toString()) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = (event.clientY - rect.top) / rect.height;
    if (position > 0.72) nav.screenDown();
    else if (position < 0.18) nav.screenUp();
  }

  app.container.addEventListener('click', onClick);
  document.getElementById('reflowContainer').addEventListener('click', onClick);

  return nav;
}
