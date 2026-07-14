import * as assimpModule from 'assimpjs';
import assimpWasm from 'assimpjs/dist/assimpjs.wasm?url';
import rockTexUrl from '../../assets/Rock-Texture-Surface.jpg';
import { biomeName } from '../biomes/index.js';
import { CHUNK_SIZE } from '../config.js';
import { fbm, ihash } from '../noise.js';
import { terrainHeight, terrainNormal, terrainNormalY } from '../terrain/height.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

var ROCK_URL = new URL('../../assets/Rock1.blend', import.meta.url).href;
var TARGET_HEIGHT = 2.4;
var _yAxis = null;
var _xAxis = null;
var _tipQ = null;
var _yawQ = null;
var _alignQ = null;
var _nml = null;
var _pos = null;

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return data;
}

function parseGlb(buffer) {
  return new Promise(function (resolve, reject) {
    new GLTFLoader().parse(toArrayBuffer(buffer), '', resolve, reject);
  });
}

async function getAssimp() {
  var factory = assimpModule.default || assimpModule['module.exports'];
  if (typeof factory !== 'function') {
    throw new Error('assimpjs failed to load');
  }
  return factory({
    locateFile: function (path) {
      return path.endsWith('.wasm') ? assimpWasm : path;
    }
  });
}

function ensureUVs(THREE, geometry) {
  if (geometry.getAttribute('uv')) return;
  geometry.computeBoundingBox();
  var box = geometry.boundingBox;
  var size = new THREE.Vector3();
  box.getSize(size);
  var pos = geometry.attributes.position;
  var uvs = new Float32Array(pos.count * 2);
  var sx = Math.max(size.x, 1e-4);
  var sy = Math.max(size.y, 1e-4);
  var sz = Math.max(size.z, 1e-4);
  for (var i = 0; i < pos.count; i++) {
    var x = (pos.getX(i) - box.min.x) / sx;
    var y = (pos.getY(i) - box.min.y) / sy;
    var z = (pos.getZ(i) - box.min.z) / sz;
    /* Prefer XZ/Y projection with a bit of height for vertical faces. */
    uvs[i * 2] = x * 0.65 + z * 0.35;
    uvs[i * 2 + 1] = y * 0.55 + z * 0.45;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

function orientRockRoot(THREE, root) {
  root.updateMatrixWorld(true);
  var box = new THREE.Box3().setFromObject(root);
  var size = new THREE.Vector3();
  box.getSize(size);
  var oriented = new THREE.Group();
  if (size.z >= size.x && size.z >= size.y) {
    oriented.rotation.x = -Math.PI / 2;
  } else if (size.x >= size.y && size.x >= size.z) {
    oriented.rotation.z = Math.PI / 2;
  }
  oriented.add(root);
  oriented.updateMatrixWorld(true);
  return oriented;
}

function attachRockEffects(THREE, material, env) {
  material.fog = false;
  if (material.isMeshStandardMaterial) {
    material.metalness = 0.02;
    material.roughness = 0.92;
    material.envMapIntensity = 0.0;
  }
  if (material.isMeshPhongMaterial) material.shininess = 8;
  if (material.map) {
    material.map.colorSpace = THREE.SRGBColorSpace;
    material.map.anisotropy = 8;
    material.map.wrapS = THREE.RepeatWrapping;
    material.map.wrapT = THREE.RepeatWrapping;
    material.map.needsUpdate = true;
  }
  material.side = THREE.FrontSide;

  var prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader) {
    if (prev) prev(shader);
    shader.uniforms.uFogColor = env.uFogColor;
    shader.uniforms.uFogNear = env.uFogNear;
    shader.uniforms.uFogFar = env.uFogFar;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nuniform vec3 uFogColor;\nuniform float uFogNear;\nuniform float uFogFar;'
    );
    var fogInject = [
      'float rockFog = smoothstep(uFogNear, uFogFar, length(vViewPosition));',
      'gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, rockFog);',
      'if (rockFog > 0.98) discard;'
    ].join('\n');
    if (shader.fragmentShader.indexOf('#include <opaque_fragment>') !== -1) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\n' + fogInject
      );
    } else {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <output_fragment>',
        '#include <output_fragment>\n' + fogInject
      );
    }
  };
  material.customProgramCacheKey = function () {
    return 'rock-fog-v1' + (material.map ? '-map' : '');
  };
  env.materials.push(material);
}

function prepareRockVariant(THREE, root, env, rockTex) {
  var wrapper = orientRockRoot(THREE, root);
  wrapper.updateMatrixWorld(true);

  var box = new THREE.Box3().setFromObject(wrapper);
  var size = new THREE.Vector3();
  var center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  if (size.y < 0.001) throw new Error('rock model has zero height');

  var scale = TARGET_HEIGHT / size.y;
  wrapper.scale.setScalar(scale);
  wrapper.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  wrapper.updateMatrixWorld(true);

  var geos = [];
  wrapper.traverse(function (child) {
    if (!child.isMesh || !child.geometry) return;
    /* Rock1.blend ships a flat texture Plane alongside the sculpted rock. */
    var localBox = new THREE.Box3().setFromBufferAttribute(child.geometry.attributes.position);
    var localSize = new THREE.Vector3();
    localBox.getSize(localSize);
    var minAxis = Math.min(localSize.x, localSize.y, localSize.z);
    var maxAxis = Math.max(localSize.x, localSize.y, localSize.z);
    if (maxAxis > 1e-4 && minAxis / maxAxis < 0.08) return;

    var geo = child.geometry.clone();
    geo.applyMatrix4(child.matrixWorld);
    ensureUVs(THREE, geo);
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    geos.push(geo);
  });
  if (!geos.length) throw new Error('rock model has no meshes');

  var geometry = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
  geos.forEach(function (g) { if (g !== geometry) g.dispose(); });
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  var material = new THREE.MeshStandardMaterial({
    map: rockTex,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.02
  });
  attachRockEffects(THREE, material, env);

  var finalBox = geometry.boundingBox;
  var height = finalBox.max.y - finalBox.min.y;
  var bx = finalBox.max.x - finalBox.min.x;
  var bz = finalBox.max.z - finalBox.min.z;
  /* After π/2 tip on X: former height lies in XZ, former Z is upright thickness. */
  var flatRadius = Math.max(bx, height) * 0.5;
  var flatHeight = bz;

  return {
    geometry: geometry,
    material: material,
    height: height,
    radius: Math.max(bx, bz) * 0.5,
    flatRadius: flatRadius,
    flatHeight: flatHeight,
    tipMinY: -finalBox.max.z
  };
}

function loadRockTexture(THREE) {
  return new Promise(function (resolve, reject) {
    var loader = new THREE.TextureLoader();
    loader.load(rockTexUrl, function (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      resolve(tex);
    }, undefined, reject);
  });
}

async function loadBlendRock(THREE, env, rockTex) {
  var ajs = await getAssimp();
  var res = await fetch(ROCK_URL);
  if (!res.ok) throw new Error('failed to fetch Rock1.blend');
  var blend = new Uint8Array(await res.arrayBuffer());
  var fileList = new ajs.FileList();
  fileList.AddFile('Rock1.blend', blend);
  var result = ajs.ConvertFileList(fileList, 'glb2');
  if (!result.IsSuccess() || result.FileCount() === 0) {
    throw new Error('Rock1.blend conversion failed: ' + result.GetErrorCode());
  }
  var glb = result.GetFile(0).GetContent();
  var gltf = await parseGlb(glb);
  return prepareRockVariant(THREE, gltf.scene, env, rockTex);
}

/** Procedural fallback if the blend asset fails to load. */
export function buildRockGeometry(THREE) {
  var geo = new THREE.IcosahedronGeometry(1, 1);
  var pa = geo.attributes.position.array;
  for (var i = 0; i < pa.length; i += 3) {
    var qx = Math.round(pa[i] * 9), qy = Math.round(pa[i + 1] * 9), qz = Math.round(pa[i + 2] * 9);
    var j = ihash(qx * 13 + qz * 31, qy * 17 - qz * 7);
    var k = ihash(qy * 23 - qx * 11, qz * 19 + qx * 3);
    var m = 0.78 + j * 0.45;
    pa[i] *= m;
    pa[i + 1] *= m * 0.72;
    pa[i + 2] *= m * (0.8 + k * 0.4);
  }
  geo.computeVertexNormals();
  ensureUVs(THREE, geo);
  geo.computeBoundingSphere();
  return geo;
}

function buildFallbackRock(THREE, env, rockTex) {
  var geometry = buildRockGeometry(THREE);
  var material = new THREE.MeshStandardMaterial({
    map: rockTex,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.02
  });
  attachRockEffects(THREE, material, env);
  geometry.computeBoundingBox();
  var box = geometry.boundingBox;
  var height = box.max.y - box.min.y;
  var bx = box.max.x - box.min.x;
  var bz = box.max.z - box.min.z;
  return {
    geometry: geometry,
    material: material,
    height: height,
    radius: Math.max(bx, bz) * 0.5,
    flatRadius: Math.max(bx, height) * 0.5,
    flatHeight: bz,
    tipMinY: -box.max.z
  };
}

export async function loadRockAssets(THREE, env) {
  env.materials = env.materials || [];
  var rockTex = await loadRockTexture(THREE);
  try {
    return await loadBlendRock(THREE, env, rockTex);
  } catch (err) {
    console.warn('[rocks] Rock1.blend failed, using procedural mesh:', err);
    return buildFallbackRock(THREE, env, rockTex);
  }
}

export function spawnRocks(chunk, ctx) {
  var THREE = ctx.THREE;
  var rock = ctx.rockAsset;
  if (!rock) return;

  if (!_yAxis) {
    _yAxis = new THREE.Vector3(0, 1, 0);
    _xAxis = new THREE.Vector3(1, 0, 0);
    _tipQ = new THREE.Quaternion().setFromAxisAngle(_xAxis, Math.PI / 2);
    _yawQ = new THREE.Quaternion();
    _alignQ = new THREE.Quaternion();
    _nml = new THREE.Vector3();
    _pos = new THREE.Vector3();
  }

  var cx = chunk.cx, cz = chunk.cz;
  var n = Math.floor(3 + ihash(cx * 199 + 8, cz * 211 - 4) * 11);
  var dummy = new THREE.Object3D();
  var slots = [];
  var tipMinY = rock.tipMinY;
  var flatR = rock.flatRadius;
  var flatH = rock.flatHeight;

  for (var i = 0; i < n; i++) {
    var rx = ihash(cx * 149 + i * 37 + 2, cz * 83 - i * 19 + 6);
    var rz = ihash(cx * 61 + i * 43 - 8, cz * 173 + i * 31 + 4);
    var r3 = ihash(i * 17 + cx * 5, i * 29 - cz * 7);
    var r4 = ihash(i * 53 + cx * 11, i * 71 - cz * 13);
    var r5 = ihash(cx * 101 - i * 7, cz * 67 + i * 23);
    var x = (cx + 0.03 + rx * 0.94) * CHUNK_SIZE;
    var z = (cz + 0.03 + rz * 0.94) * CHUNK_SIZE;
    var h = terrainHeight(x, z);
    if (h < 0.15) continue;
    var ny = terrainNormalY(x, z);
    var biome = biomeName(h, ny, x, z);
    /* Beaches + plains only; woods = forested plains (same noise as trees). */
    if (biome !== 'Sandy Shores' && biome !== 'Verdant Plains') continue;
    var forest = fbm(cx * 0.13 + 5.2, cz * 0.13 - 3.1, 2);
    var inWoods = biome === 'Verdant Plains' && h >= 2.8 && h <= 22 && forest > 0.50;
    if (biome === 'Verdant Plains' && !inWoods && ny >= 0.92 && r4 >= 0.55) continue;

    /* 1× default size → 5×; bias toward smaller rocks. */
    var s = 1 + r3 * r3 * 4;
    slots.push(x, z, h, s, rz * Math.PI * 2, 0.18 + r5 * 0.38);
  }
  if (!slots.length) return;

  var count = slots.length / 6;
  var inst = new THREE.InstancedMesh(rock.geometry, rock.material, count);
  for (var m = 0; m < count; m++) {
    var o = m * 6;
    var px = slots[o], pz = slots[o + 1], ph = slots[o + 2], s = slots[o + 3];
    var bury = flatH * s * slots[o + 5];

    terrainNormal(px, pz, _nml);
    _alignQ.setFromUnitVectors(_yAxis, _nml);
    _yawQ.setFromAxisAngle(_yAxis, slots[o + 4]);
    /* Tip onto side, random yaw, then tilt so the flat face follows the slope. */
    dummy.quaternion.copy(_tipQ).premultiply(_yawQ).premultiply(_alignQ);
    dummy.scale.setScalar(s);
    /* Seat along the terrain normal so steep ground doesn't leave a world-Y gap. */
    _pos.set(px, ph, pz);
    _pos.addScaledVector(_nml, -tipMinY * s - bury);
    dummy.position.copy(_pos);
    dummy.updateMatrix();
    inst.setMatrixAt(m, dummy.matrix);

    chunk.colliders.push({
      x: px,
      z: pz,
      r: flatR * s,
      top: ph - bury + flatH * s * _nml.y
    });
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  inst.castShadow = true;
  inst.receiveShadow = true;
  ctx.scene.add(inst);
  chunk.rocks = inst;
}
