// Builds the licensing module twice: the shipped build (the embedded vendor key) and the
// test build (the published test key, plus signing for tests). Separate target
// directories so neither build's features leak into the other's cache.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/*
  Windows locks a loaded DLL, and a `.node` file is one. While an API dev server or a
  test run has the module loaded, overwriting it fails — which used to fail `pnpm lint`
  and `pnpm typecheck` too, since turbo builds this package first. An unchanged artefact
  therefore is not copied at all; a changed one that cannot be written says what is
  holding it rather than printing EBUSY.
*/
function install(label, source, output) {
  const target = join(HERE, output);
  if (existsSync(target) && digest(source) === digest(target)) {
    console.log(`license-native: ${label} → ${output} unchanged`);
    return;
  }
  try {
    copyFileSync(source, target);
  } catch (error) {
    if (error && (error.code === 'EBUSY' || error.code === 'EPERM')) {
      console.error(
        `license-native: ${output} changed but is in use — stop the API dev server or test run that has it loaded, then build again`,
      );
      process.exit(1);
    }
    throw error;
  }
  console.log(`license-native: ${label} → ${output} (${(statSync(target).size / 1024).toFixed(0)} KB)`);
}

function build(label, targetDir, features, output) {
  const args = ['build', '--release', '--manifest-path', join(HERE, 'Cargo.toml'), '--target-dir', join(HERE, targetDir)];
  if (features) args.push('--features', features);
  const result = spawnSync('cargo', args, { stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    console.error(`license-native: ${label} build failed`);
    process.exit(result.status ?? 1);
  }
  install(label, join(HERE, targetDir, 'release', 'walaa_license_node.dll'), output);
}

build('shipped build', 'target', null, 'walaa-license.node');
build('test build', 'target-test', 'test-key', 'walaa-license.test.node');
