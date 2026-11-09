import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHelperKeys } from '../../extension/src/tts/helper-keys.js';

/** Ускоритель-заглушка: запоминает команды, умеет «нажать» кнопку. */
function fakeHelper({ features = ['media-keys'], version = '1.6.0' } = {}) {
  const calls = [];
  const listeners = [];
  const state = { connects: 0, closed: 0 };
  const client = {
    async watchMediaKeys(on) {
      calls.push(on);
      return { type: 'media-watch', on, hotkeys: on ? ['volume-up', 'next'] : [], volume: on };
    },
    onEvent: (listener) => listeners.push(listener),
    onClose() {},
    close: () => (state.closed += 1),
  };
  const connect = async () => {
    state.connects += 1;
    return { client, hello: { version: typeof version === 'function' ? version() : version, features: typeof features === 'function' ? features() : features } };
  };
  const press = (key) => listeners.forEach((listener) => listener({ type: 'event', event: 'media-key', key }));
  return { calls, connect, press, state };
}

describe('кнопки наушников через ускоритель (helper-keys.js)', () => {
  it('перехват — только пока звучит примечание; нажатия вне его не доходят', async () => {
    const helper = fakeHelper();
    const keys = [];
    const control = createHelperKeys({ onKey: (key) => keys.push(key), connect: helper.connect });
    control.prepare();
    helper.press('volume-up'); // ещё не подключились — некому
    await control.note(true);
    assert.equal(control.active, true);
    helper.press('volume-up');
    helper.press('next');
    await control.note(false);
    helper.press('volume-up'); // примечание кончилось — не считается
    assert.deepEqual(keys, ['volume-up', 'next']);
    // Быстро вкл-выкл-вкл: ускоритель получает их по порядку, итог — включено.
    control.note(true);
    control.note(false);
    await control.note(true);
    assert.deepEqual(helper.calls, [true, false, true]);
    await control.close();
    assert.deepEqual(helper.calls, [true, false, true, false]);
    assert.equal(helper.state.closed, 1);
    assert.equal(helper.state.connects, 1);
  });

  it('ускоритель без кнопок (старый, не Windows) или его нет — тихо ничего', async () => {
    const old = fakeHelper({ features: ['accent'] });
    const control = createHelperKeys({ onKey: () => assert.fail('нажатий быть не должно'), connect: old.connect });
    await control.note(true);
    assert.equal(control.active, false);
    assert.deepEqual(old.calls, []);
    assert.equal(old.state.closed, 1);
    const none = createHelperKeys({ onKey: () => {}, connect: async () => null });
    await none.note(true);
    assert.equal(none.active, false);
  });

  it('ускоритель 1.5.0 обновился посреди чтения — со следующего примечания кнопки работают', async () => {
    let updated = false;
    const helper = fakeHelper({ version: () => (updated ? '1.6.0' : '1.5.0'), features: () => (updated ? ['media-keys'] : ['accent']) });
    const keys = [];
    const control = createHelperKeys({ onKey: (key) => keys.push(key), connect: helper.connect });
    await control.note(true);
    assert.equal(control.active, false);
    await control.note(false);
    updated = true; // TeraTTS поставил новую версию
    await control.note(true);
    assert.equal(control.active, true);
    helper.press('volume-up');
    assert.deepEqual(keys, ['volume-up']);
    assert.equal(helper.state.connects, 2);
    // Не Windows (1.6.0 без кнопок) — не переподключаемся на каждом примечании.
    const linux = fakeHelper({ features: ['accent'] });
    const quiet = createHelperKeys({ onKey: () => {}, connect: linux.connect });
    await quiet.note(true);
    await quiet.note(false);
    await quiet.note(true);
    assert.equal(linux.state.connects, 1);
  });

  it('выключено в настройках — не подключается', async () => {
    const helper = fakeHelper();
    const control = createHelperKeys({ onKey: () => {}, enabled: () => false, connect: helper.connect });
    control.prepare();
    await control.note(true);
    assert.equal(helper.state.connects, 0);
  });
});
