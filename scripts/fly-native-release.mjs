import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchCommand, pollCommand, inspectCommand } from './fly-qualification-commands.mjs'
import { createFlyAdapter } from './fly-release-adapter.mjs'

const canonicalApp = 'geocluster-ai-ide'
const digestPattern = /^registry\.fly\.io\/geocluster-ai-ide@sha256:[a-f0-9]{64}$/
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/
const fail = code => { throw new Error(code) }
const requireId = value => idPattern.test(value || '') ? value : fail('missing-resource-id')
const pathFor = app => `/apps/${requireId(app)}`
const recordError = (report, code) => { report.errors.push(code); report.status = 'failed' }
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Reader qualification has no backend account. This loopback fixture renews only
// dummy authority, advertises an empty catalog, and refuses all inference.
const qualificationBackend = `const http=require('node:http');http.createServer((q,s)=>{
s.setHeader('content-type','application/json');
if(q.method==='GET'&&q.url==='/healthz'){s.end('{}');return}
if(q.method==='POST'&&q.url==='/renew'&&q.headers.authorization==='Bearer qualification-machine-only'){
s.end(JSON.stringify({llmToken:'qualification-purpose-only',activityToken:'qualification-activity-only',datasetToken:'qualification-dataset-only',expiresAt:new Date(Date.now()+3600000).toISOString()}));return}
if(q.method==='GET'&&q.url==='/v1/account'&&q.headers.authorization==='Bearer qualification-purpose-only'){
s.end(JSON.stringify({discovery_schema_version:2,allowed_model_ids:[],default_model_id:null,managed_models:{}}));return}
s.writeHead(503);s.end('{}')}).listen(18766,'127.0.0.1')`
const qualificationExec = ['/bin/bash', '-c', `node -e ${JSON.stringify(qualificationBackend.replace(/\n/g, ''))} & backend=$!; for i in {1..100}; do kill -0 "$backend" || exit 2; if curl -fs --max-time 1 http://127.0.0.1:18766/healthz >/dev/null; then exec /entrypoint.sh headless; fi; sleep .1; done; exit 2`]

function safeEvidence(value, key = '', depth = 0) {
	// Commands are trusted, but artifacts use an allowlist as a second boundary.
	if (depth > 8) return undefined
	if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string') {
		if (key === 'diagnostic') {
			const stage = value.match(/stage=(landlock-[a-z-]+|[a-z-]+-installation)/)?.[1]
			if (!stage) return undefined
			return { stage, ...Object.fromEntries([...value.matchAll(/\b(result|requiredAbi|observedAbi|errno)=(-?\d+)\b/g)].map(([, k, v]) => [k, Number(v)])) }
		}
		if (['state', 'confinement', 'status'].includes(key)) return /^(available|unavailable|verified|synthetic-test-only|passed|failed|succeeded)$/.test(value) ? value : undefined
		if (key === 'placement') return value === 'ready' ? value : undefined
		if (['architecture', 'kernelRelease', 'lsm', 'mode', 'Uid', 'Gid', 'NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'gdal', 'proj', 'parser', 'assay', 'decoded', 'reason'].includes(key)) return /^[a-zA-Z0-9_.:, +\t-]{1,256}$/.test(value) ? value : undefined
		if (key === 'bootPolicy') return /^(lsm|security|apparmor|selinux)=[a-zA-Z0-9_,.-]{1,256}$/.test(value) ? value : undefined
		if (key === 'kernelConfig' && ['unavailable', '# CONFIG_SECURITY_LANDLOCK is not set'].includes(value)) return value
		if (key === 'kernelConfig') return /^(CONFIG_SECURITY_LANDLOCK|CONFIG_LSM|CONFIG_SECCOMP|CONFIG_SECCOMP_FILTER)=["a-zA-Z0-9_,.-]{1,256}$/.test(value) ? value : undefined
		if (key === 'path') return ['/', '/opt', '/workspace'].includes(value) ? value : undefined
		if (key === 'options') return /^[a-zA-Z0-9_,=.-]{1,512}$/.test(value) ? value : undefined
		return undefined
	}
	if (Array.isArray(value)) return value.slice(0, 32).map(v => safeEvidence(v, key, depth + 1)).filter(v => v !== undefined)
	if (!value || typeof value !== 'object') return undefined
	const allowed = new Set(['ok', 'gis', 'workbook', 'assay', 'vector', 'raster', 'providers', 'readiness', 'state', 'status', 'confinement', 'reason', 'diagnostic', 'parser', 'build', 'gdal', 'proj', 'probe', 'decoded', 'filesystemDenied', 'writeDenied', 'truncateDenied', 'descriptorTruncateDenied', 'socketDenied', 'executionDenied', 'processDenied', 'signalDenied', 'fixtures', 'csv', 'xls', 'xlsx', 'auth', 'authenticated', 'unauthenticatedStatus', 'points', 'invalidCoordinateRows', 'placement', 'raw', 'rows', 'cells', 'sheets', 'preview', 'prepare', 'architecture', 'kernelRelease', 'lsm', 'bootPolicy', 'kernelConfig', 'daemon', 'pid', 'uid', 'gid', 'mode', 'Uid', 'Gid', 'NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'launchers', 'mountPolicy', 'path', 'options'])
	return Object.fromEntries(Object.entries(value).filter(([k]) => allowed.has(k)).map(([k, v]) => [k, safeEvidence(v, k, depth + 1)]).filter(([, v]) => v !== undefined))
}

function parseOutput(exec) {
	if (exec?.exit_code !== 0 || exec.exit_signal || typeof exec.stdout !== 'string' || Buffer.byteLength(exec.stdout) > 40000) fail('exec-failed-or-output-limit')
	try { return JSON.parse(exec.stdout) } catch { fail('malformed-command-output') }
}

const verified = readiness => readiness?.state === 'available' && readiness.confinement === 'verified'

function assertNativeQualification(result) {
	if (result.exitCode !== 0) fail('native-qualification-failed')
	return Object.fromEntries(['gis', 'workbook'].map(name => [name, verified(result.report[name]) ? 'verified' : fail('native-confinement-not-verified')]))
}

function assertFilesQualification(report) {
	if (report.ok !== true || report.auth?.authenticated !== true || report.auth?.unauthenticatedStatus !== 401) fail('files-auth-not-verified')
	if (!['workbook', 'assay', 'vector', 'raster'].every(name => verified(report.providers?.[name]))) fail('files-providers-not-verified')
	const csv = report.fixtures?.csv
	if (csv?.raw !== true || csv.preview !== true || csv.points !== 3 || csv.invalidCoordinateRows !== 0 || csv.placement !== 'ready') fail('files-csv-not-verified')
	if (!['xls', 'xlsx'].every(format => {
		const fixture = report.fixtures?.[format]
		return fixture?.sheets === 3 && fixture.rows === 2 && fixture.cells === true && fixture.prepare === true && fixture.preview === true
	})) fail('files-workbooks-not-verified')
}

async function createCaptured(scope, operation, create, capture, save) {
	// A lost create response can leave a resource alive. Never retry a create or
	// infer ownership from a name scan. Persist uncertainty before sending it.
	scope.uncertain.push(operation); await save()
	const result = await create()
	capture(result)
	scope.uncertain = scope.uncertain.filter(value => value !== operation); await save()
	return result
}

const deletedVolumeState = state => ['pending_destroy', 'destroyed'].includes(state)
function machineIdentity(machine, image) {
	return { id: requireId(machine.id), instanceId: requireId(machine.instance_id), image, region: machine.region }
}
function assertMachineOwnership(machine, scope, image) {
	if (!scope.machine || machine.id !== scope.machine.id || machine.instance_id !== scope.machine.instanceId || !machineImageMatches(machine, image)) fail('machine-ownership-changed')
}

export async function cleanupCaptured(report, adapter, save = async () => {}, { timeoutMs = 120000, pollMs = 2000 } = {}) {
	const deadline = Date.now() + timeoutMs
	const remaining = () => { if (Date.now() >= deadline) fail('cleanup-deadline'); return deadline - Date.now() }
	const api = (method, path) => adapter.api(method, path, undefined, { timeoutMs: remaining() })
	const pause = async () => { await sleep(Math.min(pollMs, remaining())) }
	for (const scope of [report.qualification, report.publication].filter(Boolean)) {
		if (!scope.appName || scope.cleanup === 'succeeded') continue
		const validScope = scope === report.qualification
			? /^gc-native-[a-f0-9]{20}$/.test(scope.appName) && (scope.appId || !scope.machineIds.length && !scope.volumeIds.length)
			: scope.appName === canonicalApp
		if (!validScope) { recordError(report, 'invalid-cleanup-scope'); scope.cleanup = 'failed'; await save(); continue }
		const app = pathFor(scope.appName)
		let failed = false
		scope.deletedMachineIds ||= []; scope.deletedVolumeIds ||= []
		const verifyApp = async () => {
			if (scope !== report.qualification) return true
			const info = await api('GET', app)
			if (info && info.id !== scope.appId) fail('app-ownership-changed')
			return Boolean(info)
		}
		try { await verifyApp() }
		catch { recordError(report, 'cleanup-app-ownership'); scope.cleanup = 'failed'; await save(); continue }
		for (const id of scope.machineIds.filter(id => !scope.deletedMachineIds.includes(id))) {
			if (scope.baseline?.machineIds.includes(id)) { failed = true; recordError(report, 'refused-baseline-machine-cleanup'); continue }
			try {
				const path = `${app}/machines/${requireId(id)}`
				let machine = await api('GET', path)
				if (machine && machine.id !== id) fail('machine-ownership-changed')
				if (machine && machine.state !== 'destroyed') {
					assertMachineOwnership(machine, scope, report.image)
					await verifyApp()
					await api('DELETE', `${path}?force=true`)
					while (true) {
						machine = await api('GET', path)
						if (machine && machine.id !== id) fail('machine-ownership-changed')
						if (!machine || machine.state === 'destroyed') break
						assertMachineOwnership(machine, scope, report.image)
						await pause()
					}
				}
				scope.deletedMachineIds.push(id); await save()
			} catch (cause) {
				failed = true
				recordError(report, cause?.message === 'machine-ownership-changed' ? `cleanup-machine-ownership:${id}` : `cleanup-machine:${id}`)
			}
		}
		for (const id of scope.volumeIds.filter(id => !scope.deletedVolumeIds.includes(id))) {
			if (scope.baseline?.volumeIds.includes(id)) { failed = true; recordError(report, 'refused-baseline-volume-cleanup'); continue }
			try {
				const path = `${app}/volumes/${requireId(id)}`
				let volume = await api('GET', path)
				if (volume && volume.id !== id) fail('volume-identity-changed')
				while (volume?.attached_machine_id) {
					// Wait only for detach from a machine whose destruction was confirmed.
					// An unknown or ownership-refused attachment is never a retry target.
					if (!scope.deletedMachineIds.includes(volume.attached_machine_id)) fail('unconfirmed-volume-attachment')
					await pause(); volume = await api('GET', path)
					if (volume && volume.id !== id) fail('volume-identity-changed')
				}
				if (volume && !deletedVolumeState(volume.state)) {
					if (volume.id !== id) fail('volume-identity-changed')
					await verifyApp()
					await api('DELETE', path)
					while (true) {
						volume = await api('GET', path)
						if (volume && volume.id !== id) fail('volume-identity-changed')
						if (!volume || deletedVolumeState(volume.state)) break
						if (volume.id !== id || volume.attached_machine_id) fail('volume-identity-changed')
						await pause()
					}
				}
				scope.deletedVolumeIds.push(id); await save()
			} catch { failed = true; recordError(report, `cleanup-volume:${id}`) }
		}
		if (scope === report.qualification && scope.appId && !failed && !scope.uncertain.length) {
			try {
				if (await verifyApp()) {
					const [machines, volumes] = await Promise.all([api('GET', `${app}/machines`), api('GET', `${app}/volumes`)])
					const remainingMachines = machines.filter(machine => !(scope.deletedMachineIds.includes(machine.id) && machine.state === 'destroyed'))
					const remainingVolumes = volumes.filter(volume => !(scope.deletedVolumeIds.includes(volume.id) && deletedVolumeState(volume.state)))
					scope.remaining = { machineIds: remainingMachines.map(machine => requireId(machine.id)), volumeIds: remainingVolumes.map(volume => requireId(volume.id)) }; await save()
					if (remainingMachines.length || remainingVolumes.length) fail('app-not-empty')
					await verifyApp()
					await api('DELETE', app)
					while (await verifyApp()) await pause()
				}
			} catch { failed = true; recordError(report, 'cleanup-app') }
		}
		if (scope.uncertain.length) { failed = true; recordError(report, `${scope.kind}-unresolved-ownership`) }
		scope.cleanup = failed ? 'failed' : 'succeeded'; await save()
	}
}

function scope(kind, appName) { return { kind, appName, machineIds: [], volumeIds: [], uncertain: [], cleanup: 'pending' } }
function machineImageMatches(machine, image) {
	return machine?.config?.image === image && machine?.image_ref?.digest === image.split('@')[1]
}

async function capturePublication(report, adapter, save) {
	const publication = report.publication, base = publication.baseline
	const [machines, volumes] = await Promise.all([adapter.api('GET', `${pathFor(canonicalApp)}/machines`), adapter.api('GET', `${pathFor(canonicalApp)}/volumes`)])
	const addedMachines = machines.filter(m => !base.machineIds.includes(m.id))
	const addedVolumes = volumes.filter(v => !base.volumeIds.includes(v.id) && !publication.volumeIds.includes(v.id))
	publication.observed = { machineIds: addedMachines.map(m => requireId(m.id)), volumeIds: addedVolumes.map(v => requireId(v.id)) }
	let attributableVolume
	if (addedMachines.length === 1) {
		const machine = addedMachines[0], mounts = machine.config?.mounts
		const volume = mounts?.length === 1 && mounts[0].path === '/workspace' && volumes.find(v => v.id === mounts[0].volume)
		if (machineImageMatches(machine, report.image) && volume && !base.volumeIds.includes(volume.id) && volume.attached_machine_id === machine.id) {
			publication.machineIds = [requireId(machine.id)]
			publication.machine = machineIdentity(machine, report.image)
			attributableVolume = requireId(volume.id)
			if (!publication.volumeIds.includes(attributableVolume)) publication.volumeIds.push(attributableVolume)
		}
	}
	const ambiguous = !publication.machineIds.length || addedVolumes.some(v => v.id !== attributableVolume)
	if (ambiguous) {
		publication.uncertain = ['publication-resources']; await save(); fail('ambiguous-publication-resources')
	}
	publication.uncertain = []; await save()
}

async function captureRelease(report, adapter, save) {
	const releases = await adapter.cli(['releases', '--app', canonicalApp, '--json'])
	const fresh = releases.filter(r => !report.publication.baseline.releaseIds.includes(String(r.ID ?? r.Version)))
	report.publication.observedReleaseIds = fresh.map(r => requireId(String(r.ID ?? r.Version)))
	report.publication.releaseState = fresh.length ? 'unverified' : 'not-observed'; await save()
	const matching = []
	for (const release of fresh) {
		if (typeof release.ImageRef !== 'string') continue
		if (await adapter.resolveImage(release.ImageRef) === report.image) matching.push(release)
	}
	if (matching.length !== 1) fail('publication-release-not-uniquely-verified')
	const release = matching[0]
	report.publication.release = { id: requireId(String(release.ID ?? release.Version)), image: report.image }
	report.publication.releaseState = 'created'
	await save()
}

// Only tests inject the external boundary. The CLI always uses the real adapter.
export async function releaseNativeImage(options, adapter, onReport = async () => {}) {
	const { image, orgSlug, sourceSha = '', timeoutMs = 600000, pollMs = 2000, cleanupTimeoutMs = 120000, cleanupPollMs = 2000 } = options
	const report = { version: 1, image, sourceSha, status: 'running', stage: 'validate', errors: [] }
	let saving = Promise.resolve()
	const save = () => {
		const snapshot = structuredClone(report)
		saving = saving.then(() => onReport(snapshot))
		return saving
	}
	const cleanup = () => cleanupCaptured(report, adapter, save, { timeoutMs: cleanupTimeoutMs, pollMs: cleanupPollMs })
	let stage = 'validate'
	let qualificationMachinePath
	try {
		if (!digestPattern.test(image) || !idPattern.test(orgSlug || '') || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('invalid-input')
		const deadline = Date.now() + timeoutMs
		const budget = () => { if (Date.now() >= deadline) fail('qualification-deadline'); return deadline - Date.now() }
		const pause = async () => { budget(); await sleep(Math.min(pollMs, budget())) }
		const qualificationApi = (method, path, body) => adapter.api(method, path, body, { timeoutMs: budget() })
		const appName = `gc-native-${randomBytes(10).toString('hex')}`
		const qualification = report.qualification = scope('qualification', appName)
		stage = report.stage = 'qualification-create'; await save()
		await createCaptured(qualification, 'create-app', () => qualificationApi('POST', '/apps', { app_name: appName, org_slug: orgSlug, network: appName }), result => { qualification.appId = requireId(result.id) }, save)
		const app = pathFor(appName), guest = { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 }
		budget()
		await createCaptured(qualification, 'create-volume', () => qualificationApi('POST', `${app}/volumes`, { name: 'workspace', region: 'sin', size_gb: 1, compute: guest, auto_backup_enabled: false }), result => { qualification.volumeIds.push(requireId(result.id)) }, save)
		const config = {
			image, guest, init: { swap_size_mb: 2048, exec: qualificationExec }, mounts: [{ volume: qualification.volumeIds[0], path: '/workspace' }], restart: { policy: 'no' },
			stop_config: { signal: 'SIGTERM', timeout: '300s' },
			env: { NODE_ENV: 'production', PROJECT_ID: randomUUID(), USER_ID: 'native-qualification', RUNTIME_PROFILE: 'managed', LLM_PROXY_URL: 'http://127.0.0.1:18766/v1', IDE_MACHINE_CREDENTIALS_URL: 'http://127.0.0.1:18766/renew', IDE_MACHINE_TOKEN: 'qualification-machine-only', IDE_PROXY_KEY: randomBytes(32).toString('hex'), FILES_GIS_WORKER_ENABLED: 'true', FILES_WORKBOOK_WORKER_ENABLED: 'true', SYNC_ENABLED: 'false', FILES_SYNC_ADAPTER: 'false', PREPROCESSING_ENABLED: 'false', RUNTIME_AGGREGATE_ACTIVITY: 'false', OWNED_DEMO_ENABLED: 'false' },
		}
		budget()
		await createCaptured(qualification, 'create-machine', () => qualificationApi('POST', `${app}/machines`, { region: 'sin', config }), result => {
			qualification.machineIds.push(requireId(result.id))
			qualification.machine = machineIdentity(result, image)
		}, save)
		const machinePath = `${app}/machines/${qualification.machineIds[0]}`
		qualificationMachinePath = machinePath
		let machine
		while (true) {
			machine = await qualificationApi('GET', machinePath)
			if (machine?.state === 'started') break
			if (['stopped', 'destroyed', 'failed'].includes(machine?.state)) fail('qualification-machine-not-running')
			await pause()
		}
		if (!machineImageMatches(machine, image) || machine.region !== 'sin' || Object.entries(guest).some(([key, value]) => machine.config.guest?.[key] !== value) || machine.config.init?.swap_size_mb !== 2048 || machine.config.env?.FILES_GIS_WORKER_ENABLED !== 'true' || machine.config.env?.FILES_WORKBOOK_WORKER_ENABLED !== 'true' || JSON.stringify(machine.config.init?.exec) !== JSON.stringify(qualificationExec) || machine.config.init?.entrypoint?.length || machine.config.init?.cmd?.length || !machine.config.mounts?.some(m => m.volume === qualification.volumeIds[0] && m.path === '/workspace')) fail('qualification-config-mismatch')
		assertMachineOwnership(machine, qualification, image)
		stage = report.stage = 'qualification-commands'; await save()
		for (const kind of ['native', 'files']) {
			budget()
			const launched = await qualificationApi('POST', `${machinePath}/exec`, { command: launchCommand(kind, budget()), timeout: 10 })
			if (launched?.exit_code !== 0 || launched.exit_signal) fail('qualification-launch-failed')
			let result
			while (true) {
				result = parseOutput(await qualificationApi('POST', `${machinePath}/exec`, { command: pollCommand(kind), timeout: 10 }))
				if (result?.done === true) break
				if (result?.done !== false) fail('invalid-completion-output')
				await pause()
			}
			qualification[kind] = { exitCode: result.exitCode, evidence: safeEvidence(result.report), reportSha256: sha256(result.report) }; await save()
			if (!result.report || typeof result.report !== 'object' || Array.isArray(result.report) || !Object.keys(result.report).length || result.report.error) fail(`${kind}-qualification-failed`)
			if (kind === 'native') { qualification.nativeReaders = assertNativeQualification(result); await save() }
			else if (result.exitCode !== 0) fail('files-qualification-failed')
			else assertFilesQualification(result.report)
		}
		const inspection = parseOutput(await qualificationApi('POST', `${machinePath}/exec`, { command: inspectCommand, timeout: 10 }))
		qualification.inspection = safeEvidence(inspection); await save()
		if (!inspection.kernelRelease || !['x64', 'x86_64'].includes(inspection.architecture) || inspection.daemon?.uid !== 998) fail('machine-inspection-incomplete')
		const finalMachine = await qualificationApi('GET', machinePath)
		if (!machineImageMatches(finalMachine, image) || finalMachine.instance_id !== machine.instance_id) fail('qualification-machine-changed')
		budget()
		stage = report.stage = 'qualification-cleanup'
		await cleanup()
		if (report.status === 'failed' || qualification.cleanup !== 'succeeded') fail('qualification-cleanup-failed')

		stage = report.stage = 'publication-baseline'; await save()
		const canonical = pathFor(canonicalApp)
		const [machines, volumes, releases] = await Promise.all([adapter.api('GET', `${canonical}/machines`), adapter.api('GET', `${canonical}/volumes`), adapter.cli(['releases', '--app', canonicalApp, '--json'])])
		const publication = report.publication = scope('publication', canonicalApp)
		publication.baseline = { machineIds: machines.map(m => requireId(m.id)), volumeIds: volumes.map(v => requireId(v.id)), releaseIds: releases.map(r => requireId(String(r.ID ?? r.Version))) }; await save()
		if (machines.length) fail('canonical-machines-not-empty')
		stage = report.stage = 'publication-volume'
		await createCaptured(publication, 'create-volume', () => adapter.api('POST', `${canonical}/volumes`, { name: 'workspace', region: 'sin', size_gb: 1, auto_backup_enabled: false, compute: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 } }), result => {
			const id = requireId(result.id); if (publication.baseline.volumeIds.includes(id)) fail('publication-volume-not-new'); publication.volumeIds.push(id)
		}, save)
		stage = report.stage = 'publication-deploy'
		publication.attempted = true; publication.releaseState = 'unknown'; publication.uncertain = ['publication-resources']; await save()
		try { await adapter.cli(['deploy', '--image', image, '--app', canonicalApp, '--ha=false']) }
		finally {
			// Both observations must run even after failed deploy/observation. A release
			// can already exist when flyctl exits nonzero; cleanup cannot undo it.
			const results = await Promise.allSettled([capturePublication(report, adapter, save), captureRelease(report, adapter, save)])
			for (const result of results) if (result.status === 'rejected') recordError(report, 'publication-observation-failed')
		}
		if (publication.uncertain.length || !publication.release || !publication.machineIds.length || report.status === 'failed') fail('publication-not-verified')
	} catch { recordError(report, `${stage}-failed`) }
	finally {
		if (qualificationMachinePath && !report.qualification.inspection && report.qualification.cleanup !== 'succeeded') {
			try { report.qualification.inspection = safeEvidence(parseOutput(await adapter.api('POST', `${qualificationMachinePath}/exec`, { command: inspectCommand, timeout: 10 }))); await save() }
			catch { recordError(report, 'qualification-inspection-failed') }
		}
		try { await cleanup() } catch { recordError(report, 'finalization-failed') }
		if (report.status !== 'failed') report.status = 'succeeded'
		await save()
	}
	return report
}

async function main() {
	const args = process.argv.slice(2), cleanup = args[0] === '--cleanup'
	const reportPath = process.env.FLY_RELEASE_REPORT || 'fly-native-release-report.json'
	const save = async report => { await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await rename(`${reportPath}.tmp`, reportPath) }
	const adapter = createFlyAdapter(process.env.FLY_API_TOKEN)
	let report
	if (cleanup) {
		report = JSON.parse(await readFile(reportPath, 'utf8'))
		if (report.version !== 1 || !digestPattern.test(report.image)) fail('invalid-cleanup-record')
		if (report.status === 'running') recordError(report, 'interrupted-release')
		await cleanupCaptured(report, adapter, () => save(report))
	} else {
		if (args.length) fail('unexpected-arguments')
		report = await releaseNativeImage({ image: process.env.CANDIDATE_DIGEST, orgSlug: process.env.FLY_ORG_SLUG, sourceSha: process.env.GITHUB_SHA || '', timeoutMs: Number(process.env.FLY_QUALIFICATION_TIMEOUT_MS || 600000) }, adapter, save)
	}
	console.log(`Native release ${report.status}; safe resource/evidence report: ${reportPath}`)
	if (report.status !== 'succeeded') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(() => { console.error('Native release command failed. Inspect the saved ID-only report and rerun its captured-ID cleanup.'); process.exitCode = 1 })
}
