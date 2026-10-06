// End-to-end smoke test for scripts/install.mjs.
//
// The installer is the one place in this repository with an OS branch: a
// directory junction on Windows, a directory symlink everywhere else. `--dry-run`
// deliberately does not take that branch, so a dry run alone would leave the
// code your Mac will actually execute unexercised. This test builds a throwaway
// DSH home, installs into it for real, and asserts the link is a link and that
// the package is reachable through it.
//
// Run it directly (`node test/install-smoke.mjs`); it is not part of `npm test`
// because it spawns a child process, which some sandboxed environments refuse.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER = join(PACKAGE_DIR, 'scripts', 'install.mjs')
const PACKAGE_NAME = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).name
const BACKUP = `${'package.json'}.before-${PACKAGE_NAME.replace(/[^a-z0-9]+/gi, '-')}`

const root = mkdtempSync(join(tmpdir(), 'dsh-install-smoke-'))
const home = join(root, 'dsh-home')
const profileDir = join(home, 'profiles', 'desktop')
const manifestPath = join(profileDir, 'package.json')
// The package name is unscoped, so the link sits directly under node_modules.
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)

const run = (args) =>
  spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'desktop' },
  })

const manifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'))

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${label}: ${error.message}`)
  }
}

try {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      { name: 'smoke-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } },
      null,
      2,
    )}\n`,
  )

  const before = manifest()

  console.log('dry run')
  const dry = run(['--dry-run'])
  check('exits 0', () => assert.equal(dry.status, 0, dry.stderr))
  check('creates no link', () => assert.equal(existsSync(linkPath), false))
  check('leaves the manifest untouched', () => assert.deepEqual(manifest(), before))

  console.log('install')
  const install = run([])
  check('exits 0', () => assert.equal(install.status, 0, install.stderr))
  check('writes a link: dependency', () => {
    const spec = manifest().dependencies?.[PACKAGE_NAME]
    assert.ok(typeof spec === 'string' && spec.startsWith('link:'), `got ${spec}`)
  })
  check('adds the bundle row', () => assert.ok(manifest().dsh.profile.bundles.includes(PACKAGE_NAME)))
  check('refuses to copy: the entry is a link', () => assert.equal(lstatSync(linkPath).isSymbolicLink(), true))
  check('the link resolves the package', () =>
    assert.equal(JSON.parse(readFileSync(join(linkPath, 'package.json'), 'utf8')).name, PACKAGE_NAME))
  check('backs the manifest up first', () => assert.equal(existsSync(join(profileDir, BACKUP)), true))
  check('keeps the pre-existing bundle rows', () =>
    assert.ok(manifest().dsh.profile.bundles.includes('@deepseek-ai/dsh-base')))

  console.log('reinstall (must be idempotent)')
  const again = run([])
  check('exits 0', () => assert.equal(again.status, 0, again.stderr))
  check('does not duplicate the bundle row', () =>
    assert.equal(manifest().dsh.profile.bundles.filter((entry) => entry === PACKAGE_NAME).length, 1))

  console.log('uninstall')
  const uninstall = run(['--uninstall'])
  check('exits 0', () => assert.equal(uninstall.status, 0, uninstall.stderr))
  check('drops the dependency', () => assert.equal(manifest().dependencies, undefined))
  check('drops the bundle row', () => assert.ok(!manifest().dsh.profile.bundles.includes(PACKAGE_NAME)))
  check('removes the link', () => assert.equal(existsSync(linkPath), false))
  check('never touches the package itself', () => assert.equal(existsSync(join(PACKAGE_DIR, 'index.js')), true))
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\ninstall smoke: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ninstall smoke: OK')
