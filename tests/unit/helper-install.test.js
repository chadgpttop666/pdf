import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { createHelperFlow, describeHelper, helperButton } from '../../extension/src/tts/helper-install.js';
import { HELPER_RELEASE } from '../../extension/src/tts/helper-release.js';

const INSTALLER = new TextEncoder().encode('установщик');
const SHA = createHash('sha256').update(INSTALLER).digest('hex');

/** Firefox, каким его видит расширение: разрешения, загрузки, native messaging. */
function fakeBrowser({ granted = false, installedAfterRun = true } = {}) {
  const calls = [];
  let permission = granted;
  let installed = false;
  const changed = [];
  const browser = {
    calls,
    runtime: {
      getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }),
      connectNative() {
        const message = [];
        const disconnect = [];
        const port = {
          onMessage: { addListener: (fn) => message.push(fn) },
          onDisconnect: { addListener: (fn) => disconnect.push(fn) },
          postMessage(request) {
            queueMicrotask(() => {
              if (!installed) {
                port.error = { message: 'No such native application pdf_reader_tts' };
                disconnect.forEach((fn) => fn(port));
              } else message.forEach((fn) => fn({ type: 'hello', id: request.id, version: '1.0.0', protocol: 1, files: {} }));
            });
          },
          disconnect() {},
        };
        return port;
      },
    },
    permissions: {
      contains: async () => permission,
      request: async () => {
        calls.push('permissions.request');
        permission = true;
        return true;
      },
    },
    downloads: {
      onChanged: { addListener: (fn) => changed.push(fn), removeListener: () => {} },
      async download({ filename }) {
        calls.push(`download ${filename}`);
        setTimeout(() => changed.forEach((fn) => fn({ id: 7, state: { current: 'complete' } })), 5);
        return 7;
      },
      search: async () => [{ id: 7, state: 'in_progress' }],
      async open(id) {
        calls.push(`open ${id}`);
        // Человек запустил файл — программа зарегистрировалась.
        if (installedAfterRun) setTimeout(() => (installed = true), 20);
      },
      show: async () => {},
      removeFile: async (id) => calls.push(`removeFile ${id}`),
      erase: async () => {},
    },
  };
  return browser;
}

function fakeTera() {
  let installed = false;
  return {
    connectChecks: 0,
    async helperStatus() {
      this.connectChecks += 1;
      const hello = await import('../../extension/src/tts/tera-native.js').then(({ connectHelper }) => connectHelper({ timeout: 1000 }));
      hello?.client.close();
      installed = Boolean(hello);
      return installed ? { installed: true, version: '1.0.0', packInstalled: true, modelsReady: this.synced ?? false } : { installed: false };
    },
    async prepareHelper(onProgress) {
      onProgress(50, 100);
      onProgress(100, 100);
      this.synced = true;
    },
    async removeHelper() {
      this.removed = true;
    },
  };
}

const waitFor = async (flow, step) => {
  for (let i = 0; i < 400 && flow.state.step !== step; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(flow.state.step, step, JSON.stringify(flow.state));
};

const saved = { ...HELPER_RELEASE.files.linux };
const savedFetch = globalThis.fetch;
afterEach(() => {
  Object.assign(HELPER_RELEASE.files.linux, saved);
  globalThis.fetch = savedFetch;
  delete globalThis.browser;
});

describe('установка ускорителя из расширения (helper-install.js)', () => {
  it('сборки для системы нет — карточка честно говорит об этом', async () => {
    globalThis.browser = fakeBrowser();
    const flow = createHelperFlow(fakeTera());
    flow.refresh();
    await waitFor(flow, 'unsupported');
    assert.equal(helperButton(flow.state), null);
  });

  it('весь путь: «Установить» → скачать с проверкой хэша → «Запустить» → нашёлся → модели → работает', async () => {
    Object.assign(HELPER_RELEASE.files.linux, { size: INSTALLER.length, sha256: SHA });
    globalThis.fetch = async (url) => {
      assert.match(url, /releases\/download\/helper-v1\.0\.0\/pdf-reader-tts-linux$/);
      return new Response(INSTALLER);
    };
    const browser = fakeBrowser();
    globalThis.browser = browser;
    const tera = fakeTera();
    const flow = createHelperFlow(tera);
    const seen = [];
    flow.onChange((state) => seen.push(state.step));

    flow.refresh();
    await waitFor(flow, 'missing');
    assert.deepEqual(helperButton(flow.state), { label: 'Установить', act: 'install' });

    flow.install();
    assert.equal(browser.calls[0], 'permissions.request', 'разрешение — первым делом, пока действует нажатие');
    await waitFor(flow, 'ready');
    assert.ok(browser.calls.includes('download pdf-reader-tts-linux'));
    assert.equal(helperButton(flow.state).act, 'run');

    flow.run();
    assert.equal(browser.calls.at(-1), 'open 7', 'файл открывается сразу по нажатию');
    assert.equal(flow.state.step, 'waiting');
    await waitFor(flow, 'working');
    assert.ok(seen.includes('syncing'));
    assert.ok(tera.synced);
    assert.ok(browser.calls.includes('removeFile 7'), 'скачанный установщик убран');
    assert.match(describeHelper(flow.state), /Работает \(версия 1\.0\.0\)/);

    await flow.remove();
    assert.ok(tera.removed);
    assert.equal(flow.state.step, 'missing');
  });

  it('файл подменён — не ставим', async () => {
    Object.assign(HELPER_RELEASE.files.linux, { size: INSTALLER.length, sha256: SHA });
    globalThis.fetch = async () => new Response(new TextEncoder().encode('что-то другое'));
    globalThis.browser = fakeBrowser({ granted: true });
    const flow = createHelperFlow(fakeTera());
    flow.install();
    await waitFor(flow, 'error');
    assert.match(describeHelper(flow.state), /не совпал/);
    assert.equal(helperButton(flow.state).act, 'install');
  });
});
