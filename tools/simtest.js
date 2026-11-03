// Latency/packet-loss simulation harness + stress test (headless).
// Measures: 30-min fast-forward stress (movement stability), latency variants.
import { Game } from '../shared/sim.js';
import { CFG } from '../shared/config.js';

const idle = { f: false, b: false, l: false, r: false, jump: false, sprint: false, ads: false, shoot: false, yaw: 0, pitch: 0, reload: false, grenade: false, heal: false, switch: -1, stance: null };

// Stress: 30 simulated minutes for 32 players
const g = new Game();
const ps = [];
for (let i = 0; i < 32; i++) {
  const a = (i / 32) * Math.PI * 2;
  ps.push(g.addPlayer('P' + i, Math.cos(a) * 100, Math.sin(a) * 100));
}
const t0 = Date.now();
const TOTAL = 30 * 60 / CFG.SIM_DT; // 30 min in ticks (108k)
for (let t = 0; t < TOTAL; t++) {
  const inputs = new Map();
  for (const p of ps) {
    if (!p.alive) continue;
    const yaw = t * 0.001 + p.id;
    inputs.set(p.id, { ...idle, f: true, sprint: true, yaw, shoot: t % 120 === 0 });
  }
  g.step(inputs, CFG.SIM_DT);
  // tunneling check: players inside a box?
  for (const p of ps) {
    if (!p.alive) continue;
    for (const b of g.world.boxes) {
      if (p.pos[0] > b.min[0] + 0.05 && p.pos[0] < b.max[0] - 0.05 && p.pos[2] > b.min[2] + 0.05 && p.pos[2] < b.max[2] - 0.05 && p.pos[1] > b.min[1] + 0.05 && p.pos[1] < b.max[1] - 0.05 && b.tag !== 'ground') {
        console.log(`TUNNEL at tick ${t} player ${p.id} inside ${b.tag}`);
        process.exit(1);
      }
    }
    if (!isFinite(p.pos[0]) || !isFinite(p.pos[1]) || !isFinite(p.pos[2])) { console.log('NaN!'); process.exit(1); }
  }
}
console.log(`Stress OK: ${TOTAL} ticks, ${ps.length} players in ${(Date.now() - t0) / 1000}s wallclock`);
console.log('Alive at end:', ps.filter(p => p.alive).length);

// Latency matrix: how stale is server view vs client intent at each RTT?
for (const rtt of [50, 150, 300]) {
  const g2 = new Game(); const p = g2.addPlayer('a', 0, 0);
  const inp = { ...idle, f: true, sprint: true };
  const steps = Math.round((rtt / 1000) / CFG.SIM_DT);
  for (let i = 0; i < steps; i++) g2.step(new Map([[p.id, inp]]), CFG.SIM_DT);
  const d = Math.hypot(p.pos[0], p.pos[2]);
  console.log(`RTT ${rtt}ms -> server-visible movement lag distance ${d.toFixed(1)}m (<= ${CFG.PLAYER.SPRINT}t*dt)`);
}
