#!/usr/bin/env node
/**
 * Fallback installer for a locally cloned copy of dsh-balance-badge.
 *
 * WHY THIS EXISTS
 * DSH's own plugin manager (the Plugins page in the app, or the `plugin_manager`
 * agent tool) is the sanctioned way to install a bundle: it registers the
 * package in the profile, links it into the profile's node_modules and applies
 * the bundle patch. Use that first. This script reproduces exactly those steps
 * for the case where the plugin manager is not reachable — for example an older
 * build, or a headless `dsh` CLI that refuses to manage a profile the desktop
 * app owns.
 *
 * It is deliberately dependency-free and reversible: it backs the profile
 * manifest up before touching it, only ever replaces a symlink (never a real
 * directory), and `--uninstall` undoes both edits.
 *
 *   node scripts/install.mjs                     # install into the active profile
 *   node scripts/install.mjs --profile=web       # target a specific profile
 *   node scripts/install.mjs --dry-run           # print the plan, change nothing
 *   node scripts/install.mjs --uninstall         # remove it again
 *
 * On macOS the profile it wants lives at ~/.dsh/profiles/<name> unless
 * $DSH_HOME says otherwise; on Windows it is %USERPROFILE%\.dsh\profiles\<name>.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const PACKAGE_NAME = MANIFEST.name
/** Loader row id from cordis.patch.yml; kept in step with that file. */
const ROW_ID = 'deepseek-balance'

const flags = process.argv.slice(2)
const dryRun = flags.includes('--dry-run')
const uninstall = flags.includes('--uninstall')
const profileArg = flags.find((value) => value.startsWith('--profile='))
const requestedProfile = profileArg === undefined ? process.env.DSH_PROFILE : profileArg.slice('--profile='.length)

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function dshHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Pick the profile to install into: the one explicitly asked for, else the one
 * this process was launched under ($DSH_PROFILE), else the first of the shipped
 * profile names that exists. Guessing between desktop and web is safe here only
 * because the choice is printed and can be overridden with --profile.
 */
function findProfile() {
  const home = dshHome()
  const candidates = []
  if (requestedProfile !== undefined && requestedProfile !== '') candidates.push(requestedProfile)
  for (const name of ['desktop', 'web']) if (!candidates.includes(name)) candidates.push(name)

  const found = candidates
    .map((name) => ({ name, dir: join(home, 'profiles', name), manifest: join(home, 'profiles', name, 'package.json') }))
    .filter((candidate) => existsSync(candidate.manifest))

  if (found.length === 0) {
    // A dry run is a plan, not a promise that DSH is installed here. CI runners
    // and contributor machines have no profile, and a dry run that exited
    // non-zero there would fail the check for the wrong reason.
    if (dryRun) {
      console.log(`no DSH profile under ${join(home, 'profiles')} (looked for: ${candidates.join(', ')})`)
      console.log('Dry run: nothing to plan on this machine.')
      process.exit(0)
    }
    fail(
      `no DSH profile with a package.json under ${join(home, 'profiles')}\n` +
        `       looked for: ${candidates.join(', ')}\n` +
        `       pass --profile=<name> or set $DSH_HOME if DSH lives elsewhere.`,
    )
  }
  return found[0]
}

/** Where the profile's node_modules entry for this package must point. */
function linkPathFor(profile) {
  const parts = PACKAGE_NAME.startsWith('@') ? PACKAGE_NAME.split('/') : [PACKAGE_NAME]
  return join(profile.dir, 'node_modules', ...parts)
}

/**
 * Create (or refresh) the node_modules entry.
 *
 * A junction on Windows and a directory symlink elsewhere: both resolve to the
 * working copy, so editing the clone is enough for the browser half, and both
 * are removed with the link alone. An existing real directory is never deleted —
 * that would be somebody else's install.
 */
function ensureLink(linkPath) {
  if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined) {
    const stat = lstatSync(linkPath)
    if (!stat.isSymbolicLink()) {
      fail(`${linkPath} exists and is not a symlink; refusing to replace it`)
    }
    if (!dryRun) rmSync(linkPath, { force: true })
    console.log(`  ${dryRun ? 'would replace' : 'replaced'} existing link ${linkPath}`)
  }
  if (dryRun) {
    console.log(`  would link ${linkPath} -> ${PACKAGE_DIR}`)
    return
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(PACKAGE_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`  linked ${linkPath} -> ${PACKAGE_DIR}`)
}

function backupOnce(manifestPath) {
  const backup = `${manifestPath}.before-${PACKAGE_NAME.replace(/[^a-z0-9]+/gi, '-')}`
  if (existsSync(backup)) return backup
  if (!dryRun) renameSync(manifestPath, backup)
  return backup
}

function writeManifest(manifestPath, document) {
  if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`)
}

const profile = findProfile()
console.log(`${uninstall ? 'Uninstalling' : 'Installing'} ${PACKAGE_NAME}`)
console.log(`  profile: ${profile.name} (${profile.dir})`)
console.log(`  package: ${PACKAGE_DIR}`)

const document = JSON.parse(readFileSync(profile.manifest, 'utf8'))
const linkPath = linkPathFor(profile)

if (uninstall) {
  if (document.dependencies !== undefined) {
    delete document.dependencies[PACKAGE_NAME]
    if (Object.keys(document.dependencies).length === 0) delete document.dependencies
  }
  const bundles = document.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    document.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE_NAME)
  }
  backupOnce(profile.manifest)
  writeManifest(profile.manifest, document)
  console.log(`  ${dryRun ? 'would remove' : 'removed'} manifest entries`)
  if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined) {
    if (lstatSync(linkPath).isSymbolicLink()) {
      if (!dryRun) rmSync(linkPath, { force: true })
      console.log(`  ${dryRun ? 'would remove' : 'removed'} link ${linkPath}`)
    } else {
      console.log(`  left ${linkPath} alone (not a symlink)`)
    }
  }
} else {
  // A `link:` dependency keeps the profile pointing at this working copy, which
  // is what makes `git pull` in the clone the upgrade path.
  const spec = `link:${PACKAGE_DIR.replace(/\\/g, '/')}`
  document.dependencies = { ...(document.dependencies ?? {}), [PACKAGE_NAME]: spec }
  const dsh = document.dsh ?? {}
  const profileSection = dsh.profile ?? {}
  const bundles = Array.isArray(profileSection.bundles) ? [...profileSection.bundles] : []
  if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
  document.dsh = { ...dsh, profile: { ...profileSection, bundles } }

  // Link before touching the manifest. The loader picks a new bundle up as soon
  // as the manifest names it, and DSH's client-module registry resolves the
  // package through exactly this node_modules entry. Naming the bundle first
  // leaves a window where it is declared but unresolvable, and the registry
  // keeps that failure until something else forces a recomposition — the client
  // half then silently never loads.
  ensureLink(linkPath)
  backupOnce(profile.manifest)
  writeManifest(profile.manifest, document)
  console.log(`  ${dryRun ? 'would add' : 'added'} ${PACKAGE_NAME} -> ${spec}`)
  console.log(`  ${dryRun ? 'would add' : 'added'} bundle row (plugin row id ${ROW_ID})`)
}

if (dryRun) {
  console.log('\nDry run: nothing was changed.')
} else {
  console.log('\nNext:')
  console.log('  1. Restart the DSH app (desktop) or the `dsh web` process.')
  console.log('  2. Reload the page (the browser half is re-read on every request).')
  console.log('  3. Confirm the Host route answers:')
  console.log("     curl -s http://127.0.0.1:19387/deepseek-balance/summary | head -c 400")
  console.log(`\nUndo with: node ${join(PACKAGE_DIR, 'scripts', 'install.mjs')} --uninstall`)
}
