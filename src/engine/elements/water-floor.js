import { terrainHeight } from '../terrain/height.js';

export var WATER_FLOOR_RES = 128;
export var WATER_FLOOR_EXTENT = 560;
export var WATER_FLOOR_MIN = -35;
export var WATER_FLOOR_MAX = 22;

export function createFloorHeightmap(THREE) {
  var n = WATER_FLOOR_RES;
  var data = new Uint8Array(n * n);
  var tex = new THREE.DataTexture(data, n, n, THREE.RedFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex: tex, data: data, originX: 0, originZ: 0, lastGX: null, lastGZ: null };
}

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

  for (var iz = 0; iz < n; iz++) {
    var z = floor.originZ + iz * step;
    for (var ix = 0; ix < n; ix++) {
      var x = floor.originX + ix * step;
      var h = terrainHeight(x, z);
      var t = Math.min(1, Math.max(0, (h - minH) * inv));
      floor.data[iz * n + ix] = Math.round(t * 255);
    }
  }
  floor.tex.needsUpdate = true;
  return floor;
}
