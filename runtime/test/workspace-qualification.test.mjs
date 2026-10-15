import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requireNativeProviders, verifyAssayPreview, verifyWorkbookPreview } from '../scripts/lib/workspace-qualification.mjs'

const kernelOff = (launcher, abi, stage = 'landlock-abi-query') => ({ state: 'unavailable', parser: 'test', reason: 'confinement-probe', diagnostic: `${launcher}: stage=${stage} result=-1 requiredAbi=${abi}${stage === 'landlock-abi-query' ? ' errno=38' : ''}` })

test('providers off for a kernel without Landlock cannot qualify even with the former bypass option', () => {
	const info = { filesContractVersion: 1, relayEpochFencingVersion: 1, ready: true, captures: { state: 'available' }, preview: { state: 'available' }, providerDetails: [
		{ id: 'workbook', readiness: kernelOff('workbook-launcher', 1) },
		...['assay', 'vector', 'raster'].map(id => ({ id, readiness: kernelOff('gis-launcher', 3) })),
	] }
	assert.throws(() => requireNativeProviders(info))
	assert.throws(() => requireNativeProviders(info, { allowKernelUnavailable: true }))
	const brokenSandbox = structuredClone(info); brokenSandbox.providerDetails[0].readiness = kernelOff('workbook-launcher', 1, 'landlock-restrict-self')
	assert.throws(() => requireNativeProviders(brokenSandbox, { allowKernelUnavailable: true }))
	const unsandboxed = structuredClone(info); unsandboxed.providerDetails[1].readiness = { state: 'available', confinement: 'synthetic-test-only' }
	assert.throws(() => requireNativeProviders(unsandboxed, { allowKernelUnavailable: true }))
})

test('daemon qualification rejects disabled, missing, synthetic and incomplete native providers', () => {
	const info = { filesContractVersion: 1, relayEpochFencingVersion: 1, ready: true, captures: { state: 'available' }, preview: { state: 'available' }, providerDetails: ['workbook', 'assay', 'vector', 'raster'].map(id => ({ id, readiness: { state: 'available', confinement: 'verified' } })) }
	assert.equal(Object.keys(requireNativeProviders(info)).length, 4)
	for (const mutate of [i => i.providerDetails.pop(), i => i.providerDetails[0].readiness.state = 'unavailable', i => i.providerDetails[1].readiness.confinement = 'synthetic-test-only', i => i.captures.state = 'unavailable']) {
		const wrong = structuredClone(info); mutate(wrong); assert.throws(() => requireNativeProviders(wrong))
	}
})

test('assay qualification requires the actual three identities, values and longitude-first placement', () => {
	const points = ['DBG001', 'DBG002', 'DBG003'].map((id, n) => ({ id, locator: `Samples.csv:${n + 2}`, geometry: { type: 'Point', coordinates: [121.5 + n / 100, -32.2 - n / 100] }, value: { state: 'detected', value: [0.1, 1.25, 2.5][n] } }))
	const preview = { points, counts: { invalidCoordinateRows: 0 }, placement: { state: 'ready', displayByLocator: Object.fromEntries(points.map(p => [p.locator, { coordinates: p.geometry.coordinates }])) } }
	assert.equal(verifyAssayPreview(preview).points, 3)
	for (const mutate of [p => p.points.pop(), p => p.points[0].id = 'wrong', p => p.points[1].value.value = 125, p => p.placement.displayByLocator['Samples.csv:2'].coordinates.reverse(), p => p.counts.invalidCoordinateRows = 1]) {
		const wrong = structuredClone(preview); mutate(wrong); assert.throws(() => verifyAssayPreview(wrong))
	}
})

test('workbook qualification preserves identifier text and stored formula values without evaluation', () => {
	const manifest = { sheets: [{ name: 'Data' }, { name: 'Hidden' }, { name: 'Empty' }] }
	const page = { matchingRows: 2, rows: [{ cells: [{ raw: '00123' }, { raw: 2, formula: '1+1', cache: 'present' }] }, { cells: [{ raw: 'Tail' }, { raw: 5 }] }] }
	assert.equal(verifyWorkbookPreview(manifest, page).cells, true)
	for (const mutate of [p => p.rows[0].cells[0].raw = 123, p => p.rows[0].cells[1].raw = 0, p => p.rows[0].cells[1].cache = 'missing', p => p.matchingRows = 1]) {
		const wrong = structuredClone(page); mutate(wrong); assert.throws(() => verifyWorkbookPreview(manifest, wrong))
	}
})
