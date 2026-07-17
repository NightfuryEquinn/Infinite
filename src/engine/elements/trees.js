import { CHUNK_SIZE, TREE_HEIGHT_SCALE, TREE_MAX_PER_CHUNK } from '../config.js';
import { fbm, ihash, sstep } from '../noise.js';
import { terrainHeight, terrainNormalY } from '../terrain/height.js';

var BIRCH_URL = new URL('../../assets/birch_tree.glb', import.meta.url).href;
var TARGET_HEIGHT = 11.5 * TREE_HEIGHT_SCALE;

// Extracts one geometry group into its own indexed buffer geometry
function extractGroupGeometry(THREE, geometry, group) {
  var indexAttr = geometry.index;

  if (!indexAttr) return geometry.clone();

  var indices = [];

  for (var i = 0; i < group.count; i++) indices.push(indexAttr.getX(group.start + i));

  var pos = geometry.attributes.position;
  var norm = geometry.attributes.normal;
  var uv = geometry.attributes.uv;
  var newPos = [], newNorm = [], newUv = [], newIdx = [];
  var remap = new Map();

  for (var j = 0; j < indices.length; j++) {
    var old = indices[j];

    if (!remap.has(old)) {
      remap.set(old, remap.size);
      newPos.push(pos.getX(old), pos.getY(old), pos.getZ(old));

      if (norm) newNorm.push(norm.getX(old), norm.getY(old), norm.getZ(old));
      if (uv) newUv.push(uv.getX(old), uv.getY(old));
    }

    newIdx.push(remap.get(old));
  }

  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));

  if (newNorm.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(newNorm, 3));
  if (newUv.length) geo.setAttribute('uv', new THREE.Float32BufferAttribute(newUv, 2));
  geo.setIndex(newIdx);

  return geo;
}

// Returns true when a material should be treated as foliage
function isFoliageMaterial(mat) {
  var name = (mat.name || '').toLowerCase();

  if (mat.alphaMap) return true;
  if (/leaf|blatt|foliage|needle|branch|canopy|tree_?l|birch/i.test(name)) return true;
  if (mat.transparent || (mat.opacity != null && mat.opacity < 0.99)) return true;
  if (mat.map && mat.map.image && mat.map.image.width < 256) return true;

  return false;
}

// Rotates the loaded root so its tallest axis becomes vertical
function orientTreeRoot(THREE, root) {
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

// Sets default colors and PBR values on a tree material
function tuneTreeMaterial(THREE, mat) {
  if (!mat.color) mat.color = new THREE.Color(0xffffff);

  if (mat.isMeshStandardMaterial) {
    mat.metalness = 0.0;
    mat.roughness = 0.88;
    mat.envMapIntensity = 0.0;
  }

  if (mat.isMeshPhongMaterial) mat.shininess = 18;

  if (mat.map) {
    mat.map.colorSpace = THREE.SRGBColorSpace;
    mat.map.anisotropy = 4;
  } else if (isFoliageMaterial(mat)) {
    mat.color.setRGB(0.28, 0.52, 0.22);
  } else {
    mat.color.setRGB(0.45, 0.34, 0.24);
  }

  if (mat.alphaMap) {
    mat.alphaMap.colorSpace = THREE.NoColorSpace;
    mat.alphaMap.anisotropy = 4;
  }

  if (isFoliageMaterial(mat)) {
    mat.side = THREE.DoubleSide;
    mat.transparent = true;
    mat.alphaTest = 0.38;
    mat.depthWrite = true;
  } else {
    mat.side = THREE.FrontSide;
  }

  mat.fog = false;
}

// Applies wind sway and fog to tree materials via shader hooks
function attachTreeEffects(THREE, material, env) {
  tuneTreeMaterial(THREE, material);
  var foliage = isFoliageMaterial(material);
  material.fog = false;
  var prev = material.onBeforeCompile;

  // Injects wind sway and distance fog into tree shaders
  material.onBeforeCompile = function (shader) {
    if (prev) prev(shader);

    shader.uniforms.uTime = env.uTime;
    shader.uniforms.uGust = env.uGust;
    shader.uniforms.uFogColor = env.uFogColor;
    shader.uniforms.uFogNear = env.uFogNear;
    shader.uniforms.uFogFar = env.uFogFar;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      '#include <common>\nuniform float uTime;\nuniform float uGust;'
    ).replace(
      '#include <begin_vertex>',
      [
        '#include <begin_vertex>',
        'float swayH = max(transformed.y, 0.0);',
        'float swayAmt = swayH * ' + (foliage ? '0.022' : '0.006') + ' * uGust;',
        'transformed.x += sin(uTime * 1.7 + transformed.z * 0.08 + transformed.x * 0.05) * swayAmt;',
        'transformed.z += cos(uTime * 1.3 + transformed.x * 0.07) * swayAmt * 0.6;'
      ].join('\n')
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nuniform vec3 uFogColor;\nuniform float uFogNear;\nuniform float uFogFar;'
    );

    /* three r15x+ renamed output_fragment → opaque_fragment */
    var fogInject = [
      'float treeFog = smoothstep(uFogNear, uFogFar, length(vViewPosition));',
      'gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, treeFog);',
      'if (treeFog > 0.98) discard;'
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

  // Returns a stable cache key for the tree fog shader variant
  material.customProgramCacheKey = function () {
    return 'tree-fog-v2-' + (foliage ? 'foliage' : 'bark') + (material.map ? '-map' : '');
  };

  env.materials.push(material);
}

// Scales and merges tree meshes into instancing-ready parts
function prepareTreeVariant(THREE, root, env, mergeGeometries) {
  var wrapper = orientTreeRoot(THREE, root);
  wrapper.updateMatrixWorld(true);

  var box = new THREE.Box3().setFromObject(wrapper);
  var size = new THREE.Vector3();
  var center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  if (size.y < 0.001) throw new Error('tree model has zero height');

  var scale = TARGET_HEIGHT / size.y;
  wrapper.scale.setScalar(scale);
  wrapper.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  wrapper.updateMatrixWorld(true);

  var partMap = new Map();

  // Groups mesh geometry by material for instanced rendering
  wrapper.traverse(function (child) {
    if (!child.isMesh) return;

    var geom = child.geometry;
    var mats = Array.isArray(child.material) ? child.material : [child.material];

    // Accumulates geometry for one material slot
    function addPart(subGeom, mat) {
      if (!mat || !subGeom) return;

      var key = mat.uuid;

      if (!partMap.has(key)) partMap.set(key, { material: mat, geometries: [] });

      partMap.get(key).geometries.push(subGeom);
    }

    if (mats.length > 1 && geom.groups && geom.groups.length) {
      geom.groups.forEach(function (group) {
        var sub = extractGroupGeometry(THREE, geom, group);
        sub.applyMatrix4(child.matrixWorld);

        if (!sub.getAttribute('normal')) sub.computeVertexNormals();

        addPart(sub, mats[group.materialIndex] || mats[0]);
      });

      return;
    }

    var single = geom.clone();
    single.applyMatrix4(child.matrixWorld);

    if (!single.getAttribute('normal')) single.computeVertexNormals();

    addPart(single, mats[0]);
  });

  var parts = [];

  partMap.forEach(function (entry) {
    var geometry = entry.geometries.length === 1
      ? entry.geometries[0]
      : mergeGeometries(entry.geometries, false);

    entry.geometries.forEach(function (g) {
      if (g !== geometry) g.dispose();
    });

    attachTreeEffects(THREE, entry.material, env);
    geometry.computeBoundingSphere();
    parts.push({ geometry: geometry, material: entry.material });
  });

  var finalBox = new THREE.Box3();

  parts.forEach(function (part) {
    part.geometry.computeBoundingBox();
    finalBox.union(part.geometry.boundingBox);
  });

  var height = finalBox.max.y - finalBox.min.y;
  var radius = Math.max(finalBox.max.x - finalBox.min.x, finalBox.max.z - finalBox.min.z) * 0.5;

  return { parts: parts, height: height, radius: radius };
}

// Loads the prebuilt birch GLB and prepares it for instanced rendering
export async function loadTreeAssets(THREE, env) {
  env.materials = env.materials || [];
  var modules = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/utils/BufferGeometryUtils.js')
  ]);
  var gltf = await new modules[0].GLTFLoader().loadAsync(BIRCH_URL);
  var variant = prepareTreeVariant(THREE, gltf.scene, env, modules[1].mergeGeometries);

  return [variant];
}

// Places instanced trees in forested terrain for a chunk
export function spawnTrees(chunk, ctx) {
  var THREE = ctx.THREE;
  var variants = ctx.treeVariants;

  if (!variants || !variants.length) return;

  var cx = chunk.cx, cz = chunk.cz;
  var forest = fbm(cx * 0.13 + 5.2, cz * 0.13 - 3.1, 2);
  var maxTrees = Math.round(sstep(0.50, 0.82, forest) * TREE_MAX_PER_CHUNK);

  if (!maxTrees) return;

  var dummy = new THREE.Object3D();
  var placements = [];

  for (var i = 0; i < maxTrees; i++) {
    var rx = ihash(cx * 53 + i * 17 + 1, cz * 97 - i * 29 + 3);
    var rz = ihash(cx * 71 - i * 23 + 9, cz * 41 + i * 13 - 5);
    var x = (cx + 0.04 + rx * 0.92) * CHUNK_SIZE;
    var z = (cz + 0.04 + rz * 0.92) * CHUNK_SIZE;
    var h = terrainHeight(x, z);

    if (h < 2.8 || h > 22) continue;
    if (terrainNormalY(x, z) < 0.78) continue;

    var s = 0.75 + ihash(i * 7 + 11, (cx * 13) ^ cz) * 0.8;
    var variant = Math.floor(ihash(cx * 29 + i * 41 + 7, cz * 37 - i * 19 + 3) * variants.length);
    dummy.position.set(x, h - 0.15, z);
    dummy.rotation.y = rz * Math.PI * 2;
    dummy.scale.set(s, s * (0.9 + rx * 0.4), s);
    dummy.updateMatrix();
    placements.push({
      matrix: dummy.matrix.clone(),
      variant: variant,
      scale: s,
      heightMul: 0.9 + rx * 0.4,
      h: h
    });

    var v = variants[variant];
    chunk.colliders.push({
      x: x,
      z: z,
      r: v.radius * s * 0.35 + 0.25,
      top: h + v.height * s * (0.9 + rx * 0.4)
    });
  }

  if (!placements.length) return;

  var instanced = [];

  for (var vi = 0; vi < variants.length; vi++) {
    var partPlacements = placements.filter(function (p) { return p.variant === vi; });

    if (!partPlacements.length) continue;

    variants[vi].parts.forEach(function (part) {
      var inst = new THREE.InstancedMesh(part.geometry, part.material, partPlacements.length);

      for (var m = 0; m < partPlacements.length; m++) {
        inst.setMatrixAt(m, partPlacements[m].matrix);
      }

      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      /* Keep shadow casters in the shadow pass — ortho frustum differs from camera frustum. */
      inst.frustumCulled = false;
      inst.castShadow = true;
      inst.receiveShadow = false;
      ctx.scene.add(inst);
      instanced.push(inst);
    });
  }

  chunk.trees = instanced;
}
