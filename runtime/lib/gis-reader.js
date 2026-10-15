import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { FileError, budget } from './file-contract.js'

export const GIS_PARSER = 'bounded-gdal-vector-v1'
export const ASSAY_PARSER = 'bounded-gdal-assay-v1'
export const GIS_LIMITS = Object.freeze({ inputBytes: 40 * 1048576, members: 32, features: 1000, positions: 20000, pageSize: 50, pageMaxSize: 200, bands: 32, previewEdge: 512, responseBytes: 2 * 1048576, memoryBytes: 512 * 1048576, elapsedMs: 30000, sourcePixels: 100000000, decodedBlockBytes: 128 * 1048576, assayRows: 10000, assayPoints: 10000, assayColumns: 128, assayCellBytes: 4096, assayManifestBytes: 16 * 1048576, assayResponseBytes: 16 * 1048576 })
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/
const error = (kind, message, status = 422) => new FileError(status, kind, `GisReader: ${message}`, { agent: 'file-service', tool: 'gis-reader', action: kind === 'worker_unavailable' ? 'Install the fixed GIS worker and qualify Linux confinement.' : 'Use a complete captured bundle and options within the advertised limits.' })
const unavailable = message => error('worker_unavailable', message, 503)
const cancelled = () => error('job_cancelled', 'GIS read cancelled.', 409)

/** Retained handles stay with the caller. Only verified bytes cross the native boundary. */
export class GisReader {
	constructor(config = {}, logger) {
		this.logger = logger; this.launcherPath = config.launcherPath || '/opt/geocluster-runtime/gis-launcher'; this.testRunner = config.testRunner
		if (this.testRunner && (this.testRunner.synthetic !== true || typeof this.testRunner.spawn !== 'function')) throw unavailable('Test runners must declare synthetic:true and spawn a process.')
		this.limits = Object.fromEntries(Object.entries(GIS_LIMITS).map(([key, value]) => [key, budget(config.limits?.[key], value, key === 'pageSize' ? GIS_LIMITS.pageMaxSize : value, key)]))
		if (this.limits.memoryBytes !== GIS_LIMITS.memoryBytes) throw error('invalid_budget', `memoryBytes is fixed by the installed launcher at ${GIS_LIMITS.memoryBytes}.`, 400)
		this.limits.pageSize = Math.min(this.limits.pageSize, this.limits.pageMaxSize)
		this.availability = { state: 'unavailable', reason: 'not-initialized', parser: GIS_PARSER }; this.children = new Set(); this.operations = new Set(); this.closed = false; this.active = false
	}
	async init() {
		if (this.closed) return
		if (this.initializing) return this.initializing
		this.initializing = (async () => {
			try {
				if (!this.testRunner) {
					if (!path.isAbsolute(this.launcherPath)) throw unavailable('Launcher path must be absolute.')
					for (let current = this.launcherPath; current !== '/'; current = path.dirname(current)) {
						const stat = await fs.lstat(current)
						if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022 || current === this.launcherPath && (!stat.isFile() || !(stat.mode & 0o4000))) throw unavailable('Launcher and parents must be root-controlled; launcher must be setuid-root.')
					}
				}
				if (this.closed) throw unavailable('GIS reader closed before qualification.')
				const result = await this.run({ probe: true, limits: GIS_LIMITS }, [])
				const expected = ['GeoJSON', 'ESRI Shapefile', 'MapInfo File: TAB', 'MapInfo File: MIF', 'GPKG', 'GTiff', 'ERS']
				if (this.closed || JSON.stringify(result.probe?.decoded) !== JSON.stringify(expected) || !this.testRunner && (result.probe?.assay !== ASSAY_PARSER || ['filesystemDenied', 'writeDenied', 'truncateDenied', 'descriptorTruncateDenied', 'socketDenied', 'executionDenied', 'processDenied', 'signalDenied'].some(key => result.probe[key] !== true)) || typeof result.build?.gdal !== 'string' || typeof result.build?.proj !== 'string') throw unavailable('Installed decode/denial probes did not qualify the worker.')
				this.availability = { state: 'available', parser: GIS_PARSER, confinement: this.testRunner ? 'synthetic-test-only' : 'verified', build: result.build, probe: result.probe }
			} catch (cause) {
				this.startupError = cause instanceof FileError ? cause : unavailable(`Startup failed (${cause.code || 'probe'}).`)
				this.availability = this.closed ? { state: 'unavailable', parser: GIS_PARSER, reason: 'closed' } : { state: 'unavailable', parser: GIS_PARSER, reason: 'confinement-probe', diagnostic: this.startupError.message }
			}
		})()
		return this.initializing
	}
	read(request) {
		const work = this.readRetained(request); this.operations.add(work)
		work.finally(() => this.operations.delete(work)).catch(() => {})
		return work
	}
	async readRetained({ members, kind, operation, options = {}, signal }) {
		if (this.closed || this.availability.state !== 'available') throw this.startupError || unavailable('GIS reader is not ready.')
		if (this.active) throw error('capacity', 'Another GIS read is active.', 429)
		if (signal?.aborted) throw cancelled()
		if (!['vector', 'raster', 'assay'].includes(kind) || !['manifest', 'preview', 'attributes', 'map-display'].includes(operation) || kind !== 'raster' && operation === 'map-display' || kind !== 'vector' && operation === 'attributes' || kind === 'assay' && operation !== 'manifest') throw error('gis_invalid_options', 'Invalid GIS kind or operation.', 400)
		if (!Array.isArray(members) || !members.length || members.length > this.limits.members) throw error('gis_bundle_invalid', 'Supply one primary and at most the configured number of members.', 400)
		const names = new Set()
		for (const member of members) {
			if (!namePattern.test(member.name || '') || member.name.includes('..') || member.name.endsWith(' ') || names.has(member.name.toLowerCase()) || typeof member.handle?.read !== 'function') throw error('gis_bundle_invalid', 'Members require unique case-folded basenames and retained handles.', 400)
			names.add(member.name.toLowerCase())
		}
		this.active = true; this.controller = new AbortController(); signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
		try {
			const records = []; let total = 0
			for (const member of members) {
				const before = await member.handle.stat({ bigint: true }), length = Number(before.size)
				if (!before.isFile() || !Number.isSafeInteger(length) || length !== member.source?.sizeBytes) throw error('source_integrity', 'Retained input length differs from capture.', 409)
				const expected = member.source.digest?.state === 'ready' ? member.source.digest.sha256 : null
				if (member.source.digest?.state === 'ready' && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) throw error('source_integrity', 'Invalid captured ready digest.', 409)
				total += length; if (total > this.limits.inputBytes) throw error('gis_input_limit', 'Aggregate retained input exceeds the byte limit.', 413)
				records.push({ ...member, before, length, expected })
			}
			if (signal.aborted) throw cancelled()
			const responseBytes = kind === 'assay' ? this.limits.assayResponseBytes : this.limits.responseBytes
			const header = { kind, operation, options, primary: members[0].name, members: records.map(r => ({ name: r.name, byteLength: r.length })), limits: { ...this.limits, responseBytes } }
			if (Buffer.byteLength(JSON.stringify(header)) > 16384) throw error('gis_invalid_options', 'Request header exceeds 16 KiB.', 400)
			const result = await this.run(header, records, signal)
			for (const record of records) {
				const after = await record.handle.stat({ bigint: true })
				if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => after[key] !== record.before[key])) throw error('source_integrity', 'Retained member changed during delivery.', 409)
			}
			if (signal.aborted || this.closed) throw cancelled()
			const payload = result.payload
			if (!payload || payload.parser !== (kind === 'assay' ? ASSAY_PARSER : kind === 'raster' ? operation === 'map-display' ? 'bounded-gdal-raster-map-v1' : 'bounded-gdal-raster-v1' : GIS_PARSER) || payload.schemaVersion !== (kind === 'vector' && operation === 'preview' ? 3 : 1) || 'sources' in payload) throw unavailable('Native result does not match the requested schema.')
			const boundPayload = { ...payload, inputDigests: result.inputDigests }
			if (Buffer.byteLength(JSON.stringify(boundPayload)) > responseBytes) throw error(kind === 'assay' ? 'assay_response_limit' : kind === 'vector' && operation === 'preview' ? 'vector_response_limit' : 'gis_response_limit', 'Result with input digests exceeds the response ceiling.', 413)
			return boundPayload
		} finally { this.active = false; this.controller = null }
	}
	run(header, records, signal) {
		return new Promise((resolve, reject) => {
			let child
			try { child = this.testRunner ? this.testRunner.spawn() : spawn(this.launcherPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} }) } catch (cause) { reject(unavailable(`Launcher spawn failed (${cause.code}).`)); return }
			this.children.add(child)
			const stopped = new Promise(resolve => child.once('close', resolve)), decoder = new StringDecoder('utf8')
			let ready = false, terminal, failure, pending = '', output = 0, errors = '', feeding
			const inputDigests = [], fail = cause => { failure ||= cause; child.kill('SIGTERM') }
			const timer = setTimeout(() => fail(error('gis_time_limit', 'GIS read reached its elapsed ceiling.', 408)), header.limits.elapsedMs)
			const abort = () => fail(cancelled()); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
			const write = async bytes => { if (!child.stdin.write(bytes)) await Promise.race([once(child.stdin, 'drain'), stopped.then(() => { throw unavailable('Worker exited during byte delivery.') })]) }
			const feed = async () => {
				await write(`${JSON.stringify(header)}\n`)
				for (const record of records) {
					const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let position = 0
					while (position < record.length) {
						if (failure) return
						const { bytesRead } = await record.handle.read(buffer, 0, Math.min(buffer.length, record.length - position), position)
						if (!bytesRead) throw error('source_integrity', 'Retained member ended before its exact length.', 409)
						const bytes = Buffer.from(buffer.subarray(0, bytesRead)); hash.update(bytes); position += bytesRead; await write(bytes)
					}
					if ((await record.handle.read(buffer, 0, 1, record.length)).bytesRead) throw error('source_integrity', 'Retained member exceeds its exact length.', 409)
					const sha256 = hash.digest('hex'); if (record.expected !== null && sha256 !== record.expected) throw error('source_integrity', 'Processed bytes differ from the captured digest.', 409)
					inputDigests.push({ name: record.name, sha256 })
				}
				child.stdin.end()
			}
			child.stdout.on('data', bytes => {
				if (failure) return
				output += bytes.length; if (output > header.limits.responseBytes + 16384) return fail(error(header.kind === 'assay' ? 'assay_response_limit' : header.kind === 'vector' && header.operation === 'preview' ? 'vector_response_limit' : 'gis_response_limit', 'Worker response exceeds its ceiling.', 413))
				pending += decoder.write(bytes)
				try {
					let newline
					while ((newline = pending.indexOf('\n')) >= 0) {
						const message = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1)
						if (!ready) {
							if (!message.ready || message.parser !== GIS_PARSER || !this.testRunner && (message.uid !== 997 || message.confinement !== 'installed')) throw unavailable('Native identity handshake failed.')
							ready = true; feeding = feed().catch(fail)
						} else if (terminal) throw unavailable('Worker sent multiple terminal records.')
						else if (message.error) { terminal = message; failure = error(message.error.reason, message.error.message, message.error.reason === 'worker_unavailable' ? 503 : /^assay_.*_limit$/.test(message.error.reason) ? 413 : 422) }
						else if (header.probe ? message.probe : message.payload) terminal = message
						else throw unavailable('Unexpected worker protocol record.')
					}
				} catch (cause) { fail(cause instanceof FileError ? cause : unavailable('Worker sent malformed JSON.')) }
			})
			child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(0, 4096) })
			child.stdin.on('error', cause => fail(unavailable(`Worker pipe failed (${cause.code}).`)))
			child.once('error', cause => { failure ||= unavailable(`Launcher failed (${cause.code}).`) })
			child.once('close', async (code, nativeSignal) => {
				clearTimeout(timer); signal?.removeEventListener('abort', abort); this.children.delete(child); await feeding
				if (failure) return reject(failure)
				if (code !== 0 || nativeSignal) return reject(error(code === 137 || code === 152 || nativeSignal ? 'gis_resource_limit' : 'worker_unavailable', `Native worker exited (${nativeSignal || code}). ${errors}`, 503))
				if (!ready || !terminal || pending || decoder.end() || !header.probe && inputDigests.length !== records.length) return reject(unavailable('Worker exited without a complete result and verified input delivery.'))
				resolve({ ...terminal, inputDigests })
			})
		})
	}
	async close() {
		this.closed = true; this.availability = { state: 'unavailable', parser: GIS_PARSER, reason: 'closed' }; this.controller?.abort()
		await Promise.all([...this.children].map(child => { const stopped = once(child, 'close'); child.kill('SIGTERM'); return stopped }))
		await this.initializing
		await Promise.allSettled([...this.operations])
	}
}
