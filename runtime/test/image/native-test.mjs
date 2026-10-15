#!/usr/bin/env node
// Installed qualification on the exact image, then normal authenticated daemon
// fixture operations and ENOSYS regressions. No model or backend credentials.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
assert.equal(args.length, 2, 'Usage: native-test.mjs --image <candidate>'); assert.equal(args[0], '--image')
const image = args[1], name = `gc-native-image-${crypto.randomBytes(8).toString('hex')}`, runtime = '/opt/geocluster-runtime'
let started = false
const repo = fileURLToPath(new URL('../../../', import.meta.url))
function docker(argv, timeout = 360000, expectedExit = 0) {
	const result = spawnSync('docker', argv, { encoding: 'utf8', timeout, maxBuffer: 4 * 1048576 })
	if (result.status !== expectedExit) throw new Error(`Docker qualification failed (${result.status}, expected ${expectedExit}): ${result.stdout || ''}${result.stderr || ''}`)
	return result.stdout
}
function report(output) { const r = JSON.parse(output); assert.ok(r && typeof r === 'object'); return r }
try {
	docker(['pull', image], 600000)
} catch (cause) {
	// Local tags are useful for development; absence locally still fails closed.
	docker(['image', 'inspect', image]); if (image.includes('@')) throw cause
}
try {
	const noLandlock = report(docker(['run', '--rm', '--network', 'none', '--security-opt', `seccomp=${path.join(repo, 'runtime/test/image/landlock-disabled.seccomp.json')}`,
		'--entrypoint', 'gosu', image, 'gc-files', 'node', `${runtime}/scripts/qualify-native-readers.mjs`], 140000))
	for (const id of ['gis', 'workbook']) { assert.equal(noLandlock[id]?.state, 'available'); assert.equal(noLandlock[id].confinement, 'verified') }
	console.log('PASS native readers decode and verify confinement without Landlock')
	docker(['run', '-d', '--name', name, '--network', 'none', '--memory', '4g', '--cpus', '2',
		'-e', 'PROJECT_ID=native-qualification', '-e', 'USER_ID=qualification', '-e', `IDE_PROXY_KEY=${crypto.randomBytes(32).toString('hex')}`,
		'-e', 'LLM_PROXY_URL=http://127.0.0.1:9/v1', '-e', 'IDE_LLM_TOKEN=qualification-no-model-authority',
		'-e', 'SYNC_ENABLED=false', '-e', 'FILES_SYNC_ADAPTER=false', '-e', 'OWNED_DEMO_ENABLED=false', '-e', 'PREPROCESSING_ENABLED=false', '-e', 'RUNTIME_AGGREGATE_ACTIVITY=false',
		'-e', 'FILES_GIS_WORKER_ENABLED=true', '-e', 'FILES_WORKBOOK_WORKER_ENABLED=true', image])
	started = true
	const native = report(docker(['exec', name, 'gosu', 'gc-files', 'node', `${runtime}/scripts/qualify-native-readers.mjs`], 140000))
	for (const id of ['gis', 'workbook']) { assert.equal(native[id]?.state, 'available'); assert.equal(native[id].confinement, 'verified') }
	console.log('PASS installed native qualification', JSON.stringify(native))
	const files = report(docker(['exec', name, 'node', `${runtime}/scripts/qualify-workspace-files.mjs`]))
	assert.equal(files.ok, true)
	console.log('PASS authenticated daemon and three-point CSV/XLS/XLSX fixtures', JSON.stringify(files.fixtures))
	const repeated = report(docker(['exec', name, 'node', `${runtime}/scripts/qualify-workspace-files.mjs`]))
	assert.equal(repeated.ok, true)
	assert.deepEqual(repeated.fixtures, files.fixtures)
	console.log('PASS repeated qualification on the retained workspace')
	{
		const profile = `seccomp=${path.join(repo, 'runtime/lib/gis-launcher/kernel-unavailable.seccomp.json')}`
		const denied = report(docker(['run', '--rm', '--network', 'none', '--security-opt', profile,
			'--entrypoint', 'gosu', image, 'gc-files', 'node', `${runtime}/scripts/qualify-native-readers.mjs`], 140000, 1))
		for (const id of ['gis', 'workbook']) { assert.equal(denied[id].state, 'unavailable'); assert.match(denied[id].diagnostic, /stage=chroot-installation.*errno=38/) }
		const bootstrap = `const fs = require('node:fs'), { execFileSync } = require('node:child_process');
fs.mkdirSync('/workspace/native-tests', { mode: 0o700 }); fs.chownSync('/workspace/native-tests', 998, 999);
const output = execFileSync('gosu', ['gc-files', 'node', '--test', '--test-name-pattern=chroot installation|chroot is unavailable|installed native providers', 'test/gis-reader.test.mjs', 'lib/workbook-launcher/launcher.test.mjs', 'test/native-provider-unavailable.test.mjs'], { cwd: '${runtime}', env: { ...process.env, GIS_EXPECT_UNAVAILABLE: 'true', GIS_INSTALLED_LAUNCHER: '${runtime}/gis-launcher', WORKBOOK_EXPECT_UNAVAILABLE: 'true', WORKBOOK_INSTALLED_LAUNCHER: '${runtime}/workbook-launcher', FILES_TEST_PARENT: '/workspace/native-tests' }, encoding: 'utf8' }); process.stdout.write(output);`
		const output = docker(['run', '--rm', '--network', 'none', '--security-opt', profile, '-v', `${path.join(repo, 'runtime', 'test')}:${runtime}/test:ro`, '--entrypoint', 'node', image, '-e', bootstrap])
		assert.match(output, /# pass 3\b/); assert.match(output, /# fail 0\b/)
		for (const marker of ['INSTALLED_GIS_UNAVAILABLE', 'INSTALLED_NATIVE_PROVIDERS_UNAVAILABLE']) assert.ok(output.includes(marker), `Missing required negative evidence: ${marker}`)
		assert.match(output, /^ok \d+ - installed launcher fails closed when chroot is unavailable\s*$/m)
		console.log('PASS chroot ENOSYS command, admission rejection, CSV/raw access (3 required tests passed)')
	}
	for (const id of ['gis', 'workbook']) for (const fault of ['missing-sentinel', 'readable-sentinel', 'writable-root', 'symlink-root']) {
		const root = `/opt/geocluster-reader-jails/${id}`
		const mutation = fault === 'missing-sentinel' ? `fs.unlinkSync('${root}/.geocluster-isolation-sentinel')`
			: fault === 'readable-sentinel' ? `fs.chmodSync('${root}/.geocluster-isolation-sentinel', 0o444)`
			: fault === 'writable-root' ? `fs.chmodSync('${root}', 0o777)`
			: `fs.rmSync('${root}', { recursive: true }); fs.symlinkSync('/', '${root}')`
		const bootstrap = `const fs = require('node:fs'), { spawnSync } = require('node:child_process'); ${mutation};
const result = spawnSync('gosu', ['gc-files', 'node', '${runtime}/scripts/qualify-native-readers.mjs'], { encoding: 'utf8', timeout: 130000 });
if (result.status !== 1) throw new Error('Broken jail must fail qualification'); process.stdout.write(result.stdout);`
		const broken = report(docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', bootstrap], 140000))
		assert.equal(broken[id]?.state, 'unavailable', `${id} ${fault}`)
		if (fault.endsWith('root')) assert.match(broken[id].diagnostic, /stage=chroot-installation result=-1 errno=1(?:\s|;|$)/)
		assert.equal(broken[id === 'gis' ? 'workbook' : 'gis']?.state, 'available', 'fault must remain confined to one reader')
		console.log(`PASS ${id} rejects ${fault}`)
	}
	console.log('ALL NATIVE PASS')
} finally {
	if (started) {
		const cleanup = spawnSync('docker', ['rm', '-f', '-v', name], { encoding: 'utf8', timeout: 60000 })
		if (cleanup.status !== 0) { console.error(`Failed cleanup of owned container ${name}`); process.exitCode = 1 }
	}
}
