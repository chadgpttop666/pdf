// Окно справки строится из таблицы горячих клавиш, поэтому не расходится с ней.

import { $, clear, closeOnBackdropClick, el } from '../dom.js';
import { BINDINGS, displayCombo } from '../keyboard.js';

export function createHelp() {
  const dialog = $('helpDialog');
  closeOnBackdropClick(dialog);
  const content = $('helpContent');

  function render() {
    clear(content);
    for (const binding of BINDINGS) {
      if (binding.section) {
        content.append(el('div', { class: 'section' }, binding.section));
        continue;
      }
      const keys = el('div', {}, joinKeys(binding.combos));
      content.append(keys, el('div', {}, binding.label));
    }
  }

  function joinKeys(combos) {
    const nodes = [];
    combos.forEach((combo, index) => {
      if (index) nodes.push(document.createTextNode(' или '));
      nodes.push(el('kbd', {}, displayCombo(combo)));
    });
    return nodes;
  }

  render();

  return {
    open() {
      if (!dialog.open) dialog.showModal();
    },
    close() {
      if (dialog.open) dialog.close();
    },
    toggle() {
      if (dialog.open) dialog.close();
      else dialog.showModal();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}
