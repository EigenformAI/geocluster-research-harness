export const QUALIFICATION_REPORT_BYTES = 32768
export const QUALIFICATION_DEADLINE_MS = 120000
const readerReportBytes = 12288

function failure(reason, diagnostic) {
	return { state: 'unavailable', reason, diagnostic: String(diagnostic).slice(0, 1024) }
}

export function qualificationFailure(reason, diagnostic) {
	return { json: JSON.stringify({ error: failure(reason, diagnostic) }) + '\n', exitCode: 1 }
}

function snapshot(availability) {
	try {
		const json = JSON.stringify(availability)
		if (typeof json !== 'string') throw new Error('Missing reader availability.')
		if (Buffer.byteLength(json) > readerReportBytes) return failure('report-limit', 'Reader evidence exceeds the qualification report limit.')
		const result = JSON.parse(json)
		if (!result || typeof result !== 'object' || Array.isArray(result) || !['available', 'unavailable'].includes(result.state)) throw new Error('Invalid reader availability.')
		return result
	} catch { return failure('invalid-output', 'Reader availability is not a valid bounded JSON result.') }
}

// Only tests supply fake readers here. The executable constructs fresh native readers.
export async function qualifyNativeReaders({ gis, workbook }, { deadlineMs = QUALIFICATION_DEADLINE_MS } = {}) {
	const readers = { gis, workbook }, report = {}
	let closing, timer
	const close = () => closing ||= Promise.all(Object.values(readers).map(async reader => {
		try { await reader.close() } catch (cause) { report.error ||= failure('close-failed', cause?.message || 'Reader close failed.') }
	}))
	const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(true), deadlineMs) })
	const work = (async () => {
		await Promise.all(Object.entries(readers).map(async ([name, reader]) => {
			try { await reader.init(); report[name] = snapshot(reader.availability) }
			catch (cause) { report[name] = failure('init-failed', cause?.message || 'Reader initialization failed.') }
		}))
		await close()
		return false
	})()
	try {
		if (await Promise.race([work, deadline])) {
			report.error = failure('deadline', `Native reader qualification exceeded its ${deadlineMs} ms deadline.`)
			for (const name of Object.keys(readers)) report[name] ||= failure('deadline', 'Reader initialization did not complete.')
			void close()
		}
		const exitCode = !report.error && ['gis', 'workbook'].every(name => report[name].state === 'available' && report[name].confinement === 'verified') ? 0 : 1
		const json = JSON.stringify(report) + '\n'
		if (Buffer.byteLength(json) > QUALIFICATION_REPORT_BYTES) return qualificationFailure('report-limit', 'Native qualification report exceeds its byte limit.')
		return { json, exitCode }
	} finally { clearTimeout(timer) }
}
