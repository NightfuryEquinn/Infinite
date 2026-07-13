import { terrainHeight } from './height.js';

export function findSpawn() {
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
