import { CHUNK_SIZE, TREE_HEIGHT_SCALE } from '../config.js';
import { fbm, ihash, sstep } from '../noise.js';
import { terrainHeight, terrainNormalY } from '../terrain/height.js';

export var TREE_VERT = [
  'attribute vec3 aCol;',
  'attribute float aSway;',
  'uniform float uTime;',
  'uniform float uGust;',
  'varying vec3 vCol;',
  'varying vec3 vWorld;',
  'varying vec3 vNormal;',
  'varying float vH;',
  'varying float vFol;',
  'void main() {',
  '  vCol = aCol;',
  '  vH = position.y;',
  '  vFol = aSway;',
  '  vec3 n = normal;',
  '  vec4 lp = vec4(position, 1.0);',
  '  #ifdef USE_INSTANCING',
  '    lp = instanceMatrix * lp;',
  '    n = mat3(instanceMatrix) * n;',
  '  #endif',
  '  vec4 wp = modelMatrix * lp;',
  '  float sway = aSway * max(position.y - 1.0, 0.0) * 0.16 * uGust;',
  '  wp.x += sin(uTime * 1.7 + wp.z * 0.08 + wp.x * 0.05) * sway;',
  '  wp.z += cos(uTime * 1.3 + wp.x * 0.07) * sway * 0.6;',
  '  vWorld = wp.xyz;',
  '  vNormal = normalize(mat3(modelMatrix) * n);',
  '  gl_Position = projectionMatrix * viewMatrix * wp;',
  '}'
].join('\n');

export var TREE_FRAG = [
  'uniform vec3 uSunDir;',
  'uniform vec3 uAmbient;',
  'uniform vec3 uSunCol;',
  'uniform vec3 uFogColor;',
  'uniform float uFogNear;',
  'uniform float uFogFar;',
  'varying vec3 vCol;',
  'varying vec3 vWorld;',
  'varying vec3 vNormal;',
  'varying float vH;',
  'varying float vFol;',
  'void main() {',
  '  vec3 n = normalize(vNormal);',
  '  vec3 v = normalize(cameraPosition - vWorld);',
  '  float ndl = dot(n, uSunDir);',
  '  float diff = ndl * 0.5 + 0.5;',
  '  vec3 light = uAmbient * 1.05 + uSunCol * diff * 1.15;',
  '  float ao = 0.48 + 0.52 * smoothstep(-0.3, 2.0, vH);',
  '  vec3 c = vCol * ao * light;',
  '  if (vFol > 0.5) {',
  '    float back = pow(max(dot(-uSunDir, v), 0.0), 2.2) * 0.42;',
  '    float rim = pow(1.0 - max(dot(n, v), 0.0), 2.6) * 0.18;',
  '    c += vec3(0.10, 0.22, 0.08) * (back + rim);',
  '    c = mix(c, c * 1.08, smoothstep(0.2, 0.85, vH));',
  '  } else {',
  '    float grain = 0.90 + 0.10 * sin(vWorld.y * 4.8 + vWorld.x * 1.7);',
  '    c *= grain * (0.82 + 0.18 * smoothstep(-0.5, 0.2, ndl));',
  '  }',
  '  float fog = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));',
  '  c = mix(c, uFogColor, fog);',
  '  gl_FragColor = vec4(c, 1.0);',
  '}'
].join('\n');

export function buildTreeGeometry(THREE) {
  var h = TREE_HEIGHT_SCALE;
  var parts = [
    { g: new THREE.CylinderGeometry(0.11 * h, 0.24 * h, 1.6 * h, 8), y: 0.8 * h, c: [0.34, 0.24, 0.15], s: 0 },
    { g: new THREE.ConeGeometry(1.85 * h, 2.5 * h, 8), y: 2.25 * h, c: [0.11, 0.27, 0.11], s: 1 },
    { g: new THREE.ConeGeometry(1.45 * h, 2.1 * h, 8), y: 3.85 * h, c: [0.14, 0.31, 0.13], s: 1 },
    { g: new THREE.ConeGeometry(1.05 * h, 1.8 * h, 8), y: 5.25 * h, c: [0.17, 0.35, 0.15], s: 1 },
    { g: new THREE.ConeGeometry(0.55 * h, 1.3 * h, 8), y: 6.55 * h, c: [0.21, 0.40, 0.17], s: 1 }
  ];
  var pos = [], nrm = [], col = [], sw = [];
  parts.forEach(function (part, pi) {
    part.g.translate(0, part.y, 0);
    var g = part.g.toNonIndexed();
    var pa = g.attributes.position.array, na = g.attributes.normal.array;
    for (var i = 0; i < pa.length; i += 3) {
      var x = pa[i], y = pa[i + 1], z = pa[i + 2];
      pos.push(x, y, z);
      nrm.push(na[i], na[i + 1], na[i + 2]);
      var jitter = 0.88 + ihash(Math.round(x * 40) + pi * 17, Math.round(z * 40) + pi * 23) * 0.22;
      var heightLift = 1.0;
      if (part.s) {
        var tip = Math.max(0, (y - (part.y - 0.9 * h)) / (1.8 * h));
        heightLift = 0.82 + tip * 0.28;
      }
      col.push(
        part.c[0] * jitter * heightLift,
        part.c[1] * jitter * heightLift,
        part.c[2] * jitter * (part.s ? 0.95 + jitter * 0.05 : 1.0)
      );
      sw.push(part.s);
    }
    part.g.dispose();
    g.dispose();
  });
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aSway', new THREE.Float32BufferAttribute(sw, 1));
  geo.computeBoundingSphere();
  return geo;
}

export function spawnTrees(chunk, ctx) {
  var THREE = ctx.THREE;
  var cx = chunk.cx, cz = chunk.cz;
  var forest = fbm(cx * 0.13 + 5.2, cz * 0.13 - 3.1, 2);
  var maxTrees = Math.round(sstep(0.42, 0.72, forest) * 14);
  if (!maxTrees) return;

  var dummy = new THREE.Object3D();
  var mats = [];
  for (var i = 0; i < maxTrees; i++) {
    var rx = ihash(cx * 53 + i * 17 + 1, cz * 97 - i * 29 + 3);
    var rz = ihash(cx * 71 - i * 23 + 9, cz * 41 + i * 13 - 5);
    var x = (cx + 0.04 + rx * 0.92) * CHUNK_SIZE;
    var z = (cz + 0.04 + rz * 0.92) * CHUNK_SIZE;
    var h = terrainHeight(x, z);
    if (h < 2.8 || h > 22) continue;
    if (terrainNormalY(x, z) < 0.78) continue;
    var s = 0.75 + ihash(i * 7 + 11, (cx * 13) ^ cz) * 0.8;
    dummy.position.set(x, h - 0.15, z);
    dummy.rotation.y = rz * Math.PI * 2;
    dummy.scale.set(s, s * (0.9 + rx * 0.4), s);
    dummy.updateMatrix();
    mats.push(dummy.matrix.clone());
    chunk.colliders.push({ x: x, z: z, r: 0.5 * s + 0.25, top: h + 6.8 * TREE_HEIGHT_SCALE * s * (0.9 + rx * 0.4) });
  }
  if (!mats.length) return;

  var inst = new THREE.InstancedMesh(ctx.treeGeo, ctx.treeMat, mats.length);
  for (var m = 0; m < mats.length; m++) inst.setMatrixAt(m, mats[m]);
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  ctx.scene.add(inst);
  chunk.trees = inst;
}
