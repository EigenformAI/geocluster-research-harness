import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { retained, bundleNames } from './gis-fixtures.mjs'
import { GisReader } from '../lib/gis-reader.js'
import { FileGis } from '../lib/file-gis.js'

const launcherPath = process.env.GIS_INSTALLED_LAUNCHER, fixtures = process.env.GIS_FIXTURES
const expectUnavailable = process.env.GIS_EXPECT_UNAVAILABLE === 'true'
const installed = { skip: expectUnavailable || !launcherPath || !fixtures }
async function reader(limits) { const r = new GisReader({ launcherPath, limits }); await r.init(); assert.equal(r.availability.state, 'available', JSON.stringify(r.availability)); return r }
async function read(r, primary, kind = 'vector', operation = 'preview', options = {}, names) {
	const input = await retained(fixtures, names || await bundleNames(fixtures, primary))
	try { return await r.read({ members: input.members, kind, operation, options }) } finally { await input.close() }
}

test('GIS installed launcher fails closed at chroot installation without external fixtures', { skip: !expectUnavailable }, async t => {
	assert.ok(launcherPath, 'GIS_EXPECT_UNAVAILABLE=true requires GIS_INSTALLED_LAUNCHER')
	const r = new GisReader({ launcherPath }); t.after(() => r.close())
	await r.init()
	assert.equal(r.availability.state, 'unavailable', JSON.stringify(r.availability))
	assert.equal(r.availability.reason, 'confinement-probe')
	assert.match(r.availability.diagnostic, /stage=chroot-installation result=-1 errno=38(?:\s|;|$)/)
	await assert.rejects(r.read({ members: [], kind: 'vector', operation: 'manifest' }), e => {
		assert.equal(e.status, 503); assert.equal(e.error, 'worker_unavailable')
		assert.match(e.message, /stage=chroot-installation result=-1 errno=38(?:\s|;|$)/)
		return true
	})
	const gis = new FileGis({ config: { filesGisReader: r }, captures: { availability: { state: 'available' }, requireAdmission() {} }, state: { async list() { return [] } } })
	await gis.init()
	assert.deepEqual(gis.descriptors().map(provider => provider.id), ['vector', 'raster', 'assay'])
	for (const provider of gis.descriptors()) {
		assert.deepEqual(provider.readiness, r.availability)
		assert.deepEqual(provider.inputFormats, [], provider.id)
	}
	for (const name of ['points.geojson', 'pixels.tif', 'table.csv']) assert.deepEqual(gis.eligible(name, 1), [], name)
	assert.throws(() => gis.requireAdmission(), { status: 503, error: 'gis_unavailable', reason: 'confinement-probe' })
	console.log('INSTALLED_GIS_UNAVAILABLE', JSON.stringify(r.availability))
})

test('GIS installed qualification decodes every advertised family and denies ambient authority', installed, async () => {
	const r = await reader()
	try {
		assert.equal(r.availability.confinement, 'verified')
		assert.deepEqual(r.availability.probe.decoded, ['GeoJSON', 'ESRI Shapefile', 'MapInfo File: TAB', 'MapInfo File: MIF', 'GPKG', 'GTiff', 'ERS'])
		for (const flag of ['filesystemDenied', 'writeDenied', 'truncateDenied', 'descriptorTruncateDenied', 'socketDenied', 'executionDenied', 'processDenied', 'signalDenied']) assert.equal(r.availability.probe[flag], true, flag)
		assert.equal(r.availability.build.dataMemoryBytes, 512 * 1048576); assert.equal(r.availability.build.addressSpaceBytes, 1536 * 1048576); assert.equal(r.availability.build.cpuSeconds, 30)
		console.log('INSTALLED_GIS_QUALIFICATION', JSON.stringify(r.availability))
	} finally { await r.close() }
})

test('GIS genuine SHP/SHX/DBF/PRJ yields native XY, CRS84 and geometry-free source-position attributes', installed, async () => {
	const r = await reader()
	try {
		const manifest = await read(r, 'points.shp', 'vector', 'manifest'); assert.equal(manifest.layers[0].reportedFeatureCount, 3); assert.match(manifest.layers[0].crsWkt, /Mercator/)
		const preview = await read(r, 'points.shp'), l = preview.layers[0], f = l.features[0]
		assert.equal(f.properties.label, 'first'); assert.ok(Math.abs(f.geometry.coordinates[0] - 1113194.9079) < 1)
		assert.equal(l.placement.state, 'ready'); assert.ok(Math.abs(l.placement.displayByLocator[f.locator].coordinates[0] - 10) < 0.00001)
		const page = await read(r, 'points.shp', 'vector', 'attributes', { layerId: 'layer-0', offset: 1, limit: 1 })
		assert.equal(page.rows[0].properties.label, 'second'); assert.equal(page.rows[0].locator, 'layer-0:1'); assert.equal('geometry' in page.rows[0], false); assert.equal(page.nextOffset, 2); assert.equal(page.inputDigests.length, 4)
		for (const missing of ['.shx', '.dbf']) await assert.rejects(read(r, 'points.shp', 'vector', 'manifest', {}, (await bundleNames(fixtures, 'points.shp')).filter(n => !n.endsWith(missing))), e => e.error === 'gis_bundle_invalid')
		const unknown = await read(r, 'points.shp', 'vector', 'preview', {}, (await bundleNames(fixtures, 'points.shp')).filter(n => !n.endsWith('.prj')))
		assert.equal(unknown.layers[0].placement.sourceFrame.basis, 'unknown'); assert.equal(unknown.layers[0].placement.state, 'unavailable'); assert.deepEqual(unknown.layers[0].features[0].geometry, f.geometry)
	} finally { await r.close() }
})

test('GIS physical geometry limits preserve large-vector metadata and attribute access', installed, async () => {
	const r = await reader()
	try {
		assert.equal((await read(r, 'many.geojson', 'vector', 'manifest')).layers[0].reportedFeatureCount, 1020)
		await assert.rejects(read(r, 'many.geojson'), e => e.error === 'vector_feature_limit')
		await assert.rejects(read(r, 'positions.geojson'), e => e.error === 'vector_position_limit')
		const page = await read(r, 'many.geojson', 'vector', 'attributes', { layerId: 'layer-0', offset: 1000, limit: 200 })
		assert.equal(page.rows.length, 20); assert.equal(page.rows[0].properties.value, 1000); assert.equal(page.nextOffset, null)
	} finally { await r.close() }
})

test('GIS startup cancellation jitter settles after installed worker termination', { ...installed, timeout: 30000 }, async () => {
	const r = await reader(), input = await retained(fixtures, ['points.geojson'])
	try {
		for (let n = 0; n < 24; n++) {
			const controller = new AbortController(), work = r.read({ members: input.members, kind: 'vector', operation: 'manifest', signal: controller.signal })
			const timer = setTimeout(() => controller.abort(), (n * 7) % 13)
			try { await assert.rejects(work, e => e.error === 'job_cancelled') } finally { clearTimeout(timer) }
			assert.equal(r.children.size, 0); assert.equal(r.active, false)
		}
	} finally { await r.close(); await input.close() }
})

test('GIS memory is a fixed installed ceiling; missing launcher never qualifies', async () => {
	assert.throws(() => new GisReader({ limits: { memoryBytes: 1048576 } }), e => e.error === 'invalid_budget')
	const r = new GisReader({ launcherPath: '/nonexistent-gc-gis-launcher' })
	try { await r.init(); assert.equal(r.availability.state, 'unavailable') } finally { await r.close() }
})
