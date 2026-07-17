import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const assimpFactory = require('assimpjs');
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const assetsDir = resolve(projectRoot, 'src', 'assets');

const conversions = [
  { source: 'birch_tree.blend', output: 'birch_tree.glb' },
  { source: 'rock.blend', output: 'rock.glb' }
];

// Converts one source model to a self-contained binary glTF asset.
function convertAsset(assimp, sourceName, sourceData) {
  const files = new assimp.FileList();
  files.AddFile(sourceName, sourceData);

  const result = assimp.ConvertFileList(files, 'glb2');

  if (!result.IsSuccess() || result.FileCount() === 0) {
    throw new Error(`${sourceName} conversion failed: ${result.GetErrorCode()}`);
  }

  return result.GetFile(0).GetContent();
}

// Prebakes all runtime models so browsers never initialize assimp WASM.
async function prebakeAssets() {
  const assimp = await assimpFactory();
  await mkdir(assetsDir, { recursive: true });

  for (const conversion of conversions) {
    const sourcePath = resolve(assetsDir, conversion.source);
    const outputPath = resolve(assetsDir, conversion.output);
    const source = await readFile(sourcePath);
    const glb = convertAsset(assimp, conversion.source, source);

    await writeFile(outputPath, glb);
    console.log(`Prebaked ${conversion.source} -> ${conversion.output} (${glb.byteLength} bytes)`);
  }
}

await prebakeAssets();
