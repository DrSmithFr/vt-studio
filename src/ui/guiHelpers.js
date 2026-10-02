import GUI from 'lil-gui';

const RAD_TO_DEG = 180 / Math.PI;

// Crée un lil-gui intégré dans un conteneur de l'interface (panneau, menu du
// bas) plutôt que flottant. Toute modification passe par `onChange`.
export function createEmbeddedGui(container, title, onChange) {
  const gui = new GUI({ container, title });
  gui.domElement.classList.add('embedded-gui');
  gui.onChange(onChange);
  return gui;
}

// Ajoute un contrôle affiché en degrés pour une valeur stockée en radians
// (convention du projet). `obj[key]` est lu et écrit à travers un proxy,
// donc un import ou une réinitialisation des réglages reste visible après
// updateDisplay().
export function addAngle(folder, obj, key, label, minDeg = -180, maxDeg = 180) {
  const proxy = {
    get value() {
      return obj[key] * RAD_TO_DEG;
    },
    set value(degrees) {
      obj[key] = degrees / RAD_TO_DEG;
    },
  };
  return folder.add(proxy, 'value', minDeg, maxDeg, 1).name(label);
}

// Signale qu'une section est déjà présente dans l'interface mais pas encore
// reliée au pipeline (phase de reconstruction indiquée en infobulle).
export function markPending(gui, phase) {
  const badge = document.createElement('span');
  badge.className = 'pending-badge';
  badge.textContent = 'à venir';
  badge.title = `Réglage enregistré, mais pas encore branché (phase ${phase} de la reconstruction).`;
  gui.$title.append(badge);
}

// Resynchronise tous les contrôles avec les valeurs courantes (après un
// import, une réinitialisation ou un changement fait depuis un menu).
export function refreshGui(gui) {
  for (const controller of gui.controllersRecursive()) controller.updateDisplay();
}
