// Objective mix audit for the Phase 4 weapon/reload samples.
//
//   node qa/audio-mix-audit.mjs
//
// This is NOT a substitute for a human listening test. It measures the
// delivered files with EBU R128 so gain-staging regressions inside a weapon
// pool (one variant much louder/quieter than its siblings) are visible in CI.
// The report records that subjective spatial/layering listening remains open.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOUNDS, RELOAD_SOUNDS, UI_SOUNDS } from '../src/audio/sounds.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audioDir = path.join(root, 'public/audio');
const reportPath = path.join(root, 'qa/reports/stabilization-audio-mix.json');

function measureClip(name) {
  const file = path.join(audioDir, `${name}.ogg`);
  const run = spawnSync('ffmpeg', [
    '-nostats', '-hide_banner', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const text = `${run.stdout || ''}${run.stderr || ''}`;
  // Progress lines also contain "I:"; only the summary is authoritative.
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const integrated = summary.match(/I:\s*(-?\d+(?:\.\d+)?) LUFS/);
  const peak = summary.match(/Peak:\s*(-?\d+(?:\.\d+)?) dBFS/);
  // Momentary loudness peaks are a better proxy for a sub-second gunshot than
  // integrated loudness, which rewards a longer decay tail.
  const momentary = [...text.matchAll(/M:\s*(-?\d+(?:\.\d+)?)/g)]
    .map(m => Number(m[1])).filter(v => Number.isFinite(v));
  return {
    name,
    file: path.relative(root, file),
    integratedLufs: integrated ? Number(integrated[1]) : null,
    maxMomentaryLufs: momentary.length ? Math.max(...momentary) : null,
    truePeakDbfs: peak ? Number(peak[1]) : null,
  };
}

const shots = [];
for (const [weapon, clips] of Object.entries(SOUNDS.shot.clips)) {
  const measured = clips.map(measureClip);
  const levels = measured.map(m => m.maxMomentaryLufs).filter(v => v != null);
  const integrated = measured.map(m => m.integratedLufs).filter(v => v != null);
  const min = Math.min(...levels), max = Math.max(...levels);
  shots.push({
    weapon,
    clips: measured,
    spreadLu: levels.length > 1 ? Math.round((max - min) * 10) / 10 : 0,
    meanLufs: levels.length ? Math.round(levels.reduce((a, b) => a + b, 0) / levels.length * 10) / 10 : null,
    integratedSpreadLu: integrated.length > 1
      ? Math.round((Math.max(...integrated) - Math.min(...integrated)) * 10) / 10 : 0,
  });
}

const layerNames = new Set([
  ...SOUNDS.distantShot.clips,
  ...SOUNDS.shellCasing.clips,
  ...SOUNDS.magOut.clips,
  ...SOUNDS.magIn.clips,
  ...SOUNDS.bolt.clips,
  ...SOUNDS.shell.clips,
  ...SOUNDS.pump.clips,
  ...Object.values(RELOAD_SOUNDS),
  ...Object.values(UI_SOUNDS),
]);
const layers = [...layerNames].filter(Boolean).sort().map(measureClip);

const result = {
  measuredAt: new Date().toISOString(),
  method: 'ffmpeg ebur128=peak=true over the shipped 48 kHz mono OGG files',
  disclaimer: 'Objective loudness/peak audit only. No human listening test was performed in this environment.',
  shots,
  layers,
  flags: shots.filter(s => s.spreadLu > 4).map(s => ({
    weapon: s.weapon, spreadLu: s.spreadLu,
    note: 'max-momentary level differs by more than 4 LU inside the pool; check gain staging',
  })),
};

mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(result, null, 2));

for (const shot of shots) {
  console.log(`${shot.weapon.padEnd(8)} mean ${String(shot.meanLufs).padStart(6)} LUFS  momentary spread ${shot.spreadLu} LU  integrated spread ${shot.integratedSpreadLu} LU`);
}
console.log(`layers measured: ${layers.length}`);
console.log(`flags: ${result.flags.length}`);
console.log(`report: ${path.relative(root, reportPath)}`);
