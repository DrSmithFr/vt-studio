// Petite bibliothèque de contrôles pour les panneaux (remplace lil-gui) :
// sections repliables, curseurs avec valeur éditable, interrupteurs, choix
// segmentés ou liste, champs texte, boutons, valeurs en lecture seule.
//
// Chaque contrôle est lié à une propriété d'objet (`obj[key]`) : il lit la
// valeur courante dans update() et l'écrit à chaque modification, puis
// appelle le `onChange` du panneau racine. `panel.refresh()` resynchronise
// tous les contrôles (après un import, une réinitialisation, un menu…).

const RAD_TO_DEG = 180 / Math.PI;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function decimalsOf(step) {
  const text = String(step);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

// Normalise des options { libellé: valeur } ou [{ label, value }].
function normalizeOptions(options) {
  return Array.isArray(options) ? options : Object.entries(options).map(([label, value]) => ({ label, value }));
}

export class Section {
  constructor(parentElement, title, { open = true, badge, root = null, level = 0 } = {}) {
    this.root = root ?? this;
    this.level = level;
    this.controls = root ? null : [];

    this.element = el('section', `ctl-section level-${level}`);
    this.header = el('button', 'ctl-section-header');
    this.header.type = 'button';
    const chevron = el('span', 'ctl-chevron');
    this.titleElement = el('span', 'ctl-section-title', title);
    this.header.append(chevron, this.titleElement);
    if (badge) this.header.append(createBadge(badge));
    this.body = el('div', 'ctl-section-body');
    this.element.append(this.header, this.body);
    parentElement.append(this.element);

    this.header.addEventListener('click', () => this.setOpen(!this.open));
    this.setOpen(open);
    this.ready = true;
  }

  setOpen(open) {
    this.open = open;
    this.element.classList.toggle('closed', !open);
    this.header.setAttribute('aria-expanded', String(open));
    // Les valeurs mises à jour pendant que la section était fermée ne sont
    // pas redessinées (voir Readout) : on rattrape à l'ouverture.
    if (open && this.ready) this.root.refresh();
  }

  // Vrai si la section et toutes ses ancêtres sont ouvertes.
  get visible() {
    return this.open && (this.parentSection?.visible ?? true);
  }

  section(title, options = {}) {
    const child = new Section(this.body, title, { ...options, root: this.root, level: this.level + 1 });
    child.parentSection = this;
    return child;
  }

  // --- Contrôles ----------------------------------------------------------

  slider(obj, key, { label, min = 0, max = 1, step = 0.01, unit = '' } = {}) {
    const decimals = decimalsOf(step);
    const row = this.#row(label, 'ctl-slider');
    const range = el('input', 'ctl-range');
    Object.assign(range, { type: 'range', min, max, step });
    const number = el('input', 'ctl-number');
    Object.assign(number, { type: 'number', min, max, step });
    row.field.append(range, number);
    if (unit) row.field.append(el('span', 'ctl-unit', unit));

    const write = (value) => {
      if (Number.isNaN(value)) return;
      obj[key] = value;
      update();
      this.root.notify();
    };
    const update = () => {
      const value = obj[key];
      range.value = value;
      const ratio = (Math.min(max, Math.max(min, value)) - min) / (max - min);
      range.style.setProperty('--fill', `${ratio * 100}%`);
      if (document.activeElement !== number) number.value = Number(value).toFixed(decimals);
    };
    range.addEventListener('input', () => write(Number(range.value)));
    // Le champ numérique accepte une valeur hors de la plage du curseur.
    number.addEventListener('change', () => write(Number(number.value)));
    number.addEventListener('blur', update);
    // Double-clic sur le libellé : valeur au moment de la création.
    const initial = obj[key];
    row.labelElement.title = 'Double-clic : valeur initiale';
    row.labelElement.addEventListener('dblclick', () => write(initial));

    return this.#register(row, update, [range, number]);
  }

  // Valeur stockée en radians (convention du projet), affichée en degrés.
  angle(obj, key, { label, min = -180, max = 180, step = 1 } = {}) {
    const proxy = {
      get value() {
        return obj[key] * RAD_TO_DEG;
      },
      set value(degrees) {
        obj[key] = degrees / RAD_TO_DEG;
      },
    };
    return this.slider(proxy, 'value', { label, min, max, step, unit: '°' });
  }

  toggle(obj, key, { label } = {}) {
    const row = this.#row(label, 'ctl-toggle');
    const input = el('input', 'ctl-switch');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    row.field.append(input);
    // Toute la ligne est cliquable.
    row.element.addEventListener('click', (event) => {
      if (event.target === input || input.disabled) return;
      input.click();
    });
    input.addEventListener('change', () => {
      obj[key] = input.checked;
      this.root.notify();
    });
    return this.#register(row, () => (input.checked = obj[key]), [input]);
  }

  // Choix parmi des options. Affiché en boutons segmentés si les options sont
  // peu nombreuses et courtes, sinon en liste déroulante.
  select(obj, key, options, { label, segmented } = {}) {
    const list = normalizeOptions(options);
    const useSegments = segmented ?? (list.length <= 3 && list.every((o) => o.label.length <= 12));
    const row = this.#row(label, useSegments ? 'ctl-segmented' : 'ctl-select');

    if (useSegments) {
      const group = el('div', 'ctl-segments');
      group.setAttribute('role', 'radiogroup');
      const buttons = list.map(({ label: optionLabel, value }) => {
        const button = el('button', 'ctl-segment', optionLabel);
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.addEventListener('click', () => {
          obj[key] = value;
          update();
          this.root.notify();
        });
        group.append(button);
        return { button, value };
      });
      row.field.append(group);
      const update = () => {
        for (const { button, value } of buttons) {
          const active = obj[key] === value;
          button.classList.toggle('active', active);
          button.setAttribute('aria-checked', String(active));
        }
      };
      return this.#register(row, update, buttons.map((b) => b.button));
    }

    const select = el('select', 'ctl-dropdown');
    list.forEach(({ label: optionLabel }, index) => select.add(new Option(optionLabel, String(index))));
    row.field.append(select);
    select.addEventListener('change', () => {
      obj[key] = list[Number(select.value)].value;
      this.root.notify();
    });
    const update = () => {
      select.value = String(Math.max(0, list.findIndex((o) => o.value === obj[key])));
    };
    return this.#register(row, update, [select]);
  }

  text(obj, key, { label, placeholder = '' } = {}) {
    const row = this.#row(label, 'ctl-text');
    const input = el('input', 'ctl-input');
    Object.assign(input, { type: 'text', placeholder, spellcheck: false });
    row.field.append(input);
    input.addEventListener('change', () => {
      obj[key] = input.value.trim();
      this.root.notify();
    });
    return this.#register(row, () => {
      if (document.activeElement !== input) input.value = obj[key];
    }, [input]);
  }

  button(label, onClick, { variant = '' } = {}) {
    const row = el('div', 'ctl-row ctl-button-row');
    const button = el('button', `ctl-button ${variant}`, label);
    button.type = 'button';
    button.addEventListener('click', () => onClick());
    row.append(button);
    this.body.append(row);
    const control = this.#register({ element: row }, null, [button]);
    control.setLabel = (text) => {
      button.textContent = text;
      return control;
    };
    return control;
  }

  // Valeur en lecture seule, mise à jour par set(texte). Le DOM n'est touché
  // que si la section est visible, l'appel peut donc être fait à chaque frame.
  readout(label) {
    const row = this.#row(label, 'ctl-readout');
    const value = el('output', 'ctl-value', '—');
    row.field.append(value);
    let text = '—';
    const update = () => {
      if (value.textContent !== text) {
        value.textContent = text;
        value.title = text;
      }
    };
    const control = this.#register(row, update, []);
    control.set = (nextText) => {
      text = nextText;
      if (this.visible) update();
    };
    return control;
  }

  // --- Interne -------------------------------------------------------------

  #row(label, kind) {
    const element = el('div', `ctl-row ${kind}`);
    const labelElement = el('span', 'ctl-label', label ?? '');
    const field = el('div', 'ctl-field');
    element.append(labelElement, field);
    this.body.append(element);
    return { element, labelElement, field };
  }

  #register(row, update, inputs) {
    const control = {
      row: row.element,
      update: update ?? (() => {}),
      show(visible = true) {
        row.element.hidden = !visible;
        return control;
      },
      disable(disabled = true) {
        row.element.classList.toggle('disabled', disabled);
        for (const input of inputs) input.disabled = disabled;
        return control;
      },
      tooltip(text) {
        row.element.title = text;
        return control;
      },
    };
    control.update();
    this.root.controls.push(control);
    return control;
  }
}

// Panneau racine : une section sans en-tête qui centralise les contrôles et
// la notification de changement.
export class ControlPanel extends Section {
  constructor(container, { onChange } = {}) {
    super(container, '', { open: true });
    this.element.classList.add('ctl-panel');
    this.header.remove();
    this.onChange = onChange;
  }

  notify() {
    this.onChange?.();
  }

  refresh() {
    for (const control of this.controls ?? []) control.update();
  }

  get visible() {
    return true;
  }
}

// Badge signalant une section présente dans l'interface mais pas encore
// reliée au pipeline (phase de la reconstruction en infobulle).
export function pendingBadge(phase) {
  return { text: 'à venir', title: `Réglage enregistré, mais pas encore branché (phase ${phase} de la reconstruction).` };
}

function createBadge({ text, title }) {
  const badge = el('span', 'ctl-badge', text);
  badge.title = title;
  return badge;
}
