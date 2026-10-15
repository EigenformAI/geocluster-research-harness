import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { releaseNativeImage } from './fly-native-release.mjs'
import { inspectCommand } from './fly-qualification-commands.mjs'

const image = `registry.fly.io/geocluster-ai-ide@sha256:${'a'.repeat(64)}`
const newer = `registry.fly.io/geocluster-ai-ide@sha256:${'b'.repeat(64)}`
const native = { gis: { state: 'available', confinement: 'verified', probe: { filesystemDenied: true } }, workbook: { state: 'available', confinement: 'verified' } }
const files = {
	ok: true,
	auth: { authenticated: true, unauthenticatedStatus: 401 },
	providers: Object.fromEntries(['workbook', 'assay', 'vector', 'raster'].map(name => [name, { state: 'available', confinement: 'verified' }])),
	fixtures: {
		csv: { points: 3, invalidCoordinateRows: 0, placement: 'ready', raw: true, preview: true },
		xls: { sheets: 3, rows: 2, cells: true, prepare: true, preview: true },
		xlsx: { sheets: 3, rows: 2, cells: true, prepare: true, preview: true },
	},
}

function inspectConfig(config) {
	let report
	runInNewContext(inspectCommand.at(-1).replace(/^import .*;\n/m, ''), {
		fs: {
			readFileSync(path) {
				if (path.startsWith('/boot/config-') && config !== null) return config
				throw new Error('inaccessible')
			},
			existsSync: () => false,
			statSync: () => { throw new Error('not installed') },
			readdirSync: () => [],
		},
		os: { arch: () => 'x64', release: () => '6.12.0' },
		console: { log: json => { report = JSON.parse(json) } },
	}, { timeout: 1000 })
	return report.kernelConfig
}

function fake(options = {}) {
	const calls = [], deleted = [], volumes = [{ id: 'vol_old', name: 'workspace' }], machines = []
	const qualificationVolumes = [], qualificationMachines = []
	if (options.existingMachine) machines.push({ id: 'machine_old' })
	let published = false, config, appName, appDeleted = false, gateReads = 0
	const adapter = {
		async api(method, path, body, requestOptions) {
			calls.push({ method, path, body, requestOptions })
			const appVolumes = path.includes(appName) ? qualificationVolumes : volumes
			const appMachines = path.includes(appName) ? qualificationMachines : machines
			if (method === 'DELETE') {
				const id = path.split('/').at(-1).split('?')[0]
				deleted.push(id)
				if (id === appName) appDeleted = true
				if (options.cleanupFail === id) throw new Error('token-and-config-must-not-leak')
				const list = path.includes('/machines/') ? appMachines : appVolumes
				const i = list.findIndex(x => x.id === id)
				if (path.includes('/machines/') && options.asyncMachineDelete && i !== -1) { list[i].state = 'destroying'; list[i].deletePolls = 2; return { ok: true } }
				if (path.includes('/machines/')) for (const volume of appVolumes) if (volume.attached_machine_id === id) volume.attached_machine_id = null
				if (path.includes('/volumes/') && options.softDeleteVolumes && i !== -1) { list[i].state = options.softDeleteVolumes === true ? 'pending_destroy' : options.softDeleteVolumes; return structuredClone(list[i]) }
				if (i !== -1) list.splice(i, 1)
				return { ok: true }
			}
			if (path === '/apps' && method === 'POST') { appName = body.app_name; return { id: 'app_owned' } }
			if (path.endsWith('/volumes') && method === 'POST') {
				if (options.uncertainVolume && path.includes(appName)) throw new Error('lost response')
				const volume = { id: path.includes(appName) ? 'vol_gate' : 'vol_publish', region: 'sin', name: 'workspace', state: 'created' }
				appVolumes.push(volume)
				if (path.includes(appName) && options.unknownQualificationVolume) appVolumes.push({ id: 'vol_unknown_gate', state: options.unknownQualificationVolume })
				return volume
			}
			if (path.endsWith('/machines') && method === 'POST') {
				config = body.config
				const machine = { id: 'machine_gate', state: 'started', instance_id: 'instance_gate', region: 'sin', config, image_ref: { digest: image.split('@')[1] } }
				appMachines.push(machine); appVolumes[0].attached_machine_id = machine.id
				return options.missingMachineId ? {} : structuredClone(machine)
			}
			if (path.endsWith('/exec')) {
				const command = body.command.join(' ')
				if (command.includes('qualify-native-readers.mjs')) return { exit_code: 0, stdout: '' }
				if (command.includes('qualify-workspace-files.mjs')) return { exit_code: 0, stdout: '' }
				if (command.includes('native.done')) return { exit_code: 0, stdout: JSON.stringify(options.neverCompletes ? { done: false } : { done: true, exitCode: options.nativeExit ?? (options.nativeFail ? 1 : 0), report: options.nativeReport ?? (options.synthetic ? { ...native, gis: { state: 'available', confinement: 'synthetic-test-only' } } : native) }) }
				if (command.includes('files.done')) return { exit_code: 0, stdout: options.malformed ? 'not JSON' : JSON.stringify({ done: true, exitCode: options.filesFail ? 1 : 0, report: { ...(options.filesReport ?? files), secret: config.env.IDE_PROXY_KEY } }) }
				return { exit_code: 0, stdout: JSON.stringify({ architecture: 'x86_64', kernelRelease: '6.12.0', lsm: 'landlock', daemon: { uid: 998, Seccomp: 2 }, ...(options.kernelConfig !== undefined ? { kernelConfig: inspectConfig(options.kernelConfig) } : {}) }) }
			}
			if (path.endsWith('/machines')) return structuredClone(appMachines)
			if (path.endsWith('/volumes')) return structuredClone(appVolumes)
			if (path.includes('/machines/')) {
				const machine = appMachines.find(m => path.endsWith(m.id))
				if (!machine) return null
				if (machine.id === 'machine_gate') {
					gateReads++
					if (gateReads >= 3 && options.changedQualificationInstance) machine.instance_id = 'instance_changed'
					if (gateReads >= 3 && options.changedQualificationImage) { machine.config.image = newer; machine.image_ref.digest = newer.split('@')[1] }
				}
				if (machine.id === 'machine_publish' && options.changedPublicationInstance) machine.instance_id = 'instance_changed'
				if (machine.state === 'destroying' && !options.neverDestroy) {
					if (machine.deletePolls-- === 0) {
						machine.state = 'destroyed'
						for (const volume of appVolumes) if (volume.attached_machine_id === machine.id) volume.detachPolls = 2
					}
				}
				return structuredClone(machine)
			}
			if (path.includes('/volumes/')) {
				const volume = appVolumes.find(v => path.endsWith(v.id))
				if (volume?.detachPolls !== undefined && !options.neverDetach && volume.detachPolls-- === 0) volume.attached_machine_id = null
				return volume ? structuredClone(volume) : null
			}
			if (path === `/apps/${appName}`) return appDeleted ? null : { id: options.changedQualificationApp ? 'app_changed' : 'app_owned' }
			throw new Error(`unexpected API call: ${method} ${path}`)
		},
		async cli(args) {
			calls.push({ args })
			if (args[0] === 'releases') return published ? [{ ID: 'competing', ImageRef: newer }, { ID: 'owned_release', ImageRef: options.releaseMismatch ? newer : image }] : [{ ID: 'prior', ImageRef: newer }]
			assert.deepEqual(args, ['deploy', '--image', image, '--app', 'geocluster-ai-ide', '--ha=false'])
			assert.ok(['machine_gate', 'vol_gate', appName].every(id => deleted.includes(id)), 'disposable cleanup must finish before deploy')
			published = true
			if (options.deployBeforeReleaseFail) { published = false; throw new Error('failed before release') }
			const vol = options.oldAttachment ? volumes[0] : volumes.find(v => v.id === 'vol_publish')
			const machine = { id: 'machine_publish', instance_id: 'instance_publish', region: 'sin', config: { image, mounts: [{ volume: vol.id, path: '/workspace' }] }, image_ref: { digest: image.split('@')[1] } }
			vol.attached_machine_id = machine.id; machines.push(machine)
			if (options.extraVolume) volumes.push({ id: 'vol_unknown' })
			if (options.deployFail) throw new Error('cli failed after creating a release')
			return ''
		},
		async resolveImage(ref) { return ref },
	}
	return { adapter, calls, deleted, get config() { return config } }
}

async function run(f, extra = {}) {
	return releaseNativeImage({ image, orgSlug: 'test-org', sourceSha: 'abc123', timeoutMs: 1000, pollMs: 1, cleanupTimeoutMs: 100, cleanupPollMs: 1, ...extra }, f.adapter)
}

for (const option of ['nativeFail', 'filesFail', 'synthetic', 'malformed']) test(`${option} blocks publication and cleans only captured resources`, async () => {
	const f = fake({ [option]: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.deepEqual(f.deleted, ['machine_gate', 'vol_gate', report.qualification.appName])
})

test('promotes the qualified digest despite a competing newest release and leaves old volumes alone', async () => {
	const f = fake(), report = await run(f)
	assert.equal(report.status, 'succeeded')
	assert.equal(report.publication.release.image, image)
	assert.deepEqual(f.deleted.slice(-2), ['machine_publish', 'vol_publish'])
	assert.equal(f.deleted.includes('vol_old'), false)
	assert.deepEqual(f.config.guest, { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 })
	assert.equal(f.config.init.swap_size_mb, 2048)
	assert.match(f.config.init.exec.join(' '), /\/entrypoint\.sh headless/)
	assert.equal(f.config.env.RUNTIME_PROFILE, 'managed')
	assert.equal(f.config.env.IDE_LLM_TOKEN, undefined)
	assert.equal(f.config.env.IDE_MACHINE_TOKEN, 'qualification-machine-only')
	assert.equal(f.config.env.FILES_GIS_WORKER_ENABLED, 'true')
	assert.equal(f.config.env.FILES_WORKBOOK_WORKER_ENABLED, 'true')
	assert.equal(f.config.env.RUNTIME_AUTH_DISABLED, undefined)
	assert.equal(JSON.stringify(report).includes(f.config.env.IDE_PROXY_KEY), false)
})

test('qualification cleanup failure blocks publication and never deletes its app as a fallback', async () => {
	const f = fake({ cleanupFail: 'machine_gate' }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.equal(f.deleted.includes(report.qualification.appName), false)
	assert.equal(JSON.stringify(report).includes('token-and-config'), false)
})

test('uncertain create refuses app deletion and reports known IDs and unresolved operation', async () => {
	const f = fake({ uncertainVolume: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(report.qualification.appId, 'app_owned')
	assert.deepEqual(report.qualification.uncertain, ['create-volume'])
	assert.deepEqual(f.deleted, [])
})

test('failed deploy still cleans its verified pair and records the already-created release', async () => {
	const f = fake({ deployFail: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(report.publication.release.id, 'owned_release')
	assert.deepEqual(f.deleted.slice(-2), ['machine_publish', 'vol_publish'])
})

test('publication cleanup failure is visible after release creation', async () => {
	const f = fake({ cleanupFail: 'machine_publish' }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(report.publication.release.id, 'owned_release')
	assert.equal(report.publication.cleanup, 'failed')
})

for (const option of ['oldAttachment', 'extraVolume']) test(`${option} refuses ambiguous ownership without deleting unknown or baseline IDs`, async () => {
	const f = fake({ [option]: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(f.deleted.includes('vol_old'), false)
	assert.equal(f.deleted.includes('vol_unknown'), false)
	if (option === 'oldAttachment') assert.equal(f.deleted.includes('machine_publish'), false)
})

test('mutable tags are rejected before any external effect', async () => {
	const f = fake(), report = await run(f, { image: 'registry.fly.io/geocluster-ai-ide:latest' })
	assert.equal(report.status, 'failed')
	assert.deepEqual(f.calls, [])
})

test('missing create ID preserves uncertainty; no machine discovery or app deletion fallback', async () => {
	const f = fake({ missingMachineId: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.deepEqual(report.qualification.uncertain, ['create-machine'])
	assert.deepEqual(f.deleted, [])
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
})

test('poll deadline blocks publication and cleans captured IDs', async () => {
	const f = fake({ neverCompletes: true }), report = await run(f, { timeoutMs: 25 })
	assert.equal(report.status, 'failed')
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.equal(report.qualification.cleanup, 'succeeded')
	assert.ok(f.calls.filter(c => c.path?.endsWith('/exec')).every(c => c.body.timeout <= 60))
})

test('failure before release creation cleans the pre-created publication volume', async () => {
	const f = fake({ deployBeforeReleaseFail: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(report.publication.release, undefined)
	assert.equal(report.publication.releaseState, 'not-observed')
	assert.equal(f.deleted.at(-1), 'vol_publish')
	assert.equal(f.deleted.includes('vol_old'), false)
})

test('a published release with the wrong digest fails verification but cleans the attributable pair', async () => {
	const f = fake({ releaseMismatch: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(report.publication.release, undefined)
	assert.deepEqual(f.deleted.slice(-2), ['machine_publish', 'vol_publish'])
})

test('an existing canonical machine blocks deploy and remains untouched', async () => {
	const f = fake({ existingMachine: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.deepEqual(report.publication.baseline.machineIds, ['machine_old'])
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.equal(f.deleted.includes('machine_old'), false)
	assert.equal(f.deleted.includes('vol_old'), false)
})

for (const state of ['pending_destroy', 'destroyed']) test(`owned ${state} volumes do not block disposable app cleanup or promotion`, async () => {
	const f = fake({ softDeleteVolumes: state }), report = await run(f)
	assert.equal(report.status, 'succeeded')
	assert.equal(report.qualification.cleanup, 'succeeded')
	assert.equal(report.publication.cleanup, 'succeeded')
	assert.ok(f.deleted.includes(report.qualification.appName))
	assert.equal(f.deleted.includes('vol_old'), false)
})

test('machine destruction and delayed volume detach are confirmed before deleting its volume', async () => {
	const f = fake({ asyncMachineDelete: true, softDeleteVolumes: true }), report = await run(f)
	assert.equal(report.status, 'succeeded')
	for (const [machine, volume] of [['machine_gate', 'vol_gate'], ['machine_publish', 'vol_publish']]) {
		const request = f.calls.findIndex(c => c.method === 'DELETE' && c.path?.includes(`/machines/${machine}`))
		const volumeDelete = f.calls.findIndex(c => c.method === 'DELETE' && c.path?.endsWith(`/volumes/${volume}`))
		const between = f.calls.slice(request + 1, volumeDelete)
		assert.ok(between.filter(c => c.method === 'GET' && c.path?.endsWith(`/machines/${machine}`)).length >= 3)
		assert.ok(between.filter(c => c.method === 'GET' && c.path?.endsWith(`/volumes/${volume}`)).length >= 3)
	}
})

for (const state of ['created', 'pending_destroy', 'destroyed']) test(`unknown ${state} volume is never masked by the owned-volume tombstone filter`, async () => {
	const f = fake({ softDeleteVolumes: true, unknownQualificationVolume: state }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.equal(f.deleted.includes(report.qualification.appName), false)
	assert.equal(f.deleted.includes('vol_unknown_gate'), false)
	assert.deepEqual(report.qualification.remaining.volumeIds, ['vol_unknown_gate'])
})

for (const option of ['neverDestroy', 'neverDetach']) test(`${option} exhausts the bounded cleanup budget without deleting an attached volume`, async () => {
	const f = fake({ asyncMachineDelete: true, [option]: true })
	const start = Date.now(), report = await run(f, { cleanupTimeoutMs: 25 })
	assert.equal(report.status, 'failed')
	assert.ok(Date.now() - start < 1000, 'cleanup must terminate rather than poll indefinitely')
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.equal(f.deleted.includes('vol_gate'), false)
	assert.equal(f.deleted.includes(report.qualification.appName), false)
})

for (const option of ['changedQualificationApp', 'changedQualificationInstance', 'changedQualificationImage']) test(`${option} refuses destructive cleanup and blocks publication`, async () => {
	const f = fake({ [option]: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.deepEqual(f.deleted, [])
})

test('changed publication machine instance is not deleted after release creation', async () => {
	const f = fake({ changedPublicationInstance: true }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(report.publication.release.id, 'owned_release')
	assert.equal(f.deleted.includes('machine_publish'), false)
	assert.equal(f.deleted.includes('vol_publish'), false)
})

const invalidFilesReports = [
	['missing ok', report => { delete report.ok }],
	['false ok', report => { report.ok = false }],
	['missing auth', report => { delete report.auth }],
	['failed authentication', report => { report.auth.authenticated = false }],
	['unauthenticated request accepted', report => { report.auth.unauthenticatedStatus = 200 }],
	...['workbook', 'assay', 'vector', 'raster'].map(name => [`${name} is synthetic`, report => { report.providers[name].confinement = 'synthetic-test-only' }]),
	...['workbook', 'assay', 'vector', 'raster'].map(name => [`${name} unavailable for the kernel`, report => { report.providers[name] = kernelOff(name, 3) }]),
	['wrong CSV point count', report => { report.fixtures.csv.points = 2 }],
	['invalid CSV coordinates', report => { report.fixtures.csv.invalidCoordinateRows = 1 }],
	['CSV placement not ready', report => { report.fixtures.csv.placement = 'pending' }],
	['CSV raw read failed', report => { report.fixtures.csv.raw = false }],
	['CSV preview failed', report => { report.fixtures.csv.preview = false }],
	['missing XLS fixture', report => { delete report.fixtures.xls }],
	['wrong XLS sheet count', report => { report.fixtures.xls.sheets = 2 }],
	['XLS preparation failed', report => { report.fixtures.xls.prepare = false }],
	['XLS preview failed', report => { report.fixtures.xls.preview = false }],
	['wrong XLSX row count', report => { report.fixtures.xlsx.rows = 3 }],
	...['xls', 'xlsx'].map(format => [`${format} cells not verified`, report => { report.fixtures[format].cells = false }]),
	['XLSX preparation skipped', report => { delete report.fixtures.xlsx.prepare }],
	['XLSX preview skipped', report => { delete report.fixtures.xlsx.preview }],
]
for (const [reason, change] of invalidFilesReports) test(`exit-zero files report with ${reason} cannot publish`, async () => {
	const filesReport = structuredClone(files); change(filesReport)
	const f = fake({ filesReport }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.equal(report.qualification.cleanup, 'succeeded')
})

// Missing kernel features cannot substitute for successful confined decoding.
const kernelOff = (launcher, abi, stage = 'landlock-abi-query') => ({ state: 'unavailable', parser: 'test', reason: 'confinement-probe', diagnostic: `${launcher}: stage=${stage} result=-1 requiredAbi=${abi} errno=38` })
const nativeOff = { gis: kernelOff('gis-launcher', 3), workbook: kernelOff('workbook-launcher', 1) }

const invalidQualifications = [
	['fail-closed readers exit zero', { nativeReport: nativeOff, nativeExit: 0 }],
	['an empty native report is rejected', { nativeReport: {} }],
	['an array native report is rejected', { nativeReport: [] }],
]
for (const [reason, options] of invalidQualifications) test(`qualification cannot publish when ${reason}`, async () => {
	const f = fake(options), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.equal(report.qualification.cleanup, 'succeeded')
})

test('inspection retains the exact disabled Landlock marker without unrelated kernel config values', async () => {
	const marker = '# CONFIG_SECURITY_LANDLOCK is not set'
	const f = fake({ kernelConfig: `${marker}\nCONFIG_SECCOMP=y\nCONFIG_PRIVATE_KEY=secret-value\n${marker} secret-value\n` }), report = await run(f)
	assert.equal(report.status, 'succeeded')
	assert.deepEqual(report.qualification.inspection.kernelConfig, [marker, 'CONFIG_SECCOMP=y'])
	assert.equal(JSON.stringify(report).includes('secret-value'), false)
})

test('inspection records unavailable when kernel config is inaccessible', async () => {
	const report = await run(fake({ kernelConfig: null }))
	assert.equal(report.status, 'succeeded')
	assert.equal(report.qualification.inspection.kernelConfig, 'unavailable')
})

test('a rejected chroot installation preserves only safe diagnostic fields', async () => {
	const nativeReport = { ...native, gis: { state: 'unavailable', reason: 'confinement-probe', diagnostic: 'gis-launcher: stage=chroot-installation result=-1 errno=1 secret-value' } }
	const f = fake({ nativeReport, nativeExit: 1 }), report = await run(f)
	assert.equal(report.status, 'failed')
	assert.equal(f.calls.some(c => c.args?.[0] === 'deploy'), false)
	assert.deepEqual(report.qualification.native.evidence.gis.diagnostic, { stage: 'chroot-installation', result: -1, errno: 1 })
	assert.equal(JSON.stringify(report).includes('secret-value'), false)
})

test('complete authenticated provider and fixture proof is retained safely in the artifact', async () => {
	const f = fake(), report = await run(f)
	assert.equal(report.status, 'succeeded')
	assert.deepEqual(report.qualification.files.evidence, files)
	assert.equal(JSON.stringify(report).includes(f.config.env.IDE_PROXY_KEY), false)
})

test('disposable boots have unique UUID project scopes, no model authority, and backend-compatible stop policy', async () => {
	const a = fake(), b = fake()
	assert.equal((await run(a)).status, 'succeeded')
	assert.equal((await run(b)).status, 'succeeded')
	for (const f of [a, b]) {
		assert.match(f.config.env.PROJECT_ID, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
		assert.ok(f.config.env.USER_ID)
		assert.equal(f.config.env.LLM_PROXY_URL, 'http://127.0.0.1:18766/v1')
		assert.equal(f.config.env.IDE_MACHINE_CREDENTIALS_URL, 'http://127.0.0.1:18766/renew')
		assert.equal(f.config.env.IDE_LLM_TOKEN, undefined)
		assert.deepEqual(f.config.stop_config, { signal: 'SIGTERM', timeout: '300s' })
	}
	assert.notEqual(a.config.env.PROJECT_ID, b.config.env.PROJECT_ID)
})
