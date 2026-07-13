/* Shared world / engine constants */

export var CHUNK_SIZE = 64;
export var TREE_HEIGHT_SCALE = 1.8;
export var CHUNK_RES = 36;
export var VIEW_RADIUS = 6;
export var UNLOAD_RADIUS = 5.6;
export var SEA_LEVEL = 0;
export var EYE_HEIGHT = 5;
export var WALK_SPEED = 16;
export var SPRINT_SPEED = 34;
export var GRAVITY = 32;
export var JUMP_V = 13;
export var DAY_LENGTH = 180;
export var SNOW_N = 650;
export var WIND_N = 70;
export var FOG_NEAR = 110;
export var FOG_FAR = 250;
export var FOG_COLOR = [0.80, 0.85, 0.90];
export var SKY_ZENITH = [0.34, 0.50, 0.76];
export var SUN = (function () {
  var x = 0.55, y = 0.52, z = 0.30, l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
})();
export var LS_KEY = 'infinite-explorer-discovered-v1';
