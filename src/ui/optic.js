import * as THREE from 'three';
import { CFG } from '../../shared/config.js';

const _centreVec = new THREE.Vector3();
const _edgeVec = new THREE.Vector3();

// Ocular falloff follows the real eyepiece projection, so FOV/viewport changes
// preserve the shared centre ray and physical sight picture.
export class OpticOverlay {
  constructor(root) {
    this.root = document.createElement('div'); this.root.className = 'optic-overlay';
    this.label = document.createElement('span'); this.label.className = 'optic-label';
    this.root.append(this.label); root.prepend(this.root);
    this._lastX = null;
    this._lastY = null;
    this._lastRadius = null;
    this._lastLabel = '';
    this._lastOpacity = '';
  }
  update(viewmodel, camera, player, blocked) {
    const active = !blocked && player?.alive && ['sniper', 'dmr'].includes(player.weapon) && viewmodel?.ads > .9;
    const op = active ? String(Math.min(1, (viewmodel.ads - .9) * 10)) : '0';
    if (this._lastOpacity !== op) {
      this.root.style.opacity = op;
      this._lastOpacity = op;
    }
    if (!active) return;
    const model = viewmodel.model;
    model.root.updateWorldMatrix(true, true);
    _centreVec.set(0, model.profile.sightY, model.profile.ocularZ);
    const centre = model.root.localToWorld(_centreVec).project(camera);
    _edgeVec.set(model.profile.ocularRadius, model.profile.sightY, model.profile.ocularZ);
    const edge = model.root.localToWorld(_edgeVec).project(camera);
    const radius = Math.round(Math.max(30, Math.abs(edge.x - centre.x) * innerWidth / 2));
    const ox = Math.round((centre.x + 1) * innerWidth / 2);
    const oy = Math.round((1 - centre.y) * innerHeight / 2);
    if (this._lastX !== ox) { this.root.style.setProperty('--optic-x', `${ox}px`); this._lastX = ox; }
    if (this._lastY !== oy) { this.root.style.setProperty('--optic-y', `${oy}px`); this._lastY = oy; }
    if (this._lastRadius !== radius) { this.root.style.setProperty('--optic-radius', `${radius}px`); this._lastRadius = radius; }
    const lbl = `${CFG.WEAPONS[player.weapon].name}  /  ${CFG.WEAPONS[player.weapon].adsZoom}× OPTIC`;
    if (this._lastLabel !== lbl) { this.label.textContent = lbl; this._lastLabel = lbl; }
  }
}
