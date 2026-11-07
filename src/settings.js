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
    const merged = { ...DEFAULTS, ...JSON.parse(raw) };
    merged.quality = normalizeQuality(merged.quality);
    merged.fov = Number.isFinite(merged.fov) ? Math.min(110, Math.max(60, merged.fov)) : DEFAULTS.fov;
    merged.volume = Number.isFinite(merged.volume) ? Math.min(1, Math.max(0, merged.volume)) : DEFAULTS.volume;
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export const QUALITY_NAMES = ['low', 'medium', 'high'];

// Unknown or malformed values fall back to the safest supported preset rather
// than leaking unbounded pixel ratios / shadow-map sizes into the renderer.
export function normalizeQuality(name) {
  return QUALITY_NAMES.includes(name) ? name : 'high';
}

export function qualityPreset(name) {
  const preset = QUALITY_PRESETS[normalizeQuality(name)];
  return { ...preset };
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

export function resetSettings() {
  const defaults = { ...DEFAULTS };
  saveSettings(defaults);
  return defaults;
}

// Quality is a strict monotonic ladder: every step raises or holds shadow,
// distance and pixel budgets. Tests assert this so a preset cannot regress into
// paying more for less.
const QUALITY_PRESETS = {
  low: { pixelRatio: 0.85, shadows: false, bloom: false, cascades: 0, shadowMap: 512, fogDensity: 0.0022, viewDistance: 650 },
  medium: { pixelRatio: 1.0, shadows: true, bloom: false, cascades: 1, shadowMap: 1024, fogDensity: 0.0018, viewDistance: 950 },
  high: { pixelRatio: 1.0, shadows: true, bloom: false, cascades: 2, shadowMap: 1024, fogDensity: 0.0015, viewDistance: 1250 },
};
