import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

for (const name of ['setup-common', 'setup-wizard', 'setup-host-root', 'workspace-files']) {
    test(`native setup host contract: ${name}`, () => {
        const file = fileURLToPath(new URL(`../../scripts/${name}.test.py`, import.meta.url))
        const result = spawnSync('python3', [file], { encoding: 'utf8', timeout: 60000 })
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    })
}
