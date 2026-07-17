import { SEA_LEVEL } from '../config.js';
import { isOceanBasin, terrainHeight } from './height.js';

var OCEAN_CACHE_MAX = 4096;
var oceanConnectionCache = new Map();
var OCEAN_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Returns true when submerged water at (x, z) connects to the open-ocean basin
export function isConnectedToOcean(x, z) {
  if (terrainHeight(x, z) >= SEA_LEVEL) return false;
  if (isOceanBasin(x, z)) return true;

  var step = 8;
  var maxVisits = 900;
  var sx = Math.floor(x / step);
  var sz = Math.floor(z / step);
  var startKey = sx + ',' + sz;

  if (oceanConnectionCache.has(startKey)) return oceanConnectionCache.get(startKey);

  var seen = Object.create(null);
  var qx = [sx], qz = [sz];
  seen[startKey] = 1;
  var head = 0;
  var connected = false;

  while (head < qx.length && head < maxVisits) {
    var cx = qx[head], cz = qz[head];
    head++;

    for (var d = 0; d < 4; d++) {
      var nx = cx + OCEAN_DIRS[d][0], nz = cz + OCEAN_DIRS[d][1];
      var key = nx + ',' + nz;
      if (seen[key]) continue;
      seen[key] = 1;

      var wx = nx * step, wz = nz * step;
      if (terrainHeight(wx, wz) >= SEA_LEVEL) continue;
      if (isOceanBasin(wx, wz)) {
        connected = true;
        break;
      }

      qx.push(nx);
      qz.push(nz);
    }

    if (connected) break;
  }

  if (oceanConnectionCache.size >= OCEAN_CACHE_MAX) oceanConnectionCache.clear();
  oceanConnectionCache.set(startKey, connected);

  return connected;
}

// Returns the inland water biome label for submerged height h
export function inlandWaterName(h) {
  return h < -3.5 ? 'Lake' : 'Pond';
}
