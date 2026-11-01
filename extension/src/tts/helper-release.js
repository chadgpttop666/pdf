// Сборка ускорителя (native/), которую расширение ставит и обновляет. Её
// собирает GitHub Actions (.github/workflows/helper.yml) и выкладывает в
// релиз helper-v<версия>; размер и SHA-256 здесь — чтобы поставить ровно её.
// Пустой sha256 — сборки для этой системы ещё нет.

export const HELPER_RELEASE = {
  version: '1.2.2',
  files: {
    win: { name: 'pdf-reader-tts.exe', size: 20729344, sha256: '272901cc49d282bc89b5364563de19df800fd82dd1d072f57e4d9ccdfb2c512e' },
    linux: { name: 'pdf-reader-tts-linux', size: 31388080, sha256: '06d00c8f56ab651339de87a8742a177a8c53282b7819cfa49f9dcf94dc6620aa' },
  },
};

export const helperUrl = (file) => `https://github.com/chadgpttop666/pdf/releases/download/helper-v${HELPER_RELEASE.version}/${file.name}`;
