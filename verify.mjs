/**
 * Preflight for dsh-quote-shot: everything checkable before restarting DSH.
 */
import { existsSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = 'dsh-quote-shot';

function resolveProfile() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop');
}

const PROFILE = resolveProfile();
const linkPath = join(PROFILE, 'node_modules', PACKAGE_NAME);

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${detail}`}`);
  }
}

console.log(`profile: ${PROFILE}\n`);

console.log('package manifest');
const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
check('name is dsh-quote-shot', manifest.name === PACKAGE_NAME, manifest.name);
check('declares dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', String(manifest.dsh?.bundle?.patch));
check('declares dsh.client.platform=web', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform));
check('declares DSH compatibility', typeof manifest.dsh?.compatibility?.dsh === 'string', String(manifest.dsh?.compatibility?.dsh));
check('exports ./client', manifest.exports?.['./client'] === './client.js', String(manifest.exports?.['./client']));
check('bundle patch file exists', existsSync(join(HERE, manifest.dsh.bundle.patch)));

console.log('\nbundle patch');
{
  const lines = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8').split('\n');
  const insertIndex = lines.findIndex((line) => line.trim() === '- insert:');
  check('uses an insert row', insertIndex !== -1);
  check('no bare top-level id row', !lines.some((line) => /^- id:\s/.test(line)));
  const entry = lines.slice(insertIndex + 1, insertIndex + 3).join('\n');
  check('insert names the package', entry.includes(PACKAGE_NAME), entry.replace(/\s+/g, ' ').trim());
}

console.log('\nclient bundle');
{
  const src = readFileSync(join(HERE, 'client.js'), 'utf8');
  check('registers through __ModuleLoader__', src.includes('window.__ModuleLoader__.load('));
  check('bundle id matches the package', src.includes(`id: '${PACKAGE_NAME}'`), 'id mismatch');
  check('uses only react from the module table', !/require\(['"](?!react)/.test(src));
  check('targets the assistant action slot', src.includes('conversation.chat.assistant-actions'));
  check('shows cards in the composer dock', src.includes('conversation.input.dock'));
  check('calls the host injection route', src.includes('/quote-shot/inject'));
}

console.log('\nhost half');
{
  const src = readFileSync(join(HERE, 'index.js'), 'utf8');
  // Every service the plugin touches must be declared: Cordis only injects
  // declared services, and an undeclared one reads as undefined (that broke
  // every quote once). `agents` serves injection, `tools` registers quote_read.
  check(
    'declares webServer, agents and tools',
    src.includes("export const inject = ['webServer', 'agents', 'tools']"),
    src.match(/export const inject = \[[^\]]*\]/)?.[0]
  );
  check('guards against a missing registry', src.includes('agents-unavailable'));
  check('registers the inject route', src.includes("'/quote-shot/inject'"));
  check('injects a user message with a summary', src.includes('agent.inject(') && src.includes('summary'));
  check('registers the quote_read tool', src.includes("name: 'quote_read'"));
  check('reads messages from the session log', src.includes("from './session-reader.js'"));
}

console.log('\nprofile wiring');
{
  const profileManifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'));
  const bundles = profileManifest.dsh?.profile?.bundles ?? [];
  check('selected in dsh.profile.bundles', bundles.includes(PACKAGE_NAME), bundles.join(', '));
  check('shipped bundles preserved', bundles.includes('@deepseek-ai/dsh-base') && bundles.includes('@deepseek-ai/dsh-web-app'));
}
{
  let ok = false;
  try {
    ok = realpathSync(linkPath) === realpathSync(HERE);
  } catch {
    /* reported below */
  }
  check('node_modules link points at this checkout', ok);
}
{
  const require = createRequire(join(PROFILE, 'noop.js'));
  let resolved = null;
  try {
    resolved = require.resolve(`${PACKAGE_NAME}/package.json`);
  } catch {
    /* reported below */
  }
  check('package resolves from the profile', resolved !== null);
  // The client loader resolves `exports["./client"]`, so the subpath is
  // `<pkg>/client` — not `<pkg>/client.js`, which the exports map does not grant.
  let clientResolved = null;
  try {
    clientResolved = require.resolve(`${PACKAGE_NAME}/client`);
  } catch {
    /* reported below */
  }
  check('client bundle resolves', clientResolved !== null, String(clientResolved));
}

console.log(`\n${failed === 0 ? 'PREFLIGHT OK — safe to restart' : `${failed} CHECK(S) FAILED`}`);
process.exitCode = failed === 0 ? 0 : 1;
