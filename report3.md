# Phase 3 — Ballistics, Hit Detection & Combat Correctness

**Project:** Ta3meya Royale / Frontline  
**Report Type:** Technical Audit, Remediation Plan & Verification Specification  
**Priority:** P0–P2  
**Status:** Ready for validation and implementation  
**Dependencies:** Phase 1 and Phase 2 — Completed  
**Reference:** Original codebase audit and subsequent reviews

---

## 1. Executive Summary

The previous phases addressed multiplayer reliability, authoritative simulation timing, movement prediction, collision correctness, and snapshot synchronization.

Phase 3 focuses on the correctness and consistency of the authoritative combat simulation.

The original audit identified several important issues affecting bullet travel, moving targets, lag compensation, vehicle occupants, hitbox geometry, and material penetration.

The most significant architectural defect is that ordinary bullets are simulated through their entire trajectory immediately when fired, while player collision is evaluated against a static historical hitbox snapshot.

This creates incorrect outcomes for moving targets: a correctly led shot may miss, while a shot aimed at a target's previous location may register despite the target having moved away.

The current implementation also has potentially inconsistent timing between projectile collision determination, damage application, destructible-object updates, and client-visible combat events.

### Phase Objective

Establish a coherent and authoritative combat timeline in which:

- Bullets follow consistent ballistic trajectories.
- Projectile collisions account for target movement during flight.
- Lag compensation correctly represents the shooter's firing context.
- Damage occurs according to validated collision events.
- Vehicle occupants can be hit through appropriate openings.
- Material penetration is geometrically and temporally consistent.
- Player hitboxes represent intended target geometry.
- Bots use the same authoritative combat rules as players.
- Combat results remain deterministic and fair under latency.

### Primary Engineering Principle

**Projectile flight time must be reflected in collision evaluation, not merely in delayed damage application.**

A delayed damage event is not equivalent to a projectile whose collision is evaluated over time.

---

# 2. Scope

## In Scope

| System | Relevant components |
|---|---|
| Ballistic simulation | `shared/weapons.js` |
| Projectile lifecycle | `shared/projectiles.js`, `shared/sim.js` |
| Player hit detection | `hitboxesFor()`, `nearestPlayerHit()` |
| Lag compensation | `server/server.js`, `src/net/host.js` |
| Historical collision states | `Game.captureHitboxes()`, `Game.targetsFromHistory()` |
| Vehicle bullet collision | `shared/vehicle.js`, `shared/world.js` |
| Penetration and materials | `shared/weapons.js`, `shared/config.js` |
| Damage and death lifecycle | `tryFire()`, `applyDamage()`, `stepPendingDamage()` |
| Bot firing | `server/bots.js` |
| Combat networking | Existing shot, impact, and damage events |
| Verification | Existing tests, networking tests, browser QA |

## Out of Scope

- Advanced recoil patterns or weapon balancing.
- Weapon-model geometry and animation improvements.
- New weapons or equipment.
- Full rigid-body vehicle physics.
- Building-level structural destruction.
- General visual effects and particle improvements.
- Rendering performance optimization.
- Advanced audio simulation.
- Matchmaking, authentication, and networking architecture redesign.
- Unrelated movement or snapshot changes from Phase 2.

Changes to combat-related event timing or data structures are allowed when necessary, but must remain compatible with the surrounding architecture.

---

# Part I — Findings

## F1 — Ballistic Flight Is Evaluated Against Frozen Historical Targets

**Priority:** P0 — Critical  
**Category:** Ballistics / Moving-Target Hit Detection  
**Status:** Previously confirmed; revalidate against current HEAD

### Affected Components

- `shared/weapons.js`
  - `solveBallistic()`
  - `tryFire()`
- `shared/sim.js`
  - `Game.step()`
  - `Game.stepPlayer()`
- `server/server.js`
  - `stepRoom()`

### Current Failure Mechanism

The historical implementation simulates bullet travel using a synchronous integration loop:

```js
const dt = 1 / 90;

while (elapsed < maxTime && guard++ < 260) {
  // Advance bullet position.
  // Raycast world geometry.
  // Raycast player hitboxes.
}
```

The solver receives a static collection of target hitboxes.

When a player fires, the server obtains historical targets using lag compensation and passes them into the solver.

The bullet's trajectory advances through simulated time, but the targets do not advance with it.

### Example

Assume:

- Target distance: 200 meters.
- Target movement: 7 meters/second, perpendicular to the shot.
- Bullet flight time: approximately 0.3 seconds.

During the bullet's flight, the target moves approximately:

`7 × 0.3 = 2.1 meters`

A physically consistent bullet must be evaluated against the target's position when the bullet arrives.

The historical solver instead tests the bullet against the target's position at the original historical snapshot.

### Incorrect Outcomes

**Scenario A — Correctly Led Shot**

The shooter aims ahead of a running target.

The bullet follows the intended trajectory.

However, the target's hitbox remains frozen at its earlier position.

The bullet may incorrectly miss.

**Scenario B — Shot at Previous Position**

The shooter aims directly at the target's previous position.

The target moves out of the bullet's path during flight.

However, the solver may still register a collision with the old hitbox.

Damage is subsequently scheduled for the future.

This creates an incorrect hit despite the target no longer occupying the collision location.

### Required Remediation

Redesign ordinary bullet collision evaluation so target movement during bullet flight is accounted for.

Evaluate at least two possible approaches.

**Option A — Persistent Authoritative Projectiles**

Represent fired bullets as active projectiles in the authoritative simulation.

Each simulation tick:

1. Advance projectile velocity and position.
2. Perform swept collision detection.
3. Evaluate current or temporally appropriate target hitboxes.
4. Resolve penetration and impacts.
5. Apply damage at validated collision time.
6. Remove projectiles after impact, expiration, or other terminal conditions.

**Option B — Time-Aware Trajectory Evaluation**

Retain an analytical or accelerated solver, but evaluate collision geometry at the corresponding projectile time rather than one frozen snapshot.

This would require a reliable method of obtaining or reconstructing target geometry throughout the relevant flight interval.

A constant-velocity extrapolation such as:

`target.pos + target.vel × elapsed`

may be useful as a limited approximation, but it is not necessarily authoritative or correct for arbitrary player movement, obstacles, direction changes, jumping, or vehicle interactions.

### Recommended Direction

Prefer evaluating persistent projectiles over actual authoritative simulation ticks, unless analysis demonstrates a better approach compatible with the current architecture and performance constraints.

The existing live rocket integration provides a reference for simulation ownership and tick-based projectile processing, but ordinary bullets have different velocities, lifetimes, collision requirements, and expected throughput.

Do not blindly reuse rocket implementation details.

### Acceptance Criteria

- Moving targets are evaluated at appropriate collision times.
- A properly led shot can hit a moving target.
- An unled shot misses when the target has left the bullet trajectory.
- Bullet travel time affects actual collision outcomes.
- High-speed bullets do not tunnel through valid targets.
- Bullet expiration is deterministic.
- Shotgun pellets and automatic fire remain correct.
- Dedicated-server and Browser Host behavior use consistent rules.

---

## F2 — Lag Compensation Uses Approximate Historical Timing

**Priority:** P0 — High  
**Category:** Networking / Server-Side Rewind  
**Status:** Previously confirmed; current implementation must be revalidated

### Affected Components

- `server/server.js`
  - `stepRoom()`
  - `findHistory()`
- `src/net/host.js`
- `shared/protocol.js`
- `shared/sim.js`

### Current Failure Mechanism

The historical dedicated server calculates rewind using an approximation based on network RTT and interpolation delay:

```js
const rewind = clamp(
  c.rttEma / 2000 + CFG.INTERP_DELAY,
  0,
  CFG.MAX_REWIND
);
```

It then selects the nearest historical hitbox frame:

```js
const hist = findHistory(
  room,
  game.time - rewind
);
```

The input protocol already contains a `viewTime` field, but the historical combat calculation does not directly use it.

Additionally, `findHistory()` selects the nearest history frame rather than interpolating between adjacent frames.

### Problems

**1. Approximate Shot Timing**

RTT/2 is an approximation of one-way latency.

Actual latency may be asymmetric, and packet delivery timing varies.

**2. Client View Time Is Not Fully Used**

The input protocol already carries information potentially useful for identifying what the shooter was seeing when firing.

**3. Nearest-Frame Sampling**

Historical hitboxes are sampled from one frame instead of an interpolated state between frames.

This introduces additional temporal discretization error.

**4. Timeline Consistency**

The new ballistic system must distinguish:

- Input creation time.
- Authoritative shot acceptance time.
- Historical visual target time.
- Bullet launch time.
- Bullet collision time.
- Damage application time.

Those timestamps must not be conflated.

### Required Investigation

Before changing rewind logic:

1. Trace how `viewTime` is generated.
2. Determine its clock domain.
3. Verify whether it refers to server simulation time, client time, or interpolated render time.
4. Determine how it relates to the acknowledged input sequence.
5. Check whether Phase 1 or Phase 2 changed any timing contracts.
6. Compare the dedicated-server and Browser Host paths.
7. Determine the intended maximum rewind window.

Do not trust client-provided timestamps without validation.

### Required Remediation

Implement a documented and validated temporal model.

It should:

- Select an appropriate historical firing context.
- Clamp requested rewind to safe limits.
- Reject or safely handle invalid timestamps.
- Interpolate historical target states when appropriate.
- Preserve authoritative control over shot validation.
- Handle missing history gracefully.
- Prevent clients from obtaining additional hit advantages through manipulated timestamps.
- Avoid applying lag compensation twice.

### Critical Design Decision

Lag compensation and projectile travel time are separate concepts.

The implementation must explicitly decide how a historical shot is advanced from its accepted firing time into the current simulation timeline.

A bullet launched from a rewound position must not become a permanent artificial delay for the shooter, nor may it retroactively hit targets using future information.

The agent must explain the chosen model and its fairness tradeoffs.

### Acceptance Criteria

- Rewind never exceeds configured safe limits.
- Invalid `viewTime` cannot produce arbitrary historical hits.
- Historical interpolation behaves correctly between frames.
- The same logical firing scenario produces consistent results across supported hosting modes.
- No systematic double compensation occurs.
- Shot timing and projectile collision timing are coherent.
- Controlled latency and jitter tests demonstrate the intended behavior.

---

## F3 — Vehicle Hulls Block All External Shots at Occupants

**Priority:** P0 — Critical  
**Category:** Vehicle Combat / Hit Detection  
**Status:** Previously confirmed

### Affected Components

- `shared/vehicle.js`
  - `rayVehicle()`
- `shared/world.js`
  - `raycast()`
- `shared/weapons.js`
  - `solveBallistic()`
- `shared/sim.js`
  - Vehicle occupant positioning

### Current Failure Mechanism

Vehicle bullet collision is represented using a closed oriented box.

Incoming bullets intersect the vehicle's outer hull before reaching the seated occupants' hitboxes.

The solver evaluates player hits only up to the nearest blocking world collision.

Consequently, incoming bullets cannot pass through the vehicle collider to reach occupants.

Meanwhile, `rayVehicle()` permits rays originating inside the vehicle hull to exit without colliding with that same hull.

This produces asymmetric behavior:

- Occupants may shoot outward.
- External bullets cannot directly hit occupants through windows or other cabin openings.

### Required Remediation

Separate vehicle bullet geometry from the simplified vehicle movement collision hull where necessary.

The vehicle may retain its existing solid collider for movement and physical interactions.

Bullet collision should instead represent meaningful hit regions:

- Chassis and body panels.
- Cabin openings.
- Windows or glass.
- Roof and pillars.
- Engine or mechanically protected areas, if supported.
- Occupant hitboxes.

The implementation must remain compatible with vehicle rotation and occupant positioning.

### Recommended Approach

Use an explicit vehicle ballistic collision model that distinguishes solid and pass-through regions.

Avoid a simple global rule such as:

`if (hitY > 1.1) ignore vehicle`

because it may incorrectly allow shots through roofs, pillars, and other solid geometry.

The chosen representation should balance collision fidelity with the project's existing procedural vehicle geometry.

### Required Scenarios

- Shot through front windscreen.
- Shot through side window.
- Shot through open cabin region.
- Shot into solid body panel.
- Shot through a pillar.
- Shot into the engine block.
- Passenger shooting outward.
- Vehicle rotated relative to shooter.
- Vehicle moving while occupants are seated.
- Occupant entering or leaving the vehicle.

### Acceptance Criteria

- Valid shots through openings can hit occupants.
- Solid hull components still block bullets.
- Passenger shots do not accidentally collide with their own vehicle.
- Occupant damage respects existing armor and hit-zone rules.
- Vehicle damage remains correct.
- No duplicate vehicle and player damage occurs unless intentionally specified.
- Existing movement collision behavior remains unchanged.

---

## F4 — Penetration Discards Remaining Movement Within a Bullet Substep

**Priority:** P1 — High  
**Category:** Ballistics / Material Penetration  
**Status:** Previously identified; requires reproduction against HEAD

### Affected Component

`shared/weapons.js` — `solveBallistic()`.

### Current Failure Mechanism

When a bullet penetrates material, the solver moves the projectile position to just beyond the exit point:

```js
const exitT = wh.tmax + 0.015;
```

It then continues to the next integration iteration.

However, the original integration step may have had remaining travel distance after the exit point.

The current logic does not necessarily consume that remaining distance in the same simulated interval.

### Example

Suppose one ballistic integration step represents 10 meters of travel.

A thin wall is encountered after 1 meter, with an exit at 1.2 meters.

The bullet has approximately 8.8 meters of intended travel remaining in that step.

If the solver advances directly to the next time step, that remaining displacement is lost.

### Consequences

- Incorrect effective bullet travel speed after penetration.
- Distorted collision timing.
- Incorrect penetration-to-target distance.
- Delayed or missed hits behind thin objects.
- Inconsistent behavior across materials and projectile speeds.

### Required Remediation

Ensure the solver preserves the remaining time and distance within the integration step after penetration.

The implementation must:

- Resolve entry and exit geometry correctly.
- Advance through the penetrated material.
- Apply appropriate material damage attenuation.
- Continue the remaining travel interval.
- Support multiple penetrations in one simulation tick when geometrically valid.
- Prevent infinite penetration loops.
- Handle grazing and nearly parallel rays safely.
- Preserve deterministic collision ordering.

If the ballistic system is redesigned around persistent projectiles, address penetration as part of that design rather than repairing an implementation that will be removed.

### Acceptance Criteria

- Thin-wall penetration preserves correct projectile timing.
- Targets immediately behind penetrable material can be hit.
- Multiple aligned penetrable materials work consistently.
- Impenetrable materials stop projectiles.
- No duplicate collision is produced at an entry/exit boundary.
- Penetration terminates safely when the projectile has insufficient remaining energy or penetration capability.

---

## F5 — Static Glass and Destructible Material Behavior Are Inconsistent

**Priority:** P1 — High  
**Category:** World Interaction / Combat Geometry  
**Status:** Previously identified; validate intended design

### Current Behavior

The historical implementation permits glass to affect bullet penetration and damage.

However, window glass is not consistently represented as destructible world geometry.

Some glass surfaces remain intact while repeatedly allowing bullets through and applying damage attenuation.

The original audit noted a fixed damage multiplier applied during penetration.

### Gameplay Problem

Players expect a consistent relationship between:

- What a bullet hits.
- What material the object represents.
- Whether the object can break.
- Whether a broken object still blocks future shots.
- Whether the object remains visually present.

A glass window that repeatedly absorbs bullet damage but never changes state can create confusing combat outcomes.

### Required Investigation

Determine the intended behavior for each material:

- Glass.
- Wood.
- Thin metal.
- Concrete.
- Vehicle glass.
- Destructible equipment.

Not all glass must necessarily be destructible, and not all penetration should destroy an object.

The correct behavior should follow explicit material and gameplay contracts.

### Required Remediation

Where the intended design requires breakable glass:

1. Track authoritative destruction state.
2. Update collision behavior after destruction.
3. Replicate the destruction event to clients.
4. Preserve deterministic projectile interaction.
5. Prevent already-destroyed geometry from blocking later shots.
6. Handle multiple bullets striking the same object in one tick.
7. Preserve existing structural damage rules for unrelated objects.

Do not expand this into building-wide destruction.

### Acceptance Criteria

- Material-specific penetration behaves as documented.
- Breakable glass changes state correctly.
- Destroyed glass no longer causes unintended repeated penetration loss.
- Concurrent hits do not produce duplicate destruction effects.
- Server and client collision state remain consistent.
- Visual state corresponds to authoritative state.

---

## F6 — Player Hitboxes and Damage Zones Require Validation

**Priority:** P1 — High  
**Category:** Hit Detection / Geometry  
**Status:** Geometry concerns identified; exact gameplay impact requires testing

### Affected Components

- `shared/weapons.js`
  - `hitboxesFor()`
  - `nearestPlayerHit()`
- `shared/physics.js`
- Character stance and vehicle occupancy state

### Current Model

Player hit detection uses three primary damage zones:

- Head.
- Torso.
- Legs.

Standing and crouching use vertical capsules and a head sphere.

Prone uses horizontal, yaw-oriented capsule segments.

The collision model also includes a head-priority rule to handle overlapping body geometry.

### Identified Concerns

**1. Overlapping Hit Zones**

Adjacent capsules may overlap.

The head-priority rule helps with face shots, but hit classification may still depend on arbitrary geometric tolerances.

**2. Crouching Hitboxes**

Crouched torso and leg regions may overlap significantly.

This can make damage-zone selection unintuitive.

**3. Prone Head Geometry**

The prone head sphere is derived from a base point plus its radius.

Its position should be validated against the authoritative gameplay model and the rendered prone character.

**4. Vehicle Occupancy**

Occupants use a modified collision stance and are repositioned according to vehicle seats.

The selected hitboxes must accurately represent their combat collision geometry.

**5. Rendered versus Authoritative Silhouette**

Large discrepancies between visible character geometry and authoritative hitboxes can create apparent missed shots or hits through empty space.

### Required Remediation

First, build targeted geometry tests and inspect the intended hitbox definitions.

Then correct proven issues.

Test:

- Standing front, side, and rear shots.
- Crouched front, side, and rear shots.
- Prone shots at multiple yaw angles.
- Head/torso boundaries.
- Torso/leg boundaries.
- Headshots near capsule overlaps.
- Targets on elevated surfaces.
- Targets inside vehicles.
- Targets transitioning between stances.

Do not add additional body regions merely to increase complexity.

The existing three-zone damage model may be sufficient if its geometry and classification are correct.

### Acceptance Criteria

- Intended headshots register reliably.
- Body-zone selection follows a documented geometric rule.
- Prone hitboxes rotate correctly with character yaw.
- Hitboxes track authoritative stance.
- Vehicle occupant hitboxes remain valid.
- No systematic hits occur outside intended collision geometry.
- Damage multipliers apply to the selected zone exactly once.

---

## F7 — Damage and Combat Events Are Not Fully Aligned With Projectile Time

**Priority:** P0 — High  
**Category:** Damage Lifecycle / Combat Events  
**Status:** Derived from historical code paths; reproduce and validate

### Affected Components

- `shared/weapons.js`
  - `tryFire()`
- `shared/sim.js`
  - `stepPendingDamage()`
  - `kill()`
- `shared/world.js`
- Combat event serialization and client consumers

### Current Behavior

The historical solver computes future bullet collisions when the shot is fired.

Player damage is stored as a pending event:

```js
game.pendingDamage.push({
  at: game.time + res.time,
  victimId: res.hit.targetId,
  attackerId: p.id,
  amount: res.hit.damage,
  ...
});
```

However, non-player impacts such as vehicle damage and destructible-prop damage are processed while handling the firing result.

This can create different collision and damage timelines depending on the object hit.

### Potential Inconsistencies

- Player damage is delayed.
- Vehicle damage may occur immediately.
- Destructible-object state may change immediately.
- Shot events may already contain a confirmed future hit.
- Client effects may represent an impact before the authoritative collision time.

These interactions must be revalidated after selecting the Phase 3 projectile architecture.

### Critical Edge Cases

**Target dies before bullet arrival**

The projectile should not damage a newly respawned player merely because the same player ID is reused.

**Target enters cover during flight**

Collision must reflect the actual geometry encountered at the relevant time.

**Target enters a vehicle**

The projectile must interact with the appropriate current vehicle and occupant geometry.

**Target disconnects**

The simulation must handle the projectile without invalid references or duplicate scoring.

**Multiple bullets arrive during one tick**

Damage and death processing must have deterministic ordering.

**Destructible cover breaks**

Subsequent projectiles must observe the correct world state.

### Required Remediation

Define a unified projectile-impact and damage lifecycle.

Separate clearly:

1. Weapon fire validation.
2. Projectile creation.
3. Projectile simulation.
4. Collision determination.
5. Impact resolution.
6. Damage application.
7. Death and scoring.
8. Network event emission.

Damage must result from a validated collision, not from a predicted future target selection that never gets rechecked.

Use stable projectile identities and sufficient target lifecycle information to prevent cross-respawn damage.

Preserve the existing server-authoritative ammo, cooldown, and damage rules.

### Acceptance Criteria

- Damage occurs at the correct collision time.
- Player and vehicle damage obey consistent timing rules.
- Projectile impacts cannot be applied twice.
- A projectile cannot damage the wrong player lifecycle after respawn.
- Scoring and kill attribution remain correct.
- Invalidated targets are handled safely.
- Destructible-world updates occur in deterministic order.
- Combat effects reflect authoritative results without leaking unconfirmed future hits.

---

## F8 — Bot Target Leading Must Match the Corrected Ballistic Model

**Priority:** P1  
**Category:** AI Combat / Ballistics  
**Status:** Dependent on F1 remediation

### Current Behavior

Bots estimate how far a moving target will travel before projectile arrival.

The historical aiming logic calculates a lead based partly on target velocity and projectile speed.

However, the existing ballistic solver evaluates collision against frozen targets.

This creates an inconsistency between bot aiming and hit detection.

### Required Remediation

After correcting ballistic simulation:

- Revalidate bot target leading.
- Verify gravity and drag compensation.
- Check moving-target tracking.
- Check accuracy for different projectile velocities.
- Preserve existing intended skill and accuracy differences.
- Ensure bots are not given privileged hit detection.
- Revisit RPG lead calculations only if testing demonstrates an issue.

Bots and human players must use the same authoritative collision rules.

### Acceptance Criteria

- Bots can hit correctly led moving targets.
- Bots do not systematically miss because of frozen target hitboxes.
- Bot hit rates remain within intended gameplay balance.
- RPG targeting remains correct or its limitations are documented.
- Correcting ballistics does not silently make bots unrealistically accurate.

---

# Part II — Implementation Strategy

## 3. Work Package 1 — Revalidate Findings and Establish Baselines

Before implementing any fix:

1. Inspect current HEAD after Phase 2.
2. Review existing combat tests.
3. Reproduce moving-target ballistic defects.
4. Trace historical rewind and input timestamps.
5. Reproduce occupant bullet-blocking behavior.
6. Reproduce penetration timing loss.
7. Verify current material and glass rules.
8. Build hitbox geometry fixtures.
9. Trace damage, death, and projectile lifecycle.
10. Record current combat performance and event bandwidth.

### Required Deliverable

A findings matrix that identifies each issue as:

- Confirmed.
- Partially confirmed.
- Not reproduced.
- Rejected.
- Intended behavior requiring documentation.

Do not implement speculative fixes without confirming their relevance.

---

## 4. Work Package 2 — Design the Authoritative Combat Timeline

This is the most important design step of Phase 3.

Before modifying the ballistic solver, define how projectile simulation interacts with lag compensation.

The design must answer:

**A. Firing context**

Which authoritative state defines the bullet's launch position and orientation?

**B. Lag compensation**

At which server timestamp should the shooter's historical observation be reconstructed?

**C. Projectile simulation**

Does the projectile enter the current simulation immediately, or require bounded historical catch-up?

**D. Moving targets**

Which target geometry is used for each segment of projectile travel?

**E. Moving and destructible cover**

How are vehicle movement and destructible-world changes incorporated?

**F. Damage and events**

When are impact, damage, and kill events emitted?

**G. Determinism**

How are simultaneous impacts and projectile processing order handled?

### Required Design Properties

- One coherent server-authoritative timeline.
- No double lag compensation.
- No collision against permanently frozen targets.
- No reliance on untrusted client positions.
- Bounded history access.
- Deterministic projectile updates.
- Correct interaction with changing world geometry.
- Clear handling of late packets and network jitter.
- No unnecessary increases in protocol traffic.

Document the decision and its tradeoffs before implementation.

Avoid independently fixing lag compensation and projectile simulation in incompatible ways.

---

## 5. Work Package 3 — Implement Correct Ballistics and Impact Timing

Once the timeline design is validated:

1. Implement appropriate time-aware bullet simulation.
2. Support continuous collision detection or bounded swept substeps.
3. Evaluate moving-target geometry correctly.
4. Preserve gravity, drag, spread, and weapon-specific parameters.
5. Preserve projectile lifetime and maximum travel constraints.
6. Fix penetration timing and residual movement.
7. Make collision resolution deterministic.
8. Align damage and impact event timing.
9. Preserve proper shotgun pellet behavior.
10. Verify automatic fire under sustained load.

### Performance Considerations

A persistent-projectile architecture may increase active projectile counts.

Measure:

- Number of active bullets.
- Bullet simulation time per tick.
- Raycasts per projectile.
- Swept collision queries.
- Peak load under automatic fire.
- Shotgun burst cost.
- Memory allocation and garbage collection.
- Effect on 60 Hz authoritative simulation.

Do not introduce a more expensive architecture without measuring its performance.

If optimizations are necessary, preserve correctness first, then optimize with equivalent regression tests.

---

## 6. Work Package 4 — Fix Vehicle and Material Collision

Tasks:

1. Define separate ballistic collision regions where necessary.
2. Allow valid hits through cabin openings.
3. Preserve blocking surfaces such as chassis and pillars.
4. Ensure occupants can shoot outward correctly.
5. Validate vehicle rotation and movement.
6. Correct penetration through world materials.
7. Validate glass destruction rules.
8. Synchronize destruction and collision state.
9. Verify vehicle damage and occupant damage cannot be applied incorrectly.
10. Test projectile interaction with changing geometry.

This package must not modify vehicle driving physics.

---

## 7. Work Package 5 — Validate Hitboxes and Combat Lifecycle

Tasks:

1. Test standing, crouching, and prone geometry.
2. Correct demonstrated hit-zone inaccuracies.
3. Verify headshot priority rules.
4. Validate occupant hitboxes.
5. Test player death during projectile flight.
6. Test target respawn and reused identifiers.
7. Test simultaneous impacts.
8. Test multi-pellet damage.
9. Verify armor, headshot, and falloff calculations.
10. Verify scoring and kill-feed consistency.

Ensure every confirmed bug receives regression coverage.

---

# Part III — Verification Matrix

## 8. Ballistic Accuracy

| ID | Scenario | Expected Result |
|---|---|---|
| BAL-01 | Stationary target, unobstructed | Correct ballistic hit |
| BAL-02 | Perpendicular moving target, unled | Miss when target leaves trajectory |
| BAL-03 | Perpendicular moving target, correctly led | Hit at correct projectile arrival time |
| BAL-04 | Target suddenly changes direction | Collision uses actual motion |
| BAL-05 | Target jumps during flight | Correct 3D collision |
| BAL-06 | Target crouches during flight | Correct stance-dependent collision |
| BAL-07 | Bullet passes immediately behind moving target | No false hit |
| BAL-08 | Long-range shot | Correct travel time and gravity drop |
| BAL-09 | Rapid automatic fire | Independent, deterministic shots |
| BAL-10 | Shotgun pellet spread | Correct independent pellet collisions |
| BAL-11 | High-speed sniper bullet | No tunneling |
| BAL-12 | Projectile reaches maximum lifetime | Removed safely |

## 9. Lag Compensation

| ID | Scenario | Expected Result |
|---|---|---|
| LAG-01 | Near-zero RTT | Consistent hit evaluation |
| LAG-02 | 100 ms RTT | Correct compensated firing context |
| LAG-03 | 150 ms RTT | Consistent time-aware collision |
| LAG-04 | 300 ms RTT | Safe bounded compensation |
| LAG-05 | Variable jitter | No systematic unfair hit advantage |
| LAG-06 | Historical timestamp between frames | Correct interpolation |
| LAG-07 | Malicious future timestamp | Rejected or safely clamped |
| LAG-08 | Excessively old timestamp | Rejected or safely bounded |
| LAG-09 | Missing historical frame | Safe fallback |
| LAG-10 | Projectile launched from rewound context | No double compensation |
| LAG-11 | Target changes direction after firing | Correct eventual hit/miss |
| LAG-12 | Browser Host vs Dedicated Server | Consistent combat contract |

## 10. Vehicle and Penetration

| ID | Scenario | Expected Result |
|---|---|---|
| VEH-01 | Shoot driver through windscreen | Valid occupant hit |
| VEH-02 | Shoot passenger through side window | Valid occupant hit |
| VEH-03 | Shoot solid vehicle door | Hull blocks appropriately |
| VEH-04 | Shoot vehicle pillar | Appropriate blocking |
| VEH-05 | Passenger shoots outward | No unintended self-hull collision |
| VEH-06 | Moving vehicle with occupants | Time-correct collision |
| VEH-07 | Bullet penetrates thin wood | Correct residual movement and damage |
| VEH-08 | Multiple thin materials | Correct ordered penetrations |
| VEH-09 | Bullet hits concrete | Appropriate blocking |
| VEH-10 | Bullet breaks destructible glass | State updates correctly |
| VEH-11 | Follow-up bullet passes broken glass | No stale collision |
| VEH-12 | Vehicle occupant exits during bullet flight | Correct current collision state |

## 11. Hitboxes and Damage Lifecycle

| ID | Scenario | Expected Result |
|---|---|---|
| HIT-01 | Standing headshot | Head zone |
| HIT-02 | Crouched headshot | Head zone |
| HIT-03 | Prone headshot | Accurate rotated geometry |
| HIT-04 | Torso and leg boundary | Documented zone selection |
| HIT-05 | Shot near visible silhouette edge | Expected hit/miss |
| HIT-06 | Bullet arrives after target death | No duplicate death |
| HIT-07 | Bullet arrives after respawn | No damage to unrelated new life |
| HIT-08 | Two projectiles impact same tick | Deterministic processing |
| HIT-09 | Multiple shotgun pellets impact | Damage applied correctly |
| HIT-10 | Armor absorbs partial damage | Correct health and armor changes |
| HIT-11 | Target crosses destructible cover | Correct collision state |
| HIT-12 | Kill attribution and assists | No incorrect or duplicate credit |

---

# Part IV — Integration and Performance Testing

## 12. Required Test Commands

Run the existing applicable checks:

```bash
npm test
npm run nettest
npm run build
npm run qa:peer
npm run qa:multiplayer
```

Inspect available scripts and the actual repository before running them.

Add focused ballistic, lag-compensation, hitbox, vehicle-combat, and damage-lifecycle tests as required.

### Multiplayer QA Scenarios

**Scenario A — Moving-Target Shooting**

Two clients connect to one authoritative host.

One player runs perpendicular to the shooter at different distances.

Verify unled and correctly led shots.

**Scenario B — Lag Compensation**

Repeat under controlled latency and jitter.

Record actual shot timelines and collision results.

**Scenario C — Vehicle Occupants**

Test shooting into moving and stationary vehicles from several angles.

Verify damage to occupants and vehicles.

**Scenario D — Penetration and Destruction**

Shoot through supported materials and verify impact ordering, state replication, and subsequent projectile behavior.

**Scenario E — High Fire Rate**

Exercise automatic rifles, SMGs, LMGs, shotguns, and snipers under controlled load.

**Scenario F — Death and Respawn Races**

Test simultaneous shots, delayed projectile arrival, target death, and subsequent respawn.

**Scenario G — Hosting Parity**

Repeat representative combat tests on Dedicated Server and Browser Host.

### Required Measurements

Capture, where applicable:

- Projectile count per simulation tick.
- Projectile simulation CPU cost.
- Shot-to-impact latency.
- Collision timestamps.
- Target displacement during projectile travel.
- Server-authoritative hit/miss results.
- Historical rewind duration.
- Lag-compensation error.
- False-hit and false-miss rates in deterministic scenarios.
- Projectile-related network bandwidth.
- Simulation tick rate during sustained firefights.

Use comparable before/after scenarios.

Do not invent numerical performance improvements.

---

# Part V — Recommended Pull Requests

## PR 1 — Ballistic Timeline and Lag Compensation

Scope:

- Historical firing context validation.
- Time-aware moving-target collision.
- Projectile lifecycle design and implementation.
- Historical interpolation where necessary.
- Initial ballistic regressions.

This is the principal architectural change.

## PR 2 — Damage Lifecycle and Impact Consistency

Scope:

- Authoritative impact handling.
- Damage timing.
- Death and respawn safety.
- Destructible collision ordering.
- Combat event correctness.

Keep damage lifecycle changes aligned with PR 1.

## PR 3 — Vehicle Ballistic Collision and Material Penetration

Scope:

- Vehicle openings and occupant hits.
- Solid hull blocking.
- Material penetration.
- Glass and destructible-state consistency.
- Relevant collision tests.

## PR 4 — Hitbox Accuracy, Bots, and Final Verification

Scope:

- Stance-specific hitbox correctness.
- Headshot and damage-zone behavior.
- Bot targeting compatibility.
- Performance and networking measurements.
- End-to-end multiplayer QA.
- Final verification report.

A different PR split is acceptable if dependencies require it, but unrelated refactors should remain excluded.

---

# Part VI — Risks

## R1 — Performance Regression

Persistent bullets may increase simulation workload.

Mitigation: bounded lifetimes, appropriate collision acceleration, object lifecycle management, and profiling.

## R2 — Excessive Lag Compensation

Untrusted timestamps may permit shots against states that are too old.

Mitigation: server-authoritative time validation and bounded rewind.

## R3 — Double Compensation

Combining rewound targets with historical projectile catch-up incorrectly can apply latency adjustment twice.

Mitigation: a documented combat timeline and deterministic temporal tests.

## R4 — Collision Tunneling

High-speed bullets can cross thin geometry between simulation frames.

Mitigation: continuous swept collision checks and controlled substeps where needed.

## R5 — Duplicate or Stale Damage

Projectiles may resolve against targets that have died, disconnected, or respawned.

Mitigation: projectile identity, lifecycle validation, and deterministic impact processing.

## R6 — Material and Collision Mismatch

Visual openings may not correspond to authoritative ballistic geometry.

Mitigation: explicit collision geometry contracts and targeted visual/collision QA.

## R7 — Event Protocol Changes

Changing shot and impact timing may require adjustments to client effects and network event handling.

Mitigation: preserve existing event contracts where possible, version incompatible changes, and test event consumers.

## R8 — Combat Balance Changes

Correcting ballistics may significantly change weapon effectiveness and bot accuracy.

Mitigation: distinguish correctness fixes from balancing decisions and record gameplay changes.

---

# Part VII — Definition of Done

Phase 3 is complete only when:

### Ballistics

- [ ] Projectile collision accounts for target movement during flight.
- [ ] Correctly led shots behave as expected.
- [ ] Frozen-target false hits are eliminated.
- [ ] Travel time and collision timing are consistent.
- [ ] Fast projectiles do not tunnel.
- [ ] Penetration preserves correct travel timing.
- [ ] Projectile lifetime and resource cleanup are bounded.

### Lag Compensation

- [ ] Historical firing context is validated.
- [ ] Client-provided timestamps cannot grant arbitrary rewind.
- [ ] Historical interpolation behaves correctly where required.
- [ ] No double compensation occurs.
- [ ] Missing history is handled safely.
- [ ] Browser Host and Dedicated Server follow consistent rules.

### Vehicle Combat and Materials

- [ ] Vehicle occupants can be hit through intended openings.
- [ ] Solid vehicle geometry continues to block bullets.
- [ ] Passengers can fire outward correctly.
- [ ] Material penetration follows documented rules.
- [ ] Destructible glass and objects update authoritative collision state.
- [ ] No duplicate occupant/vehicle damage is introduced.

### Hit Detection and Damage

- [ ] Standing, crouching, and prone hitboxes are validated.
- [ ] Hit zones resolve consistently.
- [ ] Damage occurs at validated impact time.
- [ ] Death/respawn lifecycle is safe.
- [ ] Simultaneous impacts resolve deterministically.
- [ ] Kill attribution remains correct.
- [ ] Bots use the corrected ballistic rules.

### Verification

- [ ] All confirmed findings have regression tests.
- [ ] Existing unit and networking tests pass.
- [ ] Multiplayer QA passes.
- [ ] Controlled moving-target tests pass.
- [ ] Controlled latency/jitter tests pass.
- [ ] Vehicle occupant tests pass.
- [ ] Projectile performance is measured.
- [ ] Combat event and bandwidth impacts are documented.
- [ ] Remaining limitations are explicitly recorded.
- [ ] No unrelated gameplay systems were modified.

---

# Part VIII — Final Deliverable

Create:

**`PHASE3-VERIFICATION.md`**

Include:

1. **Findings Validation** — Confirmed, rejected, or partially confirmed.
2. **Root Cause Analysis** — Evidence for each defect.
3. **Combat Timeline Decision** — Chosen projectile and lag-compensation model, with rationale.
4. **Implementation Summary** — Modified files and behavior.
5. **Protocol Changes** — Event or wire-format changes and compatibility implications.
6. **Regression Tests** — New tests and their corresponding failures.
7. **Verification Results** — Exact commands and actual outcomes.
8. **Ballistic Accuracy** — Moving-target hit/miss results.
9. **Latency Results** — Rewind and projectile-timing measurements.
10. **Performance Results** — CPU, tick rate, projectile counts, and bandwidth.
11. **Remaining Risks** — Known limitations and untested scenarios.
12. **Scope Confirmation** — Explicit confirmation that unrelated systems remain unchanged.

Do not report unexecuted tests as passed.

---

# Part IX — Instructions to the Implementing Agent

Use this report as a validation and remediation specification, not as a list of changes to apply blindly.

**Before implementation:**

- Inspect current HEAD.
- Verify all findings against the current code.
- Reproduce failures wherever practical.
- Check existing combat tests.
- Analyze dependencies between projectile simulation, lag compensation, and damage.
- Document the intended authoritative combat timeline.
- Reject or revise any inaccurate finding.

**During implementation:**

- Fix root causes instead of masking symptoms.
- Preserve deterministic authoritative gameplay.
- Avoid trusting client-controlled positions or timestamps.
- Keep projectile collision and damage timing consistent.
- Reuse existing systems where appropriate.
- Avoid unnecessary architecture changes.
- Preserve Phase 1 and Phase 2 guarantees.
- Add targeted regression tests with each fix.
- Keep changes limited to Phase 3.
- Do not add advanced destruction, vehicle dynamics, animation, or unrelated features.

**After implementation:**

- Run unit, networking, build, and multiplayer checks.
- Execute controlled moving-target tests.
- Execute latency and rewind tests.
- Validate vehicle occupant and material penetration behavior.
- Measure projectile simulation cost.
- Document actual before/after results.
- Update `PHASE3-VERIFICATION.md`.
- Identify remaining limitations clearly.

**Final Requirement**

Phase 3 must not be considered complete merely because bullets follow a visually convincing trajectory or damage is delayed.

The authoritative simulation must demonstrate that projectile collision, target movement, lag compensation, material interaction, and damage timing are internally consistent and produce correct results under realistic multiplayer conditions.
