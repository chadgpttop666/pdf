// Фоновая страница: пока умеет только открывать вьюер по клику на иконку.
// Перехват PDF-ссылок добавляется отдельным шагом.
const viewerUrl = browser.runtime.getURL('viewer.html');

browser.action.onClicked.addListener(async () => {
  await browser.tabs.create({ url: viewerUrl });
});
