import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  autoStepDistance,
  clampSpeed,
  nextAutoScrollTop,
  screenStepDistance,
  speedIncrement,
} from '../../extension/src/scroll-math.js';

describe('screenStepDistance', () => {
  it('оставляет нахлёст, чтобы последняя строка не терялась', () => {
    assert.equal(screenStepDistance(800, 10), 720);
    assert.equal(screenStepDistance(800, 0), 800);
  });

  it('не даёт шагу выродиться на крошечном окне', () => {
    assert.equal(screenStepDistance(50, 90), 40);
  });
});

describe('autoStepDistance', () => {
  it('считает шаг долей экрана', () => {
    assert.equal(autoStepDistance(800, 90), 720);
    assert.equal(autoStepDistance(800, 100), 800);
  });
});

describe('nextAutoScrollTop', () => {
  it('накапливает дробные пиксели: на медленной скорости иначе стоим на месте', () => {
    let top = 0;
    for (let i = 0; i < 10; i += 1) {
      top = nextAutoScrollTop({ top, maxTop: 1000, speed: 5, dtMs: 16 });
    }
    assert.ok(top > 0.7 && top < 0.9, `ожидалось около 0.8, получено ${top}`);
  });

  it('не уезжает за конец документа', () => {
    assert.equal(nextAutoScrollTop({ top: 995, maxTop: 1000, speed: 400, dtMs: 100 }), 1000);
  });

  it('игнорирует гигантский кадр после простоя вкладки', () => {
    const top = nextAutoScrollTop({ top: 0, maxTop: 100000, speed: 100, dtMs: 60000 });
    assert.equal(top, 25); // не больше, чем за 250 мс
  });
});

describe('clampSpeed и speedIncrement', () => {
  it('держит скорость в допустимых пределах', () => {
    assert.equal(clampSpeed(0), 1);
    assert.equal(clampSpeed(10000), 400);
    assert.equal(clampSpeed(42.4), 42);
  });

  it('на медленных скоростях шаг регулировки мелкий, на быстрых — крупный', () => {
    assert.equal(speedIncrement(5), 1);
    assert.equal(speedIncrement(20), 2);
    assert.equal(speedIncrement(40), 5);
    assert.equal(speedIncrement(100), 10);
    assert.equal(speedIncrement(300), 25);
  });

  it('при замедлении шаг берётся по скорости, в которую идём', () => {
    assert.equal(speedIncrement(10, -1), 1); // 10 → 9, а не 10 → 8
    assert.equal(speedIncrement(30, -1), 2);
    assert.equal(speedIncrement(30, 1), 5);
  });
});
