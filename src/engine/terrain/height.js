import { fbm, sstep, vnoise } from '../noise.js';

/* The single source of truth for terrain height (mesh AND camera). */
export function terrainHeight(x, z) {
  var cont = fbm(x * 0.0013, z * 0.0013, 3);
  var hills = fbm(x * 0.0085 + 37.7, z * 0.0085 - 11.2, 4);
  var land = sstep(0.38, 0.52, cont);
  var h = (cont - 0.42) * 88;
  h += (hills - 0.5) * 26 * land;
  var m = sstep(0.55, 0.78, cont);
  if (m > 0.001) {
    var r = 1 - Math.abs(2 * fbm(x * 0.004 - 91.3, z * 0.004 + 44.8, 3) - 1);
    h += m * r * r * 54;
  }
  h += (vnoise(x * 0.05, z * 0.05) - 0.5) * 2.4;
  return h;
}

export function terrainNormalY(x, z) {
  var e = 1.2;
  var dx = terrainHeight(x - e, z) - terrainHeight(x + e, z);
  var dz = terrainHeight(x, z - e) - terrainHeight(x, z + e);
  return (2 * e) / Math.sqrt(dx * dx + dz * dz + 4 * e * e);
}
