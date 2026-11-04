// Одно имя для API расширений во всех браузерах. Firefox даёт его как
// browser.*, Chrome и Edge — как chrome.*; в Manifest V3 chrome.* тоже
// отвечает обещаниями, поэтому для нашего кода достаточно одного имени.
// Подключается первым: на страницах расширения — обычным <script>, в фоновом
// service worker Chrome — первым import, на сайтах — первым файлом скрипта.
// На обычной веб-странице (вьюер по http в режиме отладки) chrome.runtime.id
// нет — и browser не появляется, как и раньше.
if (typeof globalThis.browser === 'undefined' && globalThis.chrome?.runtime?.id) {
  globalThis.browser = globalThis.chrome;
}
