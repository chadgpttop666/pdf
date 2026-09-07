import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectContentBox, median, medianBox } from '../../extension/src/crop-math.js';

/** Белая картинка с чёрным прямоугольником внутри. */
function image(width, height, box) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = box.top; y < box.bottom; y += 1) {
    for (let x = box.left; x < box.right; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
    }
  }
  return data;
}

describe('detectContentBox', () => {
  it('находит поля вокруг содержимого', () => {
    const data = image(100, 100, { left: 10, right: 90, top: 20, bottom: 80 });
    const box = detectContentBox(data, 100, 100, { padding: 0 });
    assert.deepEqual(box, { left: 0.1, right: 0.1, top: 0.2, bottom: 0.2 });
  });

  it('возвращает null для пустой страницы — резать нечего', () => {
    const data = new Uint8ClampedArray(40 * 40 * 4).fill(255);
    assert.equal(detectContentBox(data, 40, 40), null);
  });

  it('не срезает больше трети страницы даже при узком содержимом', () => {
    const data = image(100, 100, { left: 48, right: 52, top: 48, bottom: 52 });
    const box = detectContentBox(data, 100, 100, { padding: 0 });
    assert.equal(box.left, 0.3);
    assert.equal(box.top, 0.3);
  });

  it('считает фоном тёмную страницу, а не только белую', () => {
    const width = 60;
    const height = 60;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = 20;
      data[i * 4 + 1] = 20;
      data[i * 4 + 2] = 20;
    }
    for (let y = 10; y < 50; y += 1) {
      for (let x = 6; x < 54; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = 240;
        data[offset + 1] = 240;
        data[offset + 2] = 240;
      }
    }
    const box = detectContentBox(data, width, height, { padding: 0 });
    assert.equal(box.left, 0.1);
    assert.equal(box.top, box.bottom);
  });
});

describe('medianBox', () => {
  it('берёт медиану по страницам, игнорируя пустые', () => {
    const box = medianBox([
      { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 },
      null,
      { left: 0.2, right: 0.2, top: 0.2, bottom: 0.2 },
      { left: 0.3, right: 0.3, top: 0.3, bottom: 0.3 },
    ]);
    assert.deepEqual(box, { left: 0.2, right: 0.2, top: 0.2, bottom: 0.2 });
  });

  it('без единой пригодной страницы возвращает null', () => {
    assert.equal(medianBox([null, null]), null);
  });
});

describe('median', () => {
  it('усредняет два средних значения при чётной длине', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([5, 1, 3]), 3);
  });
});
