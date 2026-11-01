// Первый кадр — до того, как загрузятся модули читалки (их десятки, и
// браузер успевает нарисовать страницу раньше). Тема — та же, что в прошлый
// раз; если вкладка открывает документ, стартовый экран не мелькает, а
// панели появляются на своих местах, без анимаций.
(() => {
  const app = document.getElementById('app');
  try {
    const theme = localStorage.getItem('pdf-reader-ui-theme');
    if (theme === 'light' || theme === 'dark') app.dataset.uiTheme = theme;
  } catch {
    // Хранилище недоступно — тема придёт из настроек чуть позже.
  }
  app.classList.add('booting');
  if (new URLSearchParams(location.search).has('file')) app.classList.add('opening');
})();
