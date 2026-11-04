// Private-process QA setup, loaded only with Node --import. No network-facing
// debug endpoint is added to the production server. Combat still uses its wire
// input queue, fixed-step Game, replication and normal respawn timer.
import { Game } from '../../shared/sim.js';
import { CFG, MATCH_STATE } from '../../shared/config.js';

const games = new Set();
const addPlayer = Game.prototype.addPlayer;
Game.prototype.addPlayer = function (...args) {
  const player = addPlayer.apply(this, args);
  games.add(this);
  return player;
};

function clearLane(world) {
  for (let z = -180; z <= 180; z += 20) for (let x = -180; x <= 180; x += 20) {
    const y = world.terrainHeight(x, z);
    if (world.waterDepth(x, z) > .1 || world.terrainNormal(x, z)[1] < .995) continue;
    const blocked = world.queryBoxes(x - 4, z - 35, x + 4, z + 4).some(b =>
      b.max[1] > y + .2 && b.min[0] < x + 4 && b.max[0] > x - 4 && b.min[2] < z + 4 && b.max[2] > z - 35);
    if (!blocked) return [x, y, z];
  }
  throw new Error('No clear combat fixture lane');
}

process.on('message', message => {
  if (message?.type !== 'combat-fixture') return;
  const respond = result => process.send?.({ type: 'combat-fixture-result', requestId: message.requestId, ...result });
  try {
    const game = [...games].find(g => [...g.players.values()].some(p => p.name === message.owner));
    if (!game) throw new Error(`No arena for ${message.owner}`);
    if (message.operation === 'stage') {
      const lane = clearLane(game.world);
      game.matchState = MATCH_STATE.LIVE; game.countdown = 0; game.roundTime = 0;
      game.zone.active = false; game.projectiles.length = 0; game.pendingDamage.length = 0;
      game.loot.length = 0; game.vehicles.length = 0; game.smokes.length = 0;
      let index = 0;
      for (const p of game.players.values()) {
        game.spawnPlayer(p);
        p.giveLoadout(CFG.KITS[p.kit].weapons);
        p.pos = [lane[0], 0, lane[2] - index++ * 22];
        p.pos[1] = game.world.terrainHeight(p.pos[0], p.pos[2]);
        p.vel = [0, 0, 0]; p.grounded = true; p.armor = 0; p.health = 100;
        p.yaw = 0; p.pitch = 0; p.curSlot = p.kit === 'heavy' ? 1 : 0;
        p.cooldown = 0; p.prevShoot = false;
      }
    } else if (message.operation === 'kill') {
      const victim = [...game.players.values()].find(p => p.name === message.victim);
      const killer = [...game.players.values()].find(p => p.name === message.killer);
      if (!victim) throw new Error('No fixture victim');
      game.kill(victim, killer?.id ?? -1, message.weapon || 'sniper', 'head', 22);
    } else if (message.operation !== 'inspect') throw new Error('Unknown combat fixture operation');
    respond({ time: game.time, players: [...game.players.values()].map(p => ({
      id: p.id, name: p.name, kit: p.kit, pos: p.pos.slice(), alive: p.alive,
      weapon: p.curWeapon(), death: p.death,
    })) });
  } catch (error) { respond({ error: String(error) }); }
});
