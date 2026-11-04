// Chrome: перехват PDF правилами declarativeNetRequest.
//
// Блокирующего webRequest в Chrome нет. Правило с условием на заголовки
// ответа (Chrome 128+) делает то же, что webRequest в Firefox: смотрит на
// Content-Type и уводит страницу во вьюер раньше, чем её покажет встроенный
// просмотрщик. Адрес правило подставляет как есть, не кодируя, — вьюер берёт
// его из ?src= целиком (main.js, documentFromQuery). Имени файла из
// Content-Disposition правило не передаёт: вьюер возьмёт его из адреса или из
// свойств PDF.

export const PDF_RULE_IDS = [1, 2];

/** Правила для viewer.html расширения (chrome-extension://…/viewer.html). */
export function pdfRules(viewerUrl) {
  const action = { type: 'redirect', redirect: { regexSubstitution: `${viewerUrl}?src=\\0` } };
  // Скачивание не перехватываем: пользователь просил файл, а не чтение.
  const excludedResponseHeaders = [{ header: 'content-disposition', values: ['attachment*', 'Attachment*', 'ATTACHMENT*'] }];
  const contentType = (type) => [{ header: 'content-type', values: [type, `${type};*`, `${type} *`] }];
  return [
    {
      id: PDF_RULE_IDS[0],
      priority: 1,
      action,
      condition: {
        regexFilter: '^https?://.*$',
        resourceTypes: ['main_frame'],
        responseHeaders: contentType('application/pdf'),
        excludedResponseHeaders,
      },
    },
    {
      // Некоторые серверы отдают PDF как поток байтов — тогда смотрим на адрес.
      id: PDF_RULE_IDS[1],
      priority: 1,
      action,
      condition: {
        regexFilter: '^https?://[^?#]*\\.[pP][dD][fF]([?#].*)?$',
        resourceTypes: ['main_frame'],
        responseHeaders: contentType('application/octet-stream'),
        excludedResponseHeaders,
      },
    },
  ];
}
