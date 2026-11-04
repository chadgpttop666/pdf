// Свой небольшой генератор PDF — для книг FB2 и EPUB: читалка устроена
// вокруг PDF (поиск, озвучка, выделения, статистика), поэтому книгу проще
// один раз сверстать в PDF, чем учить всё это второму формату.
//
// Текст — шрифтом TrueType (CIDFontType2): у каждого символа свой номер
// (CID) и запись в ToUnicode — так pdf.js извлекает из страницы ровно тот
// текст, что набран, со всеми «ё» и знаками. Шрифт вкладывается целиком.
// Без меток времени: одна и та же книга даёт один и тот же PDF.

const encoder = new TextEncoder();

/** Сжать zlib (FlateDecode). */
export async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const number = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, ''));

/** Строка PDF в UTF-16BE: названия, оглавление. */
export function pdfText(text) {
  let hex = 'FEFF';
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code > 0xffff) {
      const value = code - 0x10000;
      hex += (0xd800 + (value >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (value & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += code.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

const hex4 = (value) => value.toString(16).toUpperCase().padStart(4, '0');

/** Юникод символа → UTF-16BE для ToUnicode. */
function utf16(code) {
  if (code <= 0xffff) return hex4(code);
  const value = code - 0x10000;
  return hex4(0xd800 + (value >> 10)) + hex4(0xdc00 + (value & 0x3ff));
}

// Пробелы, которых в шрифте может не быть, — обычным пробелом.
const SPACES = /[ -   ]/gu;

/** Шрифт в документе: символы получают номера по мере набора. */
export function createFont(key, ttf) {
  const cids = new Map(); // код символа → CID
  const codes = [0]; // CID → код символа
  return {
    key,
    ttf,
    /** Номера символов строки (2 байта на символ) и её ширина в долях кегля. */
    encode(text) {
      let hex = '';
      let width = 0;
      for (const char of text.replace(SPACES, ' ')) {
        const code = char.codePointAt(0);
        let cid = cids.get(code);
        if (cid == null) {
          cid = codes.length;
          codes.push(code);
          cids.set(code, cid);
        }
        hex += hex4(cid);
        width += ttf.advance(ttf.glyphOf(code)) / ttf.unitsPerEm;
      }
      return { hex, width };
    },
    width(text) {
      let width = 0;
      for (const char of text.replace(SPACES, ' ')) width += ttf.advance(ttf.glyphOf(char.codePointAt(0))) / ttf.unitsPerEm;
      return width;
    },
    codes,
  };
}

/**
 * Объекты шрифта Type0 (CIDFontType2, Identity-H, ToUnicode) — для книги и
 * для оформления текстовых заметок (annotation-appearance.js).
 * @param font createFont(): номера символов уже набраны
 * @param write { reserve() → { id }, put(entry, dict), putStream(entry, dict, bytes) }
 * @param into заранее выделенный объект для самого шрифта — если на него уже ссылаются
 * @returns номер объекта Type0
 */
export async function writeType0Font(font, name, { reserve, put, putStream }, into = null) {
  const { ttf, codes } = font;
  const base = name.replace(/[^A-Za-z0-9-]/g, '');
  const file = reserve();
  await putStream(file, `/Length1 ${ttf.bytes.length}`, ttf.bytes);
  const flags = (ttf.italicAngle ? 64 : 0) | 32 | 2;
  const scale = 1000 / ttf.unitsPerEm;
  const descriptor = reserve();
  put(
    descriptor,
    `<< /Type /FontDescriptor /FontName /${base} /Flags ${flags} /FontBBox [${ttf.bbox.map((v) => Math.round(v * scale)).join(' ')}] ` +
      `/ItalicAngle ${number(ttf.italicAngle)} /Ascent ${Math.round(ttf.ascent * scale)} /Descent ${Math.round(ttf.descent * scale)} ` +
      `/CapHeight ${Math.round(ttf.capHeight * scale)} /StemV ${ttf.weight >= 600 ? 140 : 80} /FontFile2 ${file.id} 0 R >>`
  );
  // CID → глиф.
  const map = new Uint8Array(codes.length * 2);
  codes.forEach((code, cid) => {
    const glyph = cid ? ttf.glyphOf(code) : 0;
    map[cid * 2] = glyph >> 8;
    map[cid * 2 + 1] = glyph & 0xff;
  });
  const cidToGid = reserve();
  await putStream(cidToGid, '', map);
  const widths = codes.slice(1).map((code) => Math.round(ttf.advance(ttf.glyphOf(code)) * scale));
  const cidFont = reserve();
  put(
    cidFont,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${descriptor.id} 0 R /CIDToGIDMap ${cidToGid.id} 0 R /DW 500 /W [1 [${widths.join(' ')}]] >>`
  );
  // CID → Юникод: из этого pdf.js берёт текст страницы.
  const lines = [];
  for (let start = 1; start < codes.length; start += 100) {
    const chunk = codes.slice(start, start + 100);
    lines.push(`${chunk.length} beginbfchar`, ...chunk.map((code, i) => `<${hex4(start + i)}> <${utf16(code)}>`), 'endbfchar');
  }
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...lines,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  const toUnicode = reserve();
  await putStream(toUnicode, '', encoder.encode(cmap));
  const type0 = into ?? reserve();
  put(type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [${cidFont.id} 0 R] /ToUnicode ${toUnicode.id} 0 R >>`);
  return type0.id;
}

/**
 * @param fonts { ключ: разобранный TTF (ttf.js) } — например regular, italic, bold
 * @param info { title, author, lang }
 */
export function createPdf({ fonts, info = {} }) {
  const fontList = Object.entries(fonts).map(([key, ttf], i) => ({ name: `F${i + 1}`, font: createFont(key, ttf) }));
  const fontByKey = new Map(fontList.map((entry) => [entry.font.key, entry]));
  const pages = [];
  const images = [];
  const outline = [];

  function fontEntry(key) {
    const entry = fontByKey.get(key);
    if (!entry) throw new Error(`нет шрифта ${key}`);
    return entry;
  }

  return {
    /** Ширина строки в пунктах. */
    measure(key, size, text) {
      return fontEntry(key).font.width(text) * size;
    },

    /** Метрики шрифта в долях кегля: над и под строкой. */
    metrics(key) {
      const { ttf } = fontEntry(key).font;
      return { ascent: ttf.ascent / ttf.unitsPerEm, descent: -ttf.descent / ttf.unitsPerEm };
    },

    /** Картинка JPEG: вернёт имя для page.image. */
    addJpeg(bytes, width, height) {
      const name = `Im${images.length + 1}`;
      images.push({ name, bytes, width, height });
      return { name, width, height };
    },

    addPage(width, height) {
      const ops = [];
      const used = { fonts: new Set(), images: new Set() };
      const page = {
        width,
        height,
        index: pages.length,
        /**
         * Строка текста: x, y — начало базовой линии (от левого нижнего угла).
         * gaps — сколько пунктов добавить после каждого пробела (выключка по ширине).
         */
        text(key, size, x, y, text, { gaps = 0 } = {}) {
          const { name, font } = fontEntry(key);
          used.fonts.add(name);
          ops.push(`BT /${name} ${number(size)} Tf 1 0 0 1 ${number(x)} ${number(y)} Tm`);
          if (gaps && text.includes(' ')) {
            // Выключка: после каждого пробела — сдвиг вправо (TJ в тысячных кегля).
            const parts = text.split(' ');
            const shift = number(-(gaps / size) * 1000);
            const items = parts.map((part, i) => `<${font.encode(i < parts.length - 1 ? `${part} ` : part).hex}>`);
            ops.push(`[${items.join(` ${shift} `)}] TJ ET`);
          } else {
            ops.push(`<${font.encode(text).hex}> Tj ET`);
          }
        },
        image(image, x, y, width, height) {
          used.images.add(image.name);
          ops.push(`q ${number(width)} 0 0 ${number(height)} ${number(x)} ${number(y)} cm /${image.name} Do Q`);
        },
        /** Тонкая линия — например, отбивка над примечаниями. */
        line(x1, y1, x2, y2, width = 0.5) {
          ops.push(`q ${number(width)} w 0.6 G ${number(x1)} ${number(y1)} m ${number(x2)} ${number(y2)} l S Q`);
        },
        ops,
        used,
      };
      pages.push(page);
      return page;
    },

    /** Пункт оглавления: level с 0, y — высота заголовка на странице. */
    addOutline(title, level, page, y) {
      outline.push({ title, level, page: page.index, y });
    },

    get pageCount() {
      return pages.length;
    },

    /** Собрать файл. */
    async save() {
      const objects = []; // { id, parts: (string|Uint8Array)[] }
      const reserve = () => {
        const entry = { id: objects.length + 1, parts: null };
        objects.push(entry);
        return entry;
      };
      const put = (entry, dict) => {
        entry.parts = [dict];
        return entry.id;
      };
      const putStream = async (entry, dict, bytes, { compress = true } = {}) => {
        const data = compress ? await deflate(bytes) : bytes;
        const filter = compress ? ' /Filter /FlateDecode' : '';
        entry.parts = [`<< ${dict}${filter} /Length ${data.length} >>\nstream\n`, data, '\nendstream'];
        return entry.id;
      };

      const catalog = reserve();
      const pagesRoot = reserve();
      const outlineRoot = outline.length ? reserve() : null;
      const infoEntry = reserve();

      // Шрифты — только те, что пригодились.
      const usedFonts = new Set(pages.flatMap((page) => [...page.used.fonts]));
      const fontRefs = {};
      for (const { name, font } of fontList) {
        if (!usedFonts.has(name)) continue;
        fontRefs[name] = await writeType0Font(font, `PTSerif-${font.key}`, { reserve, put, putStream });
      }

      const imageRefs = {};
      for (const image of images) {
        const entry = reserve();
        await putStream(
          entry,
          `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
          image.bytes,
          { compress: false }
        );
        imageRefs[image.name] = entry.id;
      }

      const pageIds = [];
      for (const page of pages) {
        const content = reserve();
        await putStream(content, '', encoder.encode(page.ops.join('\n')));
        const fontsDict = [...page.used.fonts].map((name) => `/${name} ${fontRefs[name]} 0 R`).join(' ');
        const imagesDict = [...page.used.images].map((name) => `/${name} ${imageRefs[name]} 0 R`).join(' ');
        const resources = `<< ${fontsDict ? `/Font << ${fontsDict} >>` : ''} ${imagesDict ? `/XObject << ${imagesDict} >>` : ''} >>`;
        const entry = reserve();
        put(
          entry,
          `<< /Type /Page /Parent ${pagesRoot.id} 0 R /MediaBox [0 0 ${number(page.width)} ${number(page.height)}] /Resources ${resources} /Contents ${content.id} 0 R >>`
        );
        pageIds.push(entry.id);
      }
      put(pagesRoot, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

      if (outlineRoot) {
        // Плоский список с уровнями → дерево.
        const nodes = outline.map((item) => ({ ...item, entry: reserve(), children: [], parent: null }));
        const roots = [];
        const stack = [];
        for (const node of nodes) {
          while (stack.length && stack.at(-1).level >= node.level) stack.pop();
          const parent = stack.at(-1) ?? null;
          node.parent = parent;
          (parent ? parent.children : roots).push(node);
          stack.push(node);
        }
        const count = (node) => node.children.reduce((sum, child) => sum + 1 + count(child), 0);
        const link = (list, parentId) => {
          list.forEach((node, i) => {
            const parts = [`/Title ${pdfText(node.title)}`, `/Parent ${parentId} 0 R`, `/Dest [${pageIds[node.page]} 0 R /XYZ null ${number(node.y)} null]`];
            if (i > 0) parts.push(`/Prev ${list[i - 1].entry.id} 0 R`);
            if (i < list.length - 1) parts.push(`/Next ${list[i + 1].entry.id} 0 R`);
            if (node.children.length) {
              parts.push(`/First ${node.children[0].entry.id} 0 R`, `/Last ${node.children.at(-1).entry.id} 0 R`, `/Count ${count(node)}`);
              link(node.children, node.entry.id);
            }
            put(node.entry, `<< ${parts.join(' ')} >>`);
          });
        };
        link(roots, outlineRoot.id);
        put(outlineRoot, `<< /Type /Outlines /First ${roots[0].entry.id} 0 R /Last ${roots.at(-1).entry.id} 0 R /Count ${nodes.length} >>`);
      }

      const infoParts = ['/Producer (PDF-chitalka)', '/Creator (PDF-chitalka)'];
      if (info.title) infoParts.push(`/Title ${pdfText(info.title)}`);
      if (info.author) infoParts.push(`/Author ${pdfText(info.author)}`);
      put(infoEntry, `<< ${infoParts.join(' ')} >>`);
      put(
        catalog,
        `<< /Type /Catalog /Pages ${pagesRoot.id} 0 R${outlineRoot ? ` /Outlines ${outlineRoot.id} 0 R /PageMode /UseOutlines` : ''}${info.lang ? ` /Lang (${info.lang})` : ''} >>`
      );

      // Сборка: заголовок, объекты, таблица смещений.
      const chunks = [encoder.encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')];
      let offset = chunks[0].length;
      const offsets = [];
      for (const object of objects) {
        offsets[object.id] = offset;
        const parts = [`${object.id} 0 obj\n`, ...object.parts, '\nendobj\n'].map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
        for (const part of parts) {
          chunks.push(part);
          offset += part.length;
        }
      }
      const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
      for (let id = 1; id <= objects.length; id += 1) xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
      xref.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog.id} 0 R /Info ${infoEntry.id} 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
      chunks.push(encoder.encode(xref.join('')));
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
  };
}
