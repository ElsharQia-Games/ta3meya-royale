// ============================================================================
// Frontline — central tuning. Imported by client and server. No side effects.
// All distances in metres, times in seconds, angles in radians.
// ============================================================================

export const CFG = {
  SIM_HZ: 60,
  SIM_DT: 1 / 60,
  SNAPSHOT_HZ: 30,
  INTERP_DELAY: 0.1,          // client renders remote players this far in the past
  MAX_REWIND: 0.4,            // server lag-comp clamp
  HISTORY_SECONDS: 1.0,

  MAP: {
    SIZE: 1000,               // 1 km x 1 km
    SEED: 20261104,
    GRID: 257,                // terrain samples per side
    BOUNDS: 492,              // playable half-extent
    WATER_LEVEL: -1.6,
  },

  PLAYER: {
    RADIUS: 0.38,
    HEIGHT: 1.82,
    CROUCH_HEIGHT: 1.18,
    PRONE_HEIGHT: 0.58,
    EYE: 1.64,
    CROUCH_EYE: 1.02,
    PRONE_EYE: 0.34,
    WALK: 4.5,
    SPRINT: 7.1,
    CROUCH: 2.15,
    PRONE: 0.95,
    ADS: 2.9,
    SWIM: 2.4,
    JUMP: 7.0,
    GRAVITY: 20.0,
    STEP_HEIGHT: 0.5,
    SLOPE_MAX: 0.72,          // tan(35.7°)
    GROUND_ACCEL: 55,
    GROUND_FRICTION: 9.5,
    AIR_ACCEL: 14,
    AIR_CONTROL: 0.32,
    COYOTE: 0.11,
    JUMP_BUFFER: 0.12,
    MAX_HEALTH: 100,
    MAX_ARMOR: 100,
    HEALTH_REGEN_DELAY: 7,
    HEALTH_REGEN_RATE: 2.2,
    FALL_DAMAGE_MIN: 9.5,     // m/s impact speed
    FALL_DAMAGE_SCALE: 7,
    STANCE_TIME: 0.16,
    MAX_PITCH: 1.5,
  },

  // ---------------------------------------------------------------------------
  // Weapons. `mv` m/s, `drag` quadratic coefficient, `grav` gravity scale.
  // Spread values are cone half-angle radians. Recoil is radians per shot.
  // ---------------------------------------------------------------------------
  WEAPONS: {
    pistol: {
      name: 'P92', cls: 'pistol', auto: false, dmg: 27, rpm: 420, mag: 15, reserve: 60,
      reload: 1.65, mv: 380, drag: 0.0012, grav: 0.75,
      spreadHip: 0.020, spreadAds: 0.0055, spreadMove: 0.030, spreadAir: 0.065,
      recoilPitch: 0.011, recoilYaw: 0.0045, recoilRecover: 11,
      pellets: 1, penetration: 0.07, falloff: [30, 85, 0.55],
      adsZoom: 1.18, adsTime: 0.16, sway: 0.55, switchTime: 0.3, headshot: 2.2,
      tracer: 0xffd27a, audio: 'pistol', lootTier: 1,
    },
    smg: {
      name: 'MP5', cls: 'smg', auto: true, dmg: 21, rpm: 720, mag: 30, reserve: 120,
      reload: 2.1, mv: 420, drag: 0.0011, grav: 0.8,
      spreadHip: 0.026, spreadAds: 0.010, spreadMove: 0.030, spreadAir: 0.075,
      recoilPitch: 0.0085, recoilYaw: 0.006, recoilRecover: 9,
      pellets: 1, penetration: 0.09, falloff: [18, 55, 0.5],
      adsZoom: 1.22, adsTime: 0.2, sway: 0.6, switchTime: 0.35, headshot: 2.1,
      tracer: 0xffd27a, audio: 'smg', lootTier: 2,
    },
    ar: {
      name: 'AR-4', cls: 'ar', auto: true, dmg: 31, rpm: 690, mag: 30, reserve: 150,
      reload: 2.2, mv: 880, drag: 0.0007, grav: 0.62,
      spreadHip: 0.018, spreadAds: 0.0045, spreadMove: 0.026, spreadAir: 0.07,
      recoilPitch: 0.0125, recoilYaw: 0.0075, recoilRecover: 8.5,
      pellets: 1, penetration: 0.16, falloff: [45, 140, 0.58],
      adsZoom: 1.28, adsTime: 0.24, sway: 0.5, switchTime: 0.4, headshot: 2.3,
      tracer: 0xffe08a, audio: 'ar', lootTier: 3,
    },
    dmr: {
      name: 'SKS', cls: 'dmr', auto: false, dmg: 54, rpm: 300, mag: 10, reserve: 60,
      reload: 2.5, mv: 900, drag: 0.00055, grav: 0.55,
      spreadHip: 0.022, spreadAds: 0.0018, spreadMove: 0.03, spreadAir: 0.08,
      recoilPitch: 0.026, recoilYaw: 0.010, recoilRecover: 7,
      pellets: 1, penetration: 0.24, falloff: [80, 240, 0.62],
      adsZoom: 2.2, adsTime: 0.3, sway: 0.8, switchTime: 0.45, headshot: 2.35,
      tracer: 0xffe08a, audio: 'dmr', lootTier: 3,
    },
    shotgun: {
      name: 'M870', cls: 'shotgun', auto: false, dmg: 17, rpm: 78, mag: 6, reserve: 36,
      reload: 2.8, mv: 390, drag: 0.0016, grav: 0.8,
      spreadHip: 0.052, spreadAds: 0.034, spreadMove: 0.02, spreadAir: 0.03,
      recoilPitch: 0.038, recoilYaw: 0.012, recoilRecover: 6,
      pellets: 8, penetration: 0.04, falloff: [7, 26, 0.25],
      adsZoom: 1.1, adsTime: 0.2, sway: 0.7, switchTime: 0.45, headshot: 1.6,
      tracer: 0xffc060, audio: 'shotgun', lootTier: 2,
    },
    sniper: {
      name: 'K98', cls: 'sniper', auto: false, dmg: 102, rpm: 42, mag: 5, reserve: 30,
      reload: 3.1, mv: 945, drag: 0.0004, grav: 0.5,
      spreadHip: 0.05, spreadAds: 0.0006, spreadMove: 0.05, spreadAir: 0.1,
      recoilPitch: 0.045, recoilYaw: 0.014, recoilRecover: 5.5,
      pellets: 1, penetration: 0.38, falloff: [120, 500, 0.7],
      adsZoom: 4.2, adsTime: 0.38, sway: 1.0, switchTime: 0.55, headshot: 2.5,
      tracer: 0xfff0b0, audio: 'sniper', lootTier: 4,
    },
    lmg: {
      name: 'M249', cls: 'lmg', auto: true, dmg: 26, rpm: 760, mag: 75, reserve: 225,
      reload: 4.6, mv: 850, drag: 0.00075, grav: 0.65,
      spreadHip: 0.03, spreadAds: 0.0075, spreadMove: 0.025, spreadAir: 0.08,
      recoilPitch: 0.0105, recoilYaw: 0.0085, recoilRecover: 8,
      pellets: 1, penetration: 0.2, falloff: [50, 160, 0.55],
      adsZoom: 1.25, adsTime: 0.32, sway: 0.7, switchTime: 0.6, headshot: 2.2,
      tracer: 0xffe08a, audio: 'lmg', lootTier: 4,
    },
  },

  WEAPON_ORDER: ['pistol', 'smg', 'ar', 'dmr', 'shotgun', 'sniper', 'lmg'],

  ARMOR: { absorb: 0.45, headAbsorb: 0.25, max: 100 },
  GRENADE: { dmg: 110, radius: 7.5, fuse: 3.2, throwSpeed: 19, bounces: 4, drag: 0.15, gravity: 0.9 },
  SMOKE: { fuse: 2.0, radius: 5.5, duration: 16 },
  HEAL: {
    bandage: { amount: 20, time: 2.0, cap: 75 },
    medkit: { amount: 75, time: 5.0, cap: 100 },
  },
  LOOT: { pickupRange: 2.2, dropRange: 2.0 },
  INVENTORY: { slots: 2, ammoPerPickup: { pistol: 30, smg: 45, ar: 60, dmr: 30, shotgun: 12, sniper: 10, lmg: 75 } },

  ZONE: {
    // wait -> shrink; radius is the target at the end of the phase.
    phases: [
      { wait: 45, shrink: 40, r: 330, dps: 1 },
      { wait: 30, shrink: 35, r: 210, dps: 2 },
      { wait: 25, shrink: 30, r: 130, dps: 4 },
      { wait: 20, shrink: 25, r: 75, dps: 7 },
      { wait: 15, shrink: 20, r: 34, dps: 10 },
      { wait: 12, shrink: 18, r: 8, dps: 14 },
    ],
    initialRadius: 450,
  },

  VEHICLE: {
    mass: 1400, wheelRadius: 0.42, wheelBase: 2.9, track: 1.72,
    suspensionRest: 0.55, suspensionK: 42000, suspensionD: 5200,
    engineForce: 11500, brakeForce: 16000, maxSpeed: 27, reverseMax: 8,
    steerMax: 0.62, steerSpeed: 3.2, grip: 9.5, drag: 0.42,
    enterRange: 3.4, seats: 4, health: 450,
    wheelMountHeight: .3, suspensionTravel: .42, minClearance: .26,
    floodDepth: .95, impactDamage: 5,
    occupantHeight: 1.0, eyeHeight: .82,
    bodies: {
      car: { width: 1.9, length: 4.2, height: 1.95, wheelBase: 2.9, track: 1.72 },
      truck: { width: 2.2, length: 5.6, height: 2.55, wheelBase: 3.5, track: 2.0 },
    },
  },

  MODES: {
    br: { name: 'Battle Royale', maxPlayers: 32, bots: 24, startCountdown: 8, warmup: 4 },
    tdm: { name: 'Team Deathmatch', maxPlayers: 24, bots: 16, scoreLimit: 60, timeLimit: 600, respawn: 4 },
  },

  BOT: {
    difficulty: 0.62,          // 0..1 aim skill
    think: 0.25,               // seconds between decisions
    viewRange: 120,
    reaction: 0.18,
    aimError: 0.028,           // radians at 100m, scaled
    burst: [3, 7],
    navCell: 6,                // coarse outdoor route grid
    interiorNavCell: 0.4,      // capsule-clearance grid around each building
    doorwayTolerance: 0.22,    // reach precise indoor corners before turning
  },

  NET: {
    inputHz: 60,
    maxInputsPerTick: 4,
    maxQueuedInputs: 64,
    snapshotKeyframeEvery: 30,
    eventRadius: 420,
    maxPlayers: 32,
  },

  GRAPHICS: {
    fov: 80,
    near: 0.04,
    far: 1600,
    shadowCascades: 3,
    shadowMap: 2048,
    maxPixelRatio: 1.75,
  },
};

export const MATERIALS = {
  concrete: { color: 0x9a9a92, roughness: 0.92, metalness: 0.02, surface: 'concrete', pen: 1.0 },
  brick:    { color: 0x8f5a44, roughness: 0.95, metalness: 0.0, surface: 'concrete', pen: 1.0 },
  plaster:  { color: 0xb9b2a2, roughness: 0.9, metalness: 0.0, surface: 'concrete', pen: 1.0 },
  wood:     { color: 0x8a643c, roughness: 0.85, metalness: 0.0, surface: 'wood', pen: 2.2 },
  metal:    { color: 0x6f747b, roughness: 0.45, metalness: 0.75, surface: 'metal', pen: 1.6 },
  sandbag:  { color: 0x9b8a63, roughness: 1.0, metalness: 0.0, surface: 'sand', pen: 0.35 },
  glass:    { color: 0x9fc7d8, roughness: 0.1, metalness: 0.1, surface: 'glass', pen: 8.0 },
  rock:     { color: 0x777a7d, roughness: 0.95, metalness: 0.02, surface: 'rock', pen: 0.5 },
  dirt:     { color: 0x6a5940, roughness: 1.0, metalness: 0.0, surface: 'dirt', pen: 0.5 },
  road:     { color: 0x3d4045, roughness: 0.95, metalness: 0.0, surface: 'concrete', pen: 1.0 },
};

export const TEAMS = [
  { name: 'Vanguard', color: 0x5aa9ff, css: '#5aa9ff' },
  { name: 'Legion', color: 0xff6a5c, css: '#ff6a5c' },
];

export const STANCE = { STAND: 0, CROUCH: 1, PRONE: 2 };
export const MATCH_STATE = { LOBBY: 0, WARMUP: 1, LIVE: 2, ENDED: 3 };
