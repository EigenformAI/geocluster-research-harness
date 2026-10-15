import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "node:test"

const exec = promisify(execFile)
test("engine bootstrap preserves exact service preference and permitted fallback policy", async () => {
	await exec("python3", ["-B", new URL("./preprocessing-bootstrap-fixture.py", import.meta.url).pathname], { timeout: 5000 })
})
