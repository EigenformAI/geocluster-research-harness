import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// Opt in with an already-built installed image. Every mutation is confined to
// a disposable container, and no image tag or host PROJ installation is edited.
const image = process.env.GIS_PROJECTION_ENV_IMAGE
// Development can use an explicitly supplied disposable container with an
// isolated recompiled worker. Production acceptance should use the image.
const existingContainer = process.env.GIS_PROJECTION_ENV_CONTAINER
const installed = { skip: !image && !existingContainer ? 'Set GIS_PROJECTION_ENV_IMAGE to a verified installed GIS image (or GIS_PROJECTION_ENV_CONTAINER to a disposable development container); requires Docker, C++, pkg-config and projinfo.' : false, timeout: 300_000 }
const fixture = fileURLToPath(new URL('./fixtures/gis-projection-environment-native.cpp', import.meta.url))
// Root-side inspection and mutations use the installed copy outside the chroot.
const installedProjRoot = '/opt/geocluster-reader-jails/gis/usr/share/proj'
const pins = {
	'au_icsm_GDA94_GDA2020_conformal.tif': '92b39b4898aff9e9921dce83daed4f942da0c1e714905612fa7ffdc0081dcc9c',
	'au_icsm_GDA94_GDA2020_conformal_and_distortion.tif': '89bb9e5c55a714c8925ddc134bf4c191be8df2607b229a05efb778f5f6166ee0',
}
const references = [
	[28350, [405542.53659728984, 6459127.468715401], [116, -32], 'GDA94'],
	[28355, [522743.33553664864, 6099203.676349473], [147.25, -35.25], 'GDA94'],
	[7850, [405542.53659728984, 6459127.468715401], [116, -32], 'GDA2020'],
	[7855, [522743.33553664864, 6099203.676349473], [147.25, -35.25], 'GDA2020'],
	[4283, [116, -32], [116, -32], 'GDA94'],
	[7844, [116, -32], [116, -32], 'GDA2020'],
]
async function docker(args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = ''
		const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Docker command timed out: ${args.join(' ')}`)) }, 120_000)
		child.once('error', error => { clearTimeout(timer); reject(error) })
		child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
		child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
		child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`docker ${args.join(' ')} exited ${code}: ${stderr}\n${stdout}`)) })
		child.stdin.end(input)
	})
}
const workerScript = `
const fs = require('node:fs'), { spawn } = require('node:child_process');
const header = JSON.parse(process.argv[1]), primary = header.primary;
const bytes = primary ? fs.readFileSync('/tmp/projection-fixtures/' + primary) : Buffer.alloc(0);
if (primary) header.members = [{ name: primary, byteLength: bytes.length }];
const child = spawn('/opt/geocluster-runtime/gis-launcher', [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.once('error', error => { console.error(error); process.exitCode = 1 });
child.once('close', code => { process.exitCode = code });
child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error });
child.stdin.end(Buffer.concat([Buffer.from(JSON.stringify(header) + '\\n'), bytes]));
`
async function native(container, primary, displayOptions = {}) {
	const header = primary ? { kind: 'vector', operation: 'preview', primary, options: { displayOptions }, limits: {} } : { probe: true }
	const text = await docker(['exec', container, 'node', '-e', workerScript, JSON.stringify(header)])
	const messages = text.trim().split('\n').map(line => JSON.parse(line))
	if (messages.length === 1 && messages[0].error) return messages[0]
	assert.equal(messages.length, 2, text); assert.equal(messages[0].ready, true); assert.equal(messages[0].uid, 997); assert.equal(messages[0].confinement, 'installed')
	return messages[1]
}
async function edit(container, script) { return docker(['exec', container, 'node', '-e', `const fs = require('node:fs'), projRoot = ${JSON.stringify(installedProjRoot)}; ${script}`]) }
async function preview(container, primary, options) {
	const result = await native(container, primary, options); assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.payload.layers[0]
}
async function build(container) {
	const result = await native(container); assert.equal(result.error, undefined, JSON.stringify(result.error))
	for (const key of ['filesystemDenied', 'writeDenied', 'socketDenied', 'executionDenied', 'processDenied']) assert.equal(result.probe[key], true, key)
	return result.build
}
function closeCoordinates(actual, expected, tolerance = 1e-8) {
	assert.equal(actual.length, 2)
	actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance, `${actual} differs from reference ${expected} (tolerance ${tolerance} degrees)`))
}
// Independent readback of sorted installed bytes, not the lock or mtimes.
const inventoryScript = `
const fs = require('node:fs'), crypto = require('node:crypto'), records = [], projRoot = ${JSON.stringify(installedProjRoot)};
function visit(relative) {
  for (const name of fs.readdirSync(projRoot + '/' + relative)) {
    const key = relative + name, file = projRoot + '/' + key, st = fs.lstatSync(file);
    if (st.isDirectory()) visit(key + '/');
    else if (st.isFile()) { const bytes = fs.readFileSync(file); records.push({ name: key, byteLength: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }); }
  }
}
visit(''); records.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
const hash = crypto.createHash('sha256').update('proj-inventory-v1\\n');
for (const r of records) hash.update(Buffer.byteLength(r.name) + ':' + r.name + ':' + r.byteLength + ':' + r.sha256 + '\\n');
console.log(JSON.stringify({ sha256: hash.digest('hex'), fileCount: records.length, totalBytes: records.reduce((sum, r) => sum + r.byteLength, 0), records }));
`

test('native projection environment: installed inventory and Australian coordinate evidence', installed, async t => {
	const container = existingContainer || `gc-projection-native-${randomUUID()}`
	if (!existingContainer) {
		await docker(['run', '-d', '--name', container, '--entrypoint', 'sleep', image, 'infinity'])
		t.after(() => docker(['rm', '-f', container]))
	}
	await docker(['exec', container, 'ls', '/tmp'])
	await docker(['cp', fixture, `${container}:/tmp/projection-fixture.cpp`])
	await docker(['exec', container, 'sh', '-c', 'command -v node && command -v c++ && command -v pkg-config && command -v projinfo && pkg-config --exists gdal proj && ls /tmp && c++ -std=c++17 -O2 -Wall -Wextra -Werror /tmp/projection-fixture.cpp $(pkg-config --cflags --libs gdal) -o /tmp/projection-fixture && /tmp/projection-fixture /tmp/projection-fixtures'])

	await t.test('adding, changing and removing a non-Australian grid changes identity and rejects old options', async () => {
		const name = `${installedProjRoot}/zz_native_non_australian.gsb`, primary = 'epsg-7850.gpkg'
		const before = (await preview(container, primary)).placement.environmentFingerprint
		await edit(container, `fs.writeFileSync(${JSON.stringify(name)}, 'non-Australian fixture grid A', { mode: 0o444 })`)
		try {
			const added = (await preview(container, primary)).placement.environmentFingerprint
			assert.notEqual(added, before, 'adding grid bytes must change the fingerprint even when proj.db and the pins are unchanged')
			assert.equal((await native(container, primary, { environmentFingerprint: before })).error?.reason, 'gis_environment_changed')
			await edit(container, `fs.chmodSync(${JSON.stringify(name)}, 0o644); fs.writeFileSync(${JSON.stringify(name)}, 'non-Australian fixture grid B'); fs.chmodSync(${JSON.stringify(name)}, 0o444)`)
			const changed = (await preview(container, primary)).placement.environmentFingerprint
			assert.notEqual(changed, added, 'same-length grid byte mutation must change identity')
			assert.equal((await native(container, primary, { environmentFingerprint: added })).error?.reason, 'gis_environment_changed')
			await edit(container, `fs.unlinkSync(${JSON.stringify(name)})`)
			assert.equal((await preview(container, primary)).placement.environmentFingerprint, before)
			assert.equal((await native(container, primary, { environmentFingerprint: changed })).error?.reason, 'gis_environment_changed')
		} finally { await edit(container, `fs.rmSync(${JSON.stringify(name)}, { force: true })`) }
	})

	await t.test('a same-length mutation of a genuine installed non-Australian grid invalidates old options', async () => {
		const primary = 'epsg-7850.gpkg', before = (await preview(container, primary)).placement.environmentFingerprint
		await edit(container, "const file = projRoot + '/BETA2007.gsb', st = fs.statSync(file); fs.copyFileSync(file, '/tmp/original-beta2007.gsb'); fs.chmodSync(file, 0o644); const fd = fs.openSync(file, 'r+'), byte = Buffer.alloc(1); fs.readSync(fd, byte, 0, 1, st.size - 1); byte[0] ^= 1; fs.writeSync(fd, byte, 0, 1, st.size - 1); fs.closeSync(fd); fs.chmodSync(file, st.mode & 0o777); fs.utimesSync(file, st.atime, st.mtime)")
		try {
			assert.notEqual((await preview(container, primary)).placement.environmentFingerprint, before, 'a real legacy .gsb is not represented by the Australian lock')
			assert.equal((await native(container, primary, { environmentFingerprint: before })).error?.reason, 'gis_environment_changed')
		} finally { await edit(container, "const file = projRoot + '/BETA2007.gsb', mode = fs.statSync(file).mode & 0o777; fs.chmodSync(file, 0o644); fs.copyFileSync('/tmp/original-beta2007.gsb', file); fs.chmodSync(file, mode); fs.unlinkSync('/tmp/original-beta2007.gsb')") }
		assert.equal((await preview(container, primary)).placement.environmentFingerprint, before)
	})

	await t.test('probe reports the complete digest, actual selected pin bytes and an API-sized fingerprint', async () => {
		const actual = await build(container), expected = JSON.parse(await docker(['exec', container, 'node', '-e', inventoryScript]))
		assert.match(actual.environmentFingerprint, /^gdal=[^;]+;proj=[^;]+;proj-db=[a-f0-9]{64};grids=[a-f0-9]{64}$/)
		assert.ok(actual.environmentFingerprint.length <= 256)
		assert.equal(actual.environmentFingerprint.split(';grids=')[1], expected.sha256)
		assert.equal(actual.projectionInventory.root, '/usr/share/proj'); assert.equal(actual.projectionInventory.algorithm, 'sha256-path-content-v1')
		for (const key of ['sha256', 'fileCount', 'totalBytes']) assert.equal(actual.projectionInventory[key], expected[key])
		for (const [name, sha256] of Object.entries(pins)) {
			const record = actual.projectionInventory.selectedGrids.find(grid => grid.name === name)
			assert.deepEqual(record, expected.records.find(grid => grid.name === name)); assert.equal(record.sha256, sha256, 'the installed bytes must match the official pin')
		}
		t.diagnostic(`Fingerprint (${actual.environmentFingerprint.length} chars): ${actual.environmentFingerprint}; inventory ${expected.fileCount} regular files / ${expected.totalBytes} bytes`)
	})

	await t.test('inventory is recursive, deterministic across creation order, and does not follow external symlinks or special files', async () => {
		const baseline = (await build(container)).environmentFingerprint
		await edit(container, "fs.mkdirSync(projRoot + '/native-inventory'); fs.writeFileSync(projRoot + '/native-inventory/b.gsb', 'B', { mode: 0o444 }); fs.writeFileSync(projRoot + '/native-inventory/a.gsb', 'A', { mode: 0o444 })")
		try {
			const first = (await build(container)).environmentFingerprint; assert.notEqual(first, baseline)
			await edit(container, "fs.rmSync(projRoot + '/native-inventory', { recursive: true }); fs.mkdirSync(projRoot + '/native-inventory'); fs.writeFileSync(projRoot + '/native-inventory/a.gsb', 'A', { mode: 0o444 }); fs.writeFileSync(projRoot + '/native-inventory/b.gsb', 'B', { mode: 0o444 }); fs.symlinkSync('/etc/passwd', projRoot + '/native-inventory/external.gsb')")
			await docker(['exec', container, 'mkfifo', `${installedProjRoot}/native-inventory/ignored.gsb`])
			assert.equal((await build(container)).environmentFingerprint, first, 'directory order, timestamps, links and FIFOs are not grid bytes')
			await edit(container, "fs.renameSync(projRoot + '/native-inventory/a.gsb', projRoot + '/native-inventory/c.gsb')")
			assert.notEqual((await build(container)).environmentFingerprint, first, 'names matter to PROJ grid lookup')
		} finally { await edit(container, "fs.rmSync(projRoot + '/native-inventory', { recursive: true, force: true })") }
	})

	await t.test('only confined readable regular files participate, and oversized inventories fail before hashing', async () => {
		const before = (await build(container)).environmentFingerprint
		await edit(container, "fs.writeFileSync(projRoot + '/native-unreadable.gsb', 'not readable by UID 997', { mode: 0o000 })")
		try {
			assert.equal((await build(container)).environmentFingerprint, before)
			await edit(container, "fs.chmodSync(projRoot + '/native-unreadable.gsb', 0o444)")
			assert.notEqual((await build(container)).environmentFingerprint, before)
		} finally { await edit(container, "fs.unlinkSync(projRoot + '/native-unreadable.gsb')") }
		await edit(container, "const fd = fs.openSync(projRoot + '/native-oversized.gsb', 'wx', 0o444); fs.ftruncateSync(fd, 4096 * 1048576 + 1); fs.closeSync(fd)")
		try {
			const result = await native(container)
			assert.equal(result.error?.reason, 'worker_unavailable'); assert.match(result.error.message, /byte ceiling/); assert.equal(result.probe, undefined)
		} finally { await edit(container, "fs.unlinkSync(projRoot + '/native-oversized.gsb')") }
		assert.equal((await build(container)).environmentFingerprint, before)
	})

	await t.test('declared MGA and geographic source CRSs yield independently known reference coordinates and expose the selected pipeline', async () => {
		for (const [epsg, source, expected, datum] of references) {
			const layer = await preview(container, `epsg-${epsg}.gpkg`), p = layer.placement
			assert.deepEqual(layer.features[0].geometry.coordinates, source); assert.equal(p.sourceFrame.basis, 'declared')
			assert.match(p.sourceFrame.wkt, new RegExp(datum)); assert.ok(p.sourceFrame.wkt.includes(`"${epsg}"`) || p.sourceFrame.wkt.includes(`,${epsg}]`))
			assert.deepEqual(p.sourceFrame.dataAxisMapping, epsg === 4283 || epsg === 7844 ? [2, 1] : [1, 2])
			assert.equal(p.state, 'ready', JSON.stringify(p.reasons)); assert.equal(p.operation.policy, 'strict'); assert.equal(p.displayCrs, 'OGC:CRS84')
			closeCoordinates(p.displayByLocator['layer-0:0'].coordinates, expected)
			const [lon, lat] = expected, bbox = [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01].join(',')
			const operations = await docker(['exec', '-e', `PROJ_DATA=${installedProjRoot}`, container, 'projinfo', '-s', `EPSG:${epsg}`, '-t', 'OGC:CRS84', '--bbox', bbox, '--spatial-test', 'contains', '--grid-check', 'none', '-o', 'PROJ'])
			const first = operations.split('Operation No. 1:')[1]?.split('-------------------------------------')[0]
			assert.ok(first?.includes(p.operation.identity), `worker-selected operation must match installed PROJ inspection: ${p.operation.identity}\n${operations}`)
			const pipeline = first.split('PROJ string:')[1].trim()
			// The verified PROJ 9.1 database selects the ensemble/null datum step,
			// even with the Australian pins present. A different selection requires
			// fresh reference evidence, not a relaxed coordinate tolerance.
			assert.doesNotMatch(pipeline, /hgridshift|helmert/)
			t.diagnostic(`EPSG:${epsg}: ${p.operation.identity}; selected pipeline ${pipeline.replaceAll(/\s+/g, ' ')}; accuracy ${p.operation.accuracy} is operation metadata only`)
			const swapped = await preview(container, `epsg-${epsg}-yx.gpkg`, { sourceCrs: { layerId: 'layer-0', code: `EPSG:${epsg}`, axisOrder: 'yx' } })
			assert.equal(swapped.placement.state, 'ready'); assert.equal(swapped.placement.sourceFrame.basis, 'user-assumed')
			closeCoordinates(swapped.placement.displayByLocator['layer-0:0'].coordinates, expected)
			const wrong = await preview(container, `epsg-${epsg}-yx.gpkg`, { sourceCrs: { layerId: 'layer-0', code: `EPSG:${epsg}`, axisOrder: 'xy' } })
			assert.equal(wrong.placement.state, 'unavailable'); assert.deepEqual(wrong.placement.displayByLocator, {})
		}
	})

	await t.test('strict NAD27 placement refuses the preferred missing official grid; approximation requires an explicit option', async () => {
		const primary = 'nad27-missing-official-grid.gpkg', strict = (await preview(container, primary)).placement
		assert.equal(strict.sourceFrame.basis, 'declared'); assert.match(strict.sourceFrame.wkt, /NAD27/)
		assert.equal(strict.state, 'unavailable'); assert.equal(strict.operation, null); assert.deepEqual(strict.displayByLocator, {})
		assert.match(strict.reasons.join(' '), /missing grids/)
		const operations = await docker(['exec', '-e', `PROJ_DATA=${installedProjRoot}`, container, 'projinfo', '-s', 'EPSG:4267', '-t', 'OGC:CRS84', '--bbox', '-100.01,49.99,-99.99,50.01', '--spatial-test', 'contains', '--grid-check', 'none', '-o', 'PROJ'])
		const first = operations.split('Operation No. 1:')[1]?.split('-------------------------------------')[0]
		assert.match(first, /ca_nrc_ntv2_0\.tif/); assert.match(first, /needed but not found/)
		const approximate = (await preview(container, primary, { allowApproximate: true })).placement
		assert.equal(approximate.state, 'ready'); assert.equal(approximate.operation.policy, 'approximate'); assert.ok(approximate.operation.identity)
		t.diagnostic(`Preferred unavailable NAD27 pipeline: ${first.split('PROJ string:')[1].trim().replaceAll(/\s+/g, ' ')}; explicit fallback ${approximate.operation.identity}`)
	})

	await t.test('removing the Australian pins invalidates old options but ordinary qualification still succeeds', async () => {
		const primary = 'epsg-28350.gpkg', layer = await preview(container, primary)
		const old = layer.placement.environmentFingerprint, names = Object.keys(pins)
		await edit(container, `for (const name of ${JSON.stringify(names)}) fs.renameSync(projRoot + '/' + name, '/tmp/' + name)`)
		try {
			const missing = await preview(container, primary)
			assert.notEqual(missing.placement.environmentFingerprint, old)
			assert.equal(missing.placement.state, 'ready'); closeCoordinates(missing.placement.displayByLocator['layer-0:0'].coordinates, [116, -32])
			assert.equal((await native(container, primary, { environmentFingerprint: old })).error?.reason, 'gis_environment_changed')
			const qualified = await build(container)
			assert.deepEqual(qualified.projectionInventory.selectedGrids, [], 'missing Australian pins must not make ordinary qualification fail')
		} finally { await edit(container, `for (const name of ${JSON.stringify(names)}) fs.renameSync('/tmp/' + name, projRoot + '/' + name)`) }
	})
})
