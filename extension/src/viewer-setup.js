// Сборка ядра просмотра на компонентах pdf.js: они дают виртуализацию
// страниц, текстовый слой, ссылки и поиск, а весь интерфейс — наш.

import * as pdfjsLib from '../vendor/pdf.mjs';
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
  SpreadMode,
} from '../vendor/pdf_viewer.mjs';
import { assetUrl } from './platform.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = assetUrl('../vendor/pdf.worker.mjs');

export const pdfjs = pdfjsLib;
export { ScrollMode, SpreadMode };

/** Ресурсы pdf.js, без которых часть документов рендерится с ошибками. */
export const documentResources = {
  cMapUrl: assetUrl('../vendor/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('../vendor/standard_fonts/'),
  wasmUrl: assetUrl('../vendor/wasm/'),
  iccUrl: assetUrl('../vendor/iccs/'),
};

export function createViewer({ container, viewerEl }) {
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer',
  });
  const findController = new PDFFindController({ eventBus, linkService });

  const pdfViewer = new PDFViewer({
    container,
    viewer: viewerEl,
    eventBus,
    linkService,
    findController,
    textLayerMode: 1, // текстовый слой нужен для выделения, поиска и озвучки
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
    annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
    imageResourcesPath: assetUrl('../vendor/images/'),
  });

  linkService.setViewer(pdfViewer);
  pdfViewer.scrollMode = ScrollMode.VERTICAL;
  pdfViewer.spreadMode = SpreadMode.NONE;

  return { eventBus, linkService, findController, pdfViewer, container, viewerEl };
}
