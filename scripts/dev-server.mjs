// Мини-сервер для отладки: раздаёт extension/ как обычный сайт, чтобы
// viewer.html можно было открыть в любом браузере и прогнать смоук-тесты.
// В самом Firefox расширение работает из moz-extension:// и сервер не нужен.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionDir = join(root, 'extension');
const fixturesDir = join(root, 'tests', 'fixtures');
const port = Number(process.env.PORT || 8080);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream',
};

// Фикстуры лежат вне extension/, поэтому маппим их на отдельный префикс.
function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  if (clean.startsWith('/fixtures/')) {
    return resolve(fixturesDir, '.' + clean.slice('/fixtures'.length));
  }
  return resolve(extensionDir, '.' + (clean === '/' ? '/viewer.html' : clean));
}

const server = createServer(async (req, res) => {
  const filePath = resolvePath(req.url || '/');
  const allowed = filePath.startsWith(extensionDir) || filePath.startsWith(fixturesDir);
  if (!allowed) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': types[extname(filePath)] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(port, () => {
  console.log(`dev: http://localhost:${port}/viewer.html?file=/fixtures/sample.pdf`);
});
