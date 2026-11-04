// PNG-иконки для сборки под Chrome: Chrome не принимает SVG в манифесте.
// Рисуем ту же extension/icons/icon.svg в Chromium нужных размеров и кладём
// в chrome/icons/. Запускать, когда меняется иконка: npm run icons:chrome.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const svg = readFileSync(join(root, 'extension', 'icons', 'icon.svg'), 'utf8');
const out = join(root, 'chrome', 'icons');
const SIZES = [16, 32, 48, 128];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.locator('svg').screenshot({ path: join(out, `icon-${size}.png`), omitBackground: true });
    await page.close();
    console.log(`chrome/icons/icon-${size}.png`);
  }
} finally {
  await browser.close();
}
