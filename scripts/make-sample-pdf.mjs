// Генератор тестового PDF без внешних зависимостей: восемь страниц связного
// текста плюс оглавление — этого хватает, чтобы гонять рендер, поиск,
// извлечение текста и панель оглавления в смоук-тестах.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'tests', 'fixtures', 'sample.pdf');

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN_X = 72;
const TOP = 770;
const LEADING = 16;

const chapters = [
  {
    title: 'Chapter 1. Scrolling by screen',
    body: `A reader that moves by full pages fights the way people actually read on a display.
The eye finishes a line near the bottom edge and expects the next line to appear a moment later.
This viewer therefore scrolls by exactly one viewport height minus a small overlap.
The overlap keeps the last line of the previous screen visible, so nothing is lost at the seam.
Speed matters as much as distance. A steady drift of forty pixels per second suits dense prose.
Diagrams and tables usually want a slower pace, while a familiar chapter can run twice as fast.
Every setting here is remembered per document, because a textbook and a novel need different rhythms.`,
  },
  {
    title: 'Chapter 2. Speaking the text aloud',
    body: `Speech synthesis turns a long document into something you can follow while doing other things.
The text layer of a PDF is a soup of positioned glyph runs, not sentences, so it must be rebuilt first.
Runs are grouped into lines by their vertical position, lines into paragraphs by their spacing.
Only then can the text be split into sentences that a synthesizer can pronounce naturally.
Each sentence is spoken as its own utterance, which keeps pausing and resuming responsive.
The sentence being read is highlighted, and the page follows it without jerking the view.
Clicking any word starts reading from that point, which is how you resume after a distraction.`,
  },
  {
    title: 'Chapter 3. Comfort of the eye',
    body: `White paper glowing at full brightness is the most common complaint about reading on screens.
Inverting the rendered page is cheap and effective, but it also inverts photographs and diagrams.
A hue rotation after the inversion restores most colours to something close to the original.
Sepia tinting suits long evening sessions better than pure grey, at least for most readers.
Wide margins waste a third of a narrow window, so the viewer detects and trims them automatically.
The trim is computed once from a sample of pages, which keeps the layout stable while scrolling.
Manual sliders remain available, because automatic detection cannot know what you consider margin.`,
  },
];

const escape = (s) => s.replace(/([\\()])/g, '\\$1');

function wrap(text, width = 78) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      if (line && (line + ' ' + word).length > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + ' ' + word : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function pageContent(pageNumber, heading, lines) {
  const parts = [];
  if (heading) {
    parts.push(
      'BT',
      '/F2 18 Tf',
      `1 0 0 1 ${MARGIN_X} ${TOP} Tm`,
      `(${escape(heading)}) Tj`,
      'ET'
    );
  }
  const bodyTop = heading ? TOP - 40 : TOP;
  parts.push('BT', '/F1 11 Tf', `${LEADING} TL`, `1 0 0 1 ${MARGIN_X} ${bodyTop} Tm`);
  lines.forEach((line, i) => {
    if (i > 0) parts.push('T*');
    parts.push(`(${escape(line)}) Tj`);
  });
  parts.push('ET');
  parts.push(
    'BT',
    '/F1 9 Tf',
    `1 0 0 1 ${PAGE_W / 2 - 20} 40 Tm`,
    `(Page ${pageNumber}) Tj`,
    'ET'
  );
  return parts.join('\n');
}

// Каждая глава занимает ровно две страницы: первая с заголовком, вторая — продолжение.
const pages = [];
for (const chapter of chapters) {
  const lines = wrap(chapter.body);
  const repeated = [...lines, '', ...lines, '', ...lines];
  pages.push({ heading: chapter.title, lines: repeated.slice(0, 30), chapterStart: true });
  pages.push({ heading: '', lines: repeated.slice(30, 62), chapterStart: false });
}
pages.push({
  heading: 'Appendix A. Keyboard shortcuts',
  lines: wrap(
    `Space scrolls one screen down and shift with space scrolls one screen up.
The letter a toggles automatic scrolling, and the bracket keys change its speed.
The letter s starts and stops speech, while the comma and period skip sentences.`
  ),
  chapterStart: true,
});
pages.push({ heading: '', lines: wrap('End of the sample document.'), chapterStart: false });

const objects = [];
const addObject = (body) => {
  objects.push(body);
  return objects.length; // номер объекта = индекс + 1
};

const catalogId = addObject(null); // 1, заполним позже
const pagesId = addObject(null); // 2
const fontRegularId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const fontBoldId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

const pageIds = [];
pages.forEach((page, index) => {
  const stream = pageContent(index + 1, page.heading, page.lines);
  const contentId = addObject(
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  );
  pageIds.push(
    addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`
    )
  );
});

const outlineTargets = pages
  .map((page, index) => ({ page, index }))
  .filter(({ page }) => page.chapterStart);
const outlinesId = addObject(null);
const itemIds = outlineTargets.map(() => addObject(null));
outlineTargets.forEach(({ page, index }, i) => {
  const parts = [
    `<< /Title (${escape(page.heading)})`,
    `/Parent ${outlinesId} 0 R`,
    `/Dest [${pageIds[index]} 0 R /XYZ 0 ${PAGE_H} null]`,
  ];
  if (i > 0) parts.push(`/Prev ${itemIds[i - 1]} 0 R`);
  if (i < itemIds.length - 1) parts.push(`/Next ${itemIds[i + 1]} 0 R`);
  parts.push('>>');
  objects[itemIds[i] - 1] = parts.join(' ');
});

objects[outlinesId - 1] =
  `<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds[itemIds.length - 1]} 0 R /Count ${itemIds.length} >>`;
objects[pagesId - 1] =
  `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
objects[catalogId - 1] =
  `<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outlinesId} 0 R /PageMode /UseOutlines >>`;

let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefOffset = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) {
  pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, Buffer.from(pdf, 'latin1'));
console.log(`sample: ${pages.length} страниц → ${out}`);
