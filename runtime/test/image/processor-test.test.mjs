import assert from 'node:assert/strict'
import { test } from 'node:test'
import { command, parseArgs, protocolRunArgs, validateProbe, validateProtocol } from './processor-test.mjs'

const digest = 'a'.repeat(64)
const probe = () => ({ ok: true, bundleDigest: digest, engineVersion: '2.0.19-geocluster.2',
	engineIdentityVerified: true, managedBoundaryVerified: true, authenticated: true, unauthenticatedStatus: 401,
	ready: true, executionReady: true, eligibleCandidateCount: 2, selectedModel: 'proxy/openai/gpt-6-luna', owners: 1, services: 1, uid: 996, gid: 996 })

test('requires independent digest and a positive bounded deadline', () => {
	const args = ['--image', 'local:test', '--expected-bundle-digest', digest]
	assert.equal(parseArgs(args).deadlineMs, 300000)
	for (const value of ['0', '-1', '1.5', 'Infinity', '1800001'])
		assert.throws(() => parseArgs([...args, '--deadline-ms', value]))
	assert.throws(() => parseArgs(['--image', 'local:test']))
	assert.throws(() => parseArgs([...args, '--surprise', 'yes']))
})

test('startup proof rejects mismatched bytes, truthy readiness and duplicate/wrong-identity children', () => {
	assert.doesNotThrow(() => validateProbe(probe(), digest))
	for (const patch of [{ bundleDigest: 'b'.repeat(64) }, { ready: 'true' }, { executionReady: 'false' },
		{ authenticated: false }, { owners: 2 }, { services: 0 }, { uid: 0 }, { gid: 999 },
		{ engineIdentityVerified: false }, { managedBoundaryVerified: false }, { unauthenticatedStatus: 200 }, { engineVersion: null },
		{ eligibleCandidateCount: 1 }, { selectedModel: 'proxy/google/gemini-3.8-flash' }])
		assert.throws(() => validateProbe({ ...probe(), ...patch }, digest))
})

test('protocol proof requires executed installed tests with no skips and two-model completion', () => {
	const value = { ok: true, installedPackage: true, collected: 3, passed: 3, skipped: 0,
		failed: 0, completedTurns: true, twoCandidates: true, completedCandidates: 2, evidenceBeforeDelete: true }
	assert.doesNotThrow(() => validateProtocol(value))
	for (const patch of [{ skipped: 1 }, { collected: 0, passed: 0 }, { passed: 2 },
		{ installedPackage: false }, { twoCandidates: false }, { completedCandidates: 1 }, { evidenceBeforeDelete: false }])
		assert.throws(() => validateProtocol({ ...value, ...patch }))
})

test('protocol temporary storage clears the default submission disk reserve within the container memory budget', () => {
	const args = protocolRunArgs('protocol-test', 'candidate-test-overlay')
	const mount = args[args.indexOf('--tmpfs') + 1]
	assert.equal(mount, '/tmp:rw,size=4g', '1 GiB cannot satisfy the default 1.25 GiB submission disk reserve')
	assert.equal(args[args.indexOf('--memory') + 1], '4g')
	assert.equal(args[args.indexOf('--network') + 1], 'none')
})

test('subprocess deadline, output ceiling and failures never expose raw child diagnostics', async () => {
	await assert.rejects(command(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'],
		{ deadline: Date.now() + 50 }), { message: 'deadline_exceeded' })
	await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("x".repeat(70000))'],
		{ deadline: Date.now() + 3000 }), { message: 'output_limit_exceeded' })
	await assert.rejects(command(process.execPath, ['-e', 'console.error("secret-token-config"); process.exit(1)'],
		{ deadline: Date.now() + 3000 }), { message: 'command_failed' })
})
