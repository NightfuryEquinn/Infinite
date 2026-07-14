# Infinite

Chunk-based infinite 3D world explorer built with **React**, **Three.js**, and **Bun**.

Explore procedurally generated terrain with day/night cycles, weather, points of interest, ambient music, and a full HUD — all rendered in the browser via WebGL.

## Stack

| Package | Role |
|---------|------|
| [Bun](https://bun.sh) | Package manager and runtime |
| [Vite](https://vite.dev) | Dev server and production build |
| [React 19](https://react.dev) | UI shell |
| [Three.js](https://threejs.org) | WebGL rendering (terrain, water, sky, instanced nature) |
| [Howler.js](https://howlerjs.com) | Background music playback |
| [assimpjs](https://github.com/makediff/assimpjs) | Loading `.blend` / `.3ds` assets (trees, rocks) |
| [@react-three/fiber](https://docs.pmnd.rs/react-three-fiber) | React renderer for Three.js (available for extending the scene) |
| [@react-three/drei](https://docs.pmnd.rs/drei) | Useful R3F helpers and abstractions |

The core world engine lives in `src/engine/` as a self-registering `<infinite-world>` web component. React mounts it full-screen; the engine manages its own renderer, chunk streaming, physics, HUD, and audio.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0

## Getting started

```bash
# Install dependencies
bun install

# Start the dev server (http://localhost:5173)
bun run dev

# Production build
bun run build

# Preview the production build
bun run preview
```

## Controls

| Input | Action |
|-------|--------|
| **WASD** / Arrow keys | Move |
| **Mouse** | Look (click to capture pointer) |
| **Space** | Jump / double-jump |
| **Shift** | Sprint |
| **E** | Discover nearby point of interest |
| **♪** music button | Toggle background music |

### Mobile

| Control | Action |
|---------|--------|
| **Virtual stick** | Move |
| **Drag** (on world) | Look |
| **Jump** button | Jump / double-jump |
| **Sprint** button | Hold to sprint |
| **⚙** settings | Left- or right-handed layout |
| **♪** music button | Toggle background music |

## Music

Background track: **“A Drifting Lens”** by [Amos Roddy](https://amosroddy.bandcamp.com/).

Used for ambient background only. Mute or unmute anytime with the music button (top center, beside settings on mobile). Preference is saved locally.

## Project layout

```
src/
├── App.tsx
├── components/
│   └── InfiniteWorld.tsx      # Mounts <infinite-world>
├── assets/                    # Textures, models, music
└── engine/
    ├── engine.js              # Registers the custom element
    ├── InfiniteWorld.js       # Orchestration (chunks, input, audio)
    ├── config.js              # World constants
    ├── noise.js               # Deterministic hash noise
    ├── biomes/                # Biome names and minimap colors
    ├── terrain/               # Height, shaders, chunks, spawn
    ├── elements/              # Trees, rocks, beacons, water, sky
    └── ui/
        └── hud.js             # Overlay markup (loading, HUD, controls)
```

## License

See [LICENSE](LICENSE).
