import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'

const launcher = process.env.GIS_INSTALLED_LAUNCHER
const fixtures = process.env.GIS_RASTER_MAP_FIXTURES
const installed = { skip: !launcher || !fixtures ? 'Set GIS_INSTALLED_LAUNCHER and GIS_RASTER_MAP_FIXTURES for confined native tests.' : false }

// Exercise the installed IPC directly, independently of facade option validation.
async function native(primary, options = {}, limits = {}, operation = 'map-display', kind = 'raster') {
	const names = primary.endsWith('.ers') ? [primary, primary.slice(0, -4)] : [primary]
	const buffers = await Promise.all(names.map(name => fs.readFile(path.join(fixtures, name))))
	const header = { kind, operation, options, limits, primary, members: names.map((name, i) => ({ name, byteLength: buffers[i].length })) }
	return new Promise((resolve, reject) => {
		const child = spawn(launcher, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} })
		let output = '', stderr = '', fed = false
		child.once('error', reject); child.stdin.on('error', reject)
		child.stdout.on('data', bytes => {
			output += bytes
			if (!fed && output.includes('\n')) {
				fed = true
				try { const ready = JSON.parse(output.slice(0, output.indexOf('\n'))); assert.equal(ready.ready, true); assert.equal(ready.uid, 997); assert.equal(ready.confinement, 'installed') } catch (error) { child.kill('SIGTERM'); reject(error); return }
				child.stdin.end(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ...buffers]))
			}
		})
		child.stderr.on('data', bytes => { stderr += bytes })
		child.once('close', code => {
			try { assert.equal(code, 0, stderr); const lines = output.trim().split('\n'); assert.equal(lines.length, 2, output); resolve(JSON.parse(lines[1])) } catch (error) { reject(error) }
		})
	})
}
async function display(primary, options, limits) {
	const result = await native(primary, options, limits)
	assert.equal(result.error, undefined, JSON.stringify(result.error)); assert.equal(result.payload.kind, 'raster-map-display')
	return result.payload
}

// Decode PNG without another geospatial library. GDAL emits 8-bit RGBA, PNG filters 0–4.
function png(image) {
	const bytes = Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64')
	assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
	assert.equal(bytes[24], 8); assert.equal(bytes[25], 6); assert.equal(bytes[28], 0)
	assert.equal(width, image.width); assert.equal(height, image.height)
	const chunks = []
	for (let p = 8; p < bytes.length;) { const n = bytes.readUInt32BE(p); if (bytes.toString('ascii', p + 4, p + 8) === 'IDAT') chunks.push(bytes.subarray(p + 8, p + 8 + n)); p += n + 12 }
	const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4, rgba = Buffer.alloc(stride * height)
	assert.equal(raw.length, (stride + 1) * height)
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4)
		for (let x = 0; x < stride; x++) {
			const i = y * stride + x, a = x >= 4 ? rgba[i - 4] : 0, b = y ? rgba[i - stride] : 0, c = y && x >= 4 ? rgba[i - stride - 4] : 0
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
			const predictor = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]
			rgba[i] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255
		}
	}
	return { width, height, rgba }
}
const mercator = ([lon, lat]) => [6378137 * lon * Math.PI / 180, 6378137 * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))]
const geographic = ([x, y]) => [x / 6378137 * 180 / Math.PI, (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI]
const affine = (gt, x, y) => [gt[0] + gt[1] * x + gt[2] * y, gt[3] + gt[4] * x + gt[5] * y]
function sourcePixel(gt, x, y) {
	const det = gt[1] * gt[5] - gt[2] * gt[4], dx = x - gt[0], dy = y - gt[3]
	return [(gt[5] * dx - gt[2] * dy) / det, (-gt[4] * dx + gt[1] * dy) / det]
}
function verifyWarp(product, gt, sourceGeographic, selected = 1, masked = true) {
	const image = png(product.image), [west, south, east, north] = product.extent
	let opaque = 0, outside = 0, independentMask = 0, nodata = 0
	for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
		const map = [west + (x + 0.5) / image.width * (east - west), north - (y + 0.5) / image.height * (north - south)]
		const [px, py] = sourcePixel(gt, ...(sourceGeographic ? geographic(map) : map))
		// Avoid floating-point ambiguities at source cell boundaries.
		if (Math.abs(px - Math.round(px)) < 1e-7 || Math.abs(py - Math.round(py)) < 1e-7) continue
		const inSource = px >= 0 && py >= 0 && px < 4 && py < 4, cell = Math.floor(py) * 4 + Math.floor(px)
		const alpha = image.rgba[(y * image.width + x) * 4 + 3]
		const valid = inSource && cell !== 15 && (!masked || cell !== 5)
		assert.equal(alpha, valid ? 255 : 0, `geography at output ${x},${y} -> source ${px},${py}`)
		if (!inSource) outside++
		else if (cell === 15) nodata++
		else if (masked && cell === 5) independentMask++
		else {
			opaque++
			const value = selected === 1 ? 10 + cell * 10 : 310 - cell * 20
			const stretch = product.image.stretch
			const expected = Math.round(255 * (value - stretch.minimum) / (stretch.maximum - stretch.minimum))
			assert.equal(image.rgba[(y * image.width + x) * 4], expected)
		}
	}
	assert.ok(opaque > 0); assert.ok(nodata > 0); if (masked) assert.ok(independentMask > 0)
	return { outside, image }
}

for (const [primary, gt, degrees] of [
	['rotated.tif', [13000000, 1000, 700, -3000000, 700, -1000], false],
	['sheared.tif', [120, 0.04, 0.025, -30, 0.012, -0.03], true],
]) test(`native positioned raster: ${primary} preserves geography, independent mask, and nodata`, installed, async () => {
	const product = await display(primary)
	assert.equal(product.schemaVersion, 1); assert.equal(product.parser, 'bounded-gdal-raster-map-v1'); assert.equal(product.state, 'ready'); assert.equal(product.displayCrs, 'EPSG:3857')
	assert.deepEqual(product.geoTransform, gt); assert.equal(product.bandCount, 2); assert.equal(product.image.band, 1)
	assert.equal(product.bands[0].unit, 'nT'); assert.equal(product.bands[0].scale, 2); assert.equal(product.bands[0].offset, 100); assert.equal(product.bands[0].nodata, 65535)
	assert.equal(product.sourceFrame.basis, 'declared'); assert.match(product.operation.engine, /GDAL .*PROJ/); assert.equal(product.operation.policy, 'strict'); assert.ok(product.operation.identity)
	assert.match(product.environmentFingerprint, /gdal=.*proj=.*proj-db=/); assert.equal(product.environment.networkEnabled, false)
	assert.equal(product.image.stretch.label, 'Display stretch'); assert.equal(product.image.scaleOffsetApplied, false)
	assert.ok(Math.max(product.image.width, product.image.height) <= 512); assert.ok(Buffer.byteLength(JSON.stringify(product)) <= 2 * 1048576)
	const ring = product.footprint.coordinates[0]; assert.equal(product.footprint.type, 'Polygon'); assert.ok(ring.length >= 257); assert.deepEqual(ring[0], ring.at(-1))
	for (let corner = 0; corner < 4; corner++) {
		const [x, y] = [[0, 0], [4, 0], [4, 4], [0, 4]][corner], expected = degrees ? mercator(affine(gt, x, y)) : affine(gt, x, y)
		assert.ok(Math.abs(ring[corner * (ring.length - 1) / 4][0] - expected[0]) < 1e-5)
		assert.ok(Math.abs(ring[corner * (ring.length - 1) / 4][1] - expected[1]) < 1e-5)
	}
	assert.ok(verifyWarp(product, gt, degrees).outside > 0, 'A bbox-stretched thumbnail would incorrectly fill these pixels')
})

test('native raster band selection changes display while preserving selected-band metadata and geography', installed, async () => {
	const first = await display('rotated.tif'), second = await display('rotated.tif', { band: 2 })
	assert.deepEqual(first.extent, second.extent); assert.equal(second.image.band, 2); assert.equal(second.bands[1].description, 'decreasing')
	assert.notEqual(first.image.dataUrl, second.image.dataUrl); verifyWarp(second, second.geoTransform, false, 2)
	assert.equal((await native('rotated.tif', { band: 3 })).error.reason, 'gis_invalid_options')
})

test('native ERS retained companion yields a positioned PNG with nodata transparency', installed, async () => {
	const product = await display('northup.ers'); assert.equal(product.driver, 'ERS'); assert.equal(product.sourceFrame.basis, 'declared')
	verifyWarp(product, [120, 0.04, 0, -30, 0, -0.03], true, 1, false)
})

test('native raster refuses unknown/unpositioned/singular/out-of-Mercator sources and wrong axes', installed, async () => {
	for (const [primary, reason] of [['unknown.tif', 'gis_source_crs_unknown'], ['unpositioned.tif', 'gis_georeference_required'], ['singular.tif', 'gis_metadata_invalid'], ['nonfinite.tif', 'gis_metadata_invalid'], ['polar.tif', 'gis_display_domain'], ['dateline.tif', 'gis_display_domain'], ['rotated-ers.ers', 'gis_georeference_required']]) {
		const result = await native(primary); assert.equal(result.payload?.state, undefined, `${primary} must not publish a ready image`); assert.equal(result.error.reason, reason, JSON.stringify(result.error))
	}
	const wrong = await native('sheared.tif', { displayOptions: { sourceCrs: { code: 'EPSG:4326', axisOrder: 'yx' } } })
	assert.equal(wrong.payload, undefined); assert.equal(wrong.error.reason, 'gis_display_domain')
	const assumed = await display('unknown.tif', { displayOptions: { sourceCrs: { code: 'EPSG:4326', axisOrder: 'xy' } } })
	assert.equal(assumed.sourceFrame.basis, 'user-assumed'); verifyWarp(assumed, assumed.geoTransform, true, 1, false)
	for (const displayOptions of [{ sourceCrs: { code: 'EPSG:4326', axisOrder: 'bad' } }, { sourceCrs: { code: 'EPSG:9999999', axisOrder: 'xy' } }, { allowApproximate: 'yes' }, { environmentFingerprint: 'changed' }]) {
		const result = await native('sheared.tif', { displayOptions }); assert.equal(result.payload, undefined); assert.equal(result.error.reason, displayOptions.environmentFingerprint ? 'gis_environment_changed' : 'gis_invalid_options')
	}
})

test('native positioned raster preserves fractional alpha masks in the output PNG', installed, async () => {
	const product = await display('alpha.tif'), image = png(product.image), [west, south, east, north] = product.extent
	assert.ok(product.bands[0].maskFlags.includes('alpha')); let fractional = 0
	for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
		const [px, py] = sourcePixel(product.geoTransform, west + (x + 0.5) / image.width * (east - west), north - (y + 0.5) / image.height * (north - south))
		if (Math.abs(px - Math.round(px)) < 1e-7 || Math.abs(py - Math.round(py)) < 1e-7) continue
		const inside = px >= 0 && py >= 0 && px < 4 && py < 4, cell = Math.floor(py) * 4 + Math.floor(px)
		const expected = !inside || cell === 5 || cell === 15 ? 0 : cell === 6 ? 96 : 255
		assert.equal(image.rgba[(y * image.width + x) * 4 + 3], expected)
		if (expected === 96) fractional++
	}
	assert.ok(fractional > 0)
})

test('native raster strict preferred missing-grid failure requires explicit recorded approximation', installed, async () => {
	const strict = await native('missing-grid.tif'); assert.equal(strict.payload, undefined); assert.equal(strict.error.reason, 'gis_transformation_unavailable'); assert.match(strict.error.message, /missing grids/)
	const approximate = await display('missing-grid.tif', { displayOptions: { allowApproximate: true } })
	assert.equal(approximate.operation.policy, 'approximate'); assert.ok(approximate.operation.identity)
})

test('native map display enforces source, decoded-work, response and image limits', installed, async () => {
	assert.equal((await native('rotated.tif', {}, { sourcePixels: 15 })).error.reason, 'raster_pixel_limit')
	assert.equal((await native('rotated.tif', {}, { decodedBlockBytes: 64 })).error.reason, 'raster_block_limit')
	assert.equal((await native('rotated.tif', {}, { responseBytes: 1024 })).error.reason, 'gis_response_limit')
	const product = await display('rotated.tif', {}, { previewEdge: 32 }); assert.equal(Math.max(product.image.width, product.image.height), 32)
	assert.equal((await native('rotated.tif', {}, {}, 'map-display', 'vector')).error.reason, 'gis_invalid_options')
})
