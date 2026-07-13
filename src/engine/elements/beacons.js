import { CHUNK_SIZE } from '../config.js';
import { ihash } from '../noise.js';
import { terrainHeight } from '../terrain/height.js';

export var BEACON_VERT = [
  'varying vec3 vN;',
  'varying vec3 vW;',
  'void main() {',
  '  vec4 wp = modelMatrix * vec4(position, 1.0);',
  '  vW = wp.xyz;',
  '  vN = normalize(mat3(modelMatrix) * normal);',
  '  gl_Position = projectionMatrix * viewMatrix * wp;',
  '}'
].join('\n');

export var BEACON_FRAG = [
  'uniform float uTime;',
  'uniform float uPhase;',
  'uniform float uDim;',
  'varying vec3 vN;',
  'varying vec3 vW;',
  'void main() {',
  '  vec3 v = normalize(cameraPosition - vW);',
  '  float fres = pow(1.0 - abs(dot(normalize(vN), v)), 1.4);',
  '  float pulse = 0.7 + 0.3 * sin(uTime * 2.4 + uPhase);',
  '  vec3 base = mix(vec3(0.18, 0.85, 1.0), vec3(0.65, 0.45, 1.0), 0.5 + 0.5 * sin(uPhase));',
  '  vec3 col = base * (0.35 + fres * 1.4) * pulse;',
  '  col = mix(col, vec3(0.45, 0.50, 0.55) * (0.3 + fres * 0.6), uDim);',
  '  gl_FragColor = vec4(col, 1.0);',
  '}'
].join('\n');

export var ADJ = ['Whispering', 'Sunken', 'Ancient', 'Hollow', 'Radiant', 'Forgotten', 'Drifting', 'Embered', 'Silent', 'Glacial', 'Verdant', 'Umbral'];
export var NOUN = ['Spire', 'Cairn', 'Monolith', 'Beacon', 'Relic', 'Obelisk', 'Shard', 'Sentinel', 'Waystone', 'Idol'];
export var LORE = [
  'Travelers speak of a low hum beneath the stone here, older than the sea.',
  'A cartographer\u2019s mark, left by someone who never came back for it.',
  'The crystal is warm to the touch, as if it remembers the sun.',
  'Locals say the light flickers in time with a heartbeat \u2014 nobody asks whose.',
  'Storms bend around this place. The grass has never once been flattened.',
  'An offering site from the age before the waters rose.',
  'The inscription has worn away. Only the word \u201cagain\u201d remains.',
  'Birds will not land here. The wind does, constantly.',
  'It is said each shard holds one unspent dawn.',
  'Whoever planted this meant for it to be found. Just not soon.'
];

export function spawnBeacon(chunk, ctx) {
  var THREE = ctx.THREE;
  var cx = chunk.cx, cz = chunk.cz;
  if (ihash(cx * 7919 + 13, cz * 6271 - 7) >= 0.16) return;

  var px = (cx + 0.15 + 0.7 * ihash(cx * 31 + 7, cz * 17 + 3)) * CHUNK_SIZE;
  var pz = (cz + 0.15 + 0.7 * ihash(cx * 23 - 5, cz * 41 + 11)) * CHUNK_SIZE;
  var ph = terrainHeight(px, pz);
  if (ph < 2.5 || ph > 38) return;

  var id = 'p' + cx + '_' + cz;
  var s1 = ihash(cx * 101 + 17, cz * 57 - 29);
  var s2 = ihash(cx * 67 - 3, cz * 131 + 19);
  var discovered = ctx.discovered.has(id);

  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPhase: { value: s1 * Math.PI * 2 },
      uDim: { value: discovered ? 1 : 0 }
    },
    vertexShader: BEACON_VERT,
    fragmentShader: BEACON_FRAG
  });
  var mesh = new THREE.Mesh(ctx.beaconGeo, mat);
  mesh.scale.set(1, 1.6, 1);
  mesh.position.set(px, ph + 2.6, pz);
  ctx.scene.add(mesh);

  var sprMat = new THREE.SpriteMaterial({
    map: ctx.glowTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: discovered ? 0.18 : 0.55
  });
  var sprite = new THREE.Sprite(sprMat);
  sprite.scale.set(9, 9, 1);
  sprite.position.copy(mesh.position);
  ctx.scene.add(sprite);

  var beacon = {
    id: id, x: px, z: pz, baseY: ph + 2.6,
    mesh: mesh, sprite: sprite,
    name: ADJ[Math.floor(s1 * ADJ.length) % ADJ.length] + ' ' + NOUN[Math.floor(s2 * NOUN.length) % NOUN.length],
    lore: LORE[Math.floor((s1 * 7 + s2 * 13) * LORE.length) % LORE.length],
    discovered: discovered,
    phase: s1 * Math.PI * 2
  };
  chunk.beacons.push(beacon);
  ctx.beacons.set(id, beacon);
}
