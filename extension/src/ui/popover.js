// Всплывающая панель у кнопки тулбара: открывается по кнопке, закрывается
// щелчком мимо. Одновременно открыта только одна — новая закрывает прежнюю.

const openPopovers = new Set();

export function createPopover(panel, button, { onOpen } = {}) {
  const api = {
    open() {
      for (const other of openPopovers) if (other !== api) other.close();
      panel.hidden = false;
      button.classList.add('active');
      openPopovers.add(api);
      onOpen?.();
    },
    close() {
      panel.hidden = true;
      button.classList.remove('active');
      openPopovers.delete(api);
    },
    toggle(force) {
      const open = force ?? panel.hidden;
      if (open) api.open();
      else api.close();
    },
    get isOpen() {
      return !panel.hidden;
    },
  };

  button.addEventListener('click', () => api.toggle());
  document.addEventListener('pointerdown', (event) => {
    if (panel.hidden || panel.contains(event.target) || button.contains(event.target)) return;
    // Щелчок по флажку закладки на странице открывает панель сам — не мешаем ему.
    if (event.target.closest?.('[data-keeps-popover]')) return;
    api.close();
  });

  return api;
}
