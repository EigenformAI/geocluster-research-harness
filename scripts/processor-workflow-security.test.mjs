import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const image = readFileSync(new URL('../.github/workflows/processor-image-check.yml', import.meta.url), 'utf8')
const release = readFileSync(new URL('../.github/workflows/fly-deploy.yml', import.meta.url), 'utf8')
const job = (workflow, name) => {
	const section = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))
	assert.ok(section, `missing job ${name}`)
	return section[1]
}
const permitted = (section, event, ref) => {
	const condition = section.match(/^    if: (.+)$/m)?.[1]
	assert.ok(condition, 'credentialed jobs need an explicit event/ref condition')
	return Function('github', `return (${condition.replace(/^\$\{\{\s*|\s*\}\}$/g, '')})`)({
		event_name: event,
		ref,
		repository: 'owner/runtime',
		event: { pull_request: { head: { repo: { full_name: 'owner/runtime' } } } },
	})
}

test('release and image qualification select the same pinned bytes despite stale repository variables', () => {
	const variables = { PREPROCESSING_BUNDLE_REPO: 'old/processor', PREPROCESSING_BUNDLE_TAG: 'preprocessing-0000000', PREPROCESSING_BUNDLE_DIGEST: '0'.repeat(64) }
	const environment = (section, indent, repositoryVariables = variables) => {
		const block = section.match(new RegExp(`^${' '.repeat(indent)}env:\n((?:${' '.repeat(indent + 2)}[^\n]+\n)+)`, 'm'))?.[1] ?? ''
		return Object.fromEntries([...block.matchAll(/^\s+(PREPROCESSING_BUNDLE_\w+): (.+)$/gm)].map(([, name, value]) => [name, value.replace(/\$\{\{\s*vars\.(\w+)\s*\}\}/g, (_, key) => repositoryVariables[key] ?? '')]))
	}
	let pinned
	for (const [workflow, name] of [[release, 'build'], [image, 'qualify']]) {
		const section = job(workflow, name), inherited = environment(section, 4)
		assert.deepEqual(environment(section, 4, {}), inherited, 'repository variables must not select the job bundle')
		assert.match(inherited.PREPROCESSING_BUNDLE_REPO ?? '', /^[\w.-]+\/[\w.-]+$/)
		assert.match(inherited.PREPROCESSING_BUNDLE_TAG ?? '', /^preprocessing-[a-f0-9]{7,40}$/)
		assert.match(inherited.PREPROCESSING_BUNDLE_DIGEST ?? '', /^[a-f0-9]{64}$/)
		pinned ??= inherited
		assert.deepEqual(inherited, pinned, 'release and qualification must use the same bundle')
		const consumers = section.split(/^      - /m).filter(step => /processor-ci-inputs\.py|test:image:processor|docker buildx build/.test(step))
		assert.equal(consumers.length, 3, 'verify download, build, and installed processor qualification inputs')
		for (const step of consumers) assert.deepEqual({ ...inherited, ...environment(step, 8) }, pinned, 'step overrides must not select stale repository variables')
	}
})

test('credentialed qualification rejects PRs and non-main dispatches', () => {
	for (const [workflow, name, events] of [[image, 'qualify', ['workflow_dispatch']], [release, 'build', ['push', 'workflow_dispatch']], [release, 'publish', ['push', 'workflow_dispatch']]]) {
		const section = job(workflow, name)
		for (const event of ['pull_request', 'pull_request_target', 'workflow_dispatch', 'push']) {
			for (const ref of ['refs/pull/42/merge', 'refs/heads/feature', 'refs/tags/main', 'refs/heads/main']) {
				assert.equal(permitted(section, event, ref), ref === 'refs/heads/main' && events.includes(event), `${name}: ${event} on ${ref}`)
			}
		}
	}
})

test('PR harness checks run without private secrets or submodule credentials', () => {
	const section = job(image, 'harness')
	assert.equal(permitted(section, 'pull_request', 'refs/pull/42/merge'), true)
	assert.equal(permitted(section, 'workflow_dispatch', 'refs/heads/feature'), false)
	assert.match(image, /^  pull_request:\n/m)
	assert.match(image, /^permissions:\n  contents: read\n/m)
	assert.doesNotMatch(image.slice(0, image.indexOf('\njobs:')), /secrets\.|^env:|pull_request_target|workflow_run/m)
	assert.doesNotMatch(section, /secrets\.|^    (?:env|permissions|uses):|^          (?:token|ssh-key|ref|repository):/m)
	assert.match(section, /^          submodules: false$/m)
})

test('checkout removes credentials before repository-controlled steps run', () => {
	for (const [workflow, names] of [[image, ['harness', 'qualify']], [release, ['build', 'publish']]]) {
		for (const name of names) {
			const section = job(workflow, name)
			const checkout = section.match(/- uses: actions\/checkout@v4\n([\s\S]*?)(?=^      - )/m)?.[1]
			assert.ok(checkout, `missing checkout in ${name}`)
			assert.match(checkout, /^          persist-credentials: false$/m)
			assert.doesNotMatch(checkout, /^          (?:ref|repository):/m, 'trusted ref must also be the checked-out revision')
		}
	}
})

test('only PR and manual events trigger image checks; releases trigger on main pushes and manual events', () => {
	const imageTriggers = image.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1]
	const releaseTriggers = release.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1]
	assert.deepEqual([...imageTriggers.matchAll(/^  ([\w_]+):/gm)].map(match => match[1]), ['pull_request', 'workflow_dispatch'])
	assert.deepEqual([...releaseTriggers.matchAll(/^  ([\w_]+):/gm)].map(match => match[1]), ['push', 'workflow_dispatch'])
	assert.match(releaseTriggers, /^  push:\n    branches:\n      - main\n  workflow_dispatch:/m)
})
