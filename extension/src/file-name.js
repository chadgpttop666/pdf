// Имя документа — для кнопки «Скачать», заголовка вкладки и списка недавних.
//
// Сайты часто отдают PDF по адресу вида /download.php?id=123 или /files/8f2a9c,
// и хвост адреса — не имя, а мусор. Настоящее имя сервер сообщает в заголовке
// Content-Disposition; если его нет, лучше подходит название из свойств PDF.
// Модуль общий для фоновой страницы и вьюера, без DOM.

/**
 * Строка из байтов, прочитанных как Latin-1, но на деле UTF-8: так
 * заголовки с русским именем часто приходят от серверов, которые не
 * кодируют его по RFC 5987. Если байты — не UTF-8, строка остаётся как есть.
 */
function fixMojibake(text) {
  if (!/[\u0080-ÿ]/.test(text) || /[^\u0000-ÿ]/.test(text)) return text;
  try {
    const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

/** «%D0%9A…» → байты; прочие символы берутся как есть. */
function percentBytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '%' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function decodePercent(text) {
  if (!/%[0-9a-f]{2}/i.test(text)) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Убрать путь, кавычки и запрещённые в Windows символы. */
function tidy(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return base.replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Имя файла из Content-Disposition. filename* (RFC 5987, с кодировкой)
 * важнее обычного filename.
 * @returns {string|null}
 */
export function filenameFromContentDisposition(header) {
  if (!header) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    const [, charset, value] = extended;
    let decoded = value.trim().replace(/^"|"$/g, '');
    try {
      decoded = new TextDecoder(charset || 'utf-8', { fatal: true }).decode(percentBytes(decoded));
    } catch {
      /* битая кодировка — попробуем обычный filename */
      decoded = '';
    }
    if (tidy(decoded)) return tidy(decoded);
  }
  const plain = /(?:^|;)\s*filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]*)/i.exec(header);
  if (!plain) return null;
  const raw = plain[2] !== undefined ? plain[2].replace(/\\(.)/g, '$1') : plain[1];
  return tidy(fixMojibake(decodePercent(raw.trim()))) || null;
}

/**
 * Имя из адреса: последний сегмент пути, а если он не похож на файл —
 * параметр запроса с именем .pdf (…/get?file=Книга.pdf).
 */
export function filenameFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return tidy(decodePercent(String(url || '').split(/[?#]/)[0].split('/').pop()));
  }
  const segment = tidy(decodePercent(parsed.pathname.split('/').pop()));
  if (/\.pdf$/i.test(segment)) return segment;
  for (const value of parsed.searchParams.values()) {
    const candidate = tidy(value);
    if (/\.pdf$/i.test(candidate)) return candidate;
  }
  return segment;
}

const GENERIC_TITLES = /^(untitled|без названия|document|документ|unknown|title|pdf|null|undefined|\d+)$/i;
const OFFICE_PREFIX = /^(microsoft (word|powerpoint|excel)|libreoffice|openoffice)\s*[-–—:]\s*/i;
const OFFICE_EXTENSION = /\.(docx?|odt|rtf|pptx?|odp|xlsx?|ods|txt|html?|tex|indd)$/i;

/** Название из свойств PDF, если оно годится в имя файла. */
export function titleAsName(title) {
  const name = tidy(String(title || '').replace(OFFICE_PREFIX, '').replace(OFFICE_EXTENSION, ''));
  if (name.length < 2 || name.length > 150 || GENERIC_TITLES.test(name)) return null;
  return name;
}

/**
 * Имя документа: заголовок сервера → «…/имя.pdf» в адресе → название из
 * свойств PDF → что осталось от адреса.
 */
export function pickDocumentName({ disposition, urlName, title } = {}) {
  const fromServer = tidy(disposition);
  if (fromServer) return fromServer;
  const fromUrl = tidy(urlName);
  if (/\.pdf$/i.test(fromUrl)) return fromUrl;
  return titleAsName(title) || fromUrl || 'документ.pdf';
}
