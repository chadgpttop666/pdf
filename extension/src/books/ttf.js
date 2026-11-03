// Разбор шрифта TrueType — ровно столько, сколько нужно, чтобы набрать им
// текст в PDF: какой глиф у буквы (cmap), его ширина (hmtx), высоты и рамка
// для описания шрифта.

const tag = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

function tables(view) {
  const count = view.getUint16(4);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    out[tag(view, at)] = { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) };
  }
  return out;
}

/** Таблица cmap: формат 12 (вся Юникода) или 4 (базовая плоскость). */
function readCmap(view, cmap) {
  const subtables = [];
  const count = view.getUint16(cmap.offset + 2);
  for (let i = 0; i < count; i += 1) {
    const at = cmap.offset + 4 + i * 8;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const offset = cmap.offset + view.getUint32(at + 4);
    subtables.push({ platform, encoding, offset, format: view.getUint16(offset) });
  }
  const map = new Map();
  const full = subtables.find((table) => table.format === 12 && (table.platform === 3 || table.platform === 0));
  if (full) {
    const groups = view.getUint32(full.offset + 12);
    for (let i = 0; i < groups; i += 1) {
      const at = full.offset + 16 + i * 12;
      const start = view.getUint32(at);
      const end = view.getUint32(at + 4);
      const glyph = view.getUint32(at + 8);
      for (let code = start; code <= end; code += 1) map.set(code, glyph + code - start);
    }
    return map;
  }
  const basic = subtables.find((table) => table.format === 4 && (table.platform === 3 || table.platform === 0));
  if (!basic) throw new Error('в шрифте нет таблицы символов Юникода');
  const at = basic.offset;
  const segments = view.getUint16(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  for (let i = 0; i < segments; i += 1) {
    const end = view.getUint16(ends + i * 2);
    const start = view.getUint16(starts + i * 2);
    const delta = view.getInt16(deltas + i * 2);
    const rangeOffset = view.getUint16(ranges + i * 2);
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      let glyph;
      if (!rangeOffset) glyph = (code + delta) & 0xffff;
      else {
        const address = ranges + i * 2 + rangeOffset + (code - start) * 2;
        glyph = view.getUint16(address);
        if (glyph) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph) map.set(code, glyph);
    }
  }
  return map;
}

/**
 * @param bytes Uint8Array с файлом .ttf
 * @returns шрифт: glyphOf(код), advance(глиф) в единицах unitsPerEm, метрики
 */
export function parseTtf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const t = tables(view);
  for (const name of ['cmap', 'head', 'hhea', 'hmtx', 'maxp']) if (!t[name]) throw new Error(`в шрифте нет таблицы ${name}`);
  const unitsPerEm = view.getUint16(t.head.offset + 18);
  const bbox = [0, 2, 4, 6].map((shift) => view.getInt16(t.head.offset + 36 + shift));
  const ascent = view.getInt16(t.hhea.offset + 4);
  const descent = view.getInt16(t.hhea.offset + 6);
  const metrics = view.getUint16(t.hhea.offset + 34);
  const glyphs = view.getUint16(t.maxp.offset + 4);
  const advances = new Uint16Array(glyphs);
  for (let i = 0; i < glyphs; i += 1) {
    advances[i] = view.getUint16(t.hmtx.offset + Math.min(i, metrics - 1) * 4);
  }
  let capHeight = Math.round(ascent * 0.7);
  let weight = 400;
  if (t['OS/2'] && t['OS/2'].length >= 90) {
    weight = view.getUint16(t['OS/2'].offset + 4);
    if (view.getUint16(t['OS/2'].offset) >= 2) capHeight = view.getInt16(t['OS/2'].offset + 88);
  }
  const italicAngle = t.post ? view.getInt32(t.post.offset + 4) / 65536 : 0;
  const cmap = readCmap(view, t.cmap);
  return {
    bytes,
    unitsPerEm,
    bbox,
    ascent,
    descent,
    capHeight,
    italicAngle,
    weight,
    /** Глиф символа; 0 — в шрифте его нет. */
    glyphOf: (code) => cmap.get(code) ?? 0,
    has: (code) => cmap.has(code),
    advance: (glyph) => advances[glyph] ?? advances[0],
  };
}
