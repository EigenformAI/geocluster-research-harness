import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const workflow = readFileSync(new URL('../.github/workflows/fly-deploy.yml', import.meta.url), 'utf8')
const validation = workflow.match(/FLY_QUALIFICATION_TIMEOUT_MS="\$\(node -e '([^']+)'\)"/)[1]
const validate = minutes => spawnSync(process.execPath, ['-e', validation], {
	env: { ...process.env, QUALIFICATION_MINUTES: minutes }, encoding: 'utf8',
})

test('workflow accepts the default and supported qualification boundaries', () => {
	for (const minutes of ['1', '10', '60']) {
		const result = validate(minutes)
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.stdout, String(Number(minutes) * 60000))
	}
})

test('workflow rejects qualification that can exhaust the Fly job budget', () => {
	const result = validate('61')
	assert.equal(result.status, 1, 'qualification must reject 61 minutes')
	assert.equal(result.stdout, '')
	assert.match(result.stderr, /integer from 1 to 60/)
})

test('workflow rejects zero, negative, fractional, and malformed durations', () => {
	for (const minutes of ['0', '-1', '1.5', '', 'invalid', 'Infinity']) {
		const result = validate(minutes)
		assert.equal(result.status, 1, `qualification must reject ${JSON.stringify(minutes)}`)
		assert.equal(result.stdout, '')
	}
})
