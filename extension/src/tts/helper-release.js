// Сборка ускорителя (native/), которую расширение ставит и обновляет. Её
// собирает GitHub Actions (.github/workflows/helper.yml) и выкладывает в
// релиз helper-v<версия>; размер и SHA-256 здесь — чтобы поставить ровно её.
// Пустой sha256 — сборки для этой системы ещё нет.

export const HELPER_RELEASE = {
  version: '1.4.0',
  files: {
    win: { name: 'pdf-reader-tts.exe', size: 20901376, sha256: '1f0d994217a6962fbc7bbb2ed22c64f797a04d61a9ab2c31563335cdd7b74ead' },
    linux: { name: 'pdf-reader-tts-linux', size: 31494768, sha256: 'a2728cc51da0d1d46462958e2ea18466997c34903634e3148d4a4a4ac03e4b03' },
  },
};

export const helperUrl = (file) => `https://github.com/chadgpttop666/pdf/releases/download/helper-v${HELPER_RELEASE.version}/${file.name}`;
