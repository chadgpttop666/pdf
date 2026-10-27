// Чистые расчёты прокрутки — вынесены отдельно, чтобы проверять их обычными
// юнит-тестами без браузера.

export const MIN_SPEED = 1;
export const MAX_SPEED = 400;

/** Шаг перемотки «на экран»: высота области минус нахлёст. */
export function screenStepDistance(viewportHeight, overlapPercent) {
  const overlap = (clamp(overlapPercent, 0, 90) / 100) * viewportHeight;
  return Math.max(40, viewportHeight - overlap);
}

/** Шаг автопрокрутки в шаговом режиме: доля экрана. */
export function autoStepDistance(viewportHeight, stepPercent) {
  return Math.max(20, (clamp(stepPercent, 1, 100) / 100) * viewportHeight);
}

/**
 * Новое положение при плавной автопрокрутке. Дробная часть не теряется:
 * позицию ведём сами, иначе на медленной скорости округление съедает шаг.
 */
export function nextAutoScrollTop({ top, maxTop, speed, dtMs }) {
  const delta = (clamp(speed, MIN_SPEED, MAX_SPEED) * clamp(dtMs, 0, 250)) / 1000;
  return Math.min(maxTop, top + delta);
}

export function clampSpeed(speed) {
  return clamp(Math.round(speed), MIN_SPEED, MAX_SPEED);
}

/**
 * Шаг изменения скорости: на медленных скоростях мелкий (разница между 4 и
 * 5 px/с при чтении заметна), на быстрых — крупный, чтобы хватало пары
 * нажатий. При замедлении шаг берётся по скорости, в которую идём, —
 * иначе с 10 px/с сразу прыгнули бы на 8.
 */
export function speedIncrement(speed, direction = 1) {
  const base = direction < 0 ? speed - 1 : speed;
  if (base < 10) return 1;
  if (base < 30) return 2;
  if (base < 60) return 5;
  if (base < 150) return 10;
  return 25;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
