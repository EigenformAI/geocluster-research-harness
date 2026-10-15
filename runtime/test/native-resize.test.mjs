import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"

test("terminal resize cannot be mistaken for a local service exit", { timeout: 10000 }, async () => {
	for (let round = 0; round < 5; round++) {
		const helper = new URL("../native-services.sh", import.meta.url).pathname
		const child = spawn("bash", ["-c", `
source "$1"
trap ':' WINCH
( sleep .25; exit 23 ) & NATIVE_PID=$!
sleep 10 & FILES_PID=$!
trap 'kill "$FILES_PID" 2>/dev/null || true' EXIT
echo READY
wait_for_native_services
exit "$?"
`, "test", helper], { stdio: ["ignore", "pipe", "pipe"] })
		let stderr = ""
		child.stderr.on("data", (data) => { stderr += data })
		child.stdout.once("data", () => setTimeout(() => child.kill("SIGWINCH"), 20 + Math.random() * 60))
		const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
		assert.equal(code, 23, stderr || "the wait returned the resize signal instead of the service status")
	}
})
