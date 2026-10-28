// Открытие документов из всех источников: адрес, выбранный файл, байты из
// локальной библиотеки. Наружу отдаёт единый объект источника, по которому
// потом считается ключ документа и заголовок окна.

import { safeFileName, saveBlob } from './dom.js';
import { filenameFromUrl, pickDocumentName } from './file-name.js';
import { documentResources, pdfjs } from './viewer-setup.js';

/**
 * @typedef {{ kind: 'url'|'file'|'bytes', name: string, url?: string,
 *             size?: number, file?: File }} DocumentSource
 */

export class DocumentLoader {
  constructor({ pdfViewer, linkService, findController, eventBus }) {
    this.pdfViewer = pdfViewer;
    this.linkService = linkService;
    this.findController = findController;
    this.eventBus = eventBus;
    this.pdfDocument = null;
    this.source = null;
    this.loadingTask = null;
  }

  /** @param {{ name?: string }} options name — имя файла от сервера, если известно */
  async openUrl(url, { name } = {}) {
    const source = {
      kind: 'url',
      url,
      name: name || filenameFromUrl(url) || 'документ.pdf',
      serverName: name || null,
    };
    return this.#open({ url, ...documentResources }, source);
  }

  async openFile(file) {
    const buffer = await file.arrayBuffer();
    const source = { kind: 'file', name: file.name, size: file.size, file };
    return this.#open({ data: new Uint8Array(buffer), ...documentResources }, source);
  }

  async openBytes(bytes, { name = 'документ.pdf', size, id } = {}) {
    // id приходит из библиотеки: пересчитывать ключ по тем же байтам незачем.
    const source = { kind: 'bytes', name, size: size ?? bytes.byteLength, id };
    return this.#open({ data: bytes, ...documentResources }, source);
  }

  async #open(params, source) {
    await this.close();
    // pdf.js отдаёт данные воркеру во владение, поэтому для копии в библиотеку
    // байты берём потом через pdfDocument.getData(), а не держим ссылку здесь.
    this.loadingTask = pdfjs.getDocument(params);
    this.loadingTask.onProgress = ({ loaded, total }) => {
      this.eventBus.dispatch('documentprogress', { source: this, loaded, total });
    };

    const pdfDocument = await this.loadingTask.promise;
    this.pdfDocument = pdfDocument;
    this.source = source;

    this.pdfViewer.setDocument(pdfDocument);
    this.linkService.setDocument(pdfDocument, null);
    this.findController.setDocument(pdfDocument);

    const info = await pdfDocument.getMetadata().catch(() => null);
    const title = info?.info?.Title?.trim();
    // Хвост адреса часто не имя, а «download.php» или хеш: берём имя от
    // сервера, а без него — название из свойств PDF. Своё имя локального
    // файла не трогаем; старые записи библиотеки с таким мусором чиним.
    if (source.kind === 'url') {
      source.name = pickDocumentName({
        disposition: source.serverName || info?.contentDispositionFilename,
        urlName: filenameFromUrl(source.url),
        title,
      });
    } else if (source.kind === 'bytes' && !/\.pdf$/i.test(source.name)) {
      source.name = pickDocumentName({ urlName: source.name, title });
    }
    this.eventBus.dispatch('documentopened', {
      source: this,
      pdfDocument,
      documentSource: source,
      title: title || source.name,
    });
    return pdfDocument;
  }

  async close() {
    this.findController?.setDocument?.(null);
    this.linkService?.setDocument?.(null);
    this.pdfViewer?.setDocument?.(null);
    const task = this.loadingTask;
    this.loadingTask = null;
    this.pdfDocument = null;
    this.source = null;
    await task?.destroy?.().catch(() => {});
  }

  /** Байты текущего документа — нужны, чтобы положить файл в библиотеку. */
  async getBytes() {
    if (!this.pdfDocument) return null;
    try {
      return await this.pdfDocument.getData();
    } catch {
      return null;
    }
  }

  /**
   * Сохранить исходный PDF на компьютер.
   * @returns {Promise<string|null>} имя файла или null, если документа нет
   */
  async download() {
    const bytes = await this.getBytes();
    if (!bytes) return null;

    const filename = downloadName(this.source?.name);
    saveBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
    return filename;
  }
}

/** Имя для сохранения: с расширением .pdf. */
export function downloadName(name) {
  const base = safeFileName(name || 'документ');
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}
