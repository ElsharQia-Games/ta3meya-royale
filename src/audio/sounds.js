// Central, declarative definition of every logical game sound.
//
// The audio engine never hard-codes clip names: it resolves a logical sound
// through this table. Each entry inherits mixing defaults from its category
// and may override gain, priority, distance range, filtering and reverb.
//
// Clip names must exist in `public/audio/manifest.json`. test/phase4-audio.test.js
// enforces both directions (every referenced clip ships, every shipped clip is
// referenced) so the bank cannot silently drift from the definitions.

// Mixing classes. Priority is relative: emergency warnings sit above gunfire,
// gunfire above impacts, ambience below everything. Voice caps keep one class
// from monopolising the global budget during a busy firefight.
export const CATEGORY_DEFAULTS = Object.freeze({
  shot: {
    group: 'core', priority: 70, maxVoices: 8, gain: 1,
    range: { ref: 4, rolloff: 0.42, max: 420 },
    filter: { near: 15000, far: 1800, ref: 8, span: 60 },
    reverb: 0.22, rate: [0.97, 1.03], cooldown: 0.015,
  },
  distant: {
    group: 'core', priority: 20, maxVoices: 3, gain: 0.6,
    range: { ref: 8, rolloff: 0.7, max: 640 },
    filter: { near: 4200, far: 700, ref: 10, span: 70 },
    reverb: 0.34, rate: [0.96, 1.04], cooldown: 0.02,
  },
  explosion: {
    group: 'core', priority: 95, maxVoices: 5, gain: 1,
    range: { ref: 10, rolloff: 0.5, max: 700 },
    filter: { near: 12000, far: 1100, ref: 14, span: 80 },
    reverb: 0.42, rate: [0.96, 1.04], cooldown: 0.04,
  },
  body: {
    group: 'core', priority: 55, maxVoices: 4, gain: 0.85,
    range: { ref: 4, rolloff: 0.42, max: 180 },
    filter: { near: 9000, far: 1400, ref: 6, span: 40 },
    reverb: 0.12, rate: [0.96, 1.04], cooldown: 0.02,
  },
  impact: {
    group: 'core', priority: 40, maxVoices: 6, gain: 0.8,
    range: { ref: 3, rolloff: 0.5, max: 120 },
    filter: { near: 12000, far: 1600, ref: 5, span: 35 },
    reverb: 0.1, rate: [0.9, 1.12], cooldown: 0.02,
  },
  footstep: {
    group: 'core', priority: 35, maxVoices: 6, gain: 0.55,
    range: { ref: 2, rolloff: 0.55, max: 70 },
    filter: { near: 9000, far: 1500, ref: 4, span: 20 },
    reverb: 0.06, rate: [0.94, 1.06], cooldown: 0,
  },
  jump: {
    group: 'core', priority: 45, maxVoices: 2, gain: 0.7,
    range: { ref: 3, rolloff: 0.5, max: 90 },
    filter: { near: 9000, far: 1600, ref: 4, span: 25 },
    reverb: 0.06, rate: [0.95, 1.05], cooldown: 0.1,
  },
  land: {
    group: 'core', priority: 50, maxVoices: 2, gain: 0.8,
    range: { ref: 3, rolloff: 0.5, max: 90 },
    filter: { near: 9000, far: 1600, ref: 4, span: 25 },
    reverb: 0.06, rate: [0.95, 1.05], cooldown: 0.08,
  },
  mechanism: {
    group: 'core', priority: 62, maxVoices: 4, gain: 0.55,
    range: { ref: 2, rolloff: 0.5, max: 60 },
    filter: { near: 12000, far: 2500, ref: 4, span: 15 },
    reverb: 0.05, rate: [0.94, 1.06], cooldown: 0.01,
  },
  reload: {
    group: 'core', priority: 52, maxVoices: 2, gain: 0.5,
    range: { ref: 2, rolloff: 0.5, max: 50 },
    filter: { near: 12000, far: 3000, ref: 3, span: 12 },
    reverb: 0.05, rate: [0.97, 1.03], cooldown: 0.05,
  },
  ui: {
    group: 'core', priority: 85, maxVoices: 3, gain: 0.2,
    range: { ref: 2, rolloff: 0.5, max: 20 },
    filter: { near: 16000, far: 6000, ref: 4, span: 10 },
    reverb: 0, rate: [0.98, 1.02], cooldown: 0.01,
  },
  vehicleLoop: {
    group: 'vehicle', priority: 32, maxVoices: 2, gain: 0.5,
    range: { ref: 8, rolloff: 0.45, max: 120 },
    filter: { near: 2400, far: 700, ref: 10, span: 40 },
    reverb: 0.18, rate: [1, 1], cooldown: 0,
  },
  vehicleOne: {
    group: 'vehicle', priority: 65, maxVoices: 4, gain: 0.75,
    range: { ref: 4, rolloff: 0.45, max: 180 },
    filter: { near: 10000, far: 1800, ref: 8, span: 45 },
    reverb: 0.16, rate: [0.95, 1.05], cooldown: 0.03,
  },
  ambience: {
    group: 'ambience', priority: 10, maxVoices: 3, gain: 0.8,
    range: { ref: 10, rolloff: 0.2, max: 1000 },
    filter: { near: 16000, far: 4000, ref: 10, span: 100 },
    reverb: 0.2, rate: [1, 1], cooldown: 0,
  },
  alarm: {
    group: 'core', priority: 88, maxVoices: 1, gain: 0.5,
    range: { ref: 4, rolloff: 0.35, max: 200 },
    filter: { near: 8000, far: 1800, ref: 8, span: 40 },
    reverb: 0.18, rate: [1, 1], cooldown: 0,
  },
  whiz: {
    group: 'core', priority: 78, maxVoices: 2, gain: 0.9,
    range: { ref: 1, rolloff: 0.6, max: 25 },
    filter: { near: 14000, far: 3000, ref: 2, span: 8 },
    reverb: 0.04, rate: [0.9, 1.1], cooldown: 0.03,
  },
  raw: {
    group: 'core', priority: 60, maxVoices: 40, gain: 1,
    range: { ref: 4, rolloff: 0.35, max: 500 },
    filter: { near: 16000, far: 1600, ref: 6, span: 50 },
    reverb: 0.08, rate: [1, 1], cooldown: 0,
  },
});

function define(category, clips, overrides = {}) {
  const base = CATEGORY_DEFAULTS[category];
  if (!base) throw new Error(`unknown sound category: ${category}`);
  return {
    ...base,
    ...overrides,
    category,
    clips,
    range: { ...base.range, ...(overrides.range || {}) },
    filter: { ...base.filter, ...(overrides.filter || {}) },
    rate: overrides.rate || base.rate,
  };
}

export const SOUNDS = {
  // ---------------------------------------------------------------- weapons
  shot: define('shot', {
    pistol: ['pistol-a', 'pistol-b', 'pistol-c', 'pistol-d'],
    smg: ['smg-a', 'smg-b', 'smg-c-1', 'smg-c-2'],
    ar: ['ar-a', 'ar-b'],
    dmr: ['dmr-a', 'dmr-b', 'dmr-c', 'dmr-d'],
    shotgun: ['shotgun-a', 'shotgun-b', 'shotgun-c', 'shotgun-d'],
    sniper: ['sniper-a', 'sniper-b', 'sniper-c', 'sniper-d'],
    lmg: ['lmg-a', 'lmg-b', 'lmg-c-1', 'lmg-c-2'],
    rpg: ['rocket-launch'],
  }),
  distantShot: define('distant', ['distant-1', 'distant-2', 'distant-3', 'distant-4']),
  distantExplosion: define('distant', ['distant-explosion'], { gain: 0.7 }),
  whiz: define('whiz', ['whiz-a', 'whiz-b']),

  // ------------------------------------------------------------- explosives
  explosion: define('explosion', ['explosion-a', 'explosion-b', 'explosion-c']),
  rocketLaunch: define('explosion', ['rocket-launch'], { gain: 0.9 }),
  vehicleDestroy: define('explosion', ['vehicle-destroy']),

  // ------------------------------------------------------------------- body
  fleshImpact: define('body', ['impact-flesh-a-1', 'impact-flesh-a-2', 'impact-flesh-a-3', 'impact-flesh-d']),
  bodyFall: define('body', ['body-fall'], { gain: 0.9 }),
  damage: define('body', ['damage'], { gain: 1, priority: 90 }),

  // ---------------------------------------------------------------- impacts
  impactConcrete: define('impact', ['impact-concrete-a', 'impact-concrete-b', 'impact-concrete-c']),
  impactWood: define('impact', ['impact-wood-a', 'impact-wood-b', 'impact-wood-c']),
  impactMetal: define('impact', ['impact-metal-a', 'impact-metal-b', 'impact-metal-c'], {
    filter: { near: 13000, far: 2200, ref: 5, span: 35 },
  }),
  impactDirt: define('impact', ['impact-dirt-a', 'impact-dirt-b'], {
    filter: { near: 6000, far: 1200, ref: 5, span: 30 },
  }),
  impactGlass: define('impact', ['impact-glass-a', 'impact-glass-b']),
  impactWater: define('impact', ['impact-water-a', 'impact-water-b']),
  destruction: define('impact', ['destruction-a', 'destruction-b'], { gain: 1, priority: 70 }),
  shellCasing: define('impact', ['shell-casing'], { gain: 0.35, priority: 12, maxVoices: 2, cooldown: 0.05 }),

  // -------------------------------------------------------------- footsteps
  footstepConcrete: define('footstep', ['step-concrete-a', 'step-concrete-b', 'step-concrete-c']),
  footstepWood: define('footstep', ['step-wood-a', 'step-wood-b', 'step-wood-c']),
  footstepGrass: define('footstep', ['step-grass-a', 'step-grass-b', 'step-grass-c']),
  footstepDirt: define('footstep', ['step-dirt-a', 'step-dirt-b', 'step-dirt-c']),
  footstepMetal: define('footstep', ['step-metal-a', 'step-metal-b']),
  footstepWater: define('footstep', ['step-water-a', 'step-water-b'], { gain: 0.7 }),
  jump: define('jump', ['jump-a', 'jump-b']),
  land: define('land', ['land-a', 'land-b', 'land-c']),

  // ------------------------------------------------------- weapon mechanism
  magOut: define('mechanism', ['mag-out-a', 'mag-out-b']),
  magIn: define('mechanism', ['mag-in-a', 'mag-in-b']),
  bolt: define('mechanism', ['bolt-a', 'bolt-b']),
  shell: define('mechanism', ['shell-a', 'shell-b'], { gain: 0.45 }),
  pump: define('mechanism', ['pump-1']),
  weaponSwitch: define('mechanism', ['weapon-switch-a-1', 'weapon-switch-a-2', 'weapon-switch-a-3']),
  dryFire: define('mechanism', ['dry-fire'], { gain: 0.6 }),
  reloadHandgun: define('reload', ['reload-handgun']),
  reloadRifle: define('reload', ['reload-rifle']),
  reloadGeneric: define('reload', ['reload-generic']),
  reloadAlt: define('reload', ['reload-alt-a', 'reload-alt-b']),

  // --------------------------------------------------------------- interface
  uiSelect: define('ui', ['ui-select']),
  uiConfirm: define('ui', ['ui-confirm']),
  uiError: define('ui', ['ui-error']),
  uiOpen: define('ui', ['ui-open']),
  uiClick: define('ui', ['ui-click'], { gain: 0.15 }),
  pickup: define('ui', ['pickup'], { gain: 0.35 }),
  heal: define('ui', ['heal'], { gain: 0.35 }),
  hitmarker: define('ui', ['hitmarker'], { gain: 0.4 }),
  killConfirm: define('ui', ['kill-confirm'], { gain: 0.4 }),

  // ---------------------------------------------------------------- vehicles
  engineIdle: define('vehicleLoop', ['engine-idle-a', 'engine-idle-b', 'engine-idle-c'], { loop: true }),
  engineDrive: define('vehicleLoop', ['engine-drive-a', 'engine-drive-b'], { loop: true }),
  tireSkid: define('vehicleLoop', ['tire-skid-a', 'tire-skid-b'], {
    loop: true, gain: 0.35, maxVoices: 1, priority: 28,
  }),
  engineStart: define('vehicleOne', ['engine-start'], { gain: 0.7 }),
  engineStop: define('vehicleOne', ['engine-stop'], { gain: 0.6 }),
  brake: define('vehicleOne', ['brake'], { gain: 0.55, cooldown: 0.6 }),
  doorOpen: define('vehicleOne', ['door-open'], { gain: 0.65 }),
  doorClose: define('vehicleOne', ['door-close'], { gain: 0.65 }),
  vehicleImpact: define('vehicleOne', ['vehicle-impact-a', 'vehicle-impact-b']),

  // ------------------------------------------------------ ambience / warning
  ambWind: define('ambience', ['amb-wind'], { loop: true, gain: 0.9 }),
  ambBirds: define('ambience', ['amb-birds'], { loop: true, gain: 0.55 }),
  ambBattle: define('ambience', ['amb-battle'], { loop: true, gain: 0.5 }),
  zoneAlarm: define('alarm', ['zone-alarm'], { loop: true }),
};

// Material -> logical impact sound. Unknown materials fall back to concrete,
// which is the most common generated world surface.
export const IMPACT_SOUNDS = Object.freeze({
  concrete: 'impactConcrete', road: 'impactConcrete', rock: 'impactConcrete', sandbag: 'impactConcrete',
  wood: 'impactWood', dirt: 'impactDirt', grass: 'impactDirt', metal: 'impactMetal',
  glass: 'impactGlass', water: 'impactWater', flesh: 'fleshImpact', body: 'fleshImpact',
});

// Surface -> footsteps. The world reports raw box materials and the player
// reports 'water' while submerged.
export const FOOTSTEP_SOUNDS = Object.freeze({
  concrete: 'footstepConcrete', road: 'footstepConcrete', rock: 'footstepConcrete',
  sandbag: 'footstepDirt', wood: 'footstepWood', grass: 'footstepGrass',
  dirt: 'footstepDirt', metal: 'footstepMetal', water: 'footstepWater',
});

export const UI_SOUNDS = Object.freeze({
  select: 'uiSelect', click: 'uiClick', confirm: 'uiConfirm',
  deploy: 'uiConfirm', error: 'uiError', open: 'uiOpen',
});

export const RELOAD_SOUNDS = Object.freeze({
  pistol: 'reloadHandgun', smg: 'reloadHandgun', shotgun: 'reloadGeneric',
  rpg: 'reloadAlt', ar: 'reloadRifle', dmr: 'reloadRifle',
  lmg: 'reloadRifle', sniper: 'reloadRifle',
});

// Flat list of every clip name referenced by a definition. Objects (weapon
// maps) are expanded. Used by tests and by the startup integrity check.
export function allClipRefs() {
  const out = new Set();
  for (const def of Object.values(SOUNDS)) {
    if (Array.isArray(def.clips)) def.clips.forEach(name => out.add(name));
    else for (const pool of Object.values(def.clips)) pool.forEach(name => out.add(name));
  }
  return out;
}

// Pick one clip from a pool while avoiding the immediately previous choice.
export function pickClip(def, variant = null, last = null) {
  const pool = Array.isArray(def.clips) && variant == null ? def.clips
    : Array.isArray(def.clips) ? def.clips
      : def.clips?.[variant] || def.clips?.pistol || [];
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0];
  let index = Math.floor(Math.random() * pool.length);
  if (pool[index] === last) index = (index + 1) % pool.length;
  return pool[index];
}
