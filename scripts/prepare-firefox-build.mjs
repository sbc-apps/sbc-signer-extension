import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const chromeDist = path.join(root, 'dist', 'chrome');
const firefoxDist = path.join(root, 'dist', 'firefox');
const manifestPath = path.join(firefoxDist, 'manifest.json');

if (!existsSync(path.join(chromeDist, 'manifest.json'))) {
  throw new Error('Missing dist/chrome/manifest.json. Run `npm run build:chrome` before preparing Firefox output.');
}

rmSync(firefoxDist, { recursive: true, force: true });
mkdirSync(firefoxDist, { recursive: true });
cpSync(chromeDist, firefoxDist, { recursive: true });

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function resolveContentScript(loaderPath) {
  const loaderSource = readFileSync(path.join(firefoxDist, loaderPath), 'utf8');
  const relativeMatch = loaderSource.match(/import\(\s*\/\* @vite-ignore \*\/\s*["']\.\/(.+?)["']\s*\)/s);
  if (relativeMatch) return path.join(path.dirname(loaderPath), relativeMatch[1]).replaceAll(path.sep, '/');

  const runtimeMatch = loaderSource.match(/chrome\.runtime\.getURL\(["'](.+?)["']\)/s);
  if (runtimeMatch) return runtimeMatch[1];

  throw new Error(`Unable to resolve content script loader target: ${loaderPath}`);
}

manifest.background = {
  scripts: [manifest.background.service_worker],
  type: 'module',
};

for (const script of manifest.content_scripts ?? []) {
  script.js = script.js.map((scriptPath) => (
    scriptPath.endsWith('-loader.js') ? resolveContentScript(scriptPath) : scriptPath
  ));
}

manifest.browser_specific_settings = {
  gecko: {
    id: 'sbc-signer-extension@extensions.local',
    strict_min_version: '128.0',
    data_collection_permissions: {
      required: ['none'],
    },
  },
};

for (const resource of manifest.web_accessible_resources ?? []) {
  delete resource.use_dynamic_url;
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log('Firefox extension prepared in dist/firefox/');
