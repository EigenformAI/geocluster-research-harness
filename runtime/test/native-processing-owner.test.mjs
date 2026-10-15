import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

test("native processing owner: installed owner, private context and guarded lifecycle", {
	skip: !process.env.NATIVE_PROCESSING_IMAGE,
	timeout: 180000,
}, () => {
	const root = path.resolve(new URL("../../", import.meta.url).pathname)
	const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "/opt/geocluster-preprocessing/bin/python", "-v", `${root}:/source:ro`, process.env.NATIVE_PROCESSING_IMAGE, "-I", "-u", "/source/runtime/test/fixtures/native-processing-owner-test.py"], { encoding: "utf8", timeout: 175000 })
	assert.equal(result.status, 0, result.stdout + result.stderr)
	assert.match(result.stdout, /native owner checks passed/)
})
