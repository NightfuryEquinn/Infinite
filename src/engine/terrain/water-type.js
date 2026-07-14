import { SEA_LEVEL } from '../config.js';
import { isOceanBasin, terrainHeight } from './height.js';

/**
 * Walk submerged cells from (x, z). Returns true if any cell is an open-ocean basin
 * (connected to the continental ocean). Used for HUD biomes — cheap coarse grid.
 */
export function isConnectedToOcean(x, z) {
  if (terrainHeight(x, z) >= SEA_LEVEL) return false;
  if (isOceanBasin(x, z)) return true;

  var step = 8;
  var maxVisits = 900;
  var sx = Math.floor(x / step);
  var sz = Math.floor(z / step);
  var seen = Object.create(null);
  var qx = [sx], qz = [sz];
  seen[sx + ',' + sz] = 1;
  var head = 0;
  var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  while (head < qx.length && head < maxVisits) {
    var cx = qx[head], cz = qz[head];
    head++;
    for (var d = 0; d < 4; d++) {
      var nx = cx + dirs[d][0], nz = cz + dirs[d][1];
      var key = nx + ',' + nz;
      if (seen[key]) continue;
      seen[key] = 1;
      var wx = nx * step, wz = nz * step;
      if (terrainHeight(wx, wz) >= SEA_LEVEL) continue;
      if (isOceanBasin(wx, wz)) return true;
      qx.push(nx);
      qz.push(nz);
    }
  }
  return false;
}

export function inlandWaterName(h) {
  return h < -3.5 ? 'Lake' : 'Pond';
}
