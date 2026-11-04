// One owner for short feedback/scene transitions. WAAPI animations cancel on
// replacement, avoiding stacked timers or stale screens after reconnect/restart.
import { CFG } from '../../shared/config.js';

export class CombatFeedback {
  constructor(root) {
    this.panel = document.createElement('section'); this.panel.className = 'death-card hidden';
    this.panel.setAttribute('aria-live', 'polite');
    this.panel.innerHTML = '<div class="death-eyebrow">OPERATOR DOWN <span>FL / SIGNAL LOST</span></div><h2>YOU WERE ELIMINATED</h2><div class="death-detail"><span>ELIMINATED BY</span><b class="death-killer"></b></div><div class="death-weapon"></div><div class="death-status"></div><div class="death-progress"><i></i></div>';
    root.append(this.panel);
    this.vignette = document.createElement('div'); this.vignette.className = 'death-vignette'; root.prepend(this.vignette);
    this.confirmation = document.createElement('div'); this.confirmation.className = 'elimination-confirmation'; root.append(this.confirmation);
    this.curtain = document.createElement('div'); this.curtain.className = 'scene-curtain'; document.body.append(this.curtain);
    this.animation = null; this.confirmAnimation = null; this.dead = false;
  }

  eliminated(event) {
    this.dead = true;
    this.panel.querySelector('.death-killer').textContent = event.kname || 'UNKNOWN';
    const weapon = CFG.WEAPONS[event.w]?.name || (event.w === 'zone' ? 'PERIMETER' : event.w === 'fall' ? 'FALL IMPACT' : String(event.w || 'COMBAT').toUpperCase());
    this.panel.querySelector('.death-weapon').textContent = `${weapon}  /  ${Math.round(event.dist || 0)} METRES${event.zone === 'head' ? '  /  HEADSHOT' : ''}`;
    this.panel.classList.remove('hidden'); this.vignette.classList.add('active');
    this.panel.animate([{ opacity: 0, transform: 'translate(-50%, 16px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  update(player, state) {
    if (player.alive) {
      this.dead = false; this.panel.classList.add('hidden'); this.vignette.classList.remove('active'); return;
    }
    this.panel.classList.toggle('hidden', state?.matchState === 3);
    const text = this.panel.querySelector('.death-status');
    text.textContent = state?.mode === 'tdm' ? `REDEPLOYING IN ${Math.ceil(player.respawnIn || 0)}s` : 'OBSERVING THE BATTLEFIELD  /  Q NEXT OPERATOR';
    this.panel.querySelector('.death-progress i').style.width = state?.mode === 'tdm'
      ? `${Math.max(0, Math.min(1, 1 - (player.respawnIn || 0) / CFG.MODES.tdm.respawn)) * 100}%` : '100%';
  }

  confirm(event) {
    this.confirmAnimation?.cancel();
    this.confirmation.replaceChildren();
    const label = document.createElement('b'); label.textContent = event.zone === 'head' ? 'PRECISION ELIMINATION' : 'HOSTILE ELIMINATED';
    const name = document.createElement('span'); name.textContent = event.vname || 'OPERATOR';
    this.confirmation.append(label, name);
    this.confirmAnimation = this.confirmation.animate([
      { opacity: 0, transform: 'translate(-50%, 10px)' }, { opacity: 1, transform: 'translate(-50%, 0)', offset: .09 },
      { opacity: 1, offset: .76 }, { opacity: 0, transform: 'translate(-50%, -5px)' },
    ], { duration: 2200, easing: 'ease-out' });
  }

  transition(label = 'DEPLOYING', duration = 600) {
    this.animation?.cancel(); this.curtain.textContent = label;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.animation = this.curtain.animate([
      { opacity: .95 }, { opacity: .8, offset: .22 }, { opacity: 0 },
    ], { duration: reduced ? 100 : duration, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  reset() {
    this.animation?.cancel(); this.confirmAnimation?.cancel();
    this.panel.classList.add('hidden'); this.vignette.classList.remove('active'); this.dead = false;
  }
}
