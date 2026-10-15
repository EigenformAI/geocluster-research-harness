import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { qualifyNativeReaders, QUALIFICATION_REPORT_BYTES } from '../scripts/lib/native-reader-qualification.mjs'
import { GisReader } from '../lib/gis-reader.js'
import { WorkbookReader } from '../lib/workbook-reader.js'

function reader(availability = { state: 'available', confinement: 'verified' }, overrides = {}) {
	return {
		availability: { state: 'unavailable', reason: 'not-initialized' }, calls: [],
		async init() { this.calls.push('init'); this.availability = availability },
		async close() { this.calls.push('close'); this.availability = { state: 'unavailable', reason: 'closed' } },
		...overrides,
	}
}

test('qualification snapshots both fresh results before closing both readers', async () => {
	const readers = { gis: reader(), workbook: reader() }
	const result = await qualifyNativeReaders(readers)
	assert.equal(result.exitCode, 0)
	assert.deepEqual(JSON.parse(result.json), { gis: { state: 'available', confinement: 'verified' }, workbook: { state: 'available', confinement: 'verified' } })
	for (const r of Object.values(readers)) assert.deepEqual(r.calls, ['init', 'close'])
})

for (const name of ['gis', 'workbook']) {
	test(`${name}: available synthetic confinement must fail qualification`, async () => {
		const readers = { gis: reader(), workbook: reader() }
		const probe = name === 'gis'
			? { decoded: ['GeoJSON', 'ESRI Shapefile', 'MapInfo File: TAB', 'MapInfo File: MIF', 'GPKG', 'GTiff', 'ERS'], assay: 'bounded-gdal-assay-v1', filesystemDenied: true, writeDenied: true, truncateDenied: true, descriptorTruncateDenied: true, socketDenied: true, executionDenied: true, processDenied: true, signalDenied: true }
			: { decoded: ['xls', 'xlsx'], filesystemDenied: true, socketDenied: true, executionDenied: true, signalDenied: true }
		readers[name] = reader({ state: 'available', confinement: 'synthetic-test-only', probe, ...(name === 'gis' ? { build: { gdal: '3.6.2', proj: '9.1.1' } } : {}) })
		const result = await qualifyNativeReaders(readers)
		assert.equal(result.exitCode, 1)
		assert.equal(JSON.parse(result.json)[name].confinement, 'synthetic-test-only')
		for (const r of Object.values(readers)) assert.deepEqual(r.calls, ['init', 'close'])
	})
	test(`${name}: failed reader cannot qualify the pair`, async () => {
		const readers = { gis: reader(), workbook: reader() }
		readers[name] = reader({ state: 'unavailable', reason: 'confinement-probe', diagnostic: 'stage=chroot-installation result=-1 errno=38' })
		const result = await qualifyNativeReaders(readers)
		assert.equal(result.exitCode, 1)
		assert.match(JSON.parse(result.json)[name].diagnostic, /errno=38/)
	})
}

test('missing installed launchers are unavailable, preserved in the report, and closed', async () => {
	const readers = { gis: new GisReader({ launcherPath: '/nonexistent-gc-gis-qualification' }), workbook: new WorkbookReader({ launcherPath: '/nonexistent-gc-workbook-qualification' }) }
	const result = await qualifyNativeReaders(readers)
	assert.equal(result.exitCode, 1)
	for (const [name, r] of Object.entries(readers)) {
		assert.equal(JSON.parse(result.json)[name].state, 'unavailable')
		assert.match(JSON.parse(result.json)[name].diagnostic, /ENOENT/)
		assert.equal(r.closed, true)
	}
})

test('an init exception fails qualification, still initializes the peer and closes both', async () => {
	const readers = { gis: reader(undefined, { async init() { this.calls.push('init'); throw new Error('launcher process failed') } }), workbook: reader() }
	const result = await qualifyNativeReaders(readers)
	assert.equal(result.exitCode, 1)
	assert.match(JSON.parse(result.json).gis.diagnostic, /launcher process failed/)
	for (const r of Object.values(readers)) assert.deepEqual(r.calls, ['init', 'close'])
})

for (const invalid of [undefined, null, 'not-json', {}, { state: 'available' }, { state: 'available', confinement: 'verified', probe: 1n }]) {
	test(`malformed availability fails qualification (${String(invalid)})`, async () => {
		const result = await qualifyNativeReaders({ gis: reader(invalid, { async init() { this.availability = invalid } }), workbook: reader() })
		assert.equal(result.exitCode, 1)
		assert.doesNotThrow(() => JSON.parse(result.json))
	})
}

test('oversized evidence fails with one bounded parseable report', async () => {
	const result = await qualifyNativeReaders({ gis: reader({ state: 'available', confinement: 'verified', probe: { detail: '\u0000'.repeat(40000) } }), workbook: reader() })
	assert.equal(result.exitCode, 1)
	assert.ok(Buffer.byteLength(result.json) <= QUALIFICATION_REPORT_BYTES)
	assert.equal(JSON.parse(result.json).gis.reason, 'report-limit')
})

test('deadline fails and starts closing both readers even if init and close never settle', async () => {
	const hung = reader(undefined, { async init() { this.calls.push('init'); await new Promise(() => {}) }, async close() { this.calls.push('close'); await new Promise(() => {}) } })
	const readers = { gis: hung, workbook: reader() }
	const result = await qualifyNativeReaders(readers, { deadlineMs: 20 })
	assert.equal(result.exitCode, 1)
	assert.equal(JSON.parse(result.json).error.reason, 'deadline')
	for (const r of Object.values(readers)) assert.deepEqual(r.calls, ['init', 'close'])
})

test('close errors and close deadlines cannot turn an otherwise passing run into success', async () => {
	for (const close of [async () => { throw new Error('close failed') }, async () => new Promise(() => {})]) {
		const result = await qualifyNativeReaders({ gis: reader(undefined, { close }), workbook: reader() }, { deadlineMs: 20 })
		assert.equal(result.exitCode, 1)
		assert.ok(JSON.parse(result.json).error)
	}
})

test('CLI refuses a non-service UID with one bounded JSON failure', { skip: process.getuid?.() === 998 }, () => {
	const child = spawnSync(process.execPath, [new URL('../scripts/qualify-native-readers.mjs', import.meta.url).pathname], { encoding: 'utf8', timeout: 5000 })
	assert.equal(child.status, 1, child.stderr)
	assert.ok(Buffer.byteLength(child.stdout) <= QUALIFICATION_REPORT_BYTES)
	assert.equal(JSON.parse(child.stdout).error.reason, 'service-uid')
	assert.match(JSON.parse(child.stdout).error.diagnostic, /UID 998/)
})
