/** Run as root in a disposable container; exercises real UID permissions and reboot repair. */
import assert from "node:assert/strict"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import { provisionPreprocessing } from "../lib/preprocessing-provision.js"

assert.equal(process.getuid(), 0)
fs.mkdirSync("/workspace/.runtime", { recursive: true })
fs.mkdirSync("/run/runtime", { recursive: true, mode: 0o700 })
const env = { PROJECT_ID: "fixture" }
provisionPreprocessing(env)
const base = "/workspace/.runtime/preprocessing/fixture"
fs.mkdirSync(`${base}/inbox/job`)
fs.writeFileSync(`${base}/inbox/job/input.csv`, "exact accepted bytes")
fs.writeFileSync(`${base}/data/result`, "private result")
fs.writeFileSync(`${base}/engine/descriptor`, "private recovery")
// Simulate a prior bad ownership repair, then apply the actual next-boot provisioner.
for (const filename of [`${base}/inbox/job`, `${base}/inbox/job/input.csv`, `${base}/data/result`, `${base}/engine/descriptor`]) { fs.chownSync(filename, 999, 999); fs.chmodSync(filename, 0o777) }
provisionPreprocessing(env)

function access(uid, gid, groups, filename, write = false, fd = null) {
	const program = `const fs=require('node:fs'); process.setgroups(${JSON.stringify(groups)}); process.setgid(${gid}); process.setuid(${uid}); try { ${write ? `fs.writeFileSync(${JSON.stringify(filename)},'overwrite')` : `fs.readFileSync(${JSON.stringify(filename)})`}; process.exit(0) } catch(e) { if(!['EACCES','EPERM'].includes(e.code)) throw e; process.exit(3) }`
	const result = spawnSync(process.execPath, ["-e", program], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe", ...(fd === null ? [] : [fd])] })
	assert.ok([0, 3].includes(result.status), result.stderr.toString())
	return result.status === 0
}
for (const uid of [999, 997]) for (const filename of [`${base}/inbox/job/input.csv`, `${base}/data/result`, `${base}/engine/descriptor`]) assert.equal(access(uid, uid, [], filename), false)
assert.equal(access(996, 996, [], `${base}/inbox/job/input.csv`), true)
assert.equal(access(996, 996, [], `${base}/inbox/job/input.csv`, true), false)
assert.equal(access(998, 999, [996], `${base}/data/result`), false)
assert.equal(access(998, 999, [996], `${base}/engine/descriptor`), false)
assert.equal(access(998, 999, [996], `${base}/inbox/job/input.csv`), true)
assert.equal(access(996, 996, [], `${base}/data/result`), true)
assert.equal(fs.statSync(`${base}/inbox/job`).mode & 0o777, 0o750)
assert.equal(fs.statSync(`${base}/inbox/job/input.csv`).mode & 0o777, 0o440)
assert.equal(fs.statSync(`${base}/inbox/job/input.csv`).uid, 998)
assert.equal(fs.statSync(`${base}/inbox/job/input.csv`).gid, 996)
const fd = fs.openSync("/run/runtime/preprocessing/service-token", "r")
assert.equal(access(998, 999, [996], "/proc/self/fd/3", false, fd), true)
fs.closeSync(fd)
fs.symlinkSync("/tmp", `${base}/inbox/planted`)
assert.throws(() => provisionPreprocessing(env), /Unexpected object/)
console.log(JSON.stringify({ rebootRepair: "passed", deniedUids: [999, 997], serviceUid: 996, inboxOwner: "998:996", inboxDirectoryMode: "0750", inputMode: "0440", daemonPrivateStateAccess: false, serviceInputWriteAccess: false, rootOpenedTokenFd: "passed", symlinkRejected: true }))
