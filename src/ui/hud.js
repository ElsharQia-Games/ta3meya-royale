// DOM HUD: crosshair, vitals, ammo, minimap, compass, kill feed, scoreboard,
// lobby/settings/end screens, chat and network diagnostics.
import { CFG, TEAMS, MATCH_STATE } from '../../shared/config.js';
import { clamp } from '../../shared/math.js';
import { WEAPON_KEYS } from '../../shared/weapons.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, parent, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
};

const WEAPON_LABEL = {
  pistol: 'P92', smg: 'VEX-9', ar: 'K4 CARBINE', dmr: 'SABLE DMR',
  shotgun: 'M12 BREACHER', sniper: 'AX-50', lmg: 'M249 SAW',
};

export class HUD {
  constructor(settings) {
    this.settings = settings;
    this.playerId = null;
    this.killFeed = [];
    this.damageMarks = [];
    this.hitT = 0;
    this.headshotT = 0;
    this.killT = 0;
    this.prompt = '';
    this.chatOpen = false;
    this.scoreboardOpen = false;
    this._last = {};
    this._minimapTimer = 0;
    this._build();
  }

  _build() {
    const root = $('hud');

    // ---- compass ----
    this.compass = el('canvas', 'compass', root);
    this.compass.width = 620; this.compass.height = 34;

    // ---- top center: zone + match state ----
    const top = el('div', 'hud-top', root);
    this.zoneLine = el('div', 'zone-line', top);
    this.zoneInfo = el('div', 'zone-info', this.zoneLine);
    this.zoneWarn = el('div', 'zone-warn', root, 'OUTSIDE THE ZONE — MOVE');

    // ---- minimap ----
    const mmWrap = el('div', 'minimap-wrap', root);
    this.minimap = el('canvas', 'minimap', mmWrap);
    this.minimap.width = 220; this.minimap.height = 220;
    this.mmLabel = el('div', 'mm-label', mmWrap, 'GRID 04');
    this.zoneTimer = el('div', 'zone-timer', mmWrap, '');

    // ---- kill feed ----
    this.feed = el('div', 'killfeed', root);

    // ---- vitals ----
    const vitals = el('div', 'vitals', root);
    const hpRow = el('div', 'bar-row', vitals);
    this.hpBar = el('div', 'bar hp', hpRow);
    this.hpFill = el('i', '', this.hpBar);
    this.hpText = el('span', 'bar-text', this.hpBar, '100');
    const arRow = el('div', 'bar-row', vitals);
    this.arBar = el('div', 'bar armor', arRow);
    this.arFill = el('i', '', this.arBar);
    this.arText = el('span', 'bar-text', this.arBar, '0');
    this.stanceText = el('div', 'stance', vitals, 'STANDING');

    // ---- ammo ----
    const ammo = el('div', 'ammo', root);
    this.weaponName = el('div', 'weapon-name', ammo, '—');
    const ammoRow = el('div', 'ammo-row', ammo);
    this.magText = el('span', 'mag', ammoRow, '0');
    this.reserveText = el('span', 'reserve', ammoRow, '/ 0');
    this.fireMode = el('div', 'firemode', ammo, 'AUTO');

    // ---- inventory ----
    this.inv = el('div', 'inventory', root);
    this.slots = [];
    for (let i = 0; i < 2; i++) {
      const s = el('div', 'slot', this.inv);
      el('div', 'slot-key', s, String(i + 1));
      const name = el('div', 'slot-name', s, 'EMPTY');
      this.slots.push({ root: s, name });
    }
    this.util = el('div', 'util', root);
    this.grenadeEl = el('div', 'util-item', this.util, '');
    this.smokeEl = el('div', 'util-item', this.util, '');
    this.bandageEl = el('div', 'util-item', this.util, '');
    this.medkitEl = el('div', 'util-item', this.util, '');

    // ---- crosshair ----
    this.cross = el('div', 'crosshair', root);
    this.crossLines = ['t', 'b', 'l', 'r'].map(d => el('i', `ch ${d}`, this.cross));
    this.hitmarker = el('div', 'hitmarker', root);
    this.hitmarker.innerHTML = '<i></i><i></i><i></i><i></i>';

    // ---- damage indicators ----
    this.dmgWrap = el('div', 'dmg-wrap', root);

    // ---- interaction prompt ----
    this.promptEl = el('div', 'prompt', root, '');

    // ---- diagnostics ----
    this.stats = el('div', 'stats', root, '');
    this.stats.style.display = this.settings.showFps ? '' : 'none';
    this.latency = el('div', 'latency', root, '');

    // ---- center messages ----
    this.center = el('div', 'center-msg', root, '');
    this.respawn = el('div', 'respawn', root, '');

    // ---- scoreboard ----
    this.scoreboard = el('div', 'scoreboard hidden', root);
    el('h2', '', this.scoreboard, 'SCOREBOARD');
    this.scoreTable = el('div', 'score-table', this.scoreboard);

    // ---- chat ----
    this.chatLog = el('div', 'chat-log', root);
    this.chatForm = el('form', 'chat-form hidden', root);
    this.chatInput = el('input', '', this.chatForm);
    this.chatInput.maxLength = 140;
    this.chatInput.placeholder = 'Say something… (Enter to send, Esc to cancel)';
    this.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.chatInput.value.trim();
      this.chatInput.value = '';
      this.closeChat();
      if (text && this.onChat) this.onChat(text);
    });

    this._buildLobby();
    this._buildSettings();
    this._buildEnd();
    this._buildToast();
  }

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------
  _buildLobby() {
    this.lobby = $('lobby');
    this.lobbyRoster = $('lobby-roster');
    this.lobbyStatus = $('lobby-status');
    this.lobbyTitle = $('lobby-title');
    this.copyBtn = $('copy-link');
    this.startBtn = $('start-match');
  }

  setLobbyRoster(players, mode, state) {
    if (!this.lobbyRoster) return;
    this.lobbyRoster.innerHTML = '';
    const groups = [0, 1].map(t => players.filter(p => p.team === t));
    const showTeams = mode === 'tdm';
    for (const p of players) {
      const row = el('div', 'lobby-player', this.lobbyRoster);
      const dot = el('i', 'team-dot', row);
      dot.style.background = TEAMS[p.team]?.css || '#888';
      el('span', 'lobby-name', row, p.name + (p.bot ? '  ·BOT' : ''));
      el('span', 'lobby-kd', row, `${p.kills} / ${p.deaths}`);
    }
    if (showTeams) {
      this.lobbyStatus.textContent = `${groups[0].length} v ${groups[1].length} · Team Deathmatch`;
    } else {
      this.lobbyStatus.textContent = `${players.length} in lobby · Battle Royale`;
    }
  }

  setLobbyVisible(v) {
    this.lobby.classList.toggle('hidden', !v);
    $('hud').classList.toggle('hidden', v);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  _buildSettings() {
    this.settingsPanel = $('settings-panel');
    this.sensInput = $('set-sens');
    this.adsSensInput = $('set-ads-sens');
    this.fovInput = $('set-fov');
    this.volInput = $('set-vol');
    this.qualityInput = $('set-quality');
    this.invertInput = $('set-invert');
    this.shadowsInput = $('set-shadows');
    this.bloomInput = $('set-bloom');
    this.showFpsInput = $('set-fps');
    const s = this.settings;
    this.sensInput.value = s.sensitivity;
    this.adsSensInput.value = s.adsSensitivity;
    this.fovInput.value = s.fov;
    this.volInput.value = s.volume;
    this.qualityInput.value = s.quality;
    this.invertInput.checked = s.invertY;
    this.shadowsInput.checked = s.shadows;
    this.bloomInput.checked = s.bloom;
    this.showFpsInput.checked = s.showFps;
    $('settings-close').onclick = () => this.toggleSettings(false);
    $('settings-save').onclick = () => {
      s.sensitivity = +this.sensInput.value;
      s.adsSensitivity = +this.adsSensInput.value;
      s.fov = +this.fovInput.value;
      s.volume = +this.volInput.value;
      s.quality = this.qualityInput.value;
      s.invertY = this.invertInput.checked;
      s.shadows = this.shadowsInput.checked;
      s.bloom = this.bloomInput.checked;
      s.showFps = this.showFpsInput.checked;
      this.stats.style.display = s.showFps ? '' : 'none';
      if (this.onSettings) this.onSettings(s);
      this.toggleSettings(false);
    };
    $('settings-leave').onclick = () => { if (this.onLeave) this.onLeave(); };
    $('settings-resume').onclick = () => this.toggleSettings(false);
  }

  toggleSettings(v) {
    this.settingsOpen = v;
    this.settingsPanel.classList.toggle('hidden', !v);
    if (v) this.releasePointer?.();
    else this.requestPointer?.();
  }

  // -------------------------------------------------------------------------
  // End screen
  // -------------------------------------------------------------------------
  _buildEnd() {
    this.endPanel = $('end-panel');
    this.endTitle = $('end-title');
    this.endSub = $('end-sub');
    this.endTable = $('end-table');
    $('end-again').onclick = () => { if (this.onRestart) this.onRestart(); };
    $('end-leave').onclick = () => { if (this.onLeave) this.onLeave(); };
  }

  showEnd(winner, scoreboard, mode, score = null) {
    this.endPanel.classList.remove('hidden');
    this.releasePointer?.();
    const youWon = winner && winner.id === this.playerId;
    this.endTitle.textContent = youWon ? 'VICTORY' : (winner?.name ? `${winner.name} WINS` : 'MATCH OVER');
    this.endTitle.className = youWon ? 'win' : 'lose';
    const s = Array.isArray(score) ? score : [0, 0];
    this.endSub.textContent = mode === 'tdm'
      ? `${TEAMS[0]?.name ?? 'Team 1'} ${s[0] ?? 0} : ${s[1] ?? 0} ${TEAMS[1]?.name ?? 'Team 2'}`
      : 'Last one standing.';
    this.endTable.innerHTML = '';
    const rows = [...(scoreboard || [])].sort((a, b) => b.kills - a.kills);
    for (const p of rows) {
      const row = el('div', 'end-row', this.endTable);
      el('span', '', row, p.name + (p.bot ? ' ·BOT' : ''));
      el('span', 'end-kd', row, `${p.kills} kills · ${p.deaths} deaths`);
    }
  }

  hideEnd() { this.endPanel.classList.add('hidden'); }

  _buildToast() {
    this.toast = el('div', 'toast', document.body, '');
    this.toastT = 0;
  }

  notify(text, ms = 2600) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.remove('show'), ms);
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------
  update(dt, ctx) {
    const { player, state, roster, vehicles, loot, cameraYaw, spectator } = ctx;
    const root = $('hud');
    if (!player) return;

    // health / armour
    const hp = Math.max(0, Math.round(player.hp ?? 100));
    if (this._last.hp !== hp) {
      this._last.hp = hp;
      this.hpFill.style.width = `${hp}%`;
      this.hpText.textContent = hp;
      this.hpBar.classList.toggle('low', hp <= 30);
    }
    const ar = Math.round(player.armor ?? 0);
    if (this._last.ar !== ar) {
      this._last.ar = ar;
      this.arFill.style.width = `${ar}%`;
      this.arText.textContent = ar;
    }
    const stance = player.stance === 2 ? 'PRONE' : player.stance === 1 ? 'CROUCHED' : 'STANDING';
    if (this._last.stance !== stance) {
      this._last.stance = stance;
      this.stanceText.textContent = stance;
    }

    // weapon / ammo
    const wkey = player.weapon;
    const label = WEAPON_LABEL[wkey] || '—';
    if (this._last.weapon !== label) {
      this._last.weapon = label;
      this.weaponName.textContent = label;
    }
    const mag = player.mag ?? 0, res = player.reserve ?? 0;
    if (this._last.mag !== mag) { this._last.mag = mag; this.magText.textContent = mag; this.magText.classList.toggle('empty', mag === 0); }
    if (this._last.res !== res) { this._last.res = res; this.reserveText.textContent = `/ ${res}`; }
    const W = CFG.WEAPONS[wkey];
    const mode = W ? (W.rpm > 500 ? 'AUTO' : 'SEMI') : '';
    if (this._last.mode !== mode) { this._last.mode = mode; this.fireMode.textContent = mode; }

    // inventory slots
    const weapons = player.weapons || [];
    for (let i = 0; i < 2; i++) {
      const key = weapons[i];
      const name = key ? (WEAPON_LABEL[key] || key.toUpperCase()) : 'EMPTY';
      if (this.slots[i].name.textContent !== name) this.slots[i].name.textContent = name;
      this.slots[i].root.classList.toggle('active', i === player.slot);
    }
    const util = [
      [this.grenadeEl, '◉', player.grenades ?? 0, 'FRAG'],
      [this.smokeEl, '◍', player.smokes ?? 0, 'SMOKE'],
      [this.bandageEl, '✚', player.bandages ?? 0, 'BANDAGE'],
      [this.medkitEl, '✚✚', player.medkits ?? 0, 'MEDKIT'],
    ];
    for (const [e, icon, n, name] of util) {
      const txt = `${icon} ${n}`;
      if (e.textContent !== txt) e.textContent = txt;
      e.title = name;
      e.classList.toggle('none', n === 0);
    }

    // crosshair spread
    const spread = player.spread ?? 0.02;
    const px = clamp(spread * 900, 3, 70);
    this.crossLines[0].style.transform = `translate(-50%, ${-px}px)`;
    this.crossLines[1].style.transform = `translate(-50%, ${px}px)`;
    this.crossLines[2].style.transform = `translate(${-px}px, -50%)`;
    this.crossLines[3].style.transform = `translate(${px}px, -50%)`;
    this.cross.classList.toggle('ads', !!player.ads);
    this.cross.style.opacity = player.ads ? 0.35 : 1;

    // compass
    this._drawCompass(cameraYaw);

    // minimap
    this._minimapTimer += dt;
    if (this._minimapTimer > 0.1) {
      this._minimapTimer = 0;
      this._drawMinimap(player, state, roster, vehicles, loot);
    }

    // zone
    if (state?.zone) {
      const z = state.zone;
      const phaseTxt = z.shrinking ? 'CLOSING' : 'HOLD';
      const timeLeft = z.shrinking ? Math.ceil(z.phaseT) : Math.ceil(z.phaseT);
      this.zoneInfo.innerHTML = `<b>${phaseTxt}</b> · ${timeLeft}s · ${Math.round(z.r)}m`;
      const d = Math.hypot(player.x - z.cx, player.z - z.cz);
      this.zoneWarn.classList.toggle('show', d > z.r && player.alive);
    } else {
      this.zoneWarn.classList.remove('show');
    }

    // match countdown / state
    let center = '';
    if (state?.matchState === MATCH_STATE.WARMUP || state?.matchState === MATCH_STATE.LOBBY) {
      center = `DEPLOYING IN ${Math.max(0, Math.ceil(state.countdown))}`;
    } else if (state?.matchState === MATCH_STATE.ENDED) {
      center = '';
    }
    if (this._last.center !== center) { this._last.center = center; this.center.textContent = center; }
    this.center.classList.toggle('show', !!center);

    // respawn timer
    let rtxt = '';
    if (!player.alive && state?.mode === 'tdm' && player.respawnIn > 0) {
      rtxt = `RESPAWN IN ${Math.ceil(player.respawnIn)}`;
    }
    if (this._last.respawn !== rtxt) { this._last.respawn = rtxt; this.respawn.textContent = rtxt; }
    this.respawn.classList.toggle('show', !!rtxt);

    // spectator
    if (spectator) {
      this.center.textContent = `SPECTATING ${spectator}`;
      this.center.classList.add('show');
    }

    // prompt
    if (this.prompt !== (this._last.prompt ?? '')) {
      this._last.prompt = this.prompt;
      this.promptEl.textContent = this.prompt;
      this.promptEl.classList.toggle('show', !!this.prompt);
    }

    // hitmarker fade
    if (this.hitT > 0) {
      this.hitT -= dt;
      this.hitmarker.classList.toggle('show', this.hitT > 0);
      this.hitmarker.classList.toggle('kill', this.killT > 0);
      this.hitmarker.classList.toggle('head', this.headshotT > 0);
    }

    // damage direction markers
    for (let i = this.damageMarks.length - 1; i >= 0; i--) {
      const d = this.damageMarks[i];
      d.t -= dt;
      d.el.style.opacity = Math.max(0, d.t / 1.1).toFixed(2);
      if (d.t <= 0) { d.el.remove(); this.damageMarks.splice(i, 1); }
    }

    // diagnostics
    this.latency.textContent = ctx.netStats || '';
  }

  _drawCompass(yaw) {
    const c = this.compass, ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    // yaw 0 = -Z (north)
    const deg = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
    const span = 140;
    const start = deg - span / 2;
    ctx.textAlign = 'center';
    for (let d = Math.ceil(start / 5) * 5; d <= start + span; d += 5) {
      const x = ((d - start) / span) * w;
      const dd = ((d % 360) + 360) % 360;
      const major = dd % 45 === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.28)';
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, h - (major ? 14 : 7));
      ctx.lineTo(x, h - 2);
      ctx.stroke();
      if (major) {
        const label = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : String(dd);
        ctx.fillStyle = dd === 0 ? '#f2b63a' : 'rgba(230,238,245,0.9)';
        ctx.font = 'bold 13px ui-monospace, monospace';
        ctx.fillText(label, x, h - 18);
      }
    }
    // center notch
    ctx.fillStyle = '#f2b63a';
    ctx.beginPath();
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2 - 6, 8); ctx.lineTo(w / 2 + 6, 8);
    ctx.closePath(); ctx.fill();
  }

  _drawMinimap(player, state, roster, vehicles, loot) {
    const c = this.minimap, ctx = c.getContext('2d');
    const S = c.width;
    if (!this._mapBase) this._mapBase = this._renderMapBase(S);
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this._mapBase, 0, 0);

    const toMap = (x, z) => [((x + 500) / 1000) * S, ((z + 500) / 1000) * S];

    // zone
    if (state?.zone) {
      const z = state.zone;
      const [cx, cy] = toMap(z.cx, z.cz);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, S, S);
      ctx.arc(cx, cy, (z.r / 1000) * S, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(220,70,60,0.16)';
      ctx.fill('evenodd');
      ctx.beginPath();
      ctx.arc(cx, cy, (z.r / 1000) * S, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    // vehicles
    if (vehicles) {
      ctx.fillStyle = 'rgba(160,200,255,0.75)';
      for (const v of vehicles) {
        const [x, y] = toMap(v.x, v.z);
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
    // loot
    if (loot) {
      ctx.fillStyle = 'rgba(242,182,58,0.65)';
      for (const l of loot) {
        const [x, y] = toMap(l.x, l.z);
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
    // teammates
    if (roster) {
      for (const p of roster) {
        if (p.id === this.playerId || !p.alive) continue;
        const pos = this._rosterPos?.[p.id];
        if (!pos) continue;
        const [x, y] = toMap(pos[0], pos[2]);
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = TEAMS[p.team]?.css || '#fff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // self arrow
    const [px, py] = toMap(player.x, player.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-(player.yaw || 0));
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fillStyle = '#7dffb0';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    // view cone
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-(player.yaw || 0));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 34);
    g.addColorStop(0, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 34, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    this.mmLabel.textContent = this._gridLabel(player.x, player.z);
  }

  _renderMapBase(S) {
    const world = this.world;
    if (!world) return document.createElement('canvas');
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const wx = (x / S) * 1000 - 500;
        const wz = (y / S) * 1000 - 500;
        const h = world.terrainHeight(wx, wz);
        const wet = world.waterDepth(wx, wz);
        let r, g, b;
        if (wet > 0) {
          r = 32; g = 66; b = 74;
        } else {
          const t = clamp((h + 10) / 45, 0, 1);
          r = 48 + t * 62; g = 62 + t * 60; b = 44 + t * 44;
          if (world.nearTown(wx, wz, 1.0)) { r += 26; g += 22; b += 16; }
        }
        const i = (y * S + x) * 4;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // roads
    ctx.strokeStyle = 'rgba(30,32,34,0.8)';
    for (const road of world.roads) {
      ctx.lineWidth = Math.max(1, (road.width / 1000) * S);
      ctx.beginPath();
      road.points.forEach(([x, z], i) => {
        const mx = ((x + 500) / 1000) * S, my = ((z + 500) / 1000) * S;
        if (i === 0) ctx.moveTo(mx, my); else ctx.lineTo(mx, my);
      });
      ctx.stroke();
    }
    // town labels
    ctx.font = 'bold 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (const t of world.towns) {
      const mx = ((t.x + 500) / 1000) * S, my = ((t.z + 500) / 1000) * S;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(t.name, mx + 1, my + 1);
      ctx.fillStyle = 'rgba(232,238,244,0.85)';
      ctx.fillText(t.name, mx, my);
    }
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = (i / 4) * S;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(S, p); ctx.stroke();
    }
    return c;
  }

  _gridLabel(x, z) {
    const gx = Math.floor((x + 500) / 125) + 1;
    const gz = Math.floor((z + 500) / 125) + 1;
    const letters = 'ABCDEFGH';
    return `GRID ${letters[clamp(gz - 1, 0, 7)]}${clamp(gx, 1, 8)}`;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  hit(dmg, headshot, kill) {
    this.hitT = 0.24;
    this.headshotT = headshot ? 0.24 : 0;
    this.killT = kill ? 0.24 : 0;
    this.hitmarker.classList.add('show');
  }

  addKill(ev, names) {
    const hasKiller = ev.killer > 0;
    const killer = hasKiller ? (names?.[ev.killer] || 'Unknown') : 'ZONE';
    const victim = names?.[ev.victim] || 'Unknown';
    const row = el('div', 'feed-row', this.feed);
    const k = el('span', 'feed-killer', row, killer);
    if (hasKiller) k.style.color = TEAMS[ev.team ?? 0]?.css || '#fff';
    const icon = el('span', 'feed-icon', row, ev.zone === 'head' ? '⌖' : '›');
    const v = el('span', 'feed-victim', row, victim);
    if (ev.zone === 'head') row.classList.add('headshot');
    this.killFeed.push(row);
    while (this.killFeed.length > 6) this.killFeed.shift().remove();
    setTimeout(() => { row.classList.add('fade'); }, 5000);
    setTimeout(() => {
      row.remove();
      const i = this.killFeed.indexOf(row);
      if (i >= 0) this.killFeed.splice(i, 1);
    }, 6500);
  }

  addChat(name, text, team) {
    const row = el('div', 'chat-row', this.chatLog);
    const n = el('span', 'chat-name', row, name + ':');
    n.style.color = team !== undefined ? (TEAMS[team]?.css || '#fff') : '#f2b63a';
    el('span', '', row, ' ' + text);
    while (this.chatLog.children.length > 8) this.chatLog.firstChild.remove();
    setTimeout(() => { row.classList.add('fade'); }, 12000);
    setTimeout(() => row.remove(), 14000);
  }

  damageFrom(angle, yaw) {
    // angle is world-space direction to the attacker; rotate into view space.
    const rel = angle - yaw;
    const div = el('div', 'dmg-mark', this.dmgWrap);
    div.style.transform = `rotate(${rel}rad)`;
    this.damageMarks.push({ el: div, t: 1.1 });
  }

  openChat() {
    this.chatOpen = true;
    this.chatForm.classList.remove('hidden');
    this.chatInput.focus();
    this.releasePointer?.();
  }

  closeChat() {
    this.chatOpen = false;
    this.chatForm.classList.add('hidden');
    this.chatInput.blur();
    this.requestPointer?.();
  }

  toggleScoreboard(v) {
    this.scoreboardOpen = v;
    this.scoreboard.classList.toggle('hidden', !v);
  }

  setScoreboard(roster, score, mode) {
    if (!this.scoreboardOpen) return;
    this.scoreTable.innerHTML = '';
    const header = el('div', 'score-row head', this.scoreTable);
    for (const h of ['PLAYER', 'TEAM', 'K', 'D', 'PING']) el('span', '', header, h);
    const sorted = [...roster].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    for (const p of sorted) {
      const row = el('div', 'score-row', this.scoreTable);
      if (p.id === this.playerId) row.classList.add('me');
      el('span', 'score-name', row, p.name + (p.bot ? ' ·BOT' : ''));
      const t = el('span', '', row, TEAMS[p.team]?.name || '—');
      t.style.color = TEAMS[p.team]?.css || '#fff';
      el('span', '', row, String(p.kills));
      el('span', '', row, String(p.deaths));
      el('span', '', row, String(p.ping ?? '—'));
    }
  }

  setStats(text) { if (this.stats.textContent !== text) this.stats.textContent = text; }

  setPrompt(text) { this.prompt = text; }

  setSpectating(name) { this.spectating = name; }

  showReconnect(text) {
    this.center.textContent = text;
    this.center.classList.add('show');
  }

  hideReconnect() {
    if (!this.spectating) this.center.classList.remove('show');
  }
}
