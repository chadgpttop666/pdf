// Сборка ускорителя (native/), которую расширение ставит и обновляет. Её
// собирает GitHub Actions (.github/workflows/helper.yml) и выкладывает в
// релиз helper-v<версия>; размер и SHA-256 здесь — чтобы поставить ровно её.
// Пустой sha256 — сборки для этой системы ещё нет.

export const HELPER_RELEASE = {
  version: '1.5.0',
  files: {
    win: { name: 'pdf-reader-tts.exe', size: 20902400, sha256: 'a8afb5850757578b984d8d981e5ab5f06286d000d54509b690a36efb1c3ab25b' },
    linux: { name: 'pdf-reader-tts-linux', size: 31495536, sha256: '0f2e6823caad65330dee16ace21d197f69ea165f0dbdd17b68f248a5b07d5c53' },
  },
};

export const helperUrl = (file) => `https://github.com/chadgpttop666/pdf/releases/download/helper-v${HELPER_RELEASE.version}/${file.name}`;
