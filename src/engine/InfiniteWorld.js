import {
  CHUNK_SIZE, DAY_LENGTH, EYE_HEIGHT, FOG_COLOR, FOG_FAR, FOG_NEAR,
  SHADOW_EXTENT, SHADOW_MAP_SIZE,
  GRAVITY, JUMP_V, LS_KEY, SEA_LEVEL, SETTINGS_LS_KEY, SKY_ZENITH, SNOW_N,
  SPRINT_SPEED, SUN, UNLOAD_RADIUS, VIEW_RADIUS, WALK_SPEED, WIND_N
} from './config.js';
import { biomeName, mapColor } from './biomes/index.js';
import { spawnBeacon } from './elements/beacons.js';
import { spawnRocks, loadRockAssets } from './elements/rocks.js';
import { SKY_FRAG, SKY_VERT } from './elements/sky.js';
import { spawnTrees, loadTreeAssets } from './elements/trees.js';
import {
  createFloorHeightmap, updateFloorHeightmap,
  WATER_FLOOR_EXTENT, WATER_FLOOR_MAX, WATER_FLOOR_MIN
} from './elements/water-floor.js';
import { WATER_FRAG, WATER_VERT } from './elements/water.js';
import { sstep, vnoise, ihash } from './noise.js';
import { makeGlowTexture, makeSoftTexture } from './textures.js';
import { loadThree } from './three-loader.js';
import { buildChunkMesh } from './terrain/chunk.js';
import { terrainHeight, terrainNormalY } from './terrain/height.js';
import { findSpawn } from './terrain/spawn.js';
import { TERRAIN_FRAG, TERRAIN_VERT } from './terrain/shaders.js';
import { hudHTML } from './ui/hud.js';

export class InfiniteWorld extends HTMLElement {
  connectedCallback() {
    if (this._inited) return;
    this._inited = true;
    var self = this;

    this.style.display = 'block';
    if (!this.style.position) this.style.position = 'relative';
    if (!this.clientHeight) this.style.height = '100%';

    var root = document.createElement('div');
    root.setAttribute('data-screen-label', 'Infinite World Explorer');
    root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#0a0e14;' +
      "font-family:'Space Grotesk',system-ui,sans-serif;user-select:none;-webkit-user-select:none;";
    this.appendChild(root);
    this._root = root;

    var hud = document.createElement('div');
    hud.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;';
    hud.innerHTML = hudHTML();
    root.appendChild(hud);
    this._el = {};
    ['cross', 'fps', 'clock', 'disc', 'map', 'biome', 'pos', 'speed', 'speedbar', 'hint',
      'stats', 'popup', 'popup-kicker', 'popup-name', 'popup-lore', 'popup-action',
      'start', 'start-title', 'start-sub', 'loading', 'loadbar', 'loadtext',
      'mobile', 'mobile-settings', 'mobile-panel', 'stick-zone', 'stick-base', 'stick-knob',
      'actions', 'btn-sprint', 'btn-jump', 'handed-right', 'handed-left'].forEach(function (k) {
        self._el[k.replace(/-/g, '_')] = hud.querySelector('[data-' + k + ']');
      });
    this._el.start.style.pointerEvents = 'auto';

    this._chunks = new Map();
    this._queue = [];
    this._queued = new Set();
    this._beacons = new Map();
    this._keys = {};
    this._stick = { x: 0, y: 0 };
    this._stickPointerId = null;
    this._lookPointerId = null;
    this._lookLast = null;
    this._mobileSprint = false;
    this._settingsOpen = false;
    this._yaw = Math.PI * 0.25;
    this._pitch = -0.06;
    this._vel = { x: 0, z: 0 };
    this._speed = 0;
    this._time = 0;
    this._last = 0;
    this._hudLast = 0;
    this._mapLast = -1e9;
    this._fpsFrames = 0;
    this._fpsLast = 0;
    this._fps = 60;
    this._loading = true;
    this._built = 0;
    this._dragLook = false;
    this._dragging = false;
    this._popupBeacon = null;
    this._ccx = null; this._ccz = null;
    this._vy = 0;
    this._airborne = false;
    this._jumps = 0;
    this._gust = 0.3;
    this._groundH = 0;
    this._day = 1;
    this._dayT = 0.32;
    this._weather = {
      gustOn: true, gustUntil: 60 + Math.random() * 1140,
      snowOn: true, snowUntil: 60 + Math.random() * 1140,
      gustLevel: 0.6, snowLevel: 1
    };
    this._discovered = new Set();
    this._handed = 'right';
    this._isMobile = this._detectMobile();
    try {
      var saved = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      if (Array.isArray(saved)) saved.forEach(function (id) { self._discovered.add(id); });
    } catch (e) { /* ignore */ }
    try {
      var settings = JSON.parse(localStorage.getItem(SETTINGS_LS_KEY) || '{}');
      if (settings && (settings.handed === 'left' || settings.handed === 'right')) {
        this._handed = settings.handed;
      }
    } catch (e) { /* ignore */ }

    loadThree().then(function (THREE) {
      try { self._init(THREE); } catch (err) { self._fail(err); }
    }).catch(function (err) { self._fail(err); });
  }

  disconnectedCallback() {
    var self = this;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._resizeObs) this._resizeObs.disconnect();
    (this._unbinders || []).forEach(function (fn) { fn(); });
    if (this._chunks) this._chunks.forEach(function (c) { self._disposeChunk(c); });
    if (this._renderer) this._renderer.dispose();
    this.innerHTML = '';
    this._inited = false;
  }

  _fail(err) {
    console.error('[infinite-world]', err);
    if (this._el && this._el.loadtext) {
      this._el.loadtext.textContent = 'failed to start: ' + (err && err.message ? err.message : 'WebGL unavailable');
      this._el.loadtext.style.color = '#ff9d8f';
    }
  }

  _spawnCtx() {
    return {
      THREE: this._THREE,
      scene: this._scene,
      treeVariants: this._treeVariants,
      treeEnv: this._treeEnv,
      rockAsset: this._rockAsset,
      beaconGeo: this._beaconGeo,
      glowTex: this._glowTex,
      beacons: this._beacons,
      discovered: this._discovered
    };
  }

  _init(THREE) {
    var self = this;
    this._THREE = THREE;

    var renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this._pxCap = Math.min(window.devicePixelRatio || 1, 1.75);
    this._px = this._pxCap;
    renderer.setPixelRatio(this._px);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;z-index:1;cursor:crosshair;touch-action:none;';
    this._root.insertBefore(renderer.domElement, this._root.firstChild);
    this._renderer = renderer;
    this._canvas = renderer.domElement;

    var scene = new THREE.Scene();
    this._scene = scene;
    var camera = new THREE.PerspectiveCamera(70, 1, 0.1, 900);
    camera.rotation.order = 'YXZ';
    this._camera = camera;

    var fogColor = new THREE.Color(FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
    var sunDir = new THREE.Vector3(SUN[0], SUN[1], SUN[2]);

    this._fogColor = fogColor;
    this._sunDir = sunDir;
    this._sunVis = sunDir.clone();
    this._zenithCol = new THREE.Color(SKY_ZENITH[0], SKY_ZENITH[1], SKY_ZENITH[2]);
    this._ambientCol = new THREE.Color(0.36, 0.41, 0.50);
    this._sunLightCol = new THREE.Color(0.95, 0.88, 0.76);
    this._lightI = { value: 1 };
    this._nightI = { value: 0 };

    this._ambLight = new THREE.AmbientLight(0xb8c8e0, 0.55);
    scene.add(this._ambLight);

    this._sunLight = new THREE.DirectionalLight(0xfff0dc, 1.15);
    this._sunLight.position.copy(sunDir).multiplyScalar(180);
    this._sunLight.castShadow = true;
    this._sunLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this._sunLight.shadow.camera.near = 2;
    this._sunLight.shadow.camera.far = SHADOW_EXTENT * 2 + 80;
    this._sunLight.shadow.camera.left = -SHADOW_EXTENT;
    this._sunLight.shadow.camera.right = SHADOW_EXTENT;
    this._sunLight.shadow.camera.top = SHADOW_EXTENT;
    this._sunLight.shadow.camera.bottom = -SHADOW_EXTENT;
    this._sunLight.shadow.camera.updateProjectionMatrix();
    this._sunLight.shadow.bias = -0.0004;
    this._sunLight.shadow.normalBias = 0.03;
    this._sunLight.shadow.autoUpdate = true;
    scene.add(this._sunLight);
    scene.add(this._sunLight.target);

    this._terrainMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: sunDir },
        uAmbient: { value: this._ambientCol },
        uSunCol: { value: this._sunLightCol },
        uFogColor: { value: fogColor },
        uFogNear: { value: FOG_NEAR },
        uFogFar: { value: FOG_FAR },
        uShadowMap: { value: null },
        uShadowMatrix: { value: this._sunLight.shadow.matrix },
        uShadowMapSize: { value: new THREE.Vector2(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE) },
        uShadowBias: { value: 0.0006 },
        uShadowMix: { value: 1.0 }
      },
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG
    });
    this._terrainMat.onBeforeRender = function () {
      var light = self._sunLight;
      var shadow = light.shadow;
      var u = self._terrainMat.uniforms;
      u.uShadowMap.value = shadow.map ? shadow.map.texture : null;
      u.uShadowMatrix.value.copy(shadow.matrix);
      u.uShadowMix.value = self._day;
    };

    var sky = new THREE.Mesh(
      new THREE.SphereGeometry(600, 24, 14),
      new THREE.ShaderMaterial({
        uniforms: {
          uSunDir: { value: this._sunVis },
          uZenith: { value: this._zenithCol },
          uHorizon: { value: fogColor },
          uNightI: this._nightI,
          uTime: { value: 0 }
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false
      })
    );
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    scene.add(sky);
    this._sky = sky;
    this._skyMat = sky.material;

    var spawn = findSpawn();

    this._waterFloor = createFloorHeightmap(THREE);
    updateFloorHeightmap(this._waterFloor, spawn.x, spawn.z);
    this._waterMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLightI: this._lightI,
        uSeaLevel: { value: SEA_LEVEL },
        uFloorMin: { value: WATER_FLOOR_MIN },
        uFloorMax: { value: WATER_FLOOR_MAX },
        uFloorOrigin: { value: new THREE.Vector2(this._waterFloor.originX, this._waterFloor.originZ) },
        uFloorSize: { value: WATER_FLOOR_EXTENT },
        uFloorMap: { value: this._waterFloor.tex },
        uSunDir: { value: sunDir },
        uFogColor: { value: fogColor },
        uFogNear: { value: FOG_NEAR },
        uFogFar: { value: FOG_FAR }
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      extensions: { derivatives: true }
    });
    var water = new THREE.Mesh(new THREE.PlaneGeometry(560, 560, 96, 96), this._waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = SEA_LEVEL;
    water.renderOrder = 1;
    water.frustumCulled = false;
    scene.add(water);
    this._water = water;

    this._beaconGeo = new THREE.OctahedronGeometry(1.2, 0);
    this._glowTex = makeGlowTexture(THREE);

    this._mapN = 56;
    this._mapScale = 9;
    this._mapOff = document.createElement('canvas');
    this._mapOff.width = this._mapOff.height = this._mapN;
    this._mapOffCtx = this._mapOff.getContext('2d');
    this._mapImg = this._mapOffCtx.createImageData(this._mapN, this._mapN);
    this._mapCtx = this._el.map.getContext('2d');

    var sh = terrainHeight(spawn.x, spawn.z);
    camera.position.set(spawn.x, sh + EYE_HEIGHT, spawn.z);
    this._camY = sh + EYE_HEIGHT;
    this._groundH = sh;

    this._treeVariants = null;
    this._treesReady = false;
    this._rockAsset = null;
    this._rocksReady = false;
    this._treeEnv = {
      uTime: { value: 0 },
      uGust: { value: 0.6 },
      uSunDir: { value: sunDir },
      uAmbient: { value: this._ambientCol },
      uSunCol: { value: this._sunLightCol },
      uFogColor: { value: fogColor },
      uFogNear: { value: FOG_NEAR },
      uFogFar: { value: FOG_FAR },
      materials: []
    };
    this._rockEnv = {
      uFogColor: { value: fogColor },
      uFogNear: { value: FOG_NEAR },
      uFogFar: { value: FOG_FAR },
      materials: []
    };

    var self = this;
    loadTreeAssets(THREE, this._treeEnv).then(function (variants) {
      self._treeVariants = variants;
      self._treesReady = true;
    }).catch(function (err) { self._fail(err); });

    loadRockAssets(THREE, this._rockEnv).then(function (asset) {
      self._rockAsset = asset;
      self._rocksReady = true;
    }).catch(function (err) { self._fail(err); });

    var softTex = makeSoftTexture(THREE);
    var snowPos = new Float32Array(SNOW_N * 3);
    for (var si = 0; si < SNOW_N; si++) {
      snowPos[si * 3] = spawn.x + (ihash(si, 1) - 0.5) * 110;
      snowPos[si * 3 + 1] = this._camY - 24 + ihash(si, 2) * 52;
      snowPos[si * 3 + 2] = spawn.z + (ihash(si, 3) - 0.5) * 110;
    }
    var snowGeo = new THREE.BufferGeometry();
    var snowAttr = new THREE.BufferAttribute(snowPos, 3);
    snowGeo.setAttribute('position', snowAttr);
    var snowPts = new THREE.Points(snowGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.45, map: softTex, transparent: true,
      opacity: 0, depthWrite: false, sizeAttenuation: true
    }));
    snowPts.frustumCulled = false;
    snowPts.renderOrder = 3;
    snowPts.visible = false;
    scene.add(snowPts);
    this._snow = { pts: snowPts, attr: snowAttr };

    var windData = new Float32Array(WIND_N * 4);
    for (var wi = 0; wi < WIND_N; wi++) {
      windData[wi * 4] = spawn.x + (ihash(wi, 11) - 0.5) * 120;
      windData[wi * 4 + 1] = this._camY - 10 + ihash(wi, 12) * 26;
      windData[wi * 4 + 2] = spawn.z + (ihash(wi, 13) - 0.5) * 120;
      windData[wi * 4 + 3] = ihash(wi, 14);
    }
    var windGeo = new THREE.BufferGeometry();
    var windAttr = new THREE.BufferAttribute(new Float32Array(WIND_N * 6), 3);
    windGeo.setAttribute('position', windAttr);
    var windLine = new THREE.LineSegments(windGeo, new THREE.LineBasicMaterial({
      color: 0xe8f0f8, transparent: true, opacity: 0, depthWrite: false
    }));
    windLine.frustumCulled = false;
    windLine.renderOrder = 3;
    scene.add(windLine);
    this._wind = { line: windLine, attr: windAttr, data: windData };

    this._bindEvents();
    this._resize();

    this._tick = this._tick.bind(this);
    this._last = performance.now();
    this._fpsLast = this._last;
    this._raf = requestAnimationFrame(this._tick);
  }

  _bindEvents() {
    var self = this;
    var unbind = this._unbinders = [];
    function on(target, ev, fn, opts) {
      target.addEventListener(ev, fn, opts);
      unbind.push(function () { target.removeEventListener(ev, fn, opts); });
    }

    var KEYMAP = {
      KeyW: 'w', ArrowUp: 'w', KeyS: 's', ArrowDown: 's',
      KeyA: 'a', ArrowLeft: 'a', KeyD: 'd', ArrowRight: 'd',
      ShiftLeft: 'shift', ShiftRight: 'shift'
    };
    on(window, 'keydown', function (e) {
      var k = KEYMAP[e.code];
      if (k) { self._keys[k] = true; e.preventDefault(); }
      if (e.code === 'KeyE') self._tryDiscover();
      if (e.code === 'Space') { e.preventDefault(); self._jump(); }
    });
    on(window, 'keyup', function (e) {
      var k = KEYMAP[e.code];
      if (k) self._keys[k] = false;
    });
    on(window, 'blur', function () {
      self._keys = {};
      self._dragging = false;
      self._mobileSprint = false;
      self._resetStick();
      self._lookPointerId = null;
      self._lookLast = null;
      if (self._el.btn_sprint) {
        self._el.btn_sprint.style.background = 'rgba(8,13,20,.55)';
        self._el.btn_sprint.style.borderColor = 'rgba(255,255,255,.12)';
      }    });

    function tryLock() {
      if (self._isMobile || self._dragLook) return;
      try {
        var p = self._canvas.requestPointerLock && self._canvas.requestPointerLock();
        if (p && p.catch) p.catch(function () { self._enableDragLook(); });
        setTimeout(function () {
          if (document.pointerLockElement !== self._canvas && !self._dragLook) self._enableDragLook();
        }, 350);
      } catch (e) { self._enableDragLook(); }
    }
    on(this._el.start, 'click', function () {
      if (self._isMobile) {
        self._enableDragLook();
        self._setLookActive(true);
      } else {
        tryLock();
      }
    });
    on(this._canvas, 'click', function () {
      if (!self._dragLook && document.pointerLockElement !== self._canvas) tryLock();
    });
    on(document, 'pointerlockchange', function () {
      var locked = document.pointerLockElement === self._canvas;
      self._setLookActive(locked || self._dragLook);
    });
    on(document, 'mousemove', function (e) {
      var locked = document.pointerLockElement === self._canvas;
      if (locked || (self._dragLook && self._dragging && self._lookPointerId == null)) {
        self._applyLookDelta(e.movementX || 0, e.movementY || 0);
      }
    });
    on(this._canvas, 'mousedown', function (e) {
      if (self._dragLook && e.button === 0 && self._lookPointerId == null) self._dragging = true;
    });
    on(window, 'mouseup', function () {
      if (self._lookPointerId == null) self._dragging = false;
    });

    /* Touch / pointer look (mobile drag across canvas) */
    on(this._canvas, 'pointerdown', function (e) {
      if (!self._dragLook || e.pointerType === 'mouse') return;
      if (self._lookPointerId != null) return;
      self._lookPointerId = e.pointerId;
      self._lookLast = { x: e.clientX, y: e.clientY };
      self._dragging = true;
      try { self._canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    on(this._canvas, 'pointermove', function (e) {
      if (e.pointerId !== self._lookPointerId || !self._lookLast) return;
      var dx = e.clientX - self._lookLast.x;
      var dy = e.clientY - self._lookLast.y;
      self._lookLast = { x: e.clientX, y: e.clientY };
      self._applyLookDelta(dx, dy);
      e.preventDefault();
    });
    function endLookPointer(e) {
      if (e.pointerId !== self._lookPointerId) return;
      self._lookPointerId = null;
      self._lookLast = null;
      self._dragging = false;
    }
    on(this._canvas, 'pointerup', endLookPointer);
    on(this._canvas, 'pointercancel', endLookPointer);

    this._setupMobileControls(on);
    if (this._isMobile) this._enableDragLook();

    this._resizeObs = new ResizeObserver(function () { self._resize(); });
    this._resizeObs.observe(this);
  }

  _detectMobile() {
    try {
      if (window.matchMedia('(pointer: coarse)').matches) return true;
      if (window.matchMedia('(hover: none)').matches && (navigator.maxTouchPoints || 0) > 0) return true;
    } catch (e) { /* ignore */ }
    return (navigator.maxTouchPoints || 0) > 0 &&
      Math.min(window.innerWidth || 0, window.innerHeight || 0) <= 900;
  }

  _applyLookDelta(dx, dy) {
    this._yaw -= dx * 0.0023;
    this._pitch -= dy * 0.0021;
    var lim = 1.45;
    if (this._pitch > lim) this._pitch = lim;
    if (this._pitch < -lim) this._pitch = -lim;
  }

  _setupMobileControls(on) {
    var self = this;
    if (!this._isMobile) return;

    this._el.mobile.style.display = 'block';
    this._el.mobile_settings.style.display = 'flex';
    this._el.hint.style.display = 'none';
    this._el.stats.style.bottom = '190px';
    this._el.stats.style.minWidth = '160px';
    this._el.popup.style.bottom = '200px';
    this._el.start_sub.textContent = 'tap to play \u00b7 stick move \u00b7 drag look \u00b7 jump & sprint';
    this._el.start_title.textContent = '\u25b6 TAP TO EXPLORE';
    this._applyHandedness();

    var zone = this._el.stick_zone;
    var knob = this._el.stick_knob;
    var maxR = 40;

    function setStickFromEvent(e) {
      var rect = zone.getBoundingClientRect();
      var cx = rect.left + rect.width * 0.5;
      var cy = rect.top + rect.height * 0.5;
      var dx = e.clientX - cx;
      var dy = e.clientY - cy;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var clamped = Math.min(len, maxR);
      var nx = (dx / len) * clamped;
      var ny = (dy / len) * clamped;
      knob.style.transform = 'translate(' + nx + 'px,' + ny + 'px)';
      self._stick.x = nx / maxR;
      self._stick.y = ny / maxR;
    }

    on(zone, 'pointerdown', function (e) {
      if (self._stickPointerId != null) return;
      self._stickPointerId = e.pointerId;
      try { zone.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      setStickFromEvent(e);
      e.preventDefault();
      e.stopPropagation();
    });
    on(zone, 'pointermove', function (e) {
      if (e.pointerId !== self._stickPointerId) return;
      setStickFromEvent(e);
      e.preventDefault();
    });
    function endStick(e) {
      if (e.pointerId !== self._stickPointerId) return;
      self._stickPointerId = null;
      self._resetStick();
    }
    on(zone, 'pointerup', endStick);
    on(zone, 'pointercancel', endStick);

    var sprint = this._el.btn_sprint;
    var jump = this._el.btn_jump;
    function setSprint(on) {
      self._mobileSprint = on;
      sprint.style.background = on ? 'rgba(143,216,255,.38)' : 'rgba(8,13,20,.55)';
      sprint.style.borderColor = on ? 'rgba(143,216,255,.65)' : 'rgba(255,255,255,.12)';
    }
    on(sprint, 'pointerdown', function (e) {
      setSprint(true);
      e.preventDefault();
      e.stopPropagation();
    });
    on(sprint, 'pointerup', function (e) { setSprint(false); e.preventDefault(); });
    on(sprint, 'pointercancel', function () { setSprint(false); });
    on(sprint, 'pointerleave', function (e) {
      if (e.buttons === 0) setSprint(false);
    });
    on(jump, 'pointerdown', function (e) {
      self._jump();
      jump.style.transform = 'scale(0.94)';
      e.preventDefault();
      e.stopPropagation();
    });
    on(jump, 'pointerup', function () { jump.style.transform = ''; });
    on(jump, 'pointercancel', function () { jump.style.transform = ''; });

    on(this._el.mobile_settings, 'click', function (e) {
      self._settingsOpen = !self._settingsOpen;
      self._el.mobile_panel.style.display = self._settingsOpen ? 'block' : 'none';
      e.stopPropagation();
    });
    on(this._el.handed_right, 'click', function (e) {
      self._setHandedness('right');
      e.stopPropagation();
    });
    on(this._el.handed_left, 'click', function (e) {
      self._setHandedness('left');
      e.stopPropagation();
    });
    on(this._el.mobile_panel, 'click', function (e) { e.stopPropagation(); });
    on(this._root, 'pointerdown', function (e) {
      if (!self._settingsOpen) return;
      if (e.target.closest && (e.target.closest('[data-mobile-panel]') || e.target.closest('[data-mobile-settings]'))) {
        return;
      }
      self._settingsOpen = false;
      self._el.mobile_panel.style.display = 'none';
    });
    on(this._el.popup, 'click', function (e) {
      self._tryDiscover();
      e.stopPropagation();
    });
  }

  _resetStick() {
    this._stick.x = 0;
    this._stick.y = 0;
    if (this._el.stick_knob) this._el.stick_knob.style.transform = 'translate(0px,0px)';
  }

  _setHandedness(handed) {
    if (handed !== 'left' && handed !== 'right') return;
    this._handed = handed;
    this._applyHandedness();
    try {
      localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify({ handed: handed }));
    } catch (e) { /* ignore */ }
  }

  _applyHandedness() {
    var left = this._handed === 'left';
    var stick = this._el.stick_zone;
    var actions = this._el.actions;
    stick.style.left = left ? 'auto' : '28px';
    stick.style.right = left ? '28px' : 'auto';
    actions.style.left = left ? '28px' : 'auto';
    actions.style.right = left ? 'auto' : '28px';

    var active = 'rgba(143,216,255,.22)';
    var activeBorder = 'rgba(143,216,255,.45)';
    var idle = 'rgba(8,13,20,.55)';
    var idleBorder = 'rgba(255,255,255,.12)';
    this._el.handed_right.style.background = left ? idle : active;
    this._el.handed_right.style.borderColor = left ? idleBorder : activeBorder;
    this._el.handed_left.style.background = left ? active : idle;
    this._el.handed_left.style.borderColor = left ? activeBorder : idleBorder;
  }

  _enableDragLook() {
    this._dragLook = true;
    if (this._isMobile) {
      this._el.hint.style.display = 'none';
    } else {
      this._el.hint.textContent = 'WASD move \u00b7 DRAG look \u00b7 SPACE double-jump \u00b7 SHIFT sprint \u00b7 E discover';
    }
    this._setLookActive(true);
  }

  _setLookActive(active) {
    this._el.start.style.display = active || this._loading ? 'none' : 'flex';
    this._el.cross.style.opacity = active ? '1' : '0';
  }

  _resize() {
    if (!this._renderer) return;
    var w = this.clientWidth || 1, h = this.clientHeight || 1;
    this._renderer.setPixelRatio(this._px);
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _chunkKey(cx, cz) { return cx + ',' + cz; }

  _updateChunks() {
    var cam = this._camera.position;
    var ccx = Math.floor(cam.x / CHUNK_SIZE);
    var ccz = Math.floor(cam.z / CHUNK_SIZE);
    if (ccx === this._ccx && ccz === this._ccz) return;
    this._ccx = ccx; this._ccz = ccz;

    var R = VIEW_RADIUS, R2 = R * R + 1;
    var want = [];
    for (var dz = -R; dz <= R; dz++) {
      for (var dx = -R; dx <= R; dx++) {
        var d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        var cx = ccx + dx, cz = ccz + dz;
        var key = this._chunkKey(cx, cz);
        if (!this._chunks.has(key) && !this._queued.has(key)) {
          want.push({ cx: cx, cz: cz, key: key, d2: d2 });
        }
      }
    }
    want.sort(function (a, b) { return a.d2 - b.d2; });
    for (var i = 0; i < want.length; i++) {
      this._queue.push(want[i]);
      this._queued.add(want[i].key);
    }

    var UR2 = UNLOAD_RADIUS * UNLOAD_RADIUS;
    var toRemove = [];
    this._chunks.forEach(function (chunk, key) {
      var ddx = chunk.cx - ccx, ddz = chunk.cz - ccz;
      if (ddx * ddx + ddz * ddz > UR2) toRemove.push(key);
    });
    for (var r = 0; r < toRemove.length; r++) {
      this._disposeChunk(this._chunks.get(toRemove[r]));
      this._chunks.delete(toRemove[r]);
    }
    var self = this;
    this._queue = this._queue.filter(function (q) {
      var ddx = q.cx - ccx, ddz = q.cz - ccz;
      if (ddx * ddx + ddz * ddz > UR2) { self._queued.delete(q.key); return false; }
      return true;
    });
  }

  _processQueue() {
    if (!this._treesReady || !this._rocksReady) {
      if (this._loading && this._el.loadtext) {
        this._el.loadtext.textContent = !this._treesReady
          ? 'loading tree models\u2026'
          : 'loading rock models\u2026';
      }
      return;
    }
    var budget = this._loading ? 5 : 1;
    while (budget-- > 0 && this._queue.length) {
      var q = this._queue.shift();
      this._queued.delete(q.key);
      if (!this._chunks.has(q.key)) {
        this._chunks.set(q.key, this._buildChunk(q.cx, q.cz));
        this._built++;
      }
    }
    if (this._loading) {
      var total = this._built + this._queue.length;
      var pct = total ? Math.round((this._built / total) * 100) : 0;
      this._el.loadbar.style.width = pct + '%';
      this._el.loadtext.textContent = 'generating terrain \u00b7 ' + pct + '%';
      if (!this._queue.length && this._built > 0) this._finishLoading();
    }
  }

  _finishLoading() {
    var self = this;
    this._loading = false;
    this._el.loading.style.opacity = '0';
    setTimeout(function () { self._el.loading.style.display = 'none'; }, 650);
    this._setLookActive(this._dragLook || document.pointerLockElement === this._canvas);
  }

  _buildChunk(cx, cz) {
    var chunk = buildChunkMesh(cx, cz, this._THREE, this._terrainMat);
    this._scene.add(chunk.mesh);
    var ctx = this._spawnCtx();
    spawnBeacon(chunk, ctx);
    spawnTrees(chunk, ctx);
    spawnRocks(chunk, ctx);
    return chunk;
  }

  _disposeChunk(chunk) {
    var self = this;
    this._scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    if (chunk.trees) {
      chunk.trees.forEach(function (inst) {
        self._scene.remove(inst);
        inst.dispose();
      });
    }
    if (chunk.rocks) {
      this._scene.remove(chunk.rocks);
      if (chunk.rocks.dispose) chunk.rocks.dispose();
    }
    chunk.beacons.forEach(function (b) {
      self._scene.remove(b.mesh);
      self._scene.remove(b.sprite);
      b.mesh.material.dispose();
      b.sprite.material.dispose();
      self._beacons.delete(b.id);
    });
  }

  _updateDayNight() {
    var dayT = (0.32 + this._time / DAY_LENGTH) % 1;
    this._dayT = dayT;
    var a = dayT * Math.PI * 2;
    var sunY = -Math.cos(a);
    var sunX = Math.sin(a) * 0.8;
    var day = sstep(-0.07, 0.22, sunY);
    this._day = day;
    var glow = Math.max(0, 1 - Math.abs(sunY) / 0.28) * 0.8;
    var night = 1 - sstep(-0.22, -0.02, sunY);

    this._sunVis.set(sunX, sunY, 0.35).normalize();
    if (sunY > -0.04) this._sunDir.set(sunX, Math.max(sunY, 0.06), 0.35).normalize();
    else this._sunDir.set(-sunX, Math.max(-sunY, 0.06), -0.3).normalize();

    function bl(nightC, dayC, duskC, i, ga) {
      var v = nightC[i] + (dayC[i] - nightC[i]) * day;
      return v + (duskC[i] - v) * ga;
    }
    var FOG_N = [0.04, 0.06, 0.11], FOG_D = FOG_COLOR, FOG_K = [0.82, 0.58, 0.45];
    var ZEN_N = [0.012, 0.02, 0.055], ZEN_D = SKY_ZENITH, ZEN_K = [0.28, 0.27, 0.47];
    var AMB_N = [0.085, 0.11, 0.19], AMB_D = [0.36, 0.41, 0.50], AMB_K = [0.30, 0.26, 0.30];
    var SUN_N = [0.10, 0.14, 0.24], SUN_D = [0.95, 0.88, 0.76], SUN_K = [1.0, 0.45, 0.24];
    this._fogColor.setRGB(bl(FOG_N, FOG_D, FOG_K, 0, glow), bl(FOG_N, FOG_D, FOG_K, 1, glow), bl(FOG_N, FOG_D, FOG_K, 2, glow));
    this._zenithCol.setRGB(bl(ZEN_N, ZEN_D, ZEN_K, 0, glow * 0.6), bl(ZEN_N, ZEN_D, ZEN_K, 1, glow * 0.6), bl(ZEN_N, ZEN_D, ZEN_K, 2, glow * 0.6));
    this._ambientCol.setRGB(bl(AMB_N, AMB_D, AMB_K, 0, glow * 0.5), bl(AMB_N, AMB_D, AMB_K, 1, glow * 0.5), bl(AMB_N, AMB_D, AMB_K, 2, glow * 0.5));
    var sg = glow * day;
    this._sunLightCol.setRGB(bl(SUN_N, SUN_D, SUN_K, 0, sg), bl(SUN_N, SUN_D, SUN_K, 1, sg), bl(SUN_N, SUN_D, SUN_K, 2, sg));
    this._lightI.value = 0.18 + 0.82 * day;
    this._nightI.value = night;

    this._ambLight.color.copy(this._ambientCol);
    this._ambLight.intensity = 0.22 + 0.48 * day;
    this._sunLight.color.copy(this._sunLightCol);
    this._sunLight.intensity = 0.12 + 1.15 * day;
  }

  _updateAtmosphere(dt) {
    var t = this._time;
    var cam = this._camera.position;

    /* Keep the shadow volume centered on the player so received shadows track movement.
       Snap to shadow-map texels to reduce swimming as the camera moves. */
    var lift = 40;
    var texel = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;
    var tx = Math.round(cam.x / texel) * texel;
    var tz = Math.round(cam.z / texel) * texel;

    this._sunLight.target.position.set(tx, cam.y, tz);
    this._sunLight.target.updateMatrixWorld();

    var reach = SHADOW_EXTENT * 0.85;
    this._sunLight.position.set(
      tx + this._sunDir.x * reach,
      cam.y + this._sunDir.y * reach + lift,
      tz + this._sunDir.z * reach
    );
    this._sunLight.updateMatrixWorld();

    var W = this._weather;
    if (t > W.gustUntil) { W.gustOn = !W.gustOn; W.gustUntil = t + 60 + Math.random() * 1140; }
    if (t > W.snowUntil) { W.snowOn = !W.snowOn; W.snowUntil = t + 60 + Math.random() * 1140; }
    W.gustLevel += ((W.gustOn ? 1 : 0) - W.gustLevel) * Math.min(1, dt * 0.3);
    W.snowLevel += ((W.snowOn ? 1 : 0) - W.snowLevel) * Math.min(1, dt * 0.12);

    var g = Math.min(1, Math.max(0, (vnoise(t * 0.35, 8.5) - 0.18) / 0.6));
    g = g * g * (3 - 2 * g);
    g = g * (0.08 + 0.92 * W.gustLevel);
    this._gust += (g - this._gust) * Math.min(1, dt * 1.5);
    var gust = this._gust;
    var wa = 0.9 + 0.3 * Math.sin(t * 0.05);
    var wx = Math.cos(wa), wz = Math.sin(wa);

    this._treeEnv.uTime.value = t;
    this._treeEnv.uGust.value = 0.15 + 1.8 * gust;

    var d = this._wind.data, a = this._wind.attr.array;
    var speed = 13 + 36 * gust;
    for (var i = 0; i < WIND_N; i++) {
      var o = i * 4, p6 = i * 6;
      var mul = 0.7 + d[o + 3] * 0.6;
      d[o] += wx * speed * dt * mul;
      d[o + 2] += wz * speed * dt * mul;
      d[o + 1] -= dt * 0.4;
      if (d[o] < cam.x - 60) d[o] += 120; else if (d[o] > cam.x + 60) d[o] -= 120;
      if (d[o + 2] < cam.z - 60) d[o + 2] += 120; else if (d[o + 2] > cam.z + 60) d[o + 2] -= 120;
      if (d[o + 1] < cam.y - 10) d[o + 1] += 26; else if (d[o + 1] > cam.y + 16) d[o + 1] -= 26;
      var len = 1.2 + 3.2 * gust * (0.5 + d[o + 3] * 0.5);
      a[p6] = d[o]; a[p6 + 1] = d[o + 1]; a[p6 + 2] = d[o + 2];
      a[p6 + 3] = d[o] + wx * len; a[p6 + 4] = d[o + 1]; a[p6 + 5] = d[o + 2] + wz * len;
    }
    this._wind.attr.needsUpdate = true;
    var wm = this._wind.line.material;
    wm.opacity += ((0.04 + 0.26 * gust) - wm.opacity) * Math.min(1, dt * 2);

    var sm = this._snow.pts.material;
    sm.color.setScalar(0.5 + 0.5 * this._day);
    var tgt = sstep(24, 32, this._groundH) * 0.85 * W.snowLevel;
    sm.opacity += (tgt - sm.opacity) * Math.min(1, dt * 1.6);
    if (sm.opacity < 0.02) {
      this._snow.pts.visible = false;
    } else {
      this._snow.pts.visible = true;
      var sp = this._snow.attr.array;
      var drift = 2 + 7 * gust;
      for (var j = 0; j < SNOW_N; j++) {
        var k = j * 3;
        sp[k + 1] -= (3.0 + (j % 9) * 0.4) * dt;
        sp[k] += wx * drift * dt + Math.sin(t * 1.3 + j) * dt * 0.6;
        sp[k + 2] += wz * drift * dt;
        if (sp[k + 1] < cam.y - 24) sp[k + 1] += 52;
        if (sp[k] < cam.x - 55) sp[k] += 110; else if (sp[k] > cam.x + 55) sp[k] -= 110;
        if (sp[k + 2] < cam.z - 55) sp[k + 2] += 110; else if (sp[k + 2] > cam.z + 55) sp[k + 2] -= 110;
      }
      this._snow.attr.needsUpdate = true;
    }
  }

  _updateBeacons(dt) {
    var cam = this._camera.position;
    var nearest = null, nearestD2 = 16 * 16;
    var t = this._time;
    this._beacons.forEach(function (b) {
      var dx = b.x - cam.x, dz = b.z - cam.z;
      var d2 = dx * dx + dz * dz;
      if (d2 < 90 * 90) {
        b.mesh.rotation.y += dt * 0.9;
        b.mesh.position.y = b.baseY + Math.sin(t * 1.5 + b.phase) * 0.5;
        b.sprite.position.y = b.mesh.position.y;
        b.mesh.material.uniforms.uTime.value = t;
      }
      if (d2 < nearestD2) { nearestD2 = d2; nearest = b; }
    });

    var popup = this._el.popup;
    if (nearest) {
      if (this._popupBeacon !== nearest) {
        this._el.popup_name.textContent = nearest.name;
        this._el.popup_lore.textContent = nearest.lore;
      }
      this._popupBeacon = nearest;
      this._el.popup_kicker.textContent = 'POINT OF INTEREST \u00b7 ' + Math.max(1, Math.round(Math.sqrt(nearestD2))) + 'm';
      this._el.popup_action.textContent = nearest.discovered
        ? '\u2713 DISCOVERED'
        : (this._isMobile ? 'TAP TO DISCOVER' : '[ E ] DISCOVER');
      this._el.popup_action.style.color = nearest.discovered ? 'rgba(255,255,255,.5)' : '#ffd86b';
      popup.style.opacity = '1';
      popup.style.transform = 'translate(-50%, 0)';
      popup.style.pointerEvents = this._isMobile && !nearest.discovered ? 'auto' : 'none';
      popup.style.cursor = this._isMobile && !nearest.discovered ? 'pointer' : 'default';
    } else {
      this._popupBeacon = null;
      popup.style.opacity = '0';
      popup.style.transform = 'translate(-50%, 10px)';
      popup.style.pointerEvents = 'none';
    }
  }

  _tryDiscover() {
    var b = this._popupBeacon;
    if (!b || b.discovered) return;
    b.discovered = true;
    b.mesh.material.uniforms.uDim.value = 1;
    b.sprite.material.opacity = 0.18;
    this._discovered.add(b.id);
    try { localStorage.setItem(LS_KEY, JSON.stringify(Array.from(this._discovered))); } catch (e) { /* ignore */ }
    this._el.disc.textContent = '\u25c6 ' + this._discovered.size + ' discovered';
    this._el.popup_action.textContent = '\u2713 DISCOVERED';
    this._el.popup_action.style.color = 'rgba(255,255,255,.5)';
  }

  _jump() {
    if (this._loading) return;
    if (!this._airborne) {
      this._airborne = true;
      this._vy = JUMP_V;
      this._jumps = 1;
    } else if (this._jumps < 2) {
      this._vy = JUMP_V * 0.95;
      this._jumps = 2;
    }
  }

  _updateMovement(dt) {
    var cam = this._camera.position;
    var fwd = (this._keys.w ? 1 : 0) - (this._keys.s ? 1 : 0) - this._stick.y;
    var str = (this._keys.d ? 1 : 0) - (this._keys.a ? 1 : 0) + this._stick.x;
    var mag = Math.sqrt(fwd * fwd + str * str);
    if (mag > 1) { fwd /= mag; str /= mag; }
    var yaw = this._yaw;
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    var rx = Math.cos(yaw), rz = -Math.sin(yaw);
    var wx = fx * fwd + rx * str, wz = fz * fwd + rz * str;
    var wl = Math.sqrt(wx * wx + wz * wz);
    var speed = (this._keys.shift || this._mobileSprint) ? SPRINT_SPEED : WALK_SPEED;
    if (wl > 0) {
      var ux = wx / wl, uz = wz / wl;
      var hAhead = terrainHeight(cam.x + ux * 3.5, cam.z + uz * 3.5);
      var slope = Math.max(0, (hAhead - this._groundH) / 3.5);
      var mul = 1 / (1 + slope * 1.4);
      var depth = SEA_LEVEL - this._groundH;
      if (depth > 0) mul *= 1 - 0.62 * sstep(0, 2.2, depth);
      if (this._airborne) mul = Math.max(mul, 0.75);
      speed *= mul;
      wx = ux * speed; wz = uz * speed;
    }

    var k = 1 - Math.exp(-7 * dt);
    this._vel.x += (wx - this._vel.x) * k;
    this._vel.z += (wz - this._vel.z) * k;

    cam.x += this._vel.x * dt;
    cam.z += this._vel.z * dt;
    this._resolveCollisions(cam);

    var ground = Math.max(terrainHeight(cam.x, cam.z), SEA_LEVEL - 0.4);
    this._groundH = ground;
    var targetY = ground + EYE_HEIGHT;
    if (this._airborne) {
      this._vy -= GRAVITY * dt;
      this._camY += this._vy * dt;
      if (this._camY <= targetY && this._vy <= 0) {
        this._camY = targetY;
        this._airborne = false;
        this._jumps = 0;
        this._vy = 0;
      }
    } else {
      this._camY += (targetY - this._camY) * (1 - Math.exp(-9 * dt));
    }
    cam.y = this._camY;

    this._camera.rotation.y = this._yaw;
    this._camera.rotation.x = this._pitch;
    this._speed = Math.sqrt(this._vel.x * this._vel.x + this._vel.z * this._vel.z);
  }

  _resolveCollisions(cam) {
    var PR = 0.5;
    var ccx = Math.floor(cam.x / CHUNK_SIZE), ccz = Math.floor(cam.z / CHUNK_SIZE);
    var feet = this._camY - EYE_HEIGHT;
    for (var dz = -1; dz <= 1; dz++) {
      for (var dx = -1; dx <= 1; dx++) {
        var ch = this._chunks.get(this._chunkKey(ccx + dx, ccz + dz));
        if (!ch || !ch.colliders.length) continue;
        for (var i = 0; i < ch.colliders.length; i++) {
          var c = ch.colliders[i];
          var ox = cam.x - c.x, oz = cam.z - c.z;
          var rr = c.r + PR;
          var d2 = ox * ox + oz * oz;
          if (d2 >= rr * rr || d2 < 1e-8) continue;
          if (feet > c.top - 0.4) continue;
          var dd = Math.sqrt(d2);
          var push = (rr - dd) / dd;
          cam.x += ox * push;
          cam.z += oz * push;
          var vn = (this._vel.x * ox + this._vel.z * oz) / dd;
          if (vn < 0) {
            this._vel.x -= vn * ox / dd;
            this._vel.z -= vn * oz / dd;
          }
        }
      }
    }
  }

  _updateHUD() {
    var cam = this._camera.position;
    this._el.pos.textContent = Math.round(cam.x) + ', ' + Math.round(cam.z);
    this._el.speed.textContent = this._speed.toFixed(1) + ' m/s';
    this._el.speedbar.style.width = Math.min(100, (this._speed / SPRINT_SPEED) * 100) + '%';
    var h = terrainHeight(cam.x, cam.z);
    this._el.biome.textContent = biomeName(h, terrainNormalY(cam.x, cam.z));
    this._el.disc.textContent = '\u25c6 ' + this._discovered.size + ' discovered';
    var mins = Math.floor(this._dayT * 1440);
    var hh = String(Math.floor(mins / 60)).padStart(2, '0');
    var mm = String(mins % 60).padStart(2, '0');
    this._el.clock.textContent = (this._day > 0.5 ? '\u2600\ufe0e' : '\u263d') + ' ' + hh + ':' + mm;
  }

  _redrawMinimapBase() {
    var N = this._mapN, s = this._mapScale, half = (N - 1) / 2;
    var cam = this._camera.position;
    var px = this._mapImg.data;
    var i = 0;
    for (var iz = 0; iz < N; iz++) {
      var wz = cam.z + (iz - half) * s;
      for (var ix = 0; ix < N; ix++) {
        mapColor(terrainHeight(cam.x + (ix - half) * s, wz), px, i);
        i += 4;
      }
    }
    this._mapOffCtx.putImageData(this._mapImg, 0, 0);
    this._mapCamX = cam.x; this._mapCamZ = cam.z;
  }

  _drawMinimap() {
    var ctx = this._mapCtx;
    var W = 168;
    var cam = this._camera.position;
    var wpp = (this._mapN * this._mapScale) / W;
    ctx.imageSmoothingEnabled = true;
    var ox = (this._mapCamX - cam.x) / wpp, oz = (this._mapCamZ - cam.z) / wpp;
    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, W, W);
    ctx.drawImage(this._mapOff, ox, oz, W, W);

    var self = this;
    this._beacons.forEach(function (b) {
      var dx = (b.x - cam.x) / wpp, dz = (b.z - cam.z) / wpp;
      if (dx * dx + dz * dz > 78 * 78) return;
      ctx.beginPath();
      ctx.arc(W / 2 + dx, W / 2 + dz, 3, 0, Math.PI * 2);
      ctx.fillStyle = b.discovered ? 'rgba(255,255,255,.45)' : '#ffd86b';
      ctx.fill();
    });

    ctx.save();
    ctx.translate(W / 2, W / 2);
    ctx.rotate(-this._yaw);
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 6.5);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5.5, 6.5);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  _updateFps(now) {
    this._fpsFrames++;
    if (now - this._fpsLast < 1000) return;
    this._fps = Math.round((this._fpsFrames * 1000) / (now - this._fpsLast));
    this._fpsFrames = 0;
    this._fpsLast = now;
    this._el.fps.textContent = this._fps + ' fps';
    if (this._fps < 52 && this._px > 0.8) {
      this._px = Math.max(0.8, this._px - 0.15);
      this._resize();
    } else if (this._fps > 58 && this._px < this._pxCap) {
      this._px = Math.min(this._pxCap, this._px + 0.1);
      this._resize();
    }
  }

  _tick(now) {
    this._raf = requestAnimationFrame(this._tick);
    var dt = Math.min((now - this._last) / 1000 || 0.016, 0.05);
    this._last = now;
    this._time += dt;

    this._updateMovement(dt);
    this._updateChunks();
    this._processQueue();
    this._updateBeacons(dt);

    var cam = this._camera.position;
    this._water.position.set(cam.x, SEA_LEVEL, cam.z);
    this._sky.position.copy(cam);
    updateFloorHeightmap(this._waterFloor, cam.x, cam.z);
    this._waterMat.uniforms.uFloorOrigin.value.set(this._waterFloor.originX, this._waterFloor.originZ);
    this._waterMat.uniforms.uTime.value = this._time;
    this._skyMat.uniforms.uTime.value = this._time;
    this._updateDayNight();
    this._updateAtmosphere(dt);

    if (now - this._hudLast > 100) { this._updateHUD(); this._hudLast = now; }
    if (now - this._mapLast > 280) { this._redrawMinimapBase(); this._mapLast = now; }
    this._drawMinimap();
    this._updateFps(now);

    this._renderer.render(this._scene, this._camera);
  }
}
