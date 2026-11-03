// EPUB → блоки книги для вёрстки (layout.js). Порядок глав — по spine,
// заголовки h1…h6 — уровни оглавления, сноски — ссылки epub:type="noteref"
// (или надстрочные ссылки-номера) на элементы с текстом сноски: те уходят в
// «Примечания» в конце и из основного текста убираются.

import { decodeXml, parseXml } from './fb2.js';
import { readZip } from './unzip.js';

const elements = (node) => [...node.childNodes].filter((child) => child.nodeType === 1);
const clean = (text) => text.replace(/\s+/g, ' ');

/** Путь относительно файла: «../images/a.jpg» из «text/ch1.xhtml». */
export function resolvePath(base, href) {
  const parts = base.split('/').slice(0, -1);
  for (const part of decodeURIComponent(href.split('#')[0]).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

const epubType = (node) => (node.getAttribute?.('epub:type') ?? [...(node.attributes ?? [])].find((a) => a.localName === 'type' && a.prefix === 'epub')?.value ?? '').toLowerCase();
const NOTE_TYPES = /\b(footnote|endnote|rearnote|note)\b/;
const NOTE_REF = /^\s*[[(]?\s*(\d{1,4}|\*{1,3}|[a-zа-я])\s*[\])]?\s*$/i;
// Обратная ссылка в начале текста сноски: «1», «1.», «[1]», «↑».
const BACKLINK = /^\s*(?:[[(]?\s*(?:\d{1,4}|\*{1,3})\s*[\])]?[.)]?|[↑^])\s*$/;
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'blockquote', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'dl', 'dt', 'dd', 'aside', 'figure', 'header', 'footer', 'main', 'nav', 'pre', 'hr', 'body']);

/**
 * @param bytes содержимое .epub
 * @param toJpeg async (blob) => { bytes, width, height } | null
 */
export async function parseEpub(bytes, { toJpeg = async () => null } = {}) {
  const zip = readZip(bytes);
  const read = async (path) => {
    const entry = zip.get(path);
    if (!entry) throw new Error(`в EPUB нет ${path}`);
    return entry();
  };
  const container = parseXml(decodeXml(await read('META-INF/container.xml')));
  const opfPath = container.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('в EPUB нет описания книги');
  const opf = parseXml(decodeXml(await read(opfPath)));
  const meta = (name) => clean([...opf.getElementsByTagName('*')].find((node) => node.localName === name)?.textContent ?? '').trim();
  const title = meta('title');
  const author = [...opf.getElementsByTagName('*')].filter((node) => node.localName === 'creator').map((node) => clean(node.textContent).trim()).filter(Boolean).join(', ');
  const lang = meta('language') || 'ru';

  const manifest = new Map();
  for (const item of opf.getElementsByTagName('*')) {
    if (item.localName !== 'item') continue;
    manifest.set(item.getAttribute('id'), {
      href: resolvePath(opfPath, item.getAttribute('href') ?? ''),
      type: item.getAttribute('media-type') ?? '',
      properties: item.getAttribute('properties') ?? '',
    });
  }
  const spine = [...opf.getElementsByTagName('*')]
    .filter((node) => node.localName === 'itemref' && node.getAttribute('linear') !== 'no')
    .map((node) => manifest.get(node.getAttribute('idref')))
    .filter((item) => item && /html|xml/.test(item.type));

  const images = new Map(); // путь → jpeg | null
  async function picture(path) {
    if (!images.has(path)) {
      let jpeg = null;
      try {
        const type = [...manifest.values()].find((item) => item.href === path)?.type || 'image/jpeg';
        jpeg = await toJpeg(new Blob([await read(path)], { type }));
      } catch {
        jpeg = null;
      }
      images.set(path, jpeg);
    }
    return images.get(path);
  }

  // Обложка: properties="cover-image" или <meta name="cover">.
  const coverId = [...opf.getElementsByTagName('*')].find((node) => node.localName === 'meta' && node.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem = [...manifest.values()].find((item) => /cover-image/.test(item.properties)) ?? manifest.get(coverId);
  const cover = coverItem && /^image\//.test(coverItem.type) ? await picture(coverItem.href) : null;

  // Первый проход: документы и цели сносок.
  const documents = [];
  for (const item of spine) {
    const text = decodeXml(await read(item.href));
    let doc;
    try {
      doc = parseXml(text, 'application/xhtml+xml');
    } catch {
      doc = new DOMParser().parseFromString(text, 'text/html');
    }
    documents.push({ path: item.href, doc });
  }
  const byId = new Map();
  for (const { path, doc } of documents) {
    for (const node of doc.getElementsByTagName('*')) {
      const id = node.getAttribute('id');
      if (id) byId.set(`${path}#${id}`, node);
    }
  }
  /** Ссылка — на сноску? Возвращает её элемент с текстом. */
  function noteTarget(link, path) {
    const href = link.getAttribute('href');
    if (!href || !href.includes('#') || /^[a-z]+:/i.test(href)) return null;
    const target = byId.get(`${href.startsWith('#') ? path : resolvePath(path, href)}#${href.split('#')[1]}`);
    if (!target) return null;
    const insideSup = link.parentNode?.localName === 'sup' || link.querySelector?.('sup');
    const declared = /noteref/.test(epubType(link)) || NOTE_TYPES.test(epubType(target));
    if (!declared && !(insideSup && NOTE_REF.test(link.textContent))) return null;
    // Цель — якорь внутри абзаца: текст сноски — весь этот абзац.
    let body = target;
    while (body && !BLOCKS.has(body.localName) && body.parentNode) body = body.parentNode;
    return body;
  }

  const noteNumbers = new Map(); // элемент → номер
  const notes = [];
  const noteBodies = new Set();
  // Цели сносок — заранее, чтобы не попасть в основной текст.
  for (const { path, doc } of documents) {
    for (const link of doc.getElementsByTagName('a')) {
      const target = noteTarget(link, path);
      if (target) noteBodies.add(target);
    }
  }

  function runsOf(node, path, style = {}) {
    const runs = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.data) runs.push({ text: child.data, ...style });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const name = child.localName;
      if (name === 'a') {
        const target = noteTarget(child, path);
        if (target) {
          let numberOf = noteNumbers.get(target);
          if (!numberOf) {
            numberOf = notes.length + 1;
            noteNumbers.set(target, numberOf);
            notes.push({ target, path });
          }
          runs.push({ text: String(numberOf), sup: true });
          continue;
        }
      }
      if (name === 'sup' && [...child.getElementsByTagName('a')].some((link) => noteTarget(link, path))) {
        runs.push(...runsOf(child, path, style));
        continue;
      }
      if (name === 'br') runs.push({ text: '\n', ...style });
      else if (name === 'b' || name === 'strong') runs.push(...runsOf(child, path, { ...style, bold: true }));
      else if (name === 'i' || name === 'em' || name === 'cite') runs.push(...runsOf(child, path, { ...style, italic: !style.italic }));
      else if (name === 'script' || name === 'style' || name === 'img' || name === 'svg') continue;
      else runs.push(...runsOf(child, path, style));
    }
    return runs;
  }

  const hasText = (runs) => runs.some((run) => run.text.trim());
  const headingLevels = new Set();
  const blocks = [];

  /** Абзац; строки через <br> — отдельными строками стиха. */
  function pushParagraph(runs, style) {
    if (!hasText(runs)) return;
    if (runs.some((run) => run.text.includes('\n'))) {
      let line = [];
      const lines = [];
      for (const run of runs) {
        const parts = run.text.split('\n');
        parts.forEach((part, i) => {
          if (i > 0) {
            lines.push(line);
            line = [];
          }
          if (part) line.push({ ...run, text: part });
        });
      }
      lines.push(line);
      for (const verse of lines.filter(hasText)) blocks.push({ type: 'verse', runs: verse });
      blocks.push({ type: 'gap' });
      return;
    }
    blocks.push({ type: 'paragraph', runs, ...(style ? { style } : {}) });
  }

  async function walk(node, path, context = {}) {
    for (const child of elements(node)) {
      if (noteBodies.has(child)) continue;
      const name = child.localName;
      const type = epubType(child);
      if (/^h[1-6]$/.test(name)) {
        const level = Number(name[1]);
        headingLevels.add(level);
        const runs = runsOf(child, path, { bold: true }).map((run) => ({ ...run, text: run.text.replace(/\n/g, ' ') }));
        if (hasText(runs)) blocks.push({ type: 'heading', level, runs });
      } else if (name === 'img' || name === 'image') {
        const src = child.getAttribute('src') ?? [...child.attributes].find((a) => /href$/.test(a.name))?.value;
        const source = src ? resolvePath(path, src) : null;
        // Обложка уже на первой странице — второй раз её не ставим.
        if (source && !(cover && source === coverItem?.href)) {
          const jpeg = await picture(source);
          if (jpeg) blocks.push({ type: 'image', jpeg });
        }
      } else if (name === 'hr') blocks.push({ type: 'gap' });
      else if (name === 'blockquote') await walk(child, path, { ...context, style: 'cite' });
      else if (name === 'li') {
        const marker = child.parentNode?.localName === 'ol' ? `${[...child.parentNode.children].indexOf(child) + 1}. ` : '• ';
        const nested = elements(child).some((inner) => BLOCKS.has(inner.localName) && inner.localName !== 'li');
        if (nested) {
          blocks.push({ type: 'paragraph', style: 'cite', runs: [{ text: marker }] });
          await walk(child, path, { ...context, style: 'cite' });
        } else pushParagraph([{ text: marker }, ...runsOf(child, path)], 'cite');
      } else if (name === 'svg') {
        const imageNode = [...child.getElementsByTagName('*')].find((inner) => inner.localName === 'image');
        if (imageNode) await walk({ childNodes: [imageNode] }, path, context);
      } else if (/epigraph/.test(type) || /epigraph/i.test(child.getAttribute('class') ?? '')) {
        await walk(child, path, { ...context, style: 'epigraph' });
      } else if (['div', 'section', 'article', 'main', 'body', 'header', 'footer', 'figure', 'ul', 'ol', 'table', 'tbody', 'thead', 'tr', 'dl', 'aside', 'nav'].includes(name)) {
        if (name === 'nav' && /toc|landmarks|page-list/.test(type)) continue;
        // Блок без вложенных блоков — абзац.
        const nestedBlocks = elements(child).some((inner) => BLOCKS.has(inner.localName) || inner.localName === 'img' || inner.localName === 'svg');
        if (nestedBlocks) await walk(child, path, context);
        else pushParagraph(runsOf(child, path), context.style);
      } else if (name === 'p' || name === 'pre' || name === 'dd' || name === 'dt' || name === 'td' || name === 'th') {
        const imagesInside = [...child.getElementsByTagName('*')].filter((inner) => inner.localName === 'img' || inner.localName === 'image');
        for (const image of imagesInside) await walk({ childNodes: [image] }, path, context);
        pushParagraph(runsOf(child, path), context.style);
      } else if (!['script', 'style', 'head', 'title', 'link', 'meta'].includes(name)) {
        pushParagraph(runsOf(child, path), context.style);
      }
    }
  }

  for (const { path, doc } of documents) {
    const body = doc.getElementsByTagName('body')[0];
    if (!body) continue;
    const before = blocks.length;
    blocks.push({ type: 'pagebreak' });
    await walk(body, path);
    // Глава, от которой остались одни заголовки (например, «Примечания» без
    // своих сносок — они ушли в конец), — не нужна.
    if (!blocks.slice(before).some((block) => block.type === 'paragraph' || block.type === 'verse' || block.type === 'image')) blocks.length = before;
  }

  // Уровни заголовков: самый крупный из встреченных — глава.
  const levels = [...headingLevels].sort((a, b) => a - b);
  for (const block of blocks) if (block.type === 'heading') block.level = levels.indexOf(block.level);

  const noteTexts = notes.map(({ target, path }) => {
    const paragraphs = elements(target).filter((child) => BLOCKS.has(child.localName));
    const list = (paragraphs.length ? paragraphs : [target]).map((node) => runsOf(node, path).map((run) => ({ ...run, text: run.text.replace(/\n/g, ' ') })));
    // Обратная ссылка в начале («1.», «[1]», «↑») — не текст сноски.
    if (list[0]) {
      const head = list[0];
      while (head.length && (BACKLINK.test(head[0].text) || !head[0].text.trim())) head.shift();
      if (head[0]) head[0] = { ...head[0], text: head[0].text.replace(/^\s*(?:\[?\d{1,4}\]?[.)]?|[↑^])\s+/, '') };
    }
    return list.filter(hasText);
  });

  return { title, author, lang, cover, blocks, notes: noteTexts };
}
