// Перемотка экранами вместо страниц: шаг равен высоте видимой области минус
// нахлёст, чтобы последняя прочитанная строка оставалась перед глазами.

import { get as getSetting } from './settings.js';

export function createScreenNav(app) {
  const container = app.container;

  function screenStep() {
    const overlap = (getSetting('screenOverlapPercent') / 100) * container.clientHeight;
    return Math.max(40, container.clientHeight - overlap);
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
      return app.scroller.scrollBy(Math.round(container.clientHeight * 0.12), { smooth: true, duration: 120 });
    },
    lineUp() {
      return app.scroller.scrollBy(-Math.round(container.clientHeight * 0.12), { smooth: true, duration: 120 });
    },
    toStart() {
      return app.scroller.scrollTo(0, scrollOptions());
    },
    toEnd() {
      return app.scroller.scrollTo(app.scroller.maxTop(), scrollOptions());
    },
  };

  // Клик по краю экрана — как в читалках: низ листает вперёд, верх назад.
  container.addEventListener('click', (event) => {
    if (!getSetting('clickZones')) return;
    if (event.target.closest('a, button, input, .textLayer .highlight')) return;
    if (window.getSelection()?.toString()) return;
    const rect = container.getBoundingClientRect();
    const position = (event.clientY - rect.top) / rect.height;
    if (position > 0.72) nav.screenDown();
    else if (position < 0.18) nav.screenUp();
  });

  return nav;
}
