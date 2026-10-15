import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Run as the file-service identity with a private, non-world-writable parent.
// No fixture directory is needed; both installed launchers must be supplied.
const enabled = process.env.GIS_EXPECT_UNAVAILABLE === 'true' && process.env.WORKBOOK_EXPECT_UNAVAILABLE === 'true'
async function raw(handle) {
	const chunks = []
	for await (const chunk of handle.createReadStream({ autoClose: false })) chunks.push(chunk)
	return Buffer.concat(chunks).toString()
}

test('installed native providers reject preparation while the WorkspaceFiles CSV and raw facade stays usable', { skip: !enabled, timeout: 30000 }, async t => {
	const gisLauncher = process.env.GIS_INSTALLED_LAUNCHER, workbookLauncher = process.env.WORKBOOK_INSTALLED_LAUNCHER
	assert.ok(gisLauncher, 'GIS_INSTALLED_LAUNCHER is required')
	assert.ok(workbookLauncher, 'WORKBOOK_INSTALLED_LAUNCHER is required')
	const { WorkspaceFiles } = await import('../lib/workspace-files.js')
	const { loadFilesConfig } = await import('../files-server.js')
	const { makeWorkbookFixture } = await import('./workbook-fixtures.mjs')
	const base = await fs.mkdtemp(path.join(process.env.FILES_TEST_PARENT || os.homedir(), '.gc-native-unavailable-'))
	let files
	t.after(async () => { try { await files?.close() } finally { await fs.rm(base, { recursive: true, force: true }) } })
	await fs.chmod(base, 0o700)
	const workspaceDir = path.join(base, 'project')
	await fs.mkdir(workspaceDir)
	const config = loadFilesConfig({
		VOXEL_AGENT_ENABLED: 'false', WORKSPACE_DIR: workspaceDir, FILES_STATE_DIR: path.join(base, 'state'),
		FILES_AGENT_UIDS: '999', FILES_WORKER_UIDS: '997', FILES_WORKER_UID: '997',
		FILES_WORKBOOK_WORKER_BIN: workbookLauncher, FILES_GIS_WORKER_BIN: gisLauncher,
	})
	files = await WorkspaceFiles.open(config, { info() {}, warn() {}, error() {} })
	const info = await files.info()
	assert.equal(info.captures.state, 'available', JSON.stringify(info.captures))
	assert.equal(info.preview.state, 'available', JSON.stringify(info.preview))
	assert.deepEqual(info.providers, ['csv', 'tsv', 'text'])
	for (const operation of ['raw', 'capture', 'preview', 'segments']) assert.ok(info.operations.includes(operation), operation)
	for (const operation of ['preparations', 'representations', 'workbook-query', 'vector-query', 'raster-query', 'assay-query']) assert.equal(info.operations.includes(operation), false, operation)
	for (const id of ['workbook', 'vector', 'raster', 'assay']) {
		const descriptor = info.providerDetails.find(provider => provider.id === id)
		assert.ok(descriptor, id)
		assert.equal(descriptor.readiness.state, 'unavailable', JSON.stringify(descriptor))
		assert.equal(descriptor.readiness.reason, 'confinement-probe', id)
		assert.match(descriptor.readiness.diagnostic, /stage=chroot-installation result=-1 errno=38(?:\s|;|$)/)
		if (id !== 'workbook') assert.deepEqual(descriptor.inputFormats, [], id)
	}
	assert.throws(() => files.gis.requireAdmission(), { status: 503, error: 'gis_unavailable', reason: 'confinement-probe' })
	for (const name of ['points.geojson', 'pixels.tif', 'table.csv']) assert.deepEqual(files.gis.eligible(name, 1), [], name)

	const csv = 'id,x,y,grade\nfirst,10,20,42\n'
	const sources = {}
	for (const [type, name, bytes] of [
		['workbook', 'book.xlsx', makeWorkbookFixture()],
		['vector', 'points.geojson', '{"type":"FeatureCollection","features":[]}'],
		['assay', 'table.csv', csv],
	]) {
		await fs.writeFile(path.join(workspaceDir, name), bytes)
		sources[type] = (await files.captures.create({ requestId: `capture-${type}`, path: name, computeDigest: true })).source
	}
	const records = async () => Object.fromEntries(await Promise.all(['requests', 'jobs', 'holds', 'index-reservations', 'workbook-indexes'].map(async kind => [kind, await files.state.list(kind)])))
	const before = await records()
	for (const type of ['workbook', 'vector', 'raster', 'assay']) {
		const options = type === 'assay' ? { mode: 'surface', columns: { id: 'id', x: 'x', y: 'y', analyte: 'grade' }, sourceCrs: { code: 'OGC:CRS84', axisOrder: 'xy' }, unit: { name: 'ppm', basis: 'user-assigned' } } : {}
		await assert.rejects(files.preparation({ requestId: `prepare-${type}`, type, source: sources[type] || sources.vector, options }), { status: 503, error: type === 'workbook' ? 'workbook_unavailable' : 'gis_unavailable', reason: 'confinement-probe' })
	}
	assert.deepEqual(await records(), before, 'denied preparation must not admit a receipt, job, hold, reservation or index')
	const preview = await files.captures.preview({ path: 'table.csv', format: 'csv', rowLimit: 2 })
	assert.deepEqual(preview.rows.map(row => row.cells.map(cell => cell.text)), [['id', 'x', 'y', 'grade'], ['first', '10', '20', '42']])
	const live = await files.openLive('table.csv')
	try { assert.equal(await raw(live.handle), csv) } finally { await live.handle.close() }
	await fs.writeFile(path.join(workspaceDir, 'table.csv'), 'replacement Current bytes')
	const retained = await files.captures.open('capture', sources.assay.captureId)
	try { assert.equal(await raw(retained.handle), csv) } finally { await retained.release() }
	console.log('INSTALLED_NATIVE_PROVIDERS_UNAVAILABLE', JSON.stringify({ providers: info.providers, native: info.providerDetails.filter(provider => ['workbook', 'vector', 'raster', 'assay'].includes(provider.id)), csvPreview: 'ready', liveRaw: 'ready', capturedRaw: 'ready' }))
})
