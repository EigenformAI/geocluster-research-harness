import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

export const assayCsv = 'sample_id,longitude,latitude,gold_ppm\nDBG001,121.50,-32.20,0.10\nDBG002,121.51,-32.21,1.25\nDBG003,121.52,-32.22,2.50\n'

export function requireNativeProviders(info) {
	assert.equal(info?.filesContractVersion, 1); assert.equal(info.relayEpochFencingVersion, 1)
	assert.equal(info.ready, true); assert.equal(info.captures?.state, 'available'); assert.equal(info.preview?.state, 'available')
	return Object.fromEntries(['workbook', 'assay', 'vector', 'raster'].map(id => {
		const readiness = info.providerDetails?.find(p => p.id === id)?.readiness
		assert.equal(readiness?.state, 'available', `${id} unavailable`); assert.equal(readiness.confinement, 'verified', `${id} confinement not verified`)
		return [id, readiness]
	}))
}

export function verifyAssayPreview(preview) {
	assert.equal(preview.points?.length, 3); assert.equal(preview.counts?.invalidCoordinateRows, 0); assert.equal(preview.placement?.state, 'ready')
	for (const [n, point] of preview.points.entries()) {
		assert.equal(point.id, ['DBG001', 'DBG002', 'DBG003'][n]); assert.equal(point.value.state, 'detected'); assert.equal(point.value.value, [0.1, 1.25, 2.5][n])
		assert.equal(point.geometry.type, 'Point')
		for (const coordinates of [point.geometry.coordinates, preview.placement.displayByLocator[point.locator].coordinates]) {
			assert.equal(coordinates.length, 2)
			assert.ok(Math.abs(coordinates[0] - (121.5 + n / 100)) < 1e-8); assert.ok(Math.abs(coordinates[1] - (-32.2 - n / 100)) < 1e-8)
		}
	}
	return { points: 3, invalidCoordinateRows: 0, placement: 'ready' }
}

export function verifyWorkbookPreview(manifest, page) {
	assert.deepEqual(manifest.sheets.map(s => s.name), ['Data', 'Hidden', 'Empty'])
	assert.equal(page.matchingRows, 2); assert.equal(page.rows.length, 2)
	const cells = page.rows[0].cells
	assert.equal(cells[0].raw, '00123'); assert.equal(String(cells[1].raw), '2'); assert.equal(cells[1].formula, '1+1'); assert.equal(cells[1].cache, 'present')
	assert.equal(page.rows[1].cells[0].raw, 'Tail'); assert.equal(String(page.rows[1].cells[1].raw), '5')
	return { sheets: 3, rows: 2, cells: true, prepare: true, preview: true }
}

async function workbookFixture(format) {
	const { default: XLSX } = await import('xlsx')
	const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([['Identifier', 'Result'], ['00123', 2], ['Tail', 5]])
	// BIFF has a stored formula token stream; qualification never evaluates it.
	sheet.B2 = { t: 'n', v: 2, f: '1+1', bf: [7, 0, 0x1e, 1, 0, 0x1e, 1, 0, 0x03] }
	XLSX.utils.book_append_sheet(book, sheet, 'Data'); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['secret']]), 'Hidden'); XLSX.utils.book_append_sheet(book, {}, 'Empty')
	book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 2 }] }
	return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: format === 'xls' ? 'biff8' : 'xlsx', compression: true }))
}

function gateToken(projectId, key) {
	const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
	const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'qualification', project_id: projectId, aud: 'ide-proxy', iat: now, exp: now + 300, jti: crypto.randomUUID() })}`
	return `${data}.${crypto.createHmac('sha256', key).update(data).digest('base64url')}`
}

/** Exercise the normal gate and independently initialized daemon; no model calls. */
export async function qualifyWorkspaceFiles({ projectId, gateKey, timeoutMs = 300000 }) {
	assert.ok(projectId); assert.match(gateKey || '', /^[a-f0-9]{64}$/)
	const signal = AbortSignal.timeout(timeoutMs), base = 'http://127.0.0.1:3000'
	let cookie, fence = {}
	const request = async (route, { json, bytes, method = 'GET', authenticated = true, headers = {} } = {}) => {
		const response = await fetch(base + route, { method, headers: { ...fence, ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(json) : bytes, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) })
		const raw = await response.text(); assert.ok(Buffer.byteLength(raw) < 2 * 1048576)
		let body = raw; try { body = JSON.parse(raw) } catch {}
		return { status: response.status, body, cookie: response.headers.get('set-cookie') }
	}
	const wait = async action => {
		while (true) { signal.throwIfAborted(); const result = await action(); if (result) return result; await sleep(1000, undefined, { signal }) }
	}
	await wait(async () => { try { return (await request('/livez', { authenticated: false })).status === 200 } catch { return false } })
	assert.equal((await request('/files/info', { authenticated: false })).status, 401)
	const exchange = await request('/auth/exchange', { method: 'POST', json: { token: gateToken(projectId, gateKey) }, authenticated: false })
	assert.equal(exchange.status, 204); assert.match(exchange.cookie || '', /^__Host-gc_ide=/)
	cookie = exchange.cookie.split(';')[0]
	const info = await wait(async () => { const r = await request('/files/info'); return r.status === 200 && r.body?.ready === true ? r.body : null })
	assert.equal(info.projectId, projectId); assert.equal(info.cwd, `/workspace/${projectId}`)
	const providers = requireNativeProviders(info)
	fence ={ 'X-GC-Workspace-ID': info.workspaceId, 'X-GC-Workspace-Epoch': info.workspaceEpoch }
	const prefix = `qualification-${crypto.randomUUID()}`
	const jobResult = async admission => {
		if (admission.status === 201 || admission.status === 200) return admission.body
		assert.equal(admission.status, 202); assert.ok(admission.body.jobId)
		return wait(async () => {
			const job = await request(`/files/jobs/${admission.body.jobId}`); assert.equal(job.status, 200)
			assert.ok(!['failed', 'cancelled', 'interrupted'].includes(job.body.state), 'Fixture job failed')
			return job.body.state === 'succeeded' ? job.body.result : null
		})
	}
	const capture = async (filename, bytes) => {
		const sha = crypto.createHash('sha256').update(bytes).digest('hex')
		const upload = await request(`/files/upload?path=${filename}&operationId=${prefix}-${filename}`, { method: 'PUT', bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-GC-Process-Document': 'skip' } })
		assert.equal(upload.status, 201); assert.equal(upload.body.state, 'committed'); assert.equal(upload.body.publishedSource.digest.sha256, sha)
		const captured = await jobResult(await request('/files/captures', { method: 'POST', json: { requestId: `${prefix}-capture-${filename}`, path: filename, requireCoherentSource: true, computeDigest: true } }))
		assert.equal(captured.source.digest.sha256, sha)
		// Raw workbook bytes are not UTF-8; compare digest via a binary fetch.
		const binary = await fetch(`${base}/files/captures/${captured.source.captureId}/raw`, { headers: { ...fence, Cookie: cookie }, signal })
		assert.equal(binary.status, 200); assert.equal(crypto.createHash('sha256').update(Buffer.from(await binary.arrayBuffer())).digest('hex'), sha)
		return captured.source
	}
	const csvPath = `${prefix}-Samples.csv`
	const source = await capture(csvPath, Buffer.from(assayCsv))
	const prepared = await jobResult(await request('/files/preparations', { method: 'POST', json: { requestId: `${prefix}-assay`, type: 'assay', source, options: { mode: 'surface', columns: { id: 'sample_id', x: 'longitude', y: 'latitude', analyte: 'gold_ppm' }, sourceCrs: { code: 'EPSG:4326', axisOrder: 'xy' }, unit: { name: 'ppm', basis: 'user-assigned' } } } }))
	const query = await request(`/files/representations/${prepared.representation.id}/query`, { method: 'POST', json: { operation: 'preview' } }); assert.equal(query.status, 200)
	const csv = verifyAssayPreview(query.body)
	const preview = await request('/files/preview', { method: 'POST', json: { path: csvPath, format: 'csv', rowLimit: 4 } })
	assert.equal(preview.status, 200); assert.equal(preview.body.source.kind, 'runtime-fragment'); assert.equal(preview.body.rows[1].cells[0].text, 'DBG001')
	const fixtures = { csv: { ...csv, raw: true, preview: true } }
	for (const format of ['xls', 'xlsx']) {
		const source = await capture(`${prefix}-Book.${format}`, await workbookFixture(format))
		const result = await jobResult(await request('/files/preparations', { method: 'POST', json: { requestId: `${prefix}-${format}`, type: 'workbook', source, options: {} } }))
		assert.equal(result.representation.inputSha256, source.digest.sha256)
		const page = await request(`/files/representations/${result.representation.id}/query`, { method: 'POST', json: { sheet: 'sheet-0', mode: 'stored', headerRows: [0], rowOffset: 0, rowLimit: 5, columnOffset: 0, columnLimit: 2 } })
		assert.equal(page.status, 200); fixtures[format] = verifyWorkbookPreview(result.representation, page.body)
	}
	return { ok: true, auth: { authenticated: true, unauthenticatedStatus: 401 }, providers, fixtures }
}
