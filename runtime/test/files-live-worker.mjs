/** Disposable daemon behind the real development access gate, for browser/adapter verification. */
import crypto from "node:crypto"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
const { createGateServer } = createRequire(import.meta.url)("../gate.cjs")
await fs.mkdir("/workspace/project", { mode: 0o2775 }); await fs.chown("/workspace/project", 999, 999); await fs.chmod("/workspace/project", 0o2775)
await fs.mkdir("/workspace/.runtime", { mode: 0o755 }); await fs.mkdir("/workspace/.runtime/file-service", { mode: 0o755 }); await fs.mkdir("/workspace/.runtime/file-service/project", { mode: 0o700 }); await fs.chown("/workspace/.runtime/file-service/project", 998, 999)
const secret = crypto.randomBytes(32).toString("hex")
await fs.mkdir("/run/runtime", { recursive: true, mode: 0o700 }); await fs.writeFile("/run/runtime/gate-secret", secret, { mode: 0o600 })
const child = spawn(process.execPath, ["test/files-process-worker.mjs"], { uid: 998, gid: 999, env: { PATH: "/usr/bin:/bin", TEST_WORKSPACE: "/workspace/project", TEST_STATE: "/workspace/.runtime/file-service/project", TEST_SECRET: secret }, stdio: ["ignore", "ignore", "inherit", "ipc"] })
const port = await new Promise((resolve, reject) => { child.on("message", (message) => { if (message.port) resolve(message.port) }); child.once("exit", (code) => reject(new Error(`File daemon exited ${code}`))) })
const gate = createGateServer({ listenHost: "0.0.0.0", listenPort: 3000, upstreamHost: "127.0.0.1", upstreamPort: 3001, filesPort: port, filesHost: "127.0.0.1", gateFile: "/run/runtime/gate-secret", keyFile: "/run/runtime/no-key", projectId: "project", machineId: "", authDisabled: true, authDisabledRequested: true, frameAncestors: "'self'", allowedOrigins: ["http://127.0.0.1:3316", "http://127.0.0.1:3000"] })
gate.listen(3000, "0.0.0.0", () => console.log("READY: file gate :3000; agent gateway intentionally unavailable"))
const stop = () => { child.kill("SIGKILL"); gate.close(); process.exit(0) }
process.on("SIGTERM", stop); process.on("SIGINT", stop)
