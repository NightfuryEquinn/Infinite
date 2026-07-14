import { SEA_LEVEL } from '../config.js';
import { isOceanBasin, terrainHeight } from '../terrain/height.js';

export var WATER_FLOOR_RES = 128;
export var WATER_FLOOR_EXTENT = 560;
export var WATER_FLOOR_MIN = -35;
export var WATER_FLOOR_MAX = 22;

// Creates an empty RG heightmap texture for water floor sampling
export function createFloorHeightmap(THREE) {
  var n = WATER_FLOOR_RES;
  var data = new Uint8Array(n * n * 2);
  var tex = new THREE.DataTexture(data, n, n, THREE.RGFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;

  return { tex: tex, data: data, originX: 0, originZ: 0, lastGX: null, lastGZ: null };
}

// Updates water-floor heightmap (R = terrain height, G = ocean connectivity) around the camera
export function updateFloorHeightmap(floor, cx, cz) {
  var grid = 28;
  var gx = Math.floor(cx / grid), gz = Math.floor(cz / grid);

  if (floor.lastGX === gx && floor.lastGZ === gz) return floor;

  floor.lastGX = gx;
  floor.lastGZ = gz;

  var n = WATER_FLOOR_RES;
  var ext = WATER_FLOOR_EXTENT;
  floor.originX = cx - ext * 0.5;
  floor.originZ = cz - ext * 0.5;
  var step = ext / (n - 1);
  var minH = WATER_FLOOR_MIN, maxH = WATER_FLOOR_MAX;
  var inv = 1 / (maxH - minH);
  var wet = new Uint8Array(n * n);
  var ocean = new Uint8Array(n * n);
  var queue = new Int32Array(n * n);
  var qh = 0, qt = 0;

  for (var iz = 0; iz < n; iz++) {
    var z = floor.originZ + iz * step;

    for (var ix = 0; ix < n; ix++) {
      var x = floor.originX + ix * step;
      var i = iz * n + ix;
      var h = terrainHeight(x, z);
      var t = Math.min(1, Math.max(0, (h - minH) * inv));
      floor.data[i * 2] = Math.round(t * 255);
      floor.data[i * 2 + 1] = 0;

      if (h < SEA_LEVEL) {
        wet[i] = 1;

        if (isOceanBasin(x, z)) {
          ocean[i] = 1;
          queue[qt++] = i;
        }
      }
    }
  }

  /* Flood through submerged neighbors from open-ocean seeds. */
  while (qh < qt) {
    var cur = queue[qh++];
    var cy = (cur / n) | 0;
    var cx0 = cur - cy * n;
    var nbs = [
      cx0 > 0 ? cur - 1 : -1,
      cx0 < n - 1 ? cur + 1 : -1,
      cy > 0 ? cur - n : -1,
      cy < n - 1 ? cur + n : -1
    ];

    for (var k = 0; k < 4; k++) {
      var ni = nbs[k];

      if (ni < 0 || !wet[ni] || ocean[ni]) continue;

      ocean[ni] = 1;
      queue[qt++] = ni;
    }
  }

  for (var j = 0; j < n * n; j++) {
    floor.data[j * 2 + 1] = ocean[j] ? 255 : 0;
  }

  floor.tex.needsUpdate = true;

  return floor;
}
