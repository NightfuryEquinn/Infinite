import { CHUNK_SIZE, CHUNK_RES } from '../config.js';
import { terrainHeight } from './height.js';

export function buildChunkMesh(cx, cz, THREE, terrainMat) {
  var res = CHUNK_RES, size = CHUNK_SIZE, step = size / res;
  var x0 = cx * size, z0 = cz * size;
  var n1 = res + 1, pad = res + 3;

  var hg = new Float32Array(pad * pad);
  for (var iz = 0; iz < pad; iz++) {
    var wz = z0 + (iz - 1) * step;
    for (var ix = 0; ix < pad; ix++) {
      hg[iz * pad + ix] = terrainHeight(x0 + (ix - 1) * step, wz);
    }
  }

  var pos = new Float32Array(n1 * n1 * 3);
  var nrm = new Float32Array(n1 * n1 * 3);
  var ao = new Float32Array(n1 * n1);
  var p = 0, vi = 0;
  for (var jz = 0; jz < n1; jz++) {
    for (var jx = 0; jx < n1; jx++) {
      var gi = (jz + 1) * pad + (jx + 1);
      var h = hg[gi];
      pos[p] = jx * step; pos[p + 1] = h; pos[p + 2] = jz * step;

      /* Sobel-weighted central differences → smoother shaded slopes. */
      var hl = hg[gi - 1], hr = hg[gi + 1];
      var hd = hg[gi - pad], hu = hg[gi + pad];
      var hld = hg[gi - pad - 1], hrd = hg[gi - pad + 1];
      var hlu = hg[gi + pad - 1], hru = hg[gi + pad + 1];
      var nx = (hld + 2 * hl + hlu) - (hrd + 2 * hr + hru);
      var nz = (hld + 2 * hd + hrd) - (hlu + 2 * hu + hru);
      var ny = 8 * step;
      var il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nrm[p] = nx * il; nrm[p + 1] = ny * il; nrm[p + 2] = nz * il;

      var lap = (hl + hr + hd + hu) * 0.25 - h;
      ao[vi++] = 1 - Math.min(0.32, Math.max(0, lap * 0.22));
      p += 3;
    }
  }

  var idx = new Uint16Array(res * res * 6);
  var q = 0;
  for (var tz = 0; tz < res; tz++) {
    for (var tx = 0; tx < res; tx++) {
      var a = tz * n1 + tx, b = a + 1, c = a + n1, d = c + 1;
      /* Alternate tri wind so long edges don't accumulate into visible facets. */
      if (((tx + tz) & 1) === 0) {
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = c; idx[q++] = d; idx[q++] = b;
      } else {
        idx[q++] = a; idx[q++] = c; idx[q++] = d;
        idx[q++] = a; idx[q++] = d; idx[q++] = b;
      }
    }
  }

  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  var mesh = new THREE.Mesh(geo, terrainMat);
  mesh.position.set(x0, 0, z0);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return { cx: cx, cz: cz, mesh: mesh, beacons: [], trees: null, rocks: null, colliders: [] };
}
