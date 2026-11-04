import * as THREE from 'three';
import { CFG } from '../../shared/config.js';

// Ocular falloff follows the real eyepiece projection, so FOV/viewport changes
// preserve the shared centre ray and physical sight picture.
export class OpticOverlay {
  constructor(root) {
    this.root = document.createElement('div'); this.root.className = 'optic-overlay';
    this.label = document.createElement('span'); this.label.className = 'optic-label';
    this.root.append(this.label); root.prepend(this.root);
  }
  update(viewmodel, camera, player, blocked) {
    const active = !blocked && player?.alive && ['sniper', 'dmr'].includes(player.weapon) && viewmodel?.ads > .9;
    this.root.style.opacity = active ? String(Math.min(1, (viewmodel.ads - .9) * 10)) : '0';
    if (!active) return;
    const model = viewmodel.model;
    model.root.updateWorldMatrix(true, true);
    const centre = model.root.localToWorld(new THREE.Vector3(0, model.profile.sightY, model.profile.ocularZ)).project(camera);
    const edge = model.root.localToWorld(new THREE.Vector3(model.profile.ocularRadius, model.profile.sightY, model.profile.ocularZ)).project(camera);
    const radius = Math.max(30, Math.abs(edge.x - centre.x) * innerWidth / 2);
    this.root.style.setProperty('--optic-x', `${(centre.x + 1) * innerWidth / 2}px`);
    this.root.style.setProperty('--optic-y', `${(1 - centre.y) * innerHeight / 2}px`);
    this.root.style.setProperty('--optic-radius', `${radius}px`);
    this.label.textContent = `${CFG.WEAPONS[player.weapon].name}  /  ${CFG.WEAPONS[player.weapon].adsZoom}× OPTIC`;
  }
}
