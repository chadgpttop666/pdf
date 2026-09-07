// Поиск полей страницы по пикселям уменьшенного рендера. Вынесено отдельно от
// DOM, чтобы проверять юнит-тестами на синтетических картинках.

/**
 * Границы содержимого в долях от размера страницы.
 * @param {Uint8ClampedArray} data RGBA-пиксели
 * @param {number} width
 * @param {number} height
 * @param {{ threshold?: number, padding?: number }} [options]
 * @returns {{ left: number, right: number, top: number, bottom: number } | null}
 */
export function detectContentBox(data, width, height, { threshold = 14, padding = 0.006 } = {}) {
  const background = backgroundLevel(data, width, height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      if (alpha === 0) continue; // прозрачные поля тоже считаем фоном
      const level = luminance(data[offset], data[offset + 1], data[offset + 2]);
      if (Math.abs(level - background) < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null; // пустая страница — обрезать нечего

  return {
    left: clampFraction(minX / width - padding),
    right: clampFraction(1 - (maxX + 1) / width - padding),
    top: clampFraction(minY / height - padding),
    bottom: clampFraction(1 - (maxY + 1) / height - padding),
  };
}

/** Итоговые поля документа — медиана по страницам, чтобы вёрстка не прыгала. */
export function medianBox(boxes) {
  const usable = boxes.filter(Boolean);
  if (!usable.length) return null;
  const pick = (side) => median(usable.map((box) => box[side]));
  return { left: pick('left'), right: pick('right'), top: pick('top'), bottom: pick('bottom') };
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Фон берём по углам: там почти всегда чистое поле страницы. */
function backgroundLevel(data, width, height) {
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  const levels = corners.map(([x, y]) => {
    const offset = (y * width + x) * 4;
    return data[offset + 3] === 0 ? 255 : luminance(data[offset], data[offset + 1], data[offset + 2]);
  });
  return median(levels);
}

/** Ограничение снизу нулём и сверху 30%: больше трети страницы не режем. */
function clampFraction(value) {
  return Math.min(0.3, Math.max(0, Number(value.toFixed(4))));
}
