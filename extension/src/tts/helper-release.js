// Сборка ускорителя (native/), которую расширение ставит и обновляет. Её
// собирает GitHub Actions (.github/workflows/helper.yml) и выкладывает в
// релиз helper-v<версия>; размер и SHA-256 здесь — чтобы поставить ровно её.
// Пустой sha256 — сборки для этой системы ещё нет.

export const HELPER_RELEASE = {
  version: '1.1.0',
  files: {
    win: { name: 'pdf-reader-tts.exe', size: 19011584, sha256: '1ef109c7297fc8d5cd25c12e2b004b2180e5b2f5a44c490f2abeeb2be81a107b' },
    linux: { name: 'pdf-reader-tts-linux', size: 30083280, sha256: 'a5ee7a88a1bf7e6fb7378ffbdb680f6ef8a51272a551c0f739d92897d5d10b73' },
  },
};

export const helperUrl = (file) => `https://github.com/chadgpttop666/pdf/releases/download/helper-v${HELPER_RELEASE.version}/${file.name}`;
