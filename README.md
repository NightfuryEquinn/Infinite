# Infinite

Chunk-based infinite 3D world explorer built with **React**, **Three.js**, and **Bun**.

Explore procedurally generated terrain with day/night cycles, weather, points of interest, and a full HUD — all rendered in the browser via WebGL.

## Stack

| Package | Role |
|---------|------|
| [Bun](https://bun.sh) | Package manager and runtime |
| [Vite](https://vite.dev) | Dev server and production build |
| [React 19](https://react.dev) | UI shell |
| [Three.js](https://threejs.org) | WebGL rendering (terrain, water, sky, instanced nature) |
| [@react-three/fiber](https://docs.pmnd.rs/react-three-fiber) | React renderer for Three.js (available for extending the scene) |
| [@react-three/drei](https://github.com/pmndrs/drei) | Useful R3F helpers and abstractions |

The core world engine lives in `src/engine/engine.js` as a self-registering `<infinite-world>` web component. React mounts it full-screen; the engine manages its own renderer, chunk streaming, physics, and HUD.

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

### Mobile

| Control | Action |
|---------|--------|
| **Virtual stick** | Move |
| **Drag** (on world) | Look |
| **Jump** button | Jump / double-jump |
| **Sprint** button | Hold to sprint |
| **⚙** settings | Left- or right-handed layout |


## Project layout

```
src/
├── App.tsx                 # Root React component
├── components/
│   └── InfiniteWorld.tsx   # Mounts the <infinite-world> custom element
└── engine/
    └── engine.js           # Three.js world engine (chunks, shaders, HUD)
```

## License

See [LICENSE](LICENSE).
