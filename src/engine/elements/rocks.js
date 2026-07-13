import { CHUNK_SIZE } from '../config.js';
import { ihash } from '../noise.js';
import { terrainHeight, terrainNormalY } from '../terrain/height.js';

export function buildRockGeometry(THREE) {
  var geo = new THREE.IcosahedronGeometry(1, 1);
  var pa = geo.attributes.position.array;
  for (var i = 0; i < pa.length; i += 3) {
    var qx = Math.round(pa[i] * 9), qy = Math.round(pa[i + 1] * 9), qz = Math.round(pa[i + 2] * 9);
    var j = ihash(qx * 13 + qz * 31, qy * 17 - qz * 7);
    var k = ihash(qy * 23 - qx * 11, qz * 19 + qx * 3);
    var m = 0.78 + j * 0.45;
    pa[i] *= m;
    pa[i + 1] *= m * 0.72;
    pa[i + 2] *= m * (0.8 + k * 0.4);
  }
  geo.computeVertexNormals();
  var count = geo.attributes.position.count;
  var col = new Float32Array(count * 3);
  for (var v = 0; v < count; v++) {
    var y = geo.attributes.position.array[v * 3 + 1];
    var shade = (0.42 + ihash(v * 7 + 1, v * 13 + 5) * 0.10) *
      (0.66 + 0.34 * Math.min(1, Math.max(0, (y + 0.7) / 1.3)));
    col[v * 3] = shade * 1.03; col[v * 3 + 1] = shade; col[v * 3 + 2] = shade * 0.95;
  }
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

export function spawnRocks(chunk, ctx) {
  var THREE = ctx.THREE;
  var cx = chunk.cx, cz = chunk.cz;
  var n = Math.floor(2 + ihash(cx * 199 + 8, cz * 211 - 4) * 9);
  var dummy = new THREE.Object3D();
  var mats = [];
  for (var i = 0; i < n; i++) {
    var rx = ihash(cx * 149 + i * 37 + 2, cz * 83 - i * 19 + 6);
    var rz = ihash(cx * 61 + i * 43 - 8, cz * 173 + i * 31 + 4);
    var x = (cx + 0.03 + rx * 0.94) * CHUNK_SIZE;
    var z = (cz + 0.03 + rz * 0.94) * CHUNK_SIZE;
    var h = terrainHeight(x, z);
    if (h < 0.6 || h > 44) continue;
    if (terrainNormalY(x, z) >= 0.80 && ihash(i * 91 + cx, i * 53 + cz) >= 0.4) continue;
    var r3 = ihash(i * 17 + cx * 5, i * 29 - cz * 7);
    var s = 0.5 + r3 * r3 * 2.6;
    dummy.position.set(x, h - 0.25 * s, z);
    dummy.rotation.set((rx - 0.5) * 0.5, rz * Math.PI * 2, (rz - 0.5) * 0.5);
    dummy.scale.set(s * (0.8 + rx * 0.5), s * (0.6 + r3 * 0.5), s * (0.8 + rz * 0.5));
    dummy.updateMatrix();
    mats.push(dummy.matrix.clone());
    if (s >= 0.75) chunk.colliders.push({ x: x, z: z, r: s * 1.0, top: h - 0.25 * s + s * (0.6 + r3 * 0.5) * 0.9 });
  }
  if (!mats.length) return;

  var inst = new THREE.InstancedMesh(ctx.rockGeo, ctx.rockMat, mats.length);
  for (var m = 0; m < mats.length; m++) inst.setMatrixAt(m, mats[m]);
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  ctx.scene.add(inst);
  chunk.rocks = inst;
}
