// Плавная прокрутка контейнера. Своя анимация вместо scrollTo({behavior:'smooth'}),
// потому что нужны настраиваемая длительность, мгновенная отмена при вмешательстве
// пользователя и точность до дробных пикселей для медленной автопрокрутки.
//
// Контейнер можно передать функцией: у читалки две области прокрутки —
// страницы PDF и режим «только текст», — и работать надо с той, что видна.

const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export function createScroller(source) {
  const current = () => (typeof source === 'function' ? source() : source);
  let frame = 0;
  let onDone = null;

  function cancel() {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
    const callback = onDone;
    onDone = null;
    callback?.(false);
  }

  function maxTop(container = current()) {
    return Math.max(0, container.scrollHeight - container.clientHeight);
  }

  function scrollTo(top, { smooth = true, duration = 220 } = {}) {
    cancel();
    const container = current(); // анимация доводится в той области, где началась
    const from = container.scrollTop;
    const to = Math.min(Math.max(0, top), maxTop(container));
    if (!smooth || duration <= 0 || Math.abs(to - from) < 1) {
      container.scrollTop = to;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      onDone = resolve;
      const start = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - start) / duration);
        container.scrollTop = from + (to - from) * easeInOutQuad(progress);
        if (progress < 1) {
          frame = requestAnimationFrame(step);
          return;
        }
        frame = 0;
        onDone = null;
        resolve(true);
      };
      frame = requestAnimationFrame(step);
    });
  }

  return {
    cancel,
    scrollTo,
    scrollBy(delta, options) {
      return scrollTo(current().scrollTop + delta, options);
    },
    get animating() {
      return frame !== 0;
    },
    get atBottom() {
      return current().scrollTop >= maxTop() - 1;
    },
    get atTop() {
      return current().scrollTop <= 1;
    },
    maxTop: () => maxTop(),
  };
}
