import { qualifyNativeReaders, qualificationFailure, QUALIFICATION_DEADLINE_MS } from './lib/native-reader-qualification.mjs'

const readers = {}
let emitted = false, expired = false
process.stdout.on('error', () => process.exit(1))
const emit = ({ json, exitCode }) => {
	if (emitted) return
	emitted = true
	// Explicit exit also bounds a reader whose init/close cannot settle after timeout.
	process.stdout.write(json, error => { clearTimeout(watchdog); process.exit(error || expired ? 1 : exitCode) })
}
const watchdog = setTimeout(() => {
	expired = true
	for (const reader of Object.values(readers)) void reader.close().catch(() => {})
	emit(qualificationFailure('deadline', 'Native reader qualification exceeded its 120000 ms deadline.'))
	// A blocked report pipe must not extend the command's deadline either.
	setImmediate(() => process.exit(1))
}, QUALIFICATION_DEADLINE_MS)

try {
	if (process.getuid?.() !== 998) emit(qualificationFailure('service-uid', 'Run native reader qualification as gc-files (UID 998).'))
	else if (process.argv.length !== 2) emit(qualificationFailure('arguments', 'Native reader qualification accepts no arguments; use the fixed production installation.'))
	else {
		const [{ GisReader }, { WorkbookReader }] = await Promise.all([import('../lib/gis-reader.js'), import('../lib/workbook-reader.js')])
		readers.gis = new GisReader()
		readers.workbook = new WorkbookReader()
		emit(await qualifyNativeReaders(readers))
	}
} catch (cause) {
	await Promise.allSettled(Object.values(readers).map(reader => reader.close()))
	emit(qualificationFailure('process-failed', cause?.message || 'Native reader qualification process failed.'))
}
