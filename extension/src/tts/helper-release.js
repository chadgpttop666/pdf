// Сборка ускорителя (native/), которую расширение ставит и обновляет. Её
// собирает GitHub Actions (.github/workflows/helper.yml) и выкладывает в
// релиз helper-v<версия>; размер и SHA-256 здесь — чтобы поставить ровно её.
// Пустой sha256 — сборки для этой системы ещё нет.

export const HELPER_RELEASE = {
  version: '1.3.0',
  files: {
    win: { name: 'pdf-reader-tts.exe', size: 20793856, sha256: '367616658fbd9f6b0650d4c67298a7347c84487f31a140b74598d8ecfa7aedd7' },
    linux: { name: 'pdf-reader-tts-linux', size: 31431632, sha256: 'c460f228f5f88023bc6837016678d9485dbaf5919b62d9296ba495c4d07478bd' },
  },
};

export const helperUrl = (file) => `https://github.com/chadgpttop666/pdf/releases/download/helper-v${HELPER_RELEASE.version}/${file.name}`;
