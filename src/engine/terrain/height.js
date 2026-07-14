import { SEA_LEVEL } from '../config.js';
import { fbm, ridged, sstep, vnoise } from '../noise.js';

// Returns continental noise — low is ocean basin, high is landmass
export function continentNoise(x, z) {
  return fbm(x * 0.0013, z * 0.0013, 4);
}

// Returns true when the point is submerged in the open-ocean continental basin
export function isOceanBasin(x, z) {
  return continentNoise(x, z) < 0.40;
}

// Returns terrain height at world coordinates (mesh and camera source of truth)
export function terrainHeight(x, z) {
  var cont = continentNoise(x, z);
  var hills = fbm(x * 0.0085 + 37.7, z * 0.0085 - 11.2, 5);
  var land = sstep(0.40, 0.50, cont);
  var h = (cont - 0.42) * 88;
  h += (hills - 0.5) * 28 * land;

  /* Soft mid-scale variation — light ridge bias, mostly hills. */
  var mid = ridged(x * 0.018 + 5.1, z * 0.018 - 2.7, 3);
  h += (mid - 0.42) * 4.0 * land;

  var m = sstep(0.56, 0.74, cont);
  if (m > 0.001) {
    var r = ridged(x * 0.0042 - 91.3, z * 0.0042 + 44.8, 3);
    h += m * r * r * 48;
  }

  /* Fine ground grain — sampled densely by the higher-res mesh. */
  h += (vnoise(x * 0.07, z * 0.07) - 0.5) * 1.6;
  h += (vnoise(x * 0.22 + 3.1, z * 0.22 - 1.7) - 0.5) * 0.55 * land;

  /* Closed inland bowls — ponds/lakes sealed off from the ocean. */
  var inland = sstep(0.46, 0.58, cont);
  if (inland > 0.01) {
    var pond = fbm(x * 0.0058 + 17.3, z * 0.0058 - 29.1, 3);
    var bowl = sstep(0.58, 0.74, pond);
    if (bowl > 0.001) {
      var depth = 2.5 + sstep(0.70, 0.86, pond) * 5.5;
      var carved = Math.min(h, SEA_LEVEL - depth * bowl);
      h = h + (carved - h) * inland * bowl;
    }
  }

  return h;
}

// Fills out with the unit terrain normal pointing up and out of the ground
export function terrainNormal(x, z, out) {
  var e = 0.85;
  var dx = terrainHeight(x - e, z) - terrainHeight(x + e, z);
  var dz = terrainHeight(x, z - e) - terrainHeight(x, z + e);
  var inv = 1 / Math.sqrt(dx * dx + dz * dz + 4 * e * e);
  out.x = dx * inv;
  out.y = 2 * e * inv;
  out.z = dz * inv;
  return out;
}

// Returns the Y component of the unit terrain normal at world coordinates
export function terrainNormalY(x, z) {
  var e = 0.85;
  var dx = terrainHeight(x - e, z) - terrainHeight(x + e, z);
  var dz = terrainHeight(x, z - e) - terrainHeight(x, z + e);
  return (2 * e) / Math.sqrt(dx * dx + dz * dz + 4 * e * e);
}
