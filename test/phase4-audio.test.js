// Phase 4 audio: asset inventory, central definitions, spatial math, voice
// limiting and lazy group loading. These run in Node without WebAudio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  SOUNDS, CATEGORY_DEFAULTS, IMPACT_SOUNDS, FOOTSTEP_SOUNDS,
  UI_SOUNDS, RELOAD_SOUNDS, allClipRefs, pickClip,
} from '../src/audio/sounds.js';
import {
  listenerBasis, distanceGain, spatialFor, pathProximity, nearestPath,
  indoorAt, cutoffFor,
} from '../src/audio/spatial.js';
import { VoiceBudget } from '../src/audio/voices.js';
import { SampleBank, ReloadCues } from '../src/audio/samples.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audioDir = path.join(root, 'public/audio');
const manifest = JSON.parse(readFileSync(path.join(audioDir, 'manifest.json'), 'utf8'));
const byName = new Map(manifest.clips.map(clip => [clip.name, clip]));

test('audio manifest ships every declared clip with provenance and hashes', () => {
  assert.equal(manifest.sampleRate, 48000);
  assert.equal(manifest.channels, 1);
  assert.ok(manifest.clips.length >= 120, `expected a full bank, got ${manifest.clips.length}`);
  for (const clip of manifest.clips) {
    assert.ok(clip.file.endsWith('.ogg'), `${clip.name} is not OGG`);
    assert.equal(clip.license, 'CC0-1.0', `${clip.name} is not CC0`);
    assert.ok(clip.author, `${clip.name} has no author`);
    assert.ok(clip.url, `${clip.name} has no source URL`);
    assert.ok(clip.downloadDate, `${clip.name} has no download date`);
    assert.ok(clip.bytes > 0 && clip.bytes < 200_000, `${clip.name} has an implausible size`);
    const file = path.join(audioDir, clip.file);
    assert.ok(statSync(file).isFile(), `${clip.name} file is missing`);
    const bytes = readFileSync(file);
    assert.equal(bytes.length, clip.bytes, `${clip.name} byte count drifted`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash, clip.sha256, `${clip.name} hash drifted`);
  }
  for (const [library, info] of Object.entries(manifest.libraries)) {
    assert.equal(info.license, 'CC0-1.0', `${library} is not CC0`);
  }
});

test('every logical sound references shipped clips and every shipped clip is used', () => {
  const refs = allClipRefs();
  for (const name of refs) assert.ok(byName.has(name), `sound definition references missing clip ${name}`);
  const unused = manifest.clips.map(clip => clip.name).filter(name => !refs.has(name));
  assert.deepEqual(unused, [], `unused shipped clips: ${unused.join(', ')}`);
  assert.equal(refs.size, manifest.clips.length);
});

test('sound definitions stay inside their category mixing contract', () => {
  for (const [name, def] of Object.entries(SOUNDS)) {
    assert.ok(CATEGORY_DEFAULTS[def.category], `${name} has an unknown category`);
    assert.ok(def.priority >= 0 && def.priority <= 100, `${name} priority out of range`);
    assert.ok(def.maxVoices >= 1 && def.maxVoices <= 40, `${name} voice cap out of range`);
    assert.ok(def.range.max > def.range.ref, `${name} range max must exceed ref`);
    assert.ok(def.filter.near > def.filter.far, `${name} filter near must exceed far`);
    assert.ok(def.gain > 0 && def.gain <= 2, `${name} gain out of range`);
    assert.ok(Array.isArray(def.rate) && def.rate[0] > 0 && def.rate[1] >= def.rate[0]);
    if (def.loop) assert.ok(['engineIdle', 'engineDrive', 'tireSkid', 'ambWind', 'ambBirds', 'ambBattle', 'zoneAlarm'].includes(name),
      `${name} must not loop`);
    if (Array.isArray(def.clips)) assert.ok(def.clips.length > 0, `${name} has no clips`);
    else assert.ok(Object.keys(def.clips).length > 0, `${name} has no weapon pools`);
  }
  assert.equal(SOUNDS.zoneAlarm.clips[0], 'zone-alarm');
  assert.equal(SOUNDS.shot.clips.rpg[0], 'rocket-launch');
});

test('pickClip varies and avoids immediate repetition', () => {
  const pool = { clips: ['a', 'b', 'c'] };
  let previous = null;
  for (let i = 0; i < 30; i++) {
    const clip = pickClip(pool, null, previous);
    assert.notEqual(clip, previous);
    previous = clip;
  }
  assert.ok(['ar-a', 'ar-b'].includes(pickClip(SOUNDS.shot, 'ar')));
  assert.equal(pickClip({ clips: [] }), null);
});

test('distance, stereo placement and propagation are predictable', () => {
  assert.equal(distanceGain(0), 1);
  assert.ok(distanceGain(10) > 0.6 && distanceGain(10) < 0.7);
  assert.equal(distanceGain(9999), 0);
  let last = 2;
  for (let d = 0; d <= 300; d += 10) {
    const g = distanceGain(d);
    assert.ok(g <= last + 1e-9, 'distance gain must be monotonic');
    last = g;
  }

  const right = spatialFor([0, 0, 0], 0, [10, 0, 0]);
  const left = spatialFor([0, 0, 0], 0, [-10, 0, 0]);
  const behind = spatialFor([0, 0, 0], 0, [0, 0, 10]);
  assert.ok(right.pan > 0.8);
  assert.ok(left.pan < -0.8);
  assert.ok(Math.abs(behind.pan) < 1e-9);
  assert.ok(behind.front < -0.9);
  assert.ok(right.delay > 0 && right.delay < 0.05);
  assert.equal(spatialFor([0, 0, 0], 0, [0, 0, 9000]), null);

  const basis = listenerBasis(Math.PI / 2);
  assert.ok(Math.abs(basis.forward[0] + 1) < 1e-9);
  assert.ok(Math.abs(basis.right[2] + 1) < 1e-9);
});

test('projectile path proximity drives whizz-by at the closest pass', () => {
  const pass = pathProximity([0, 1, 0], [0, 0, -20], [0, 0, 20], 0.2);
  assert.ok(Math.abs(pass.distance - 1) < 1e-9);
  assert.ok(Math.abs(pass.t - 0.5) < 1e-9);
  assert.ok(Math.abs(pass.time - 0.1) < 1e-9);
  assert.ok(Math.abs(pass.point[2]) < 1e-9);

  const nearest = nearestPath([0, 1, 0], [0, 0, -20], [[9, 0, 20], [0, 0, 20], [-9, 0, 20]], [0.2, 0.2, 0.2]);
  assert.ok(nearest.distance < 1.001);
  assert.equal(nearestPath([0, 1, 0], [0, 0, -20], null), null);
});

test('indoor detection follows generated building footprints', () => {
  const world = {
    buildings: [{ x: 0, z: 0, w: 10, d: 8, y0: 0.1, floors: 2, floorH: 3.15, wallT: 0.24 }],
  };
  assert.equal(indoorAt(world, [0, 1, 0]), true);
  assert.equal(indoorAt(world, [0, 6, 0]), true);
  assert.equal(indoorAt(world, [9, 1, 0]), false);
  assert.equal(indoorAt(world, [0, 9, 0]), false);
  assert.equal(indoorAt(null, [0, 1, 0]), false);
});

test('distance filtering removes high frequencies with distance', () => {
  const near = cutoffFor(0, { near: 15000, far: 1800, ref: 8, span: 60 });
  const far = cutoffFor(200, { near: 15000, far: 1800, ref: 8, span: 60 });
  assert.equal(near, 15000);
  assert.ok(far < 2500 && far >= 1800);
  assert.ok(cutoffFor(40) < cutoffFor(4));
});

function fakeVoice(budget, category, priority, maxVoices = 4) {
  const voice = {
    category, priority, maxVoices, startedAt: budget.size,
    stopped: 0,
    stop() { voice.stopped++; budget.remove(voice); },
  };
  return voice;
}

test('voice budget enforces global and category caps with priority stealing', () => {
  const budget = new VoiceBudget(3);
  const a = fakeVoice(budget, 'shot', 10, 4);
  const b = fakeVoice(budget, 'shot', 20, 4);
  const c = fakeVoice(budget, 'impact', 30, 4);
  assert.equal(budget.admit(a), true);
  assert.equal(budget.admit(b), true);
  assert.equal(budget.admit(c), true);
  assert.equal(budget.size, 3);

  const high = fakeVoice(budget, 'explosion', 90, 4);
  assert.equal(budget.admit(high), true);
  assert.equal(budget.size, 3);
  assert.equal(a.stopped, 1, 'lowest priority voice must be stolen');

  const low = fakeVoice(budget, 'ambience', 1, 4);
  assert.equal(budget.admit(low), false, 'cannot admit below the lowest active voice');

  const categoryCapped = new VoiceBudget(10);
  const one = fakeVoice(categoryCapped, 'ui', 10, 1);
  assert.equal(categoryCapped.admit(one), true);
  const two = fakeVoice(categoryCapped, 'ui', 50, 1);
  assert.equal(categoryCapped.admit(two), true);
  assert.equal(one.stopped, 1);
  assert.equal(categoryCapped.count('ui'), 1);
});

test('voice cancellation is idempotent and removes entries once', () => {
  const budget = new VoiceBudget(8);
  const voices = [fakeVoice(budget, 'impact', 10), fakeVoice(budget, 'impact', 20)];
  for (const voice of voices) budget.admit(voice);
  budget.cancel('impact');
  budget.cancel('impact');
  assert.equal(budget.size, 0);
  for (const voice of voices) assert.equal(voice.stopped, 1);
});

test('reload cues emit every logical phase once and reset when finished', () => {
  const cues = new ReloadCues();
  const seen = [];
  for (let t = 0; t < 2; t += 0.01) seen.push(...cues.step('ar', 2 - t, 2));
  assert.deepEqual(seen, ['mag-out', 'mag-in', 'bolt']);
  assert.deepEqual(cues.step('ar', 0, 2), [], 'finished reload emits nothing');
  assert.deepEqual(cues.step('ar', 1.9, 2), ['mag-out'], 'a new reload starts a fresh cycle');

  const shotgun = new ReloadCues();
  const shells = [];
  for (let t = 0; t < 3; t += 0.01) shells.push(...shotgun.step('shotgun', 3 - t, 3));
  assert.deepEqual(shells, ['shell', 'shell', 'shell', 'shell', 'bolt']);

  assert.deepEqual(new ReloadCues().step('rpg', 1.8, 2), ['mag-out']);
  assert.deepEqual(new ReloadCues().step(null, 1, 2), []);
  const disabled = new ReloadCues();
  assert.deepEqual(disabled.step('ar', 2, 2, false), []);
});

test('sample bank loads core eagerly and optional groups on demand', async () => {  const originalFetch = globalThis.fetch;
  const files = new Map(manifest.clips.map(clip => [clip.file, new ArrayBuffer(16)]));
  let fetches = 0;
  globalThis.fetch = async url => {
    fetches++;
    if (String(url).endsWith('manifest.json')) {
      return { ok: true, json: async () => manifest };
    }
    const name = String(url).split('/').pop();
    const data = files.get(name);
    return data ? { ok: true, arrayBuffer: async () => data } : { ok: false, status: 404 };
  };
  try {
    const context = { decodeAudioData: async data => ({ data }) };
    const bank = new SampleBank(context, 'audio/');
    await bank.load();
    assert.equal(bank.errors.length, 0, JSON.stringify(bank.errors.slice(0, 3)));
    assert.equal(bank.buffers.size, manifest.groups.core.length);
    assert.equal(bank.hasGroup('core'), true);
    assert.equal(bank.hasGroup('vehicle'), false);

    const beforeVehicle = fetches;
    await bank.loadGroups(['vehicle', 'ambience']);
    assert.ok(fetches > beforeVehicle);
    assert.equal(bank.buffers.size, manifest.clips.length);
    assert.equal(bank.errors.length, 0);
    assert.ok(bank.info('engine-idle-a'));
    assert.ok(bank.buffer('amb-wind'));
    assert.equal(bank.buffer('does-not-exist'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('material and UI mappings point at defined sounds', () => {
  for (const sound of Object.values(IMPACT_SOUNDS)) assert.ok(SOUNDS[sound], sound);
  for (const sound of Object.values(FOOTSTEP_SOUNDS)) assert.ok(SOUNDS[sound], sound);
  for (const sound of Object.values(UI_SOUNDS)) assert.ok(SOUNDS[sound], sound);
  for (const sound of Object.values(RELOAD_SOUNDS)) assert.ok(SOUNDS[sound], sound);
  assert.equal(IMPACT_SOUNDS.flesh, 'fleshImpact');
  assert.equal(FOOTSTEP_SOUNDS.water, 'footstepWater');
});
