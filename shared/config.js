// ALL gameplay tuning lives here. Both client and server import this.
export const CFG = {
  SIM_DT: 1 / 60,          // fixed physics step (sec)
  TICK_HZ: 30,             // server snapshot rate
  MAP_SIZE: 1000,          // world is 1000x1000 m
  WORLD_SCALE: 1,          // 1 unit = 1 meter
  GRAVITY: 22,             // m/s^2 (snappy, game feel)

  PLAYER: {
    RADIUS: 0.45, HEIGHT: 1.8, CROUCH_HEIGHT: 1.1, PRONE_HEIGHT: 0.6,
    WALK: 4.2, SPRINT: 7.3, CROUCH: 2.0, PRONE: 1.0, ADS: 2.6,
    JUMP: 7.6, STEP_HEIGHT: 0.55, SLOPE_MAX: 0.6, AIR_CONTROL: 0.35,
    ACCEL_GND: 14, ACCEL_AIR: 3.5, FRICTION: 10, MAX_HEALTH: 100, EYE: 1.62
  },

  WEAPONS: {
    pistol:  { dmg: 26, rpm: 360, auto: false, mag: 12,  mv: 340,  spread: 0.012, ads: 0.006, reload: 1.0,  rPitch: 0.013, rYaw: 0.006,  falloff: [25, 60],  pellet: 1,  name: 'P229' },
    smg:     { dmg: 17, rpm: 900, auto: true,  mag: 32,  mv: 380,  spread: 0.028, ads: 0.014, reload: 1.6,  rPitch: 0.010, rYaw: 0.008,  falloff: [15, 30],  pellet: 1,  name: 'MPX' },
    ar:      { dmg: 30, rpm: 650, auto: true,  mag: 30,  mv: 800,  spread: 0.016, ads: 0.007, reload: 1.9,  rPitch: 0.016, rYaw: 0.010,  falloff: [25, 80],  pellet: 1,  name: 'AR-47' },
    shotgun: { dmg: 14, rpm: 70,  auto: false, mag: 6,   mv: 390,  spread: 0.045, ads: 0.028, reload: 2.4,  rPitch: 0.040, rYaw: 0.020,  falloff: [8,  25],  pellet: 8,  name: 'M870' },
    sniper:  { dmg: 95, rpm: 42,  auto: false, mag: 5,   mv: 920,  spread: 0.002, ads: 0.001, reload: 2.8,  rPitch: 0.030, rYaw: 0.012,  falloff: [40, 150], pellet: 1,  name: 'Kar98' },
    lmg:     { dmg: 22, rpm: 550, auto: true,  mag: 50,  mv: 820,  spread: 0.020, ads: 0.010, reload: 3.4,  rPitch: 0.018, rYaw: 0.012,  falloff: [25, 90],  pellet: 1,  name: 'PKM' }
  },
  GRENADE: { dmg: 90, radius: 6, fuse: 1.6, mv: 22, bounces: 3 },
  HEAL: { amount: 75, time: 2.5 },
  ZONE: {
    phases: [
      { wait: 25, shrink: 40, r: 330 }, { wait: 20, shrink: 35, r: 210 },
      { wait: 15, shrink: 30, r: 130 }, { wait: 12, shrink: 25, r: 70 },
      { wait: 10, shrink: 20, r: 30 },  { wait: 8,  shrink: 20, r: 4 }
    ],
    dps: [1, 2, 3, 5, 8, 12]
  },
  WATER: { level: 0.8, damage: 0, slow: 0.5 },
  VEHICLE: { accel: 11, maxSpeed: 26, turn: 1.9, brake: 16, wheelBase: 2.9, track: 1.7, suspension: 0.55, grip: 8 },
  MAX_PLAYERS: 32,
  BOT_COUNT: 12
};
