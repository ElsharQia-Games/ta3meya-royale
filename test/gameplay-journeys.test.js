import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, emptyInput } from '../shared/sim.js';
import { CFG, MATCH_STATE } from '../shared/config.js';
import { pickupLoot, tryInteract, applyDamage, explode } from '../shared/weapons.js';

function fixture() {
  const game = new Game({ mode: 'tdm' });
  const player = game.addPlayer('Journey');
  game.begin(); game.matchState = MATCH_STATE.LIVE;
  game.vehicles.length = 0;
  player.armor = 0; player.lastDamageAt = game.time;
  return { game, player };
}
function wait(game, player, seconds) {
  for (let i = 0; i < Math.ceil(seconds / CFG.SIM_DT) + 1; i++) {
    game.step(new Map([[player.id, emptyInput()]]), CFG.SIM_DT);
  }
}

test('bandages and medkits take their full duration and respect their health caps', () => {
  const { game, player } = fixture();
  player.health = 70; player.bandages = 1;
  game.step(new Map([[player.id, { ...emptyInput(), heal: true }]]));
  wait(game, player, .5);
  assert.equal(player.health, 70);
  wait(game, player, 1.6);
  assert.equal(player.health, 75);
  assert.equal(player.bandages, 0);
  player.medkits = 1; player.lastDamageAt = game.time;
  game.step(new Map([[player.id, { ...emptyInput(), heal: true }]]));
  wait(game, player, 5.1);
  assert.equal(player.health, 100);
  assert.equal(player.medkits, 0);
});

test('damage and weapon switching interrupt healing and do not grant delayed health', () => {
  const { game, player } = fixture();
  player.health = 50; player.bandages = 2;
  game.step(new Map([[player.id, { ...emptyInput(), heal: true }]]));
  applyDamage(game, player, 5, -1, 'torso', player.pos, 'fixture');
  assert.equal(player.healT, 0);
  wait(game, player, 2.1);
  assert.equal(player.health, 45);
  game.step(new Map([[player.id, { ...emptyInput(), heal: true }]]));
  game.step(new Map([[player.id, { ...emptyInput(), slot: 1 }]]));
  assert.equal(player.healT, 0);
  assert.equal(player.healItem, null);
});

test('duplicate weapon pickup conserves ammo without aliasing two inventory slots', () => {
  const { game, player } = fixture();
  const before = player.inv.ar.reserve;
  const item = { id: game.nextId++, type: 'weapon', weapon: 'ar', mag: 5, reserve: 15,
    x: player.pos[0], y: player.pos[1], z: player.pos[2] };
  game.loot.push(item);
  assert.equal(pickupLoot(game, player, item), true);
  assert.deepEqual(player.weapons, ['ar', 'pistol']);
  assert.equal(player.inv.ar.reserve, before + 20);
  assert.equal(pickupLoot(game, player, item), false, 'removed loot cannot be collected twice');
  assert.equal(player.inv.ar.reserve, before + 20);
});

test('loot cannot be collected through a wall or from the floor above', () => {
  const { game, player } = fixture();
  const item = { id: game.nextId++, type: 'ammo', weapon: 'ar', amount: 30,
    x: player.pos[0] + .4, y: player.pos[1] + 3.5, z: player.pos[2] };
  game.loot = [item];
  assert.equal(tryInteract(game, player), false);
  item.y = player.pos[1] + .1;
  game.world.lineOfSight = () => false;
  assert.equal(tryInteract(game, player), false);
  assert.equal(game.loot.length, 1);
  game.world.lineOfSight = () => true;
  assert.equal(tryInteract(game, player), true);
});

test('destroyed cover is recorded for late joiners and a new round restores its health', () => {
  const { game, player } = fixture();
  const box = game.world.boxes.find(b => b.dynamic && b.maxHp > 0);
  assert.ok(box);
  box.hp = 1;
  const centre = box.min.map((n, i) => (n + box.max[i]) / 2);
  explode(game, centre, 100, 4, player.id);
  assert.equal(box.destroyed, true);
  assert.equal(game.destroyedBoxes.has(box.id), true);
  game.matchState = MATCH_STATE.ENDED;
  game.begin();
  assert.equal(box.destroyed, false);
  assert.equal(box.hp, box.maxHp);
  assert.equal(game.destroyedBoxes.size, 0);
});
