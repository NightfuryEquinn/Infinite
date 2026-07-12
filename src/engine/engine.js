/* ============================================================================
   INFINITE — chunk-based infinite 3D world explorer
   Self-registering <infinite-world> web component (plain script, no exports).

   Performance notes (the two requested optimizations):

   1. CHUNK LOADING RADIUS — chunks load in a CIRCLE (not a square) of
      VIEW_RADIUS=4 around the camera (~49 chunks live at once), each
      36x36 quads => ~127k triangles total. Fog far is matched to the
      radius edge so unloaded terrain is never visible. Chunks build at
      most 1 per frame (5 during the initial load) from a distance-sorted
      queue, and are disposed the moment they leave UNLOAD_RADIUS.

   2. SIMPLIFIED NOISE — terrain height is a cheap hash-based VALUE-noise
      FBM (max 11 octave evaluations per sample, and the 3-octave ridge
      term is skipped entirely over ocean/plains). Heights + normals are
      baked ONCE into chunk geometry on the CPU, so:
        - the vertex shader does ZERO per-frame noise work,
        - the fragment shader needs only a 1-line hash grain (no per-pixel
          FBM at all — biomes blend from baked height/normal varyings),
        - the camera's terrain-following uses the SAME JS function as the
          mesh, so there is no GPU/CPU noise divergence (no sinking
          through hills).
      A dynamic-resolution governor also nudges pixel ratio down/up to
      hold a stable 60 FPS on slower GPUs.
   ========================================================================= */
(function () {
  'use strict';
  if (customElements.get('infinite-world')) return;

  /* ------------------------------------------------------------ config */
  var CHUNK_SIZE = 64;          // world units per chunk side
  var CHUNK_RES = 36;           // quads per chunk side (37x37 verts < 65k => Uint16 indices)
  var VIEW_RADIUS = 4;          // chunk-space circular load radius
  var UNLOAD_RADIUS = 5.6;      // chunk-space dispose radius (hysteresis)
  var SEA_LEVEL = 0;
  var EYE_HEIGHT = 2.3;
  var WALK_SPEED = 16;
  var SPRINT_SPEED = 34;
  var GRAVITY = 32;
  var JUMP_V = 13;
  var DAY_LENGTH = 180;      // seconds per full day/night cycle
  var SNOW_N = 650;          // snowfall particles (only visible over snowy peaks)
  var WIND_N = 70;           // wind gust streak segments
  var FOG_NEAR = 110;
  var FOG_FAR = 250;            // == VIEW_RADIUS * CHUNK_SIZE - a bit
  var FOG_COLOR = [0.80, 0.85, 0.90];
  var SKY_ZENITH = [0.34, 0.50, 0.76];
  var SUN = (function () {
    var x = 0.55, y = 0.52, z = 0.30, l = Math.sqrt(x * x + y * y + z * z);
    return [x / l, y / l, z / l];
  })();
  var LS_KEY = 'infinite-explorer-discovered-v1';

  /* ----------------------------------------------------- three.js loader */
  var threePromise = null;
  function loadThree() {
    if (threePromise) return threePromise;
    threePromise = import('three').then(function (m) {
      return m;
    });
    return threePromise;
  }

  /* ------------------------------------------------- deterministic noise */
  function ihash(ix, iz) {
    var n = (ix * 374761393 + iz * 668265263) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n = n ^ (n >>> 16);
    return (n >>> 0) / 4294967296;
  }
  function vnoise(x, z) {
    var ix = Math.floor(x), iz = Math.floor(z);
    var fx = x - ix, fz = z - iz;
    var ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    var a = ihash(ix, iz), b = ihash(ix + 1, iz);
    var c = ihash(ix, iz + 1), d = ihash(ix + 1, iz + 1);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  }
  function fbm(x, z, oct) {
    var v = 0, amp = 0.5, tot = 0;
    for (var i = 0; i < oct; i++) {
      v += vnoise(x, z) * amp;
      tot += amp; amp *= 0.5;
      x = x * 2.03 + 11.31; z = z * 2.03 - 7.77;
    }
    return v / tot;
  }
  function sstep(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /* The single source of truth for terrain height (mesh AND camera). */
  function terrainHeight(x, z) {
    var cont = fbm(x * 0.0013, z * 0.0013, 3);            // continents
    var hills = fbm(x * 0.0085 + 37.7, z * 0.0085 - 11.2, 4);
    var land = sstep(0.38, 0.52, cont);
    var h = (cont - 0.42) * 88;
    h += (hills - 0.5) * 26 * land;
    var m = sstep(0.55, 0.78, cont);                       // mountain mask
    if (m > 0.001) {                                       // skip 3 octaves over ocean/plains
      var r = 1 - Math.abs(2 * fbm(x * 0.004 - 91.3, z * 0.004 + 44.8, 3) - 1);
      h += m * r * r * 54;
    }
    h += (vnoise(x * 0.05, z * 0.05) - 0.5) * 2.4;         // fine detail
    return h;
  }
  function terrainNormalY(x, z) {
    var e = 1.2;
    var dx = terrainHeight(x - e, z) - terrainHeight(x + e, z);
    var dz = terrainHeight(x, z - e) - terrainHeight(x, z + e);
    return (2 * e) / Math.sqrt(dx * dx + dz * dz + 4 * e * e);
  }
  function biomeName(h, ny) {
    if (h < -10) return 'Deep Ocean';
    if (h < 0.3) return 'Shallows';
    if (h < 2.2) return 'Sandy Shores';
    if (h > 36) return 'Snowy Peaks';
    if (ny < 0.62) return 'Rocky Cliffs';
    if (h > 20) return 'Highlands';
    return 'Verdant Plains';
  }

  /* -------------------------------------------------------- POI flavour */
  var ADJ = ['Whispering', 'Sunken', 'Ancient', 'Hollow', 'Radiant', 'Forgotten', 'Drifting', 'Embered', 'Silent', 'Glacial', 'Verdant', 'Umbral'];
  var NOUN = ['Spire', 'Cairn', 'Monolith', 'Beacon', 'Relic', 'Obelisk', 'Shard', 'Sentinel', 'Waystone', 'Idol'];
  var LORE = [
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

  /* ------------------------------------------------------------ shaders */
  var TERRAIN_VERT = [
    'attribute float aAO;',
    'varying vec3 vWorld;',
    'varying vec3 vNormal;',
    'varying float vAO;',
    'void main() {',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vWorld = wp.xyz;',
    '  vNormal = normalize(mat3(modelMatrix) * normal);',
    '  vAO = aAO;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var TERRAIN_FRAG = [
    'uniform vec3 uSunDir;',
    'uniform vec3 uAmbient;',
    'uniform vec3 uSunCol;',
    'uniform vec3 uFogColor;',
    'uniform float uFogNear;',
    'uniform float uFogFar;',
    'varying vec3 vWorld;',
    'varying vec3 vNormal;',
    'varying float vAO;',
    'float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    '/* smooth value noise (4 hashes) — replaces the old pixelated floor() grain */',
    'float vn2(vec2 p) {',
    '  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));',
    '  float c = hash21(i + vec2(0.0, 1.0)), e = hash21(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);',
    '}',
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  float h = vWorld.y;',
    '  float slope = 1.0 - n.y;',
    '  /* two smooth octaves of albedo detail + one broad patchiness octave */',
    '  float detail = vn2(vWorld.xz * 0.9) * 0.65 + vn2(vWorld.xz * 3.7) * 0.35;',
    '  float vary = vn2(vWorld.xz * 0.045);',
    '  /* noise-derivative normal perturbation — craggy shading on cliffs */',
    '  float rockAmt = smoothstep(0.30, 0.52, slope + (detail - 0.5) * 0.12);',
    '  float nb = vn2(vWorld.xz * 1.6);',
    '  vec3 pn = vec3(vn2(vWorld.xz * 1.6 + vec2(0.31, 0.0)) - nb, 0.0, vn2(vWorld.xz * 1.6 + vec2(0.0, 0.31)) - nb);',
    '  n = normalize(n + pn * 2.4 * rockAmt);',
    '  vec3 colSea   = vec3(0.13, 0.22, 0.21);',
    '  vec3 colSand  = vec3(0.76, 0.68, 0.48);',
    '  vec3 colGrass = mix(vec3(0.23, 0.37, 0.18), vec3(0.34, 0.46, 0.22), vary);',
    '  vec3 colRock  = mix(vec3(0.38, 0.36, 0.35), vec3(0.46, 0.44, 0.42), vary);',
    '  vec3 colSnow  = vec3(0.92, 0.94, 0.97);',
    '  vec3 col = mix(colSea, colSand, smoothstep(-1.8, 0.5, h));',
    '  col = mix(col, colGrass, smoothstep(1.0, 3.6, h));',
    '  col = mix(col, colRock, rockAmt);',
    '  col = mix(col, colSnow, smoothstep(33.0, 40.0, h + (detail - 0.5) * 5.0) * (1.0 - smoothstep(0.25, 0.55, slope)));',
    '  col *= 0.86 + 0.26 * detail;',
    '  float diff = max(dot(n, uSunDir), 0.0);',
    '  vec3 light = uAmbient + uSunCol * diff * 1.25;',
    '  vec3 view = normalize(cameraPosition - vWorld);',
    '  vec3 hv = normalize(uSunDir + view);',
    '  float spec = pow(max(dot(n, hv), 0.0), 48.0);',
    '  float specAmt = 0.5 * smoothstep(33.0, 40.0, h) + 0.15 * smoothstep(0.5, -0.5, h);',
    '  vec3 c = col * vAO * light + spec * specAmt * uSunCol * 1.3;',
    '  float fog = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));',
    '  c = mix(c, uFogColor, fog);',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  var WATER_VERT = [
    'uniform float uTime;',
    'varying vec3 vWorld;',
    'void main() {',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  /* waves keyed to WORLD xz so they stay put while the plane follows the camera */',
    '  wp.y += sin(wp.x * 0.06 + uTime * 1.1) * 0.22 + cos(wp.z * 0.085 + uTime * 1.6) * 0.16;',
    '  vWorld = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var WATER_FRAG = [
    'uniform float uTime;',
    'uniform float uLightI;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uFogColor;',
    'uniform float uFogNear;',
    'uniform float uFogFar;',
    'varying vec3 vWorld;',
    'void main() {',
    '  vec2 p = vWorld.xz;',
    '  float dx = cos(p.x * 0.06 + uTime * 1.1) * 0.30 + cos(p.x * 0.23 + p.y * 0.11 + uTime * 2.2) * 0.10;',
    '  float dz = -sin(p.y * 0.085 + uTime * 1.6) * 0.30 + cos(p.y * 0.19 - p.x * 0.07 + uTime * 1.9) * 0.10;',
    '  vec3 n = normalize(vec3(-dx, 1.0, -dz));',
    '  vec3 view = normalize(cameraPosition - vWorld);',
    '  float fres = pow(1.0 - max(dot(n, view), 0.0), 3.0);',
    '  vec3 deep = vec3(0.05, 0.20, 0.27);',
    '  vec3 shallow = vec3(0.10, 0.34, 0.40);',
    '  vec3 col = mix(deep, shallow, 0.5 + 0.5 * sin(p.x * 0.02 + p.y * 0.017 + uTime * 0.3));',
    '  col *= mix(0.30, 1.0, uLightI);',
    '  col = mix(col, uFogColor * 0.9, fres * 0.75);',
    '  vec3 hv = normalize(uSunDir + view);',
    '  float spec = pow(max(dot(n, hv), 0.0), 140.0);',
    '  col += spec * vec3(1.0, 0.95, 0.85) * 0.9 * uLightI;',
    '  float fog = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));',
    '  col = mix(col, uFogColor, fog);',
    '  gl_FragColor = vec4(col, 0.86);',
    '}'
  ].join('\n');

  var SKY_VERT = [
    'varying vec3 vDir;',
    'void main() {',
    '  vDir = position;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  var SKY_FRAG = [
    'uniform vec3 uSunDir;',
    'uniform vec3 uZenith;',
    'uniform vec3 uHorizon;',
    'uniform float uNightI;',
    'uniform float uTime;',
    'varying vec3 vDir;',
    'float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float vn2(vec2 p) {',
    '  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));',
    '  float c = hash21(i + vec2(0.0, 1.0)), e = hash21(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);',
    '}',
    '/* point stars: one star per cell, round falloff, per-star tint + twinkle */',
    'vec3 starLayer(vec2 sp, float scale, float thresh, float boost, float t) {',
    '  vec2 g = sp * scale;',
    '  vec2 id = floor(g);',
    '  float h = hash21(id);',
    '  if (h < thresh) return vec3(0.0);',
    '  vec2 pos = vec2(hash21(id + 1.3), hash21(id + 2.7)) * 0.8 + 0.1;',
    '  float dd = length(fract(g) - pos);',
    '  float h2 = hash21(id + 3.7);',
    '  float tw = 0.72 + 0.28 * sin(t * (1.5 + 3.0 * h2) + h2 * 40.0);',
    '  float b = smoothstep(0.10 + 0.14 * h2, 0.0, dd) * (0.25 + 0.75 * h2) * tw * boost;',
    '  vec3 tint = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.90, 0.74), step(0.72, hash21(id + 5.1)));',
    '  return b * tint;',
    '}',
    'void main() {',
    '  vec3 d = normalize(vDir);',
    '  float t = pow(clamp(d.y, 0.0, 1.0), 0.55);',
    '  vec3 col = mix(uHorizon, uZenith, t);',
    '  float s = max(dot(d, uSunDir), 0.0);',
    '  float dayGlow = 1.0 - uNightI * 0.85;',
    '  col += vec3(1.0, 0.9, 0.7) * pow(s, 350.0) * 1.2 * dayGlow;',
    '  col += vec3(1.0, 0.85, 0.6) * pow(s, 12.0) * 0.18 * dayGlow;',
    '  if (uNightI > 0.001) {',
    '    float hm = smoothstep(0.0, 0.18, d.y);',
    '    vec2 sp = d.xz / (abs(d.y) + 0.30);',
    '    /* milky way: soft great-circle band with noisy wisps + dust lane */',
    '    float bandD = dot(d, normalize(vec3(0.55, 0.18, -0.81)));',
    '    float band = exp(-bandD * bandD * 22.0);',
    '    float wisps = vn2(sp * 7.0 + 3.7) * 0.6 + vn2(sp * 16.0) * 0.4;',
    '    float dust = smoothstep(0.3, 0.75, vn2(sp * 4.2 + 19.1)) * band * 0.5;',
    '    col += vec3(0.42, 0.47, 0.68) * band * (0.10 + 0.18 * wisps) * (1.0 - dust) * uNightI * hm;',
    '    /* two star layers; density rises inside the galactic band */',
    '    vec3 stars = starLayer(sp, 70.0, 0.78 - band * 0.12, 1.0, uTime)',
    '               + starLayer(sp + 11.7, 150.0, 0.84 - band * 0.10, 0.55, uTime * 1.3);',
    '    col += stars * uNightI * hm;',
    '    /* moon: crisp disc, limb darkening, mare mottling, cool halo */',
    '    vec3 md = -uSunDir;',
    '    float ang = acos(clamp(dot(d, md), -1.0, 1.0));',
    '    float disc = smoothstep(0.040, 0.0365, ang);',
    '    vec3 mr = normalize(cross(md, vec3(0.0, 1.0, 0.0)));',
    '    vec3 mu = cross(mr, md);',
    '    vec2 mp = vec2(dot(d, mr), dot(d, mu)) / 0.040;',
    '    float limb = sqrt(max(1.0 - dot(mp, mp), 0.0));',
    '    float mare = vn2(mp * 3.1 + 7.3) * 0.5 + vn2(mp * 6.7 + 2.2) * 0.5;',
    '    vec3 moonCol = mix(vec3(0.87, 0.89, 0.93), vec3(0.55, 0.57, 0.62), smoothstep(0.35, 0.75, mare));',
    '    col = mix(col, moonCol * (0.5 + 0.5 * limb) * 1.15, disc * uNightI);',
    '    col += vec3(0.45, 0.53, 0.74) * exp(-ang * ang * 160.0) * 0.45 * (1.0 - disc) * uNightI;',
    '  }',
    '  col = mix(col, uHorizon, smoothstep(0.0, -0.25, d.y));',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var BEACON_VERT = [
    'varying vec3 vN;',
    'varying vec3 vW;',
    'void main() {',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vW = wp.xyz;',
    '  vN = normalize(mat3(modelMatrix) * normal);',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var BEACON_FRAG = [
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

  var TREE_VERT = [
    'attribute vec3 aCol;',
    'attribute float aSway;',
    'uniform float uTime;',
    'uniform float uGust;',
    'varying vec3 vCol;',
    'varying vec3 vWorld;',
    'varying vec3 vNormal;',
    'varying float vH;',
    'void main() {',
    '  vCol = aCol;',
    '  vH = position.y;',
    '  vec3 n = normal;',
    '  vec4 lp = vec4(position, 1.0);',
    '  #ifdef USE_INSTANCING',
    '    lp = instanceMatrix * lp;',
    '    n = mat3(instanceMatrix) * n;',
    '  #endif',
    '  vec4 wp = modelMatrix * lp;',
    '  /* only foliage sways (aSway = 1 on the cones, 0 on trunks and rocks), */',
    '  /* keyed to MODEL-space height so altitude cannot amplify the bend */',
    '  float sway = aSway * max(position.y - 1.0, 0.0) * 0.16 * uGust;',
    '  wp.x += sin(uTime * 1.7 + wp.z * 0.08 + wp.x * 0.05) * sway;',
    '  wp.z += cos(uTime * 1.3 + wp.x * 0.07) * sway * 0.6;',
    '  vWorld = wp.xyz;',
    '  vNormal = normalize(mat3(modelMatrix) * n);',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var TREE_FRAG = [
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
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  float diff = max(dot(n, uSunDir), 0.0);',
    '  vec3 light = uAmbient * 1.05 + uSunCol * diff * 1.2;',
    '  /* baked contact AO: vertices near the ground are occluded */',
    '  float ao = 0.5 + 0.5 * smoothstep(-0.3, 1.8, vH);',
    '  vec3 c = vCol * ao * light;',
    '  float fog = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));',
    '  c = mix(c, uFogColor, fog);',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  var GRASS_VERT = [
    'attribute float aW;',
    'uniform float uTime;',
    'uniform vec3 uWind;   /* x,z = direction, y = gust strength */',
    'uniform vec3 uPlayer;',
    'varying vec3 vCol;',
    'varying float vW;',
    'varying vec3 vWorld;',
    'float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'void main() {',
    '  vW = aW;',
    '  vec4 lp = vec4(position, 1.0);',
    '  vec3 org = vec3(0.0);',
    '  #ifdef USE_INSTANCING',
    '    org = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);',
    '    lp = instanceMatrix * lp;',
    '  #endif',
    '  vec4 wp = modelMatrix * lp;',
    '  float ph = hash21(org.xz * 0.731);',
    '  vCol = mix(vec3(0.27, 0.40, 0.16), vec3(0.47, 0.52, 0.20), ph);',
    '  /* gust lean + per-tuft flutter (tips only — aW = 0 at the roots) */',
    '  float flutter = sin(uTime * (2.0 + ph * 2.0) + ph * 17.0 + org.x * 0.5);',
    '  vec2 lean = uWind.xz * (0.05 + 0.34 * uWind.y * (0.65 + 0.35 * flutter));',
    '  /* trample: blades bend away from the player within ~1.6m */',
    '  vec2 away = wp.xz - uPlayer.xz;',
    '  float pd = max(length(away), 0.001);',
    '  float push = smoothstep(1.6, 0.25, pd) * 0.5;',
    '  wp.xz += (lean + away / pd * push) * aW;',
    '  vWorld = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var GRASS_FRAG = [
    'uniform vec3 uAmbient;',
    'uniform vec3 uSunCol;',
    'uniform vec3 uFogColor;',
    'uniform float uFogNear;',
    'uniform float uFogFar;',
    'varying vec3 vCol;',
    'varying float vW;',
    'varying vec3 vWorld;',
    'void main() {',
    '  vec3 light = uAmbient * 1.1 + uSunCol * 0.85;',
    '  vec3 c = vCol * (0.62 + 0.38 * vW) * light;',
    '  float fog = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));',
    '  c = mix(c, uFogColor, fog);',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  /* --------------------------------------------------------- HUD markup */
  var GLASS = 'background:rgba(8,13,20,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.12);border-radius:12px;';
  var MONO = "font-family:'IBM Plex Mono',ui-monospace,monospace;";

  function hudHTML() {
    return [
      // vignette
      '<div style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, transparent 55%, rgba(5,10,18,.5));"></div>',
      // crosshair
      '<div data-cross style="position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 6px rgba(0,0,0,.6);pointer-events:none;opacity:0;transition:opacity .3s;"></div>',
      // title / fps / discovered (top-left)
      '<div style="position:absolute;top:16px;left:16px;padding:12px 16px;' + GLASS + 'pointer-events:none;display:flex;flex-direction:column;gap:4px;">',
      '  <div style="font-weight:700;font-size:17px;letter-spacing:.32em;color:#fff;">INFINITE</div>',
      '  <div data-fps style="' + MONO + 'font-size:11px;color:rgba(255,255,255,.6);">\u2014 fps</div>',
      '  <div data-clock style="' + MONO + 'font-size:11px;color:rgba(255,255,255,.75);">\u2014</div>',
      '  <div data-disc style="font-size:12px;color:#8fd8ff;">\u25c6 0 discovered</div>',
      '</div>',
      // minimap (top-right)
      '<div style="position:absolute;top:16px;right:16px;padding:8px;' + GLASS + 'pointer-events:none;">',
      '  <canvas data-map width="168" height="168" style="display:block;border-radius:8px;"></canvas>',
      '  <div style="position:absolute;top:12px;left:50%;transform:translateX(-50%);' + MONO + 'font-size:10px;color:rgba(255,255,255,.75);text-shadow:0 1px 3px rgba(0,0,0,.8);">N</div>',
      '</div>',
      // stats (bottom-left)
      '<div style="position:absolute;left:16px;bottom:16px;padding:12px 16px;' + GLASS + 'pointer-events:none;min-width:208px;display:flex;flex-direction:column;gap:7px;">',
      '  <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline;">',
      '    <span style="font-size:10px;letter-spacing:.18em;color:rgba(255,255,255,.5);">BIOME</span>',
      '    <span data-biome style="font-size:13px;font-weight:500;color:#fff;">\u2014</span>',
      '  </div>',
      '  <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline;">',
      '    <span style="font-size:10px;letter-spacing:.18em;color:rgba(255,255,255,.5);">POS</span>',
      '    <span data-pos style="' + MONO + 'font-size:12px;color:rgba(255,255,255,.85);">0, 0</span>',
      '  </div>',
      '  <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;">',
      '    <span style="font-size:10px;letter-spacing:.18em;color:rgba(255,255,255,.5);">SPEED</span>',
      '    <span style="display:flex;align-items:center;gap:8px;">',
      '      <span style="width:74px;height:4px;border-radius:2px;background:rgba(255,255,255,.14);overflow:hidden;display:inline-block;"><span data-speedbar style="display:block;height:100%;width:0%;border-radius:2px;background:linear-gradient(90deg,#5fb8e8,#8fd8ff);transition:width .15s;"></span></span>',
      '      <span data-speed style="' + MONO + 'font-size:12px;color:rgba(255,255,255,.85);min-width:54px;text-align:right;">0.0 m/s</span>',
      '    </span>',
      '  </div>',
      '</div>',
      // controls hint (bottom-right)
      '<div data-hint style="position:absolute;right:16px;bottom:16px;padding:8px 14px;' + GLASS + MONO + 'font-size:11px;color:rgba(255,255,255,.62);pointer-events:none;">WASD move \u00b7 mouse look \u00b7 SPACE double-jump \u00b7 SHIFT sprint \u00b7 E discover</div>',
      // POI popup (bottom-center)
      '<div data-popup style="position:absolute;left:50%;bottom:84px;transform:translate(-50%,10px);max-width:380px;padding:14px 18px;' + GLASS + 'border-color:rgba(143,216,255,.35);pointer-events:none;opacity:0;transition:opacity .25s, transform .25s;text-align:center;">',
      '  <div data-popup-kicker style="' + MONO + 'font-size:10px;letter-spacing:.14em;color:#8fd8ff;margin-bottom:5px;">POINT OF INTEREST</div>',
      '  <div data-popup-name style="font-size:17px;font-weight:700;color:#fff;margin-bottom:6px;">\u2014</div>',
      '  <div data-popup-lore style="font-size:12.5px;line-height:1.5;color:rgba(255,255,255,.78);margin-bottom:9px;">\u2014</div>',
      '  <div data-popup-action style="' + MONO + 'font-size:11px;color:#ffd86b;">[ E ] DISCOVER</div>',
      '</div>',
      // click-to-start overlay
      '<div data-start style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(5,9,16,.42);cursor:pointer;">',
      '  <div style="text-align:center;padding:22px 34px;' + GLASS + '">',
      '    <div style="font-size:15px;font-weight:700;letter-spacing:.26em;color:#fff;margin-bottom:8px;">\u25b6 CLICK TO EXPLORE</div>',
      '    <div style="' + MONO + 'font-size:11px;color:rgba(255,255,255,.6);">pointer locks for mouse-look \u00b7 ESC releases</div>',
      '  </div>',
      '</div>',
      // loading overlay
      '<div data-loading style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0e14;transition:opacity .6s;z-index:5;">',
      '  <div style="text-align:center;">',
      '    <div style="font-size:22px;font-weight:700;letter-spacing:.42em;color:#fff;margin-bottom:18px;">INFINITE</div>',
      '    <div style="width:220px;height:3px;border-radius:2px;background:rgba(255,255,255,.12);margin:0 auto 12px;overflow:hidden;"><div data-loadbar style="height:100%;width:0%;background:#8fd8ff;border-radius:2px;transition:width .2s;"></div></div>',
      '    <div data-loadtext style="' + MONO + 'font-size:11px;color:rgba(255,255,255,.55);">compiling shaders \u00b7 generating terrain</div>',
      '  </div>',
      '</div>'
    ].join('');
  }

  /* ----------------------------------------------------- misc factories */
  function makeGlowTexture(THREE) {
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.35, 'rgba(160,220,255,0.35)');
    grad.addColorStop(1, 'rgba(120,180,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  function makeSoftTexture(THREE) {
    var c = document.createElement('canvas');
    c.width = c.height = 32;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }

  /* low-poly pine: trunk + two cones merged into ONE geometry with baked
     vertex colors, so every chunk's trees render as a single instanced draw */
  function buildTreeGeometry(THREE) {
    var parts = [
      { g: new THREE.CylinderGeometry(0.16, 0.26, 1.7, 5), y: 0.85, c: [0.36, 0.26, 0.18], s: 0 },
      { g: new THREE.ConeGeometry(1.7, 2.7, 6), y: 2.7, c: [0.16, 0.30, 0.16], s: 1 },
      { g: new THREE.ConeGeometry(1.2, 2.1, 6), y: 4.3, c: [0.20, 0.36, 0.18], s: 1 }
    ];
    var pos = [], nrm = [], col = [], sw = [];
    parts.forEach(function (part) {
      part.g.translate(0, part.y, 0);
      var g = part.g.toNonIndexed();
      var pa = g.attributes.position.array, na = g.attributes.normal.array;
      for (var i = 0; i < pa.length; i += 3) {
        pos.push(pa[i], pa[i + 1], pa[i + 2]);
        nrm.push(na[i], na[i + 1], na[i + 2]);
        col.push(part.c[0], part.c[1], part.c[2]);
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

  /* faceted boulder: jittered icosahedron with baked gray vertex colors.
     Jitter is keyed to quantized vertex position so coincident vertices of
     adjacent faces move together (watertight). Shares the tree shader with
     uGust pinned to 0, so the GPU program is compiled once. */
  function buildRockGeometry(THREE) {
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

  /* grass tuft: 3 vertical triangle blades fanned 120° apart; aW marks the
     tip vertex so only tips lean with gusts and trampling */
  function buildGrassGeometry(THREE) {
    var pos = [], w = [];
    for (var k = 0; k < 3; k++) {
      var a = k * 2.094 + 0.35;
      var ca = Math.cos(a), sa = Math.sin(a);
      var bw = 0.07;
      pos.push(-bw * ca, 0, -bw * sa);
      pos.push(bw * ca, 0, bw * sa);
      pos.push(-sa * 0.10, 0.62, ca * 0.10);
      w.push(0, 0, 1);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aW', new THREE.Float32BufferAttribute(w, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  function mapColor(h, px, i) {
    var r, g, b, t;
    if (h < SEA_LEVEL) {
      t = Math.min(1, Math.max(0, (h + 26) / 26));
      r = 13 + t * 25; g = 34 + t * 52; b = 52 + t * 56;
    } else if (h < 2) { r = 186; g = 168; b = 122; }
    else if (h < 24) { t = (h - 2) / 22; r = 62 + t * 34; g = 94 + t * 24; b = 48 + t * 14; }
    else if (h < 36) { r = 104; g = 100; b = 95; }
    else { r = 232; g = 236; b = 240; }
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }

  function findSpawn() {
    for (var r = 0; r <= 1600; r += 28) {
      var steps = Math.max(1, Math.round(r / 20));
      for (var i = 0; i < steps; i++) {
        var a = (i / steps) * Math.PI * 2;
        var x = Math.cos(a) * r, z = Math.sin(a) * r;
        var h = terrainHeight(x, z);
        if (h > 4 && h < 16) return { x: x, z: z };
      }
    }
    return { x: 0, z: 0 };
  }

  /* ============================================================ element */
  class InfiniteWorld extends HTMLElement {
    connectedCallback() {
      if (this._inited) return;
      this._inited = true;
      var self = this;

      this.style.display = 'block';
      if (!this.style.position) this.style.position = 'relative';
      if (!this.clientHeight) this.style.height = '100%';

      var root = document.createElement('div');
      root.setAttribute('data-screen-label', 'Infinite World Explorer');
      root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#0a0e14;' +
        "font-family:'Space Grotesk',system-ui,sans-serif;user-select:none;-webkit-user-select:none;";
      this.appendChild(root);
      this._root = root;

      var hud = document.createElement('div');
      hud.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;';
      hud.innerHTML = hudHTML();
      // start overlay needs clicks:
      root.appendChild(hud);
      this._el = {};
      ['cross', 'fps', 'clock', 'disc', 'map', 'biome', 'pos', 'speed', 'speedbar', 'hint',
        'popup', 'popup-kicker', 'popup-name', 'popup-lore', 'popup-action',
        'start', 'loading', 'loadbar', 'loadtext'].forEach(function (k) {
          self._el[k.replace(/-/g, '_')] = hud.querySelector('[data-' + k + ']');
        });
      this._el.start.style.pointerEvents = 'auto';

      // state
      this._chunks = new Map();
      this._queue = [];
      this._queued = new Set();
      this._beacons = new Map();
      this._keys = {};
      this._yaw = Math.PI * 0.25;
      this._pitch = -0.06;
      this._vel = { x: 0, z: 0 };
      this._speed = 0;
      this._time = 0;
      this._last = 0;
      this._hudLast = 0;
      this._mapLast = -1e9;
      this._fpsFrames = 0;
      this._fpsLast = 0;
      this._fps = 60;
      this._loading = true;
      this._built = 0;
      this._dragLook = false;
      this._dragging = false;
      this._popupBeacon = null;
      this._ccx = null; this._ccz = null;
      this._vy = 0;
      this._airborne = false;
      this._jumps = 0;
      this._gust = 0.3;
      this._groundH = 0;
      this._day = 1;
      this._dayT = 0.32;
      /* weather episodes: each phase lasts 1-20 min, levels ramp smoothly */
      this._weather = {
        gustOn: true, gustUntil: 60 + Math.random() * 1140,
        snowOn: true, snowUntil: 60 + Math.random() * 1140,
        gustLevel: 0.6, snowLevel: 1
      };
      this._discovered = new Set();
      try {
        var saved = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
        if (Array.isArray(saved)) saved.forEach(function (id) { self._discovered.add(id); });
      } catch (e) { /* ignore */ }

      loadThree().then(function (THREE) {
        try { self._init(THREE); } catch (err) { self._fail(err); }
      }).catch(function (err) { self._fail(err); });
    }

    disconnectedCallback() {
      var self = this;
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this._resizeObs) this._resizeObs.disconnect();
      (this._unbinders || []).forEach(function (fn) { fn(); });
      if (this._chunks) this._chunks.forEach(function (c) { self._disposeChunk(c); });
      if (this._renderer) this._renderer.dispose();
      this.innerHTML = '';
      this._inited = false;
    }

    _fail(err) {
      console.error('[infinite-world]', err);
      if (this._el && this._el.loadtext) {
        this._el.loadtext.textContent = 'failed to start: ' + (err && err.message ? err.message : 'WebGL unavailable');
        this._el.loadtext.style.color = '#ff9d8f';
      }
    }

    /* ------------------------------------------------------------ init */
    _init(THREE) {
      var self = this;
      this._THREE = THREE;

      var renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      this._pxCap = Math.min(window.devicePixelRatio || 1, 1.75);
      this._px = this._pxCap;
      renderer.setPixelRatio(this._px);
      renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;z-index:1;cursor:crosshair;';
      this._root.insertBefore(renderer.domElement, this._root.firstChild);
      this._renderer = renderer;
      this._canvas = renderer.domElement;

      var scene = new THREE.Scene();
      this._scene = scene;
      var camera = new THREE.PerspectiveCamera(70, 1, 0.1, 900);
      camera.rotation.order = 'YXZ';
      this._camera = camera;

      var fogColor = new THREE.Color(FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
      var sunDir = new THREE.Vector3(SUN[0], SUN[1], SUN[2]);

      /* day/night state — these instances are SHARED by every material's
         uniforms and mutated in place each frame by _updateDayNight() */
      this._fogColor = fogColor;
      this._sunDir = sunDir;                  // light direction (sun or moon)
      this._sunVis = sunDir.clone();          // visual sun position for the sky
      this._zenithCol = new THREE.Color(SKY_ZENITH[0], SKY_ZENITH[1], SKY_ZENITH[2]);
      this._ambientCol = new THREE.Color(0.36, 0.41, 0.50);
      this._sunLightCol = new THREE.Color(0.95, 0.88, 0.76);
      this._lightI = { value: 1 };
      this._nightI = { value: 0 };

      // shared terrain material
      this._terrainMat = new THREE.ShaderMaterial({
        uniforms: {
          uSunDir: { value: sunDir },
          uAmbient: { value: this._ambientCol },
          uSunCol: { value: this._sunLightCol },
          uFogColor: { value: fogColor },
          uFogNear: { value: FOG_NEAR },
          uFogFar: { value: FOG_FAR }
        },
        vertexShader: TERRAIN_VERT,
        fragmentShader: TERRAIN_FRAG
      });

      // sky dome
      var sky = new THREE.Mesh(
        new THREE.SphereGeometry(600, 24, 14),
        new THREE.ShaderMaterial({
          uniforms: {
            uSunDir: { value: this._sunVis },
            uZenith: { value: this._zenithCol },
            uHorizon: { value: fogColor },
            uNightI: this._nightI,
            uTime: { value: 0 }
          },
          vertexShader: SKY_VERT,
          fragmentShader: SKY_FRAG,
          side: THREE.BackSide,
          depthWrite: false,
          depthTest: false
        })
      );
      sky.renderOrder = -1;
      sky.frustumCulled = false;
      scene.add(sky);
      this._sky = sky;
      this._skyMat = sky.material;

      // water plane (follows camera; waves anchored to world coords in shader)
      this._waterMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uLightI: this._lightI,
          uSunDir: { value: sunDir },
          uFogColor: { value: fogColor },
          uFogNear: { value: FOG_NEAR },
          uFogFar: { value: FOG_FAR }
        },
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
        transparent: true,
        depthWrite: false
      });
      var water = new THREE.Mesh(new THREE.PlaneGeometry(560, 560, 72, 72), this._waterMat);
      water.rotation.x = -Math.PI / 2;
      water.position.y = SEA_LEVEL;
      water.renderOrder = 1;
      water.frustumCulled = false;
      scene.add(water);
      this._water = water;

      // shared beacon resources
      this._beaconGeo = new THREE.OctahedronGeometry(1.2, 0);
      this._glowTex = makeGlowTexture(THREE);

      // minimap offscreen buffer
      this._mapN = 56;
      this._mapScale = 9; // world units per sample
      this._mapOff = document.createElement('canvas');
      this._mapOff.width = this._mapOff.height = this._mapN;
      this._mapOffCtx = this._mapOff.getContext('2d');
      this._mapImg = this._mapOffCtx.createImageData(this._mapN, this._mapN);
      this._mapCtx = this._el.map.getContext('2d');

      // spawn
      var spawn = findSpawn();
      var sh = terrainHeight(spawn.x, spawn.z);
      camera.position.set(spawn.x, sh + EYE_HEIGHT, spawn.z);
      this._camY = sh + EYE_HEIGHT;
      this._groundH = sh;

      /* ---- nature: trees (one InstancedMesh per chunk, shared geo + mat) */
      this._treeGeo = buildTreeGeometry(THREE);
      this._treeMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uGust: { value: 0.6 },
          uSunDir: { value: sunDir },
          uAmbient: { value: this._ambientCol },
          uSunCol: { value: this._sunLightCol },
          uFogColor: { value: fogColor },
          uFogNear: { value: FOG_NEAR },
          uFogFar: { value: FOG_FAR }
        },
        vertexShader: TREE_VERT,
        fragmentShader: TREE_FRAG
      });

      /* ---- rocks: same shader as trees (program cached), zero sway */
      this._rockGeo = buildRockGeometry(THREE);
      this._rockMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uGust: { value: 0 },
          uSunDir: { value: sunDir },
          uAmbient: { value: this._ambientCol },
          uSunCol: { value: this._sunLightCol },
          uFogColor: { value: fogColor },
          uFogNear: { value: FOG_NEAR },
          uFogFar: { value: FOG_FAR }
        },
        vertexShader: TREE_VERT,
        fragmentShader: TREE_FRAG
      });

      /* ---- grass: instanced tufts, gust-leaning + player trampling */
      this._grassGeo = buildGrassGeometry(THREE);
      this._grassMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uWind: { value: new THREE.Vector3(1, 0.3, 0) },
          uPlayer: { value: new THREE.Vector3() },
          uAmbient: { value: this._ambientCol },
          uSunCol: { value: this._sunLightCol },
          uFogColor: { value: fogColor },
          uFogNear: { value: FOG_NEAR },
          uFogFar: { value: FOG_FAR }
        },
        vertexShader: GRASS_VERT,
        fragmentShader: GRASS_FRAG,
        side: THREE.DoubleSide
      });

      /* ---- snowfall (fades in over snowy peaks) */
      var softTex = makeSoftTexture(THREE);
      var snowPos = new Float32Array(SNOW_N * 3);
      for (var si = 0; si < SNOW_N; si++) {
        snowPos[si * 3] = spawn.x + (ihash(si, 1) - 0.5) * 110;
        snowPos[si * 3 + 1] = this._camY - 24 + ihash(si, 2) * 52;
        snowPos[si * 3 + 2] = spawn.z + (ihash(si, 3) - 0.5) * 110;
      }
      var snowGeo = new THREE.BufferGeometry();
      var snowAttr = new THREE.BufferAttribute(snowPos, 3);
      snowGeo.setAttribute('position', snowAttr);
      var snowPts = new THREE.Points(snowGeo, new THREE.PointsMaterial({
        color: 0xffffff, size: 0.45, map: softTex, transparent: true,
        opacity: 0, depthWrite: false, sizeAttenuation: true
      }));
      snowPts.frustumCulled = false;
      snowPts.renderOrder = 3;
      snowPts.visible = false;
      scene.add(snowPts);
      this._snow = { pts: snowPts, attr: snowAttr };

      /* ---- wind gust streaks */
      var windData = new Float32Array(WIND_N * 4); // x, y, z, seed per streak
      for (var wi = 0; wi < WIND_N; wi++) {
        windData[wi * 4] = spawn.x + (ihash(wi, 11) - 0.5) * 120;
        windData[wi * 4 + 1] = this._camY - 10 + ihash(wi, 12) * 26;
        windData[wi * 4 + 2] = spawn.z + (ihash(wi, 13) - 0.5) * 120;
        windData[wi * 4 + 3] = ihash(wi, 14);
      }
      var windGeo = new THREE.BufferGeometry();
      var windAttr = new THREE.BufferAttribute(new Float32Array(WIND_N * 6), 3);
      windGeo.setAttribute('position', windAttr);
      var windLine = new THREE.LineSegments(windGeo, new THREE.LineBasicMaterial({
        color: 0xe8f0f8, transparent: true, opacity: 0, depthWrite: false
      }));
      windLine.frustumCulled = false;
      windLine.renderOrder = 3;
      scene.add(windLine);
      this._wind = { line: windLine, attr: windAttr, data: windData };

      this._bindEvents();
      this._resize();

      this._tick = this._tick.bind(this);
      this._last = performance.now();
      this._fpsLast = this._last;
      this._raf = requestAnimationFrame(this._tick);
    }

    /* ---------------------------------------------------------- events */
    _bindEvents() {
      var self = this;
      var unbind = this._unbinders = [];
      function on(target, ev, fn, opts) {
        target.addEventListener(ev, fn, opts);
        unbind.push(function () { target.removeEventListener(ev, fn, opts); });
      }

      var KEYMAP = {
        KeyW: 'w', ArrowUp: 'w', KeyS: 's', ArrowDown: 's',
        KeyA: 'a', ArrowLeft: 'a', KeyD: 'd', ArrowRight: 'd',
        ShiftLeft: 'shift', ShiftRight: 'shift'
      };
      on(window, 'keydown', function (e) {
        var k = KEYMAP[e.code];
        if (k) { self._keys[k] = true; e.preventDefault(); }
        if (e.code === 'KeyE') self._tryDiscover();
        if (e.code === 'Space') { e.preventDefault(); self._jump(); }
      });
      on(window, 'keyup', function (e) {
        var k = KEYMAP[e.code];
        if (k) self._keys[k] = false;
      });
      on(window, 'blur', function () { self._keys = {}; self._dragging = false; });

      // pointer lock with drag-look fallback (sandboxed iframes may deny lock)
      function tryLock() {
        if (self._dragLook) return;
        try {
          var p = self._canvas.requestPointerLock && self._canvas.requestPointerLock();
          if (p && p.catch) p.catch(function () { self._enableDragLook(); });
          setTimeout(function () {
            if (document.pointerLockElement !== self._canvas && !self._dragLook) self._enableDragLook();
          }, 350);
        } catch (e) { self._enableDragLook(); }
      }
      on(this._el.start, 'click', tryLock);
      on(this._canvas, 'click', function () {
        if (!self._dragLook && document.pointerLockElement !== self._canvas) tryLock();
      });
      on(document, 'pointerlockchange', function () {
        var locked = document.pointerLockElement === self._canvas;
        self._setLookActive(locked || self._dragLook);
      });
      on(document, 'mousemove', function (e) {
        var locked = document.pointerLockElement === self._canvas;
        if (locked || (self._dragLook && self._dragging)) {
          self._yaw -= (e.movementX || 0) * 0.0023;
          self._pitch -= (e.movementY || 0) * 0.0021;
          var lim = 1.45;
          if (self._pitch > lim) self._pitch = lim;
          if (self._pitch < -lim) self._pitch = -lim;
        }
      });
      on(this._canvas, 'mousedown', function () { if (self._dragLook) self._dragging = true; });
      on(window, 'mouseup', function () { self._dragging = false; });

      this._resizeObs = new ResizeObserver(function () { self._resize(); });
      this._resizeObs.observe(this);
    }

    _enableDragLook() {
      this._dragLook = true;
      this._el.hint.textContent = 'WASD move \u00b7 DRAG look \u00b7 SPACE double-jump \u00b7 SHIFT sprint \u00b7 E discover';
      this._setLookActive(true);
    }

    _setLookActive(active) {
      this._el.start.style.display = active || this._loading ? 'none' : 'flex';
      this._el.cross.style.opacity = active ? '1' : '0';
    }

    _resize() {
      if (!this._renderer) return;
      var w = this.clientWidth || 1, h = this.clientHeight || 1;
      this._renderer.setPixelRatio(this._px);
      this._renderer.setSize(w, h, false);
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
    }

    /* ------------------------------------------------------ chunk system */
    _chunkKey(cx, cz) { return cx + ',' + cz; }

    _updateChunks() {
      var cam = this._camera.position;
      var ccx = Math.floor(cam.x / CHUNK_SIZE);
      var ccz = Math.floor(cam.z / CHUNK_SIZE);
      if (ccx === this._ccx && ccz === this._ccz) return;
      this._ccx = ccx; this._ccz = ccz;

      var R = VIEW_RADIUS, R2 = R * R + 1;
      var want = [];
      for (var dz = -R; dz <= R; dz++) {
        for (var dx = -R; dx <= R; dx++) {
          var d2 = dx * dx + dz * dz;
          if (d2 > R2) continue; // circular radius — skip the corners of the square
          var cx = ccx + dx, cz = ccz + dz;
          var key = this._chunkKey(cx, cz);
          if (!this._chunks.has(key) && !this._queued.has(key)) {
            want.push({ cx: cx, cz: cz, key: key, d2: d2 });
          }
        }
      }
      want.sort(function (a, b) { return a.d2 - b.d2; });
      for (var i = 0; i < want.length; i++) {
        this._queue.push(want[i]);
        this._queued.add(want[i].key);
      }

      // unload far chunks immediately (free GPU memory)
      var UR2 = UNLOAD_RADIUS * UNLOAD_RADIUS;
      var toRemove = [];
      this._chunks.forEach(function (chunk, key) {
        var ddx = chunk.cx - ccx, ddz = chunk.cz - ccz;
        if (ddx * ddx + ddz * ddz > UR2) toRemove.push(key);
      });
      for (var r = 0; r < toRemove.length; r++) {
        this._disposeChunk(this._chunks.get(toRemove[r]));
        this._chunks.delete(toRemove[r]);
      }
      // drop queued chunks that are now out of range
      var self = this;
      this._queue = this._queue.filter(function (q) {
        var ddx = q.cx - ccx, ddz = q.cz - ccz;
        if (ddx * ddx + ddz * ddz > UR2) { self._queued.delete(q.key); return false; }
        return true;
      });
    }

    _processQueue() {
      var budget = this._loading ? 5 : 1; // amortize builds: 1 chunk/frame in steady state
      while (budget-- > 0 && this._queue.length) {
        var q = this._queue.shift();
        this._queued.delete(q.key);
        if (!this._chunks.has(q.key)) {
          this._chunks.set(q.key, this._buildChunk(q.cx, q.cz));
          this._built++;
        }
      }
      if (this._loading) {
        var total = this._built + this._queue.length;
        var pct = total ? Math.round((this._built / total) * 100) : 0;
        this._el.loadbar.style.width = pct + '%';
        this._el.loadtext.textContent = 'generating terrain \u00b7 ' + pct + '%';
        if (!this._queue.length && this._built > 0) this._finishLoading();
      }
    }

    _finishLoading() {
      var self = this;
      this._loading = false;
      this._el.loading.style.opacity = '0';
      setTimeout(function () { self._el.loading.style.display = 'none'; }, 650);
      this._setLookActive(this._dragLook || document.pointerLockElement === this._canvas);
    }

    _buildChunk(cx, cz) {
      var THREE = this._THREE;
      var res = CHUNK_RES, size = CHUNK_SIZE, step = size / res;
      var x0 = cx * size, z0 = cz * size;
      var n1 = res + 1, pad = res + 3;

      // heights on a grid padded by 1 sample on each side (for seam-free normals)
      var hg = new Float32Array(pad * pad);
      for (var iz = 0; iz < pad; iz++) {
        var wz = z0 + (iz - 1) * step;
        for (var ix = 0; ix < pad; ix++) {
          hg[iz * pad + ix] = terrainHeight(x0 + (ix - 1) * step, wz);
        }
      }

      var pos = new Float32Array(n1 * n1 * 3);
      var nrm = new Float32Array(n1 * n1 * 3);
      var ao = new Float32Array(n1 * n1);
      var p = 0, vi = 0;
      for (var jz = 0; jz < n1; jz++) {
        for (var jx = 0; jx < n1; jx++) {
          var gi = (jz + 1) * pad + (jx + 1);
          var h = hg[gi];
          pos[p] = jx * step; pos[p + 1] = h; pos[p + 2] = jz * step;
          var nx = hg[gi - 1] - hg[gi + 1];
          var nz = hg[gi - pad] - hg[gi + pad];
          var ny = 2 * step;
          var il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
          nrm[p] = nx * il; nrm[p + 1] = ny * il; nrm[p + 2] = nz * il;
          /* baked AO: concave vertices (neighbors higher) sit in crevices */
          var lap = (hg[gi - 1] + hg[gi + 1] + hg[gi - pad] + hg[gi + pad]) * 0.25 - h;
          ao[vi++] = 1 - Math.min(0.42, Math.max(0, lap * 0.30));
          p += 3;
        }
      }

      var idx = new Uint16Array(res * res * 6);
      var q = 0;
      for (var tz = 0; tz < res; tz++) {
        for (var tx = 0; tx < res; tx++) {
          var a = tz * n1 + tx, b = a + 1, c = a + n1, d = c + 1;
          idx[q++] = a; idx[q++] = c; idx[q++] = b;
          idx[q++] = c; idx[q++] = d; idx[q++] = b;
        }
      }

      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();

      var mesh = new THREE.Mesh(geo, this._terrainMat);
      mesh.position.set(x0, 0, z0);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this._scene.add(mesh);

      var chunk = { cx: cx, cz: cz, mesh: mesh, beacons: [], trees: null, rocks: null, grass: null, colliders: [] };
      this._maybeSpawnBeacon(chunk);
      this._spawnTrees(chunk);
      this._spawnRocks(chunk);
      this._spawnGrass(chunk);
      return chunk;
    }

    _disposeChunk(chunk) {
      var self = this;
      this._scene.remove(chunk.mesh);
      chunk.mesh.geometry.dispose(); // material is shared — keep it
      if (chunk.trees) {
        this._scene.remove(chunk.trees);
        if (chunk.trees.dispose) chunk.trees.dispose(); // frees the instanceMatrix GPU buffer
      }
      if (chunk.rocks) {
        this._scene.remove(chunk.rocks);
        if (chunk.rocks.dispose) chunk.rocks.dispose();
      }
      if (chunk.grass) {
        this._scene.remove(chunk.grass);
        if (chunk.grass.dispose) chunk.grass.dispose();
      }
      chunk.beacons.forEach(function (b) {
        self._scene.remove(b.mesh);
        self._scene.remove(b.sprite);
        b.mesh.material.dispose();   // per-beacon ShaderMaterial (program is cached)
        b.sprite.material.dispose(); // texture is shared — keep it
        self._beacons.delete(b.id);
      });
    }

    /* ------------------------------------------------------------ trees */
    _spawnTrees(chunk) {
      var THREE = this._THREE;
      var cx = chunk.cx, cz = chunk.cz;
      /* patchy forests: low-freq mask decides density per chunk */
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
        if (h < 2.8 || h > 22) continue;          // grass / lower highlands only
        if (terrainNormalY(x, z) < 0.78) continue; // not on cliffs
        var s = 0.75 + ihash(i * 7 + 11, (cx * 13) ^ cz) * 0.8;
        dummy.position.set(x, h - 0.15, z);
        dummy.rotation.y = rz * Math.PI * 2;
        dummy.scale.set(s, s * (0.9 + rx * 0.4), s);
        dummy.updateMatrix();
        mats.push(dummy.matrix.clone());
        /* trunk collider — too tall to jump over */
        chunk.colliders.push({ x: x, z: z, r: 0.5 * s + 0.25, top: h + 5.6 * s * (0.9 + rx * 0.4) });
      }
      if (!mats.length) return;
      var inst = new THREE.InstancedMesh(this._treeGeo, this._treeMat, mats.length);
      for (var m = 0; m < mats.length; m++) inst.setMatrixAt(m, mats[m]);
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false; // instance bounds != geometry bounds
      this._scene.add(inst);
      chunk.trees = inst;
    }

    /* ------------------------------------------------------------ rocks */
    _spawnRocks(chunk) {
      var THREE = this._THREE;
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
        /* boulders favor rocky slopes; only some survive on flats */
        if (terrainNormalY(x, z) >= 0.80 && ihash(i * 91 + cx, i * 53 + cz) >= 0.4) continue;
        var r3 = ihash(i * 17 + cx * 5, i * 29 - cz * 7);
        var s = 0.5 + r3 * r3 * 2.6;
        dummy.position.set(x, h - 0.25 * s, z);
        dummy.rotation.set((rx - 0.5) * 0.5, rz * Math.PI * 2, (rz - 0.5) * 0.5);
        dummy.scale.set(s * (0.8 + rx * 0.5), s * (0.6 + r3 * 0.5), s * (0.8 + rz * 0.5));
        dummy.updateMatrix();
        mats.push(dummy.matrix.clone());
        /* boulder collider — pebbles (s < 0.75) stay walkable, big rocks can be jumped onto */
        if (s >= 0.75) chunk.colliders.push({ x: x, z: z, r: s * 1.0, top: h - 0.25 * s + s * (0.6 + r3 * 0.5) * 0.9 });
      }
      if (!mats.length) return;
      var inst = new THREE.InstancedMesh(this._rockGeo, this._rockMat, mats.length);
      for (var m = 0; m < mats.length; m++) inst.setMatrixAt(m, mats[m]);
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      this._scene.add(inst);
      chunk.rocks = inst;
    }

    /* ------------------------------------------------------------ grass */
    _spawnGrass(chunk) {
      var THREE = this._THREE;
      var cx = chunk.cx, cz = chunk.cz;
      var dummy = new THREE.Object3D();
      var mats = [];
      for (var i = 0; i < 64; i++) {
        var rx = ihash(cx * 211 + i * 61 + 3, cz * 127 - i * 17 + 9);
        var rz = ihash(cx * 89 - i * 41 + 5, cz * 233 + i * 53 - 2);
        var x = (cx + 0.02 + rx * 0.96) * CHUNK_SIZE;
        var z = (cz + 0.02 + rz * 0.96) * CHUNK_SIZE;
        if (vnoise(x * 0.045 + 9.1, z * 0.045 - 4.4) < 0.42) continue; // meadow patches
        var h = terrainHeight(x, z);
        if (h < 2.6 || h > 19.5) continue;
        if (terrainNormalY(x, z) < 0.82) continue;
        var s = 0.7 + ihash(i * 13 + cx * 3, i * 7 - cz * 11) * 0.9;
        dummy.position.set(x, h - 0.04, z);
        dummy.rotation.y = rz * Math.PI * 2;
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        mats.push(dummy.matrix.clone());
      }
      if (!mats.length) return;
      var inst = new THREE.InstancedMesh(this._grassGeo, this._grassMat, mats.length);
      for (var m = 0; m < mats.length; m++) inst.setMatrixAt(m, mats[m]);
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      this._scene.add(inst);
      chunk.grass = inst;
    }

    /* -------------------------------------------------- day/night cycle */
    _updateDayNight() {
      var dayT = (0.32 + this._time / DAY_LENGTH) % 1; // 0 = midnight, .5 = noon
      this._dayT = dayT;
      var a = dayT * Math.PI * 2;
      var sunY = -Math.cos(a);
      var sunX = Math.sin(a) * 0.8;
      var day = sstep(-0.07, 0.22, sunY);
      this._day = day;
      var glow = Math.max(0, 1 - Math.abs(sunY) / 0.28) * 0.8; // dawn/dusk band
      var night = 1 - sstep(-0.22, -0.02, sunY);

      this._sunVis.set(sunX, sunY, 0.35).normalize();
      if (sunY > -0.04) this._sunDir.set(sunX, Math.max(sunY, 0.06), 0.35).normalize();
      else this._sunDir.set(-sunX, Math.max(-sunY, 0.06), -0.3).normalize(); // moonlight

      function bl(nightC, dayC, duskC, i, ga) {
        var v = nightC[i] + (dayC[i] - nightC[i]) * day;
        return v + (duskC[i] - v) * ga;
      }
      var FOG_N = [0.04, 0.06, 0.11], FOG_D = FOG_COLOR, FOG_K = [0.82, 0.58, 0.45];
      var ZEN_N = [0.012, 0.02, 0.055], ZEN_D = SKY_ZENITH, ZEN_K = [0.28, 0.27, 0.47];
      var AMB_N = [0.085, 0.11, 0.19], AMB_D = [0.36, 0.41, 0.50], AMB_K = [0.30, 0.26, 0.30];
      var SUN_N = [0.10, 0.14, 0.24], SUN_D = [0.95, 0.88, 0.76], SUN_K = [1.0, 0.45, 0.24];
      this._fogColor.setRGB(bl(FOG_N, FOG_D, FOG_K, 0, glow), bl(FOG_N, FOG_D, FOG_K, 1, glow), bl(FOG_N, FOG_D, FOG_K, 2, glow));
      this._zenithCol.setRGB(bl(ZEN_N, ZEN_D, ZEN_K, 0, glow * 0.6), bl(ZEN_N, ZEN_D, ZEN_K, 1, glow * 0.6), bl(ZEN_N, ZEN_D, ZEN_K, 2, glow * 0.6));
      this._ambientCol.setRGB(bl(AMB_N, AMB_D, AMB_K, 0, glow * 0.5), bl(AMB_N, AMB_D, AMB_K, 1, glow * 0.5), bl(AMB_N, AMB_D, AMB_K, 2, glow * 0.5));
      var sg = glow * day; // sun tint only while the sun is the light source
      this._sunLightCol.setRGB(bl(SUN_N, SUN_D, SUN_K, 0, sg), bl(SUN_N, SUN_D, SUN_K, 1, sg), bl(SUN_N, SUN_D, SUN_K, 2, sg));
      this._lightI.value = 0.18 + 0.82 * day;
      this._nightI.value = night;
    }

    /* ------------------------------------------- wind, gusts & snowfall */
    _updateAtmosphere(dt) {
      var t = this._time;
      var cam = this._camera.position;

      /* weather episodes: gust & snow toggle at random; each phase lasts
         1-20 minutes (60s + rand*1140s) and levels ramp smoothly */
      var W = this._weather;
      if (t > W.gustUntil) { W.gustOn = !W.gustOn; W.gustUntil = t + 60 + Math.random() * 1140; }
      if (t > W.snowUntil) { W.snowOn = !W.snowOn; W.snowUntil = t + 60 + Math.random() * 1140; }
      W.gustLevel += ((W.gustOn ? 1 : 0) - W.gustLevel) * Math.min(1, dt * 0.3);
      W.snowLevel += ((W.snowOn ? 1 : 0) - W.snowLevel) * Math.min(1, dt * 0.12);

      /* gust strength 0..1 — smooth value-noise so gusts build and die naturally */
      var g = Math.min(1, Math.max(0, (vnoise(t * 0.35, 8.5) - 0.18) / 0.6));
      g = g * g * (3 - 2 * g);
      g = g * (0.08 + 0.92 * W.gustLevel);
      this._gust += (g - this._gust) * Math.min(1, dt * 1.5);
      var gust = this._gust;
      var wa = 0.9 + 0.3 * Math.sin(t * 0.05); // slowly veering wind direction
      var wx = Math.cos(wa), wz = Math.sin(wa);

      this._treeMat.uniforms.uTime.value = t;
      this._treeMat.uniforms.uGust.value = 0.15 + 1.8 * gust;
      this._grassMat.uniforms.uTime.value = t;
      this._grassMat.uniforms.uWind.value.set(wx, gust, wz);
      this._grassMat.uniforms.uPlayer.value.copy(cam);

      /* ---- wind streaks */
      var d = this._wind.data, a = this._wind.attr.array;
      var speed = 13 + 36 * gust;
      for (var i = 0; i < WIND_N; i++) {
        var o = i * 4, p6 = i * 6;
        var mul = 0.7 + d[o + 3] * 0.6;
        d[o] += wx * speed * dt * mul;
        d[o + 2] += wz * speed * dt * mul;
        d[o + 1] -= dt * 0.4;
        if (d[o] < cam.x - 60) d[o] += 120; else if (d[o] > cam.x + 60) d[o] -= 120;
        if (d[o + 2] < cam.z - 60) d[o + 2] += 120; else if (d[o + 2] > cam.z + 60) d[o + 2] -= 120;
        if (d[o + 1] < cam.y - 10) d[o + 1] += 26; else if (d[o + 1] > cam.y + 16) d[o + 1] -= 26;
        var len = 1.2 + 3.2 * gust * (0.5 + d[o + 3] * 0.5);
        a[p6] = d[o]; a[p6 + 1] = d[o + 1]; a[p6 + 2] = d[o + 2];
        a[p6 + 3] = d[o] + wx * len; a[p6 + 4] = d[o + 1]; a[p6 + 5] = d[o + 2] + wz * len;
      }
      this._wind.attr.needsUpdate = true;
      var wm = this._wind.line.material;
      wm.opacity += ((0.04 + 0.26 * gust) - wm.opacity) * Math.min(1, dt * 2);

      /* ---- snowfall: fades in when the ground below is in the snow zone */
      var sm = this._snow.pts.material;
      sm.color.setScalar(0.5 + 0.5 * this._day);
      var tgt = sstep(24, 32, this._groundH) * 0.85 * W.snowLevel;
      sm.opacity += (tgt - sm.opacity) * Math.min(1, dt * 1.6);
      if (sm.opacity < 0.02) {
        this._snow.pts.visible = false;
      } else {
        this._snow.pts.visible = true;
        var sp = this._snow.attr.array;
        var drift = 2 + 7 * gust;
        for (var j = 0; j < SNOW_N; j++) {
          var k = j * 3;
          sp[k + 1] -= (3.0 + (j % 9) * 0.4) * dt;
          sp[k] += wx * drift * dt + Math.sin(t * 1.3 + j) * dt * 0.6;
          sp[k + 2] += wz * drift * dt;
          if (sp[k + 1] < cam.y - 24) sp[k + 1] += 52;
          if (sp[k] < cam.x - 55) sp[k] += 110; else if (sp[k] > cam.x + 55) sp[k] -= 110;
          if (sp[k + 2] < cam.z - 55) sp[k + 2] += 110; else if (sp[k + 2] > cam.z + 55) sp[k + 2] -= 110;
        }
        this._snow.attr.needsUpdate = true;
      }
    }

    /* ------------------------------------------------------------- POIs */
    _maybeSpawnBeacon(chunk) {
      var THREE = this._THREE;
      var cx = chunk.cx, cz = chunk.cz;
      if (ihash(cx * 7919 + 13, cz * 6271 - 7) >= 0.16) return;
      var px = (cx + 0.15 + 0.7 * ihash(cx * 31 + 7, cz * 17 + 3)) * CHUNK_SIZE;
      var pz = (cz + 0.15 + 0.7 * ihash(cx * 23 - 5, cz * 41 + 11)) * CHUNK_SIZE;
      var ph = terrainHeight(px, pz);
      if (ph < 2.5 || ph > 38) return; // land only, below the snow line

      var id = 'p' + cx + '_' + cz;
      var s1 = ihash(cx * 101 + 17, cz * 57 - 29);
      var s2 = ihash(cx * 67 - 3, cz * 131 + 19);
      var discovered = this._discovered.has(id);

      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uPhase: { value: s1 * Math.PI * 2 },
          uDim: { value: discovered ? 1 : 0 }
        },
        vertexShader: BEACON_VERT,
        fragmentShader: BEACON_FRAG
      });
      var mesh = new THREE.Mesh(this._beaconGeo, mat);
      mesh.scale.set(1, 1.6, 1);
      mesh.position.set(px, ph + 2.6, pz);
      this._scene.add(mesh);

      var sprMat = new THREE.SpriteMaterial({
        map: this._glowTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: discovered ? 0.18 : 0.55
      });
      var sprite = new THREE.Sprite(sprMat);
      sprite.scale.set(9, 9, 1);
      sprite.position.copy(mesh.position);
      this._scene.add(sprite);

      var beacon = {
        id: id, x: px, z: pz, baseY: ph + 2.6,
        mesh: mesh, sprite: sprite,
        name: ADJ[Math.floor(s1 * ADJ.length) % ADJ.length] + ' ' + NOUN[Math.floor(s2 * NOUN.length) % NOUN.length],
        lore: LORE[Math.floor((s1 * 7 + s2 * 13) * LORE.length) % LORE.length],
        discovered: discovered,
        phase: s1 * Math.PI * 2
      };
      chunk.beacons.push(beacon);
      this._beacons.set(id, beacon);
    }

    _updateBeacons(dt) {
      var cam = this._camera.position;
      var nearest = null, nearestD2 = 16 * 16;
      var t = this._time;
      this._beacons.forEach(function (b) {
        var dx = b.x - cam.x, dz = b.z - cam.z;
        var d2 = dx * dx + dz * dz;
        if (d2 < 90 * 90) { // animate only when close enough to matter
          b.mesh.rotation.y += dt * 0.9;
          b.mesh.position.y = b.baseY + Math.sin(t * 1.5 + b.phase) * 0.5;
          b.sprite.position.y = b.mesh.position.y;
          b.mesh.material.uniforms.uTime.value = t;
        }
        if (d2 < nearestD2) { nearestD2 = d2; nearest = b; }
      });

      var popup = this._el.popup;
      if (nearest) {
        if (this._popupBeacon !== nearest) {
          this._el.popup_name.textContent = nearest.name;
          this._el.popup_lore.textContent = nearest.lore;
        }
        this._popupBeacon = nearest;
        this._el.popup_kicker.textContent = 'POINT OF INTEREST \u00b7 ' + Math.max(1, Math.round(Math.sqrt(nearestD2))) + 'm';
        this._el.popup_action.textContent = nearest.discovered ? '\u2713 DISCOVERED' : '[ E ] DISCOVER';
        this._el.popup_action.style.color = nearest.discovered ? 'rgba(255,255,255,.5)' : '#ffd86b';
        popup.style.opacity = '1';
        popup.style.transform = 'translate(-50%, 0)';
      } else {
        this._popupBeacon = null;
        popup.style.opacity = '0';
        popup.style.transform = 'translate(-50%, 10px)';
      }
    }

    _tryDiscover() {
      var b = this._popupBeacon;
      if (!b || b.discovered) return;
      b.discovered = true;
      b.mesh.material.uniforms.uDim.value = 1;
      b.sprite.material.opacity = 0.18;
      this._discovered.add(b.id);
      try { localStorage.setItem(LS_KEY, JSON.stringify(Array.from(this._discovered))); } catch (e) { /* ignore */ }
      this._el.disc.textContent = '\u25c6 ' + this._discovered.size + ' discovered';
      this._el.popup_action.textContent = '\u2713 DISCOVERED';
      this._el.popup_action.style.color = 'rgba(255,255,255,.5)';
    }

    /* --------------------------------------------------------- movement */
    _jump() {
      if (this._loading) return;
      if (!this._airborne) {
        this._airborne = true;
        this._vy = JUMP_V;
        this._jumps = 1;
      } else if (this._jumps < 2) {
        this._vy = JUMP_V * 0.95; // mid-air double jump resets upward velocity
        this._jumps = 2;
      }
    }

    _updateMovement(dt) {
      var cam = this._camera.position;
      var fwd = (this._keys.w ? 1 : 0) - (this._keys.s ? 1 : 0);
      var str = (this._keys.d ? 1 : 0) - (this._keys.a ? 1 : 0);
      var yaw = this._yaw;
      var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      var rx = Math.cos(yaw), rz = -Math.sin(yaw);
      var wx = fx * fwd + rx * str, wz = fz * fwd + rz * str;
      var wl = Math.sqrt(wx * wx + wz * wz);
      var speed = this._keys.shift ? SPRINT_SPEED : WALK_SPEED;
      if (wl > 0) {
        var ux = wx / wl, uz = wz / wl;
        /* climbing penalty: sample the slope ahead along the move direction */
        var hAhead = terrainHeight(cam.x + ux * 3.5, cam.z + uz * 3.5);
        var slope = Math.max(0, (hAhead - this._groundH) / 3.5);
        var mul = 1 / (1 + slope * 1.4);
        /* wading penalty: deeper water drags harder (caps at -62%) */
        var depth = SEA_LEVEL - this._groundH;
        if (depth > 0) mul *= 1 - 0.62 * sstep(0, 2.2, depth);
        if (this._airborne) mul = Math.max(mul, 0.75); // jumping clears obstacles
        speed *= mul;
        wx = ux * speed; wz = uz * speed;
      }

      // smooth acceleration / deceleration
      var k = 1 - Math.exp(-7 * dt);
      this._vel.x += (wx - this._vel.x) * k;
      this._vel.z += (wz - this._vel.z) * k;

      cam.x += this._vel.x * dt;
      cam.z += this._vel.z * dt;
      this._resolveCollisions(cam);

      // terrain-following camera (math, not colliders) — same height fn as the mesh
      var ground = Math.max(terrainHeight(cam.x, cam.z), SEA_LEVEL - 0.4);
      this._groundH = ground;
      var targetY = ground + EYE_HEIGHT;
      if (this._airborne) {
        this._vy -= GRAVITY * dt;
        this._camY += this._vy * dt;
        if (this._camY <= targetY && this._vy <= 0) {
          this._camY = targetY;
          this._airborne = false;
          this._jumps = 0;
          this._vy = 0;
        }
      } else {
        this._camY += (targetY - this._camY) * (1 - Math.exp(-9 * dt));
      }
      cam.y = this._camY;

      this._camera.rotation.y = this._yaw;
      this._camera.rotation.x = this._pitch;
      this._speed = Math.sqrt(this._vel.x * this._vel.x + this._vel.z * this._vel.z);
    }

    /* circle colliders for trees & rocks — checked against the player's
       chunk + 8 neighbors only (≤ ~200 cheap distance tests per frame) */
    _resolveCollisions(cam) {
      var PR = 0.5; // player radius
      var ccx = Math.floor(cam.x / CHUNK_SIZE), ccz = Math.floor(cam.z / CHUNK_SIZE);
      var feet = this._camY - EYE_HEIGHT;
      for (var dz = -1; dz <= 1; dz++) {
        for (var dx = -1; dx <= 1; dx++) {
          var ch = this._chunks.get(this._chunkKey(ccx + dx, ccz + dz));
          if (!ch || !ch.colliders.length) continue;
          for (var i = 0; i < ch.colliders.length; i++) {
            var c = ch.colliders[i];
            var ox = cam.x - c.x, oz = cam.z - c.z;
            var rr = c.r + PR;
            var d2 = ox * ox + oz * oz;
            if (d2 >= rr * rr || d2 < 1e-8) continue;
            if (feet > c.top - 0.4) continue; // airborne above it — clears the obstacle
            var dd = Math.sqrt(d2);
            var push = (rr - dd) / dd;
            cam.x += ox * push;
            cam.z += oz * push;
            var vn = (this._vel.x * ox + this._vel.z * oz) / dd;
            if (vn < 0) { // strip the velocity component pointing into the obstacle
              this._vel.x -= vn * ox / dd;
              this._vel.z -= vn * oz / dd;
            }
          }
        }
      }
    }

    /* -------------------------------------------------------------- HUD */
    _updateHUD() {
      var cam = this._camera.position;
      this._el.pos.textContent = Math.round(cam.x) + ', ' + Math.round(cam.z);
      this._el.speed.textContent = this._speed.toFixed(1) + ' m/s';
      this._el.speedbar.style.width = Math.min(100, (this._speed / SPRINT_SPEED) * 100) + '%';
      var h = terrainHeight(cam.x, cam.z);
      this._el.biome.textContent = biomeName(h, terrainNormalY(cam.x, cam.z));
      this._el.disc.textContent = '\u25c6 ' + this._discovered.size + ' discovered';
      var mins = Math.floor(this._dayT * 1440);
      var hh = String(Math.floor(mins / 60)).padStart(2, '0');
      var mm = String(mins % 60).padStart(2, '0');
      this._el.clock.textContent = (this._day > 0.5 ? '\u2600\ufe0e' : '\u263d') + ' ' + hh + ':' + mm;
    }

    _redrawMinimapBase() {
      var N = this._mapN, s = this._mapScale, half = (N - 1) / 2;
      var cam = this._camera.position;
      var px = this._mapImg.data;
      var i = 0;
      for (var iz = 0; iz < N; iz++) {
        var wz = cam.z + (iz - half) * s;
        for (var ix = 0; ix < N; ix++) {
          mapColor(terrainHeight(cam.x + (ix - half) * s, wz), px, i);
          i += 4;
        }
      }
      this._mapOffCtx.putImageData(this._mapImg, 0, 0);
      this._mapCamX = cam.x; this._mapCamZ = cam.z;
    }

    _drawMinimap() {
      var ctx = this._mapCtx;
      var W = 168;
      var cam = this._camera.position;
      var wpp = (this._mapN * this._mapScale) / W; // world units per canvas px
      ctx.imageSmoothingEnabled = true;
      // shift the cached base image by how far we've moved since it was sampled
      var ox = (this._mapCamX - cam.x) / wpp, oz = (this._mapCamZ - cam.z) / wpp;
      ctx.fillStyle = '#101820';
      ctx.fillRect(0, 0, W, W);
      ctx.drawImage(this._mapOff, ox, oz, W, W);

      // beacon dots
      var self = this;
      this._beacons.forEach(function (b) {
        var dx = (b.x - cam.x) / wpp, dz = (b.z - cam.z) / wpp;
        if (dx * dx + dz * dz > 78 * 78) return;
        ctx.beginPath();
        ctx.arc(W / 2 + dx, W / 2 + dz, 3, 0, Math.PI * 2);
        ctx.fillStyle = b.discovered ? 'rgba(255,255,255,.45)' : '#ffd86b';
        ctx.fill();
      });

      // player arrow (north-up map, arrow shows heading)
      ctx.save();
      ctx.translate(W / 2, W / 2);
      ctx.rotate(-this._yaw);
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(5.5, 6.5);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5.5, 6.5);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }

    /* ---------------------------------------------------- dynamic res */
    _updateFps(now) {
      this._fpsFrames++;
      if (now - this._fpsLast < 1000) return;
      this._fps = Math.round((this._fpsFrames * 1000) / (now - this._fpsLast));
      this._fpsFrames = 0;
      this._fpsLast = now;
      this._el.fps.textContent = this._fps + ' fps';
      // gentle dynamic-resolution governor toward a stable 60
      if (this._fps < 52 && this._px > 0.8) {
        this._px = Math.max(0.8, this._px - 0.15);
        this._resize();
      } else if (this._fps > 58 && this._px < this._pxCap) {
        this._px = Math.min(this._pxCap, this._px + 0.1);
        this._resize();
      }
    }

    /* ------------------------------------------------------------- tick */
    _tick(now) {
      this._raf = requestAnimationFrame(this._tick);
      var dt = Math.min((now - this._last) / 1000 || 0.016, 0.05);
      this._last = now;
      this._time += dt;

      this._updateMovement(dt);
      this._updateChunks();
      this._processQueue();
      this._updateBeacons(dt);

      // water + sky follow the camera
      var cam = this._camera.position;
      this._water.position.set(cam.x, SEA_LEVEL, cam.z);
      this._sky.position.copy(cam);
      this._waterMat.uniforms.uTime.value = this._time;
      this._skyMat.uniforms.uTime.value = this._time;
      this._updateDayNight();
      this._updateAtmosphere(dt);

      if (now - this._hudLast > 100) { this._updateHUD(); this._hudLast = now; }
      if (now - this._mapLast > 280) { this._redrawMinimapBase(); this._mapLast = now; }
      this._drawMinimap();
      this._updateFps(now);

      this._renderer.render(this._scene, this._camera);
    }
  }

  customElements.define('infinite-world', InfiniteWorld);
})();
