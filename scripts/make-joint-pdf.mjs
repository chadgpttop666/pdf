// Две страницы, где фраза переходит со страницы на страницу, — как в
// настоящих книгах: «…которому была | поручена разработка…». На этом стыке
// озвучка должна читать одну фразу, а режим «только текст» — не превращать
// обрывок в заголовок. Плюс годы и сокращения для нейроголоса.
//
// Нужен LibreOffice (soffice). Готовый файл лежит в репозитории.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'tests', 'fixtures', 'joint.pdf');

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Стык страниц</title>
<style>
  @page { size: A5; margin: 2cm; }
  body { font-family: 'Liberation Serif', 'DejaVu Serif', serif; font-size: 12pt; }
  p { text-align: justify; text-indent: 1cm; margin: 0; line-height: 1.15; }
  .next { text-indent: 0; page-break-before: always; }
</style></head>
<body>
<p>С осени 1945 по конец 1946 года Эрхард был министром хозяйства Баварии; в 1947 году — профессором университета.</p>
<p>Вскоре он возглавил «Особый отдел по вопросам денег и кредита», которому была</p>
<p class="next">поручена разработка проекта денежной реформы, осуществленной затем оккупационными властями. Весной 1948 года он стал директором Управления хозяйства (т. е. трех западных зон).</p>
</body></html>`;

const workdir = mkdtempSync(join(tmpdir(), 'reader-joint-'));
const source = join(workdir, 'joint.html');
writeFileSync(source, html);
execFileSync(
  'soffice',
  ['--headless', '--infilter=HTML (StarWriter)', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', workdir, source],
  { stdio: 'ignore' }
);
copyFileSync(join(workdir, 'joint.pdf'), out);
console.log(`joint: ${out}`);
