#!/usr/bin/env node
// Development-only installed-image qualification. Child output is private and bounded.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = path.resolve(here, '../../..')
const fail = code => { throw new Error(code) }
const sha = value => crypto.createHash('sha256').update(value).digest('hex')

export function parseArgs(argv) {
	const allowed = new Set(['image', 'expected-bundle-digest', 'deadline-ms', 'processor-source', 'backend-source', 'report'])
	const values = {}
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]?.replace(/^--/, '')
		if (!argv[i]?.startsWith('--') || !allowed.has(key) || !argv[i + 1] || key in values) fail('invalid_arguments')
		values[key] = argv[i + 1]
	}
	const deadlineMs = Number(values['deadline-ms'] ?? 300000)
	if (!/^[A-Za-z0-9][A-Za-z0-9./:_@-]{0,511}$/.test(values.image || '') || !/^[a-f0-9]{64}$/.test(values['expected-bundle-digest'] || '') ||
		!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 1800000) fail('invalid_arguments')
	return { ...values, deadlineMs }
}

export function validateProbe(r, digest) {
	if (!r || r.ok !== true || r.bundleDigest !== digest || r.engineIdentityVerified !== true || r.managedBoundaryVerified !== true ||
		r.authenticated !== true || r.unauthenticatedStatus !== 401 || r.ready !== true || r.executionReady !== true ||
		r.eligibleCandidateCount !== 2 || r.selectedModel !== 'proxy/openai/gpt-6-luna' ||
		r.owners !== 1 || r.services !== 1 || r.uid !== 996 || r.gid !== 996 ||
		typeof r.engineVersion !== 'string' || !/^[A-Za-z0-9.+_-]{1,128}$/.test(r.engineVersion)) fail('invalid_startup_proof')
}

export function validateProtocol(r) {
	if (!r || r.ok !== true || r.installedPackage !== true || !Number.isSafeInteger(r.collected) || r.collected < 3 ||
		r.passed !== r.collected || r.skipped !== 0 || r.failed !== 0 || r.completedTurns !== true ||
		r.twoCandidates !== true || r.completedCandidates !== 2 || r.evidenceBeforeDelete !== true) fail('invalid_protocol_proof')
}

export function protocolRunArgs(name, overlay) {
	// Submission reserves 1.25 GiB of free disk by default. This tmpfs ceiling
	// clears that check without preallocating memory; fixture writes stay small.
	return ['run', '--name', name, '--network', 'none', '--memory', '4g', '--cpus', '2',
		'--tmpfs', '/tmp:rw,size=4g', '--entrypoint', '/opt/geocluster-preprocessing/bin/python', overlay,
		'/qualification/processor-protocol-runner.py']
}

// Never include subprocess stdout/stderr or arbitrary exception messages in a failure.
export async function command(executable, argv, { deadline, input, limit = 65536, code = 'command_failed', accepted = [0] } = {}) {
	const remaining = deadline - Date.now()
	if (remaining <= 0) fail('deadline_exceeded')
	return new Promise((resolve, reject) => {
		const child = spawn(executable, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
		let output = [], bytes = 0, overflow = false, expired = false
		const timer = setTimeout(() => { expired = true; child.kill('SIGKILL') }, remaining)
		for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
			bytes += chunk.length
			if (bytes > limit) { overflow = true; child.kill('SIGKILL') }
			else if (stream === child.stdout) output.push(chunk)
		})
		child.on('error', () => { clearTimeout(timer); reject(new Error(code)) })
		child.on('close', status => {
			clearTimeout(timer)
			if (expired || overflow || !accepted.includes(status)) reject(new Error(expired ? 'deadline_exceeded' : overflow ? 'output_limit_exceeded' : code))
			else resolve(Buffer.concat(output).toString('utf8'))
		})
		child.stdin.on('error', () => {})
		child.stdin.end(input)
	})
}

async function jsonFile(filename, limit = 65536) {
	const data = await fs.readFile(filename)
	if (data.length > limit) fail('input_limit_exceeded')
	return JSON.parse(data)
}

async function main(options) {
	const deadline = Date.now() + options.deadlineMs
	const report = { schemaVersion: 1, status: 'failed', expectedBundleDigest: options['expected-bundle-digest'] }
	if (/@sha256:[a-f0-9]{64}$/.test(options.image)) report.candidateDigest = options.image
	const id = crypto.randomBytes(8).toString('hex'), boot = `gc-processor-boot-${id}`, protocol = `gc-processor-protocol-${id}`
	const overlay = `gc-processor-tests:${id}`
	const baseTag = `gc-processor-candidate:${id}`
	let stage, fixture, overlayBuilt = false, baseTagged = false
	const containers = []
	const docker = (args, extra = {}) => command('docker', args, { deadline, ...extra })
	try {
		// Resolve tags once, then use the local content-addressed config ID for every run and overlay.
		let inspection
		try { inspection = await docker(['image', 'inspect', '--format', '{{json .Id}}', options.image]) }
		catch { await docker(['pull', '--quiet', options.image]); inspection = await docker(['image', 'inspect', '--format', '{{json .Id}}', options.image]) }
		const image = JSON.parse(inspection)
		if (!/^sha256:[a-f0-9]{64}$/.test(image)) fail('invalid_image_identity')
		report.imageId = image
		const label = (await docker(['image', 'inspect', '--format', '{{index .Config.Labels "org.geocluster.preprocessing.bundle.sha256"}}', image])).trim()
		if (label !== options['expected-bundle-digest']) fail('bundle_label_mismatch')
		const recipe = await jsonFile(path.join(repo, 'opencode/engine/source-build.json'))
		const engineInput = { ...recipe, buildScriptSha256: sha(await fs.readFile(path.join(repo, 'opencode/engine/build.ts'))) }
		report.engineInputSha256 = sha(JSON.stringify(engineInput))
		let discovery
		if (options['backend-source']) {
			const source = path.resolve(options['backend-source'])
			const venv = path.join(source, '.venv/bin/python')
			const python = await fs.access(venv).then(() => venv, () => 'python3')
			const raw = await command(python, [path.join(here, 'processor-discovery-fixture.py'), '--backend-source', source], { deadline, code: 'discovery_builder_failed' })
			discovery = JSON.parse(raw)
		} else discovery = await jsonFile(path.join(here, 'processor-discovery-fixture.json'))
		if (discovery.projection?.discovery_schema_version !== 2 || discovery.projection.allowed_model_ids?.length !== 2 ||
			!discovery.provenance?.builderSha256 || !/^[a-f0-9]{64}$/.test(discovery.provenance.builderSha256)) fail('invalid_discovery_fixture')
		report.discovery = { builderSha256: discovery.provenance.builderSha256, fixtureSha256: sha(JSON.stringify(discovery.projection)), candidates: 2 }
		containers.push(boot)
		await docker(['create', '--name', boot, '--network', 'none', '--memory', '4g', '--cpus', '2',
			'--entrypoint', '/bin/bash',
			'--tmpfs', '/workspace:rw,size=1g', '--tmpfs', '/run/runtime:rw,mode=0700', '--tmpfs', '/tmp:rw,size=1g',
			'-e', 'PROJECT_ID=processor-qualification', '-e', 'USER_ID=qualification',
			'-e', `IDE_PROXY_KEY=${crypto.randomBytes(32).toString('hex')}`,
			'-e', 'RUNTIME_PROFILE=managed', '-e', 'LLM_PROXY_URL=http://127.0.0.1:18766/v1',
			'-e', 'IDE_MACHINE_CREDENTIALS_URL=http://127.0.0.1:18766/renew', '-e', 'IDE_MACHINE_TOKEN=local-machine-only',
			'-e', 'PREPROCESSING_MODEL=proxy/openai/gpt-6-luna',
			'-e', 'PREPROCESSING_ENABLED=false', '-e', 'RUNTIME_AGGREGATE_ACTIVITY=false',
			'-e', 'SYNC_ENABLED=false', '-e', 'FILES_SYNC_ADAPTER=false', '-e', 'OWNED_DEMO_ENABLED=false', image,
			'-c', 'for i in {1..300}; do if [ -f /tmp/qualification-ready ]; then exec /entrypoint.sh headless; fi; sleep .1; done; exit 2'])
		await docker(['start', boot])
		// Start the loopback backend before the unmodified entrypoint's mandatory renewal.
		const fixtureSource = await fs.readFile(path.join(here, 'processor-discovery-server.mjs'), 'utf8')
		fixture = spawn('docker', ['exec', '-i', boot, 'node', '--input-type=module', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
		fixture.stdin.on('error', () => {})
		fixture.stdin.end(`const projection = ${JSON.stringify(discovery.projection)};\n${fixtureSource}`)
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { fixture.kill('SIGKILL'); reject(new Error('discovery_fixture_timeout')) }, Math.min(10000, Math.max(1, deadline - Date.now())))
			fixture.stdout.once('data', data => { clearTimeout(timer); data.toString().trim() === 'FIXTURE_READY' ? resolve() : reject(new Error('discovery_fixture_failed')) })
			fixture.stderr.resume()
			fixture.once('error', () => { clearTimeout(timer); reject(new Error('discovery_fixture_failed')) })
			fixture.once('exit', () => { clearTimeout(timer); reject(new Error('discovery_fixture_failed')) })
		})
		fixture.stdout.resume()
		const probeSource = await fs.readFile(path.join(here, 'processor-probe.py'), 'utf8')
		const raw = await docker(['exec', '-i', boot, '/opt/geocluster-preprocessing/bin/python', '-', JSON.stringify({ digest: options['expected-bundle-digest'], engineInput, deadlineMs: Math.max(1, deadline - Date.now() - 1000) })], { input: probeSource, code: 'installed_startup_failed', accepted: [0, 1] })
		const startup = JSON.parse(raw)
		if (startup.ok !== true) {
			if (['boot', 'service', 'dependency', 'policy', 'identity', 'processes', 'discovery', 'boundary'].includes(startup.stage)) report.startupFailureStage = startup.stage
			fail('installed_startup_failed')
		}
		validateProbe(startup, options['expected-bundle-digest'])
		report.startup = startup
		if (!options['processor-source']) fail('processor_test_source_required')
		const source = path.join(path.resolve(options['processor-source']), 'tests/preprocessing/test_engine_http_real.py')
		const stat = await fs.lstat(source)
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) fail('invalid_protocol_test_source')
		stage = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-processor-tests-'))
		await fs.copyFile(source, path.join(stage, 'test_engine_http_real.py'))
		for (const filename of ['processor-protocol.Dockerfile', 'processor-protocol-runner.py']) await fs.copyFile(path.join(here, filename), path.join(stage, filename))
		report.protocolSourceSha256 = sha(await fs.readFile(source))
		const provenancePath = path.join(path.resolve(options['processor-source']), 'qualification-provenance.json')
		if (await fs.access(provenancePath).then(() => true, () => false)) {
			const provenance = await jsonFile(provenancePath)
			if (provenance.testSourceSha256 !== report.protocolSourceSha256 || !/^[a-f0-9]{40}$/.test(provenance.sourceRevision || '')) fail('invalid_protocol_test_source')
			report.processorSourceRevision = provenance.sourceRevision
		}
		// BuildKit interprets a bare config ID as a repository. Give the captured ID
		// a unique disposable local tag, and verify that tag around the overlay build.
		await docker(['image', 'tag', image, baseTag])
		baseTagged = true
		if (JSON.parse(await docker(['image', 'inspect', '--format', '{{json .Id}}', baseTag])) !== image) fail('invalid_image_identity')
		await docker(['build', '--quiet', '--build-arg', `CANDIDATE=${baseTag}`, '-f', path.join(stage, 'processor-protocol.Dockerfile'), '-t', overlay, stage], { limit: 1048576, code: 'protocol_overlay_build_failed' })
		overlayBuilt = true
		if (JSON.parse(await docker(['image', 'inspect', '--format', '{{json .Id}}', baseTag])) !== image) fail('invalid_image_identity')
		containers.push(protocol)
		const result = JSON.parse(await docker(protocolRunArgs(protocol, overlay), { code: 'installed_protocol_failed', accepted: [0, 1] }))
		// Retain safe counts on a failed protocol run, never arbitrary runner fields.
		report.protocol = Object.fromEntries(['ok', 'installedPackage', 'collected', 'passed', 'skipped', 'failed',
			'completedTurns', 'twoCandidates', 'completedCandidates', 'evidenceBeforeDelete'].filter(key =>
				typeof result[key] === 'boolean' || (Number.isSafeInteger(result[key]) && result[key] >= 0 && result[key] <= 10000))
			.map(key => [key, result[key]]))
		validateProtocol(result)
		report.status = 'succeeded'
	} catch (error) {
		const codes = new Set(['invalid_image_identity', 'bundle_label_mismatch', 'invalid_discovery_fixture', 'discovery_builder_failed',
			'discovery_fixture_timeout', 'discovery_fixture_failed', 'invalid_startup_proof', 'processor_test_source_required',
			'invalid_protocol_test_source', 'protocol_overlay_build_failed', 'installed_protocol_failed', 'invalid_protocol_proof',
			'installed_startup_failed', 'deadline_exceeded', 'output_limit_exceeded', 'input_limit_exceeded', 'command_failed'])
		report.failure = codes.has(error.message) ? error.message : 'qualification_failed'
	} finally {
		fixture?.kill('SIGKILL')
		const cleanupDeadline = Date.now() + 30000
		report.cleanup = true
		for (const name of containers) try { await command('docker', ['rm', '-f', '-v', name], { deadline: cleanupDeadline }) } catch { report.cleanup = false }
		if (overlayBuilt) try { await command('docker', ['image', 'rm', overlay], { deadline: cleanupDeadline }) } catch { report.cleanup = false }
		if (baseTagged) try { await command('docker', ['image', 'rm', baseTag], { deadline: cleanupDeadline }) } catch { report.cleanup = false }
		if (stage) await fs.rm(stage, { recursive: true, force: true })
		if (!report.cleanup) report.status = 'failed'
	}
	const output = JSON.stringify(report, null, 2) + '\n'
	if (options.report) await fs.writeFile(options.report, output, { mode: 0o600 })
	process.stdout.write(output)
	if (report.status !== 'succeeded') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try { await main(parseArgs(process.argv.slice(2))) }
	catch { console.error('Processor qualification failed: invalid arguments or inaccessible evidence destination.'); process.exitCode = 1 }
}
