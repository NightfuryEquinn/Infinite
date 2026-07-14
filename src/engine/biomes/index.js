import { SEA_LEVEL } from '../config.js';
import { continentNoise } from '../terrain/height.js';
import { inlandWaterName, isConnectedToOcean } from '../terrain/water-type.js';

// Returns the biome display name for height, slope, and world position
export function biomeName(h, ny, x, z) {
  if (h < SEA_LEVEL) {
    if (x != null && z != null && !isConnectedToOcean(x, z)) {
      return inlandWaterName(h);
    }
    if (h < -10) return 'Deep Ocean';
    return 'Shallows';
  }

  if (h < 2.2) return 'Sandy Shores';
  if (h > 36) return 'Snowy Peaks';
  if (ny < 0.62) return 'Rocky Cliffs';
  if (h > 20) return 'Highlands';
  return 'Verdant Plains';
}

// Writes RGBA minimap pixel colors into px at index i for height and position
export function mapColor(h, px, i, x, z) {
  var r, g, b, t;

  if (h < SEA_LEVEL) {
    var inland = x != null && z != null && continentNoise(x, z) >= 0.40;
    if (inland) {
      t = Math.min(1, Math.max(0, (h + 12) / 12));
      r = 18 + t * 22;
      g = 62 + t * 48;
      b = 48 + t * 36;
    } else {
      t = Math.min(1, Math.max(0, (h + 26) / 26));
      r = 13 + t * 25;
      g = 34 + t * 52;
      b = 52 + t * 56;
    }
  } else if (h < 0.8) {
    r = 122;
    g = 112;
    b = 92;
  } else if (h < 2.2) {
    t = (h - 0.8) / 1.4;
    r = 122 + t * 72;
    g = 112 + t * 52;
    b = 92 + t * 46;
  } else if (h < 24) {
    t = (h - 2.2) / 21.8;
    r = 51 + t * 38;
    g = 102 + t * 18;
    b = 38 + t * 16;
  } else if (h < 36) {
    r = 104;
    g = 100;
    b = 95;
  } else {
    r = 228;
    g = 238;
    b = 248;
  }

  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = 255;
}
