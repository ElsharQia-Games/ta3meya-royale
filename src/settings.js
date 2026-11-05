// User settings, persisted in localStorage. No side effects on import.
const KEY = 'frontline.settings.v1';

export const DEFAULTS = {
  sensitivity: 1.0,
  adsSensitivity: 0.72,
  fov: 80,
  invertY: false,
  volume: 0.65,
  muted: false,
  quality: 'high',        // high | medium | low
  shadows: true,
  bloom: false,
  showFps: false,
  crosshair: '#e7efc9',
  minimap: true,
  name: 'Soldier',
  room: 'ALPHA01',
  mode: 'br',
  kit: 'assault',
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

export function resetSettings() {
  const defaults = { ...DEFAULTS };
  saveSettings(defaults);
  return defaults;
}

export function qualityPreset(name) {
  if (name === 'low') {
    return { pixelRatio: 0.85, shadows: false, bloom: false, cascades: 0, shadowMap: 512, fogDensity: 0.0022, viewDistance: 650 };
  }
  if (name === 'medium') {
    return { pixelRatio: 1.0, shadows: true, bloom: false, cascades: 1, shadowMap: 1024, fogDensity: 0.0018, viewDistance: 950 };
  }
  return { pixelRatio: 1.0, shadows: true, bloom: false, cascades: 2, shadowMap: 1024, fogDensity: 0.0015, viewDistance: 1250 };
}
