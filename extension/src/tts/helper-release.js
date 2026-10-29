// Сборка ускорителя (native/), которую расширение ставит и обновляет. Её
// собирает GitHub Actions (.github/workflows/helper.yml) и выкладывает в
// релиз helper-v<версия>; размер и SHA-256 здесь — чтобы поставить ровно её.
// Пустой sha256 — сборки для этой системы ещё нет.

export const HELPER_RELEASE = {
  version: '1.0.0',
  files: {
    win: { name: 'pdf-reader-tts.exe', size: 19011072, sha256: 'a0bafd10262801f9557c2c62781dc3e3c78c8159c1cf7064bcd44c90efdc38d3' },
    linux: { name: 'pdf-reader-tts-linux', size: 30082544, sha256: 'eac7a3efaff2261aa84acce172c4bf542836c0f5c26525b23a0aaf6faf9058bb' },
  },
};

export const helperUrl = (file) => `https://github.com/chadgpttop666/pdf/releases/download/helper-v${HELPER_RELEASE.version}/${file.name}`;
