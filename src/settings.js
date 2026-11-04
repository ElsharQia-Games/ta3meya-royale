// User settings, persisted in localStorage. No side effects on import.
const KEY = 'frontline.settings.v1';

export const DEFAULTS = {
  sensitivity: 1.0,
  adsSensitivity: 0.72,
  fov: 80,
  invertY: false,
  volume: 0.65,
  quality: 'high',        // high | medium | low
  shadows: true,
  bloom: true,
  showFps: true,
  crosshair: '#7dffb0',
  minimap: true,
  name: 'Soldier',
  room: 'ALPHA01',
  mode: 'br',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

export function qualityPreset(name) {
  if (name === 'low') {
    return { pixelRatio: 0.85, shadows: false, bloom: false, cascades: 1, shadowMap: 512, fogDensity: 0.0022, viewDistance: 700 };
  }
  if (name === 'medium') {
    return { pixelRatio: 1.15, shadows: true, bloom: false, cascades: 2, shadowMap: 1024, fogDensity: 0.0018, viewDistance: 1000 };
  }
  return { pixelRatio: 1.65, shadows: true, bloom: true, cascades: 3, shadowMap: 2048, fogDensity: 0.0015, viewDistance: 1400 };
}
