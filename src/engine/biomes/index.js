import { SEA_LEVEL } from '../config.js';

export function biomeName(h, ny) {
  if (h < -10) return 'Deep Ocean';
  if (h < 0.3) return 'Shallows';
  if (h < 2.2) return 'Sandy Shores';
  if (h > 36) return 'Snowy Peaks';
  if (ny < 0.62) return 'Rocky Cliffs';
  if (h > 20) return 'Highlands';
  return 'Verdant Plains';
}

export function mapColor(h, px, i) {
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
