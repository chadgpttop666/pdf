// FB2 → блоки книги для вёрстки (layout.js): заголовки разделов, абзацы,
// стихи, эпиграфы, цитаты, картинки и сноски.
//
// Сноски (<a type="note">) получают номера по порядку первого упоминания,
// их текст — из тела notes/comments; в тексте — надстрочный номер.

const XLINK = /(?:^|:)href$/;

/** Текст файла в его кодировке (FB2 часто в windows-1251). */
export function decodeXml(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 300));
  const declared = head.match(/encoding\s*=\s*["']([\w.:-]+)["']/i)?.[1];
  let encoding = declared || 'utf-8';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = 'utf-8';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function parseXml(text, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type);
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) throw new Error(`файл повреждён: ${error.textContent.split('\n')[0].slice(0, 120)}`);
  return doc;
}

const elements = (node) => [...node.childNodes].filter((child) => child.nodeType === 1);
const named = (node, name) => elements(node).filter((child) => child.localName === name);
const first = (node, name) => (node ? named(node, name)[0] ?? null : null);
const hrefOf = (node) => [...(node.attributes ?? [])].find((attribute) => XLINK.test(attribute.name))?.value ?? '';
const clean = (text) => text.replace(/\s+/g, ' ');

/**
 * @param bytes содержимое .fb2
 * @param toJpeg async (blob) => { bytes, width, height } | null — картинка для PDF
 * @returns {Promise<{ title, author, lang, cover, blocks, notes }>}
 */
export async function parseFb2(bytes, { toJpeg = async () => null } = {}) {
  const doc = parseXml(decodeXml(bytes));
  const root = doc.documentElement;
  if (root.localName !== 'FictionBook') throw new Error('это не FB2');

  const description = first(root, 'description');
  const titleInfo = first(description, 'title-info');
  const title = clean(first(titleInfo, 'book-title')?.textContent ?? '').trim();
  const authors = titleInfo
    ? named(titleInfo, 'author').map((author) =>
        ['first-name', 'middle-name', 'last-name']
          .map((part) => clean(first(author, part)?.textContent ?? '').trim())
          .filter(Boolean)
          .join(' ') || clean(first(author, 'nickname')?.textContent ?? '').trim()
      )
    : [];
  const lang = clean(first(titleInfo, 'lang')?.textContent ?? '').trim() || 'ru';

  // Картинки — в <binary id>.
  const binaries = new Map(
    named(root, 'binary').map((binary) => [binary.getAttribute('id'), { type: binary.getAttribute('content-type') || 'image/jpeg', data: binary.textContent }])
  );
  async function picture(href) {
    const binary = binaries.get(href.replace(/^#/, ''));
    if (!binary) return null;
    try {
      const raw = Uint8Array.from(atob(binary.data.replace(/\s+/g, '')), (char) => char.charCodeAt(0));
      return await toJpeg(new Blob([raw], { type: binary.type }));
    } catch {
      return null;
    }
  }

  const bodies = named(root, 'body');
  const isNotes = (body) => /^(notes|comments|footnotes)$/i.test(body.getAttribute('name') ?? '');
  const main = bodies.filter((body) => !isNotes(body));
  // Тексты сносок: элемент с id в телах notes/comments.
  const noteTargets = new Map();
  for (const body of bodies.filter(isNotes)) {
    for (const node of body.getElementsByTagName('*')) {
      const id = node.getAttribute('id');
      if (id) noteTargets.set(id, node);
    }
  }
  const noteNumbers = new Map(); // id → номер
  const notes = [];

  /** Строчные куски абзаца: жирный, курсив, знаки сносок. */
  function runsOf(node, style = {}) {
    const runs = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.data) runs.push({ text: child.data, ...style });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const name = child.localName;
      if (name === 'a') {
        const id = hrefOf(child).replace(/^#/, '');
        if (noteTargets.has(id) || child.getAttribute('type') === 'note') {
          if (!noteTargets.has(id)) {
            runs.push(...runsOf(child, style));
            continue;
          }
          let numberOf = noteNumbers.get(id);
          if (!numberOf) {
            numberOf = notes.length + 1;
            noteNumbers.set(id, numberOf);
            notes.push(id);
          }
          runs.push({ text: String(numberOf), sup: true, ...style, bold: false, italic: false });
          continue;
        }
        runs.push(...runsOf(child, style));
      } else if (name === 'strong') runs.push(...runsOf(child, { ...style, bold: true }));
      else if (name === 'emphasis') runs.push(...runsOf(child, { ...style, italic: !style.italic }));
      else if (name === 'image') continue;
      else runs.push(...runsOf(child, style));
    }
    return runs;
  }

  const blocks = [];
  const hasText = (runs) => runs.some((run) => run.text.trim());

  async function walkPoem(poem, depth) {
    for (const child of elements(poem)) {
      const name = child.localName;
      if (name === 'title') for (const p of named(child, 'p')) blocks.push({ type: 'paragraph', style: 'subtitle', runs: runsOf(p) });
      else if (name === 'epigraph') await walkEpigraph(child);
      else if (name === 'stanza') {
        for (const line of elements(child)) {
          if (line.localName === 'v') blocks.push({ type: 'verse', runs: runsOf(line) });
          else if (line.localName === 'title' || line.localName === 'subtitle') blocks.push({ type: 'paragraph', style: 'subtitle', runs: runsOf(line) });
        }
        blocks.push({ type: 'gap' });
      } else if (name === 'text-author') blocks.push({ type: 'paragraph', style: 'right', runs: runsOf(child, { italic: true }) });
      else if (name === 'date') blocks.push({ type: 'paragraph', style: 'right', runs: runsOf(child) });
    }
    void depth;
  }

  async function walkEpigraph(epigraph) {
    for (const child of elements(epigraph)) {
      if (child.localName === 'p') blocks.push({ type: 'paragraph', style: 'epigraph', runs: runsOf(child) });
      else if (child.localName === 'poem') {
        for (const stanza of named(child, 'stanza')) for (const v of named(stanza, 'v')) blocks.push({ type: 'paragraph', style: 'epigraph', runs: runsOf(v) });
      } else if (child.localName === 'text-author') blocks.push({ type: 'paragraph', style: 'epigraph', runs: runsOf(child, { bold: true }) });
      else if (child.localName === 'empty-line') blocks.push({ type: 'gap' });
    }
    blocks.push({ type: 'gap' });
  }

  async function walk(node, depth) {
    for (const child of elements(node)) {
      const name = child.localName;
      if (name === 'title') {
        const lines = named(child, 'p').map((p) => runsOf(p)).filter(hasText);
        if (!lines.length) continue;
        // Строки заголовка — в одну («Глава I. Название»).
        const runs = lines.flatMap((line, i) => (i ? [{ text: '. ' }, ...line] : line));
        blocks.push({ type: 'heading', level: depth, runs });
      } else if (name === 'section') await walk(child, depth + 1);
      else if (name === 'p') blocks.push({ type: 'paragraph', runs: runsOf(child) });
      else if (name === 'subtitle') blocks.push({ type: 'paragraph', style: 'subtitle', runs: runsOf(child) });
      else if (name === 'empty-line') blocks.push({ type: 'gap' });
      else if (name === 'epigraph') await walkEpigraph(child);
      else if (name === 'poem') await walkPoem(child, depth);
      else if (name === 'cite') {
        for (const part of elements(child)) {
          if (part.localName === 'p') blocks.push({ type: 'paragraph', style: 'cite', runs: runsOf(part) });
          else if (part.localName === 'poem') await walkPoem(part, depth);
          else if (part.localName === 'text-author') blocks.push({ type: 'paragraph', style: 'right', runs: runsOf(part, { italic: true }) });
          else if (part.localName === 'empty-line') blocks.push({ type: 'gap' });
        }
      } else if (name === 'image') {
        const jpeg = await picture(hrefOf(child));
        if (jpeg) blocks.push({ type: 'image', jpeg });
      } else if (name === 'table') {
        for (const row of named(child, 'tr')) {
          const cells = elements(row).map((cell) => runsOf(cell));
          const runs = cells.flatMap((cell, i) => (i ? [{ text: ' | ' }, ...cell] : cell));
          blocks.push({ type: 'paragraph', style: 'cite', runs });
        }
      }
    }
  }

  for (const body of main) {
    // Заголовок тела — обычно автор и название, их уже есть на титуле.
    for (const child of elements(body)) {
      if (child.localName === 'title') continue;
      if (child.localName === 'epigraph') await walkEpigraph(child);
      else if (child.localName === 'image') {
        const jpeg = await picture(hrefOf(child));
        if (jpeg) blocks.push({ type: 'image', jpeg });
      } else if (child.localName === 'section') await walk(child, 0);
      else await walk({ childNodes: [child] }, 0);
    }
  }

  // Тексты сносок по порядку номеров: абзацы без заголовка-номера.
  const noteTexts = notes.map((id) => {
    const target = noteTargets.get(id);
    const paragraphs = [...target.getElementsByTagName('p')].filter((p) => p.parentNode?.localName !== 'title').map((p) => runsOf(p));
    const list = paragraphs.length ? paragraphs : [runsOf(target)];
    return list.filter(hasText);
  });

  const coverHref = hrefOf(first(first(titleInfo, 'coverpage'), 'image') ?? {});
  const cover = coverHref ? await picture(coverHref) : null;
  return { title, author: authors.filter(Boolean).join(', '), lang, cover, blocks: blocks.filter((block) => !block.runs || hasText(block.runs)), notes: noteTexts };
}
