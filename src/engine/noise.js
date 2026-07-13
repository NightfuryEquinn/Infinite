/* Deterministic hash-based value noise */

export function ihash(ix, iz) {
  var n = (ix * 374761393 + iz * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

export function vnoise(x, z) {
  var ix = Math.floor(x), iz = Math.floor(z);
  var fx = x - ix, fz = z - iz;
  var ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  var a = ihash(ix, iz), b = ihash(ix + 1, iz);
  var c = ihash(ix, iz + 1), d = ihash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

export function fbm(x, z, oct) {
  var v = 0, amp = 0.5, tot = 0;
  for (var i = 0; i < oct; i++) {
    v += vnoise(x, z) * amp;
    tot += amp; amp *= 0.5;
    x = x * 2.03 + 11.31; z = z * 2.03 - 7.77;
  }
  return v / tot;
}

export function sstep(a, b, x) {
  var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
