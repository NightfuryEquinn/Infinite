/* Deterministic hash-based value noise */

// Returns a deterministic hash in [0, 1) for integer lattice coordinates
export function ihash(ix, iz) {
  var n = (ix * 374761393 + iz * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

// Quintic hermite fade — C2-smooth, less faceting than cubic
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Returns smooth value noise at continuous world coordinates
export function vnoise(x, z) {
  var ix = Math.floor(x), iz = Math.floor(z);
  var fx = x - ix, fz = z - iz;
  var ux = fade(fx), uz = fade(fz);
  var a = ihash(ix, iz), b = ihash(ix + 1, iz);
  var c = ihash(ix, iz + 1), d = ihash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

// Returns fractal Brownian motion noise averaged over oct octaves
export function fbm(x, z, oct) {
  var v = 0, amp = 0.5, tot = 0;
  for (var i = 0; i < oct; i++) {
    v += vnoise(x, z) * amp;
    tot += amp;
    amp *= 0.5;
    x = x * 2.03 + 11.31;
    z = z * 2.03 - 7.77;
  }
  return v / tot;
}

// Returns ridged multifractal noise with sharp crests and smooth valleys
export function ridged(x, z, oct) {
  var v = 0, amp = 0.5, tot = 0;
  for (var i = 0; i < oct; i++) {
    var n = 1 - Math.abs(2 * vnoise(x, z) - 1);
    n = n * n;
    v += n * amp;
    tot += amp;
    amp *= 0.5;
    x = x * 2.07 + 9.17;
    z = z * 2.07 - 5.43;
  }
  return v / tot;
}

// Returns a smooth Hermite step from a to b at x
export function sstep(a, b, x) {
  var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
