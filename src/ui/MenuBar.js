// Barre de menu type logiciel (Fichier, Views, Settings).
//
// Chaque menu est décrit par une liste d'entrées :
//   { label, action }                    — commande
//   { label, checked: () => bool, action } — case à cocher ou choix exclusif
//   { label, submenu: [entrées] }         — sous-menu
//   { label, disabled: true }            — entrée grisée
//   { separator: true }
// Les entrées sont reconstruites à chaque ouverture, pour que l'état coché
// reflète toujours les réglages courants.
export class MenuBar {
  constructor(container, menus) {
    this.container = container;
    this.menus = menus;
    this.openIndex = -1;

    this.container.classList.add('menubar');
    this.container.setAttribute('role', 'menubar');
    this.buttons = menus.map((menu, index) => {
      const button = document.createElement('button');
      button.className = 'menubar-item';
      button.textContent = menu.label;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.openIndex === index ? this.close() : this.open(index);
      });
      // Survol d'un autre titre pendant qu'un menu est ouvert : bascule.
      button.addEventListener('mouseenter', () => {
        if (this.openIndex !== -1 && this.openIndex !== index) this.open(index);
      });
      this.container.append(button);
      return button;
    });

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'menu-dropdown';
    this.dropdown.hidden = true;
    this.container.append(this.dropdown);

    document.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });
  }

  open(index) {
    this.openIndex = index;
    this.buttons.forEach((button, i) => button.classList.toggle('open', i === index));
    this.dropdown.replaceChildren(this.#renderEntries(this.menus[index].items));
    const rect = this.buttons[index].getBoundingClientRect();
    const parentRect = this.container.getBoundingClientRect();
    this.dropdown.style.left = `${rect.left - parentRect.left}px`;
    this.dropdown.hidden = false;
  }

  close() {
    this.openIndex = -1;
    this.buttons.forEach((button) => button.classList.remove('open'));
    this.dropdown.hidden = true;
  }

  #renderEntries(entries) {
    const list = document.createElement('ul');
    list.className = 'menu-list';
    list.setAttribute('role', 'menu');
    for (const entry of entries) {
      const item = document.createElement('li');
      if (entry.separator) {
        item.className = 'menu-separator';
        list.append(item);
        continue;
      }

      item.className = 'menu-entry';
      item.setAttribute('role', entry.checked ? 'menuitemcheckbox' : 'menuitem');
      const check = document.createElement('span');
      check.className = 'menu-check';
      if (entry.checked) {
        const isChecked = entry.checked();
        check.textContent = isChecked ? '✓' : '';
        item.setAttribute('aria-checked', String(isChecked));
      }
      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = entry.label;
      const hint = document.createElement('span');
      hint.className = 'menu-hint';
      hint.textContent = entry.submenu ? '▸' : (entry.shortcut ?? '');
      item.append(check, label, hint);

      if (entry.disabled) {
        item.classList.add('disabled');
      } else if (entry.submenu) {
        item.classList.add('has-submenu');
        item.append(this.#renderEntries(entry.submenu));
        item.addEventListener('click', (event) => event.stopPropagation());
      } else {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          this.close();
          entry.action?.();
        });
      }
      list.append(item);
    }
    return list;
  }
}
