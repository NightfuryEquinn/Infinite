/* ============================================================================
   INFINITE — chunk-based infinite 3D world explorer
   Self-registering <infinite-world> web component.

   Module layout:
     config.js          — world constants
     noise.js           — deterministic hash noise
     terrain/           — height, shaders, chunk mesh, spawn
     biomes/            — biome names and minimap colors
     elements/          — trees, rocks, beacons, water, sky
     ui/hud.js          — overlay markup
     InfiniteWorld.js   — web component orchestration
   ========================================================================= */
import { InfiniteWorld } from './InfiniteWorld.js';

if (!customElements.get('infinite-world')) {
  customElements.define('infinite-world', InfiniteWorld);
}
