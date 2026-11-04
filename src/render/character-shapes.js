import * as THREE from 'three';

// Elliptical rings give clothing a shoulder/waist profile without a boxy torso.
// The ring heights stay inside the existing standing/crouched body dimensions.
export function torsoGeometry() {
  const rings = [[-.09, .155, .102], [.06, .172, .117], [.27, .203, .137],
    [.43, .213, .13], [.51, .175, .105], [.56, .073, .068]];
  const positions = [], uvs = [], indices = [], segments = 24;
  for (const [y, width, depth] of rings) for (let i = 0; i <= segments; i++) {
    const angle = i / segments * Math.PI * 2;
    positions.push(Math.cos(angle) * width, y, Math.sin(angle) * depth);
    uvs.push(i / segments * 1.6, (y + .1) * 2);
  }
  for (let row = 0; row < rings.length - 1; row++) for (let i = 0; i < segments; i++) {
    const a = row * (segments + 1) + i, b = a + segments + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geo.setIndex(indices); geo.computeVertexNormals();
  return geo;
}

export function carrierPlate() {
  const shape = new THREE.Shape();
  shape.moveTo(-.18, 0); shape.lineTo(.18, 0); shape.lineTo(.185, .25);
  shape.lineTo(.135, .36); shape.lineTo(-.135, .36); shape.lineTo(-.185, .25); shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: .038, bevelEnabled: true,
    bevelThickness: .009, bevelSize: .012, bevelSegments: 2, steps: 1 });
}
