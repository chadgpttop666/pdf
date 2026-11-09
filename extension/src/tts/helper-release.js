// Сборка ускорителя (native/), которую расширение ставит и обновляет. Её
// собирает GitHub Actions (.github/workflows/helper.yml) и выкладывает в
// релиз helper-v<версия>; размер и SHA-256 здесь — чтобы поставить ровно её.
// Пустой sha256 — сборки для этой системы ещё нет.

export const HELPER_RELEASE = {
  version: '1.6.0',
  files: {
    win: { name: 'pdf-reader-tts.exe', size: 20976128, sha256: 'f8cb89bd0d1e8cf442120aa6533a5d3de7e6d7657127383329e46caaf67ce4d4' },
    linux: { name: 'pdf-reader-tts-linux', size: 31496080, sha256: '225702cab8d765f3ee9cceafa9c3de057cb689868e13f4d488cb95cb1392d464' },
  },
};

export const helperUrl = (file) => `https://github.com/chadgpttop666/pdf/releases/download/helper-v${HELPER_RELEASE.version}/${file.name}`;
