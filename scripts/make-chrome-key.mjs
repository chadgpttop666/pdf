// Постоянный ID расширения в Chrome. У распакованного расширения без ключа
// ID зависит от папки — переложили папку, и библиотека (закладки, заметки,
// голоса) осталась у «другого» расширения. С открытым ключом в манифесте
// (поле key) ID один на всех компьютерах: на него же ускоритель выдаёт
// разрешение (allowed_origins) и по нему находит папку для обновлений.
//
// Закрытый ключ не нужен и не хранится: распакованному расширению Chrome
// подпись не проверяет. Запускается один раз; ключ — в chrome/key.txt.
// Повторный запуск сменил бы ID — поэтому файл не перезаписывается.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(root, 'chrome', 'key.txt');

/** ID расширения по ключу — как его считает Chrome: SHA-256, 32 знака a–p. */
export function chromeExtensionId(keyBase64) {
  const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex');
  return [...digest.slice(0, 32)].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join('');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (existsSync(file)) {
    console.error('chrome/key.txt уже есть — новый ключ сменил бы ID расширения');
    process.exit(1);
  }
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(file, `${key}\n`);
  console.log(chromeExtensionId(key));
}
