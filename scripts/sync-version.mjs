/**
 * Keeps `src/manifest.json`'s `version` in lock-step with `package.json`,
 * which is the single source of truth for the extension version.
 *
 *   node scripts/sync-version.mjs          # write package.json version into the manifest
 *   node scripts/sync-version.mjs --check  # exit non-zero if they differ (used in CI)
 *
 * Runs automatically from the `version` npm lifecycle hook, so
 * `npm version patch|minor|major` bumps both files in one commit.
 *
 * Browsers only accept 1–4 dot-separated integers (0–65535) as an
 * extension version, so semver pre-release/build suffixes such as
 * `1.5.0-beta.1` are rejected here rather than at store-upload time.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packagePath = path.join(root, 'package.json');
const manifestPath = path.join(root, 'src', 'manifest.json');

const { version } = JSON.parse(readFileSync(packagePath, 'utf8'));

const parts = typeof version === 'string' ? version.split('.') : [];
const isValid =
  parts.length === 3 &&
  parts.every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 65535);

if (!isValid) {
  console.error(
    `Invalid version "${version}" in package.json. Use MAJOR.MINOR.PATCH with plain integers (0–65535), e.g. 1.4.0.`,
  );
  process.exit(1);
}

const manifestSource = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestSource);

if (manifest.version === version) {
  console.log(`Version ${version} is in sync.`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  console.error(
    `Version mismatch: package.json is ${version} but src/manifest.json is ${manifest.version}. Run \`node scripts/sync-version.mjs\`.`,
  );
  process.exit(1);
}

// Replace only the top-level "version" value so the manifest's existing
// formatting and key order are preserved byte-for-byte otherwise.
const updated = manifestSource.replace(
  /("version"\s*:\s*)"[^"]*"/,
  `$1${JSON.stringify(version)}`,
);
if (JSON.parse(updated).version !== version) {
  console.error('Failed to update the version in src/manifest.json.');
  process.exit(1);
}
writeFileSync(manifestPath, updated);
console.log(`Updated src/manifest.json version: ${manifest.version} → ${version}`);
