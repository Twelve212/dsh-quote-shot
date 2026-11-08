/**
 * Install dsh-quote-shot into the desktop DSH profile.
 *
 * Links the workspace package into the profile (so edits here take effect
 * without re-copying) and selects it in `dsh.profile.bundles`.
 *
 * Usage:
 *   node install.mjs            install / refresh
 *   node install.mjs --status   report only
 *   node install.mjs --uninstall
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = 'dsh-quote-shot';

function resolveProfile() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop');
}

const PROFILE = resolveProfile();
const linkPath = join(PROFILE, 'node_modules', PACKAGE_NAME);
const manifestPath = join(PROFILE, 'package.json');
const mode = process.argv.includes('--status') ? 'status' : process.argv.includes('--uninstall') ? 'uninstall' : 'install';

function report(label, detail) {
  console.log(`${label.padEnd(10)} ${detail}`);
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { name: 'dsh-profile-desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  }
}

function lstatExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function install() {
  if (!existsSync(PROFILE)) {
    console.error(`profile not found: ${PROFILE}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(join(PROFILE, 'node_modules'), { recursive: true });
  if (lstatExists(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(HERE, linkPath, 'junction');
  report('link', `${linkPath} -> ${HERE}`);

  const manifest = readManifest();
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles ??= [];
  if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) manifest.dsh.profile.bundles.push(PACKAGE_NAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, void 0, 2)}\n`);
  report('bundles', manifest.dsh.profile.bundles.join(', '));
  console.log('\nDone. Restart the DSH desktop app to load the plugin.');
}

function uninstall() {
  const manifest = readManifest();
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  if (bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, void 0, 2)}\n`);
    report('bundles', `removed (${manifest.dsh.profile.bundles.length} left)`);
  } else {
    report('bundles', 'not selected');
  }
  if (lstatExists(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  report('link', 'removed');
  console.log('\nRestart the DSH desktop app to unload the plugin.');
}

function status() {
  report('profile', PROFILE);
  let linked = 'missing';
  try {
    linked = lstatSync(linkPath).isSymbolicLink() ? `-> ${HERE}` : 'present but not a link';
  } catch {
    /* stays missing */
  }
  report('link', linked);
  const bundles = readManifest().dsh?.profile?.bundles ?? [];
  report('bundles', bundles.includes(PACKAGE_NAME) ? 'selected' : 'NOT selected');
}

if (mode === 'install') install();
else if (mode === 'uninstall') uninstall();
else status();
