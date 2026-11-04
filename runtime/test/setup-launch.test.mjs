import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { test } from "node:test"

const root = new URL("../../", import.meta.url).pathname
const entrypoint = await fs.readFile(path.join(root, "entrypoint.sh"), "utf8")
// Nix hosts keep Python outside the image's trusted /usr/bin location.
const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim()
const definitions = entrypoint.replace(/launch_runtime "\$@"\s*$/, "").replaceAll("/usr/bin/python3", JSON.stringify(python))
const ptyRunner = "import os,pty,subprocess,sys; master,slave=pty.openpty(); result=subprocess.run(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave); os.close(slave); output=b'';\nwhile True:\n try: output+=os.read(master,65536)\n except OSError: break\nsys.stdout.buffer.write(output); sys.exit(result.returncode)"
const isRoot = process.getuid?.() === 0
const rootAvailable = isRoot || spawnSync("sudo", ["-n", "true"], { timeout: 5000 }).status === 0

function runRoot(command, args, options = {}) {
	return spawnSync(isRoot ? command : "sudo", isRoot ? args : ["-n", "--", command, ...args], { encoding: "utf8", timeout: 5000, ...options })
}

function rootPython(code, args) {
	const result = runRoot(python, ["-IB", "-c", code, ...args])
	assert.equal(result.status, 0, result.stdout + result.stderr)
	return result.stdout
}

async function startupFixture(t, { privileged = false } = {}) {
	if (privileged && !rootAvailable) {
		t.skip("Native project ownership fixtures require root or working sudo -n; neither is available")
		return null
	}
	const dir = path.join("/tmp/opencode", `setup-launch-${randomUUID()}`)
	await fs.mkdir(dir, { mode: 0o700 })
	t.after(() => privileged ? rootPython(`
import pathlib, shutil, sys, uuid
target = pathlib.Path(sys.argv[1])
assert target.parent == pathlib.Path('/tmp/opencode') and target.name.startswith('setup-launch-')
uuid.UUID(target.name.removeprefix('setup-launch-'))
assert target.is_dir() and not target.is_symlink()
shutil.rmtree(target)
`, [dir]) : fs.rm(dir, { recursive: true, force: true }))
	const workspace = path.join(dir, "workspace"), runtime = path.join(dir, "fixture-runtime")
	await fs.mkdir(workspace)
	await fs.mkdir(runtime)
	for (const name of ["setup-workspace.py", "setup_transfer.py"]) await fs.symlink(path.join(root, "runtime", name), path.join(runtime, name))
	if (privileged) rootPython("import os,sys; os.chown(sys.argv[1],0,0); os.chmod(sys.argv[1],0o755)", [workspace])
	// Keep the real lock and startup dispatch. Replace the services that require
	// image users and system directories with observable project preparation.
	// Root fixtures retain the native project-root ownership and mode changes.
	await fs.writeFile(path.join(runtime, "native-services.sh"), `
native_main() {
    mkdir -p "$WORKSPACE_DIR"
    if [ "$TEST_NATIVE_NORMALIZE" = 1 ]; then
        "$TEST_PYTHON" -IB -c 'import os,sys; os.chown(sys.argv[1],999,999); os.chmod(sys.argv[1],0o2775)' "$WORKSPACE_DIR"
    fi
    printf prepared > "$WORKSPACE_DIR/startup"
    echo NATIVE_STARTED
}
`)
	return {
		workspace,
		prepare(project, { uid = 999, gid = 999, mode = 0o2775, acl = null } = {}) {
			rootPython(`
import os, pathlib, struct, sys
project = pathlib.Path(sys.argv[1])
project.mkdir()
(project / 'input.csv').write_text('hole_id\\nWC141\\n')
os.chown(project, int(sys.argv[2]), int(sys.argv[3]))
os.chmod(project, int(sys.argv[4]))
if sys.argv[5]:
    entries = [(1, 7, 0xffffffff), (2, 4, 20001), (4, 7, 0xffffffff), (16, 7, 0xffffffff), (32, 5, 0xffffffff)]
    value = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)
    os.setxattr(project, 'system.posix_acl_' + sys.argv[5], value)
`, [path.join(workspace, project), String(uid), String(gid), String(mode), acl || ""])
		},
		snapshot(project) {
			return JSON.parse(rootPython(`
import base64, errno, json, os, pathlib, stat, sys
project = pathlib.Path(sys.argv[1])
info = project.stat()
acls = {}
for name in ('system.posix_acl_access', 'system.posix_acl_default'):
    try:
        acls[name] = base64.b64encode(os.getxattr(project, name)).decode('ascii')
    except OSError as error:
        if error.errno != errno.ENODATA:
            raise
print(json.dumps({'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
                  'inode': info.st_ino, 'ctimeNs': str(info.st_ctime_ns), 'mtimeNs': str(info.st_mtime_ns),
                  'acls': acls, 'children': sorted(os.listdir(project)), 'input': (project / 'input.csv').read_text()}))
`, [path.join(workspace, project)]))
		},
		launch(project = "default", required = true) {
			const args = [path.join(root, "runtime/lifecycle-lock.py"), workspace, "native", "bash", "-c", `${definitions}
WORKSPACE_DIR="$TEST_WORKSPACE/$PROJECT_ID"
RUNTIME_CODE_DIR="$TEST_RUNTIME"
validate_launch() { RUNTIME_PROFILE=native; }
launch_runtime --runtime-lock-held tui
`]
			const env = { PATH: process.env.PATH, TEST_WORKSPACE: workspace, TEST_RUNTIME: runtime, TEST_PYTHON: python, TEST_NATIVE_NORMALIZE: privileged ? "1" : "0", PROJECT_ID: project, ...(required ? { RUNTIME_REQUIRE_EXISTING_PROJECT: "1" } : {}) }
			return privileged
				? runRoot("/usr/bin/env", ["-i", ...Object.entries(env).map(([name, value]) => `${name}=${value}`), python, ...args])
				: spawnSync("python3", args, { env, encoding: "utf8", timeout: 5000 })
		},
	}
}

test("required saved project stays absent when locked startup cannot find it", async (t) => {
	const fixture = await startupFixture(t)
	const result = fixture.launch()
	assert.equal(result.status, 2, result.stdout + result.stderr)
	assert.match(result.stderr, /workspace data directory.*does not exist/i)
	assert.doesNotMatch(result.stdout, /NATIVE_STARTED/)
	await assert.rejects(fs.lstat(path.join(fixture.workspace, "default")), { code: "ENOENT" })
})

test("required existing project reaches native startup with its files retained", async (t) => {
	const fixture = await startupFixture(t, { privileged: true })
	if (!fixture) return
	for (const mode of [0o2770, 0o2775]) {
		const project = `valid-${mode.toString(8)}`
		fixture.prepare(project, { mode })
		const result = fixture.launch(project)
		assert.equal(result.status, 0, result.stdout + result.stderr)
		assert.match(result.stdout, /NATIVE_STARTED/)
		const snapshot = fixture.snapshot(project)
		assert.equal(snapshot.input, "hole_id\nWC141\n")
		assert.deepEqual(snapshot.children, ["input.csv", "startup"])
	}
})

for (const [name, properties] of [
	["UID", { uid: 0 }],
	["GID", { gid: 0 }],
	["mode", { mode: 0o777 }],
	["access ACL", { acl: "access" }],
	["default ACL", { acl: "default" }],
]) {
	test(`required project rejects unsafe ${name} before native repair or startup`, async (t) => {
		const fixture = await startupFixture(t, { privileged: true })
		if (!fixture) return
		fixture.prepare("default", properties)
		const before = fixture.snapshot("default")
		const result = fixture.launch()
		assert.deepEqual(fixture.snapshot("default"), before, "Rejected project metadata, ACLs, and input must remain unchanged")
		assert.equal(result.status, 2, result.stdout + result.stderr)
		assert.match(result.stderr, /ownership|permission|mode|ACL/i)
		assert.doesNotMatch(result.stdout, /NATIVE_STARTED/)
	})
}

test("required project rejects links and non-directories without changing them", async (t) => {
	const fixture = await startupFixture(t)
	const target = path.join(fixture.workspace, "target")
	await fs.mkdir(target)
	await fs.symlink(target, path.join(fixture.workspace, "linked"))
	await fs.symlink(path.join(fixture.workspace, "absent"), path.join(fixture.workspace, "dangling"))
	await fs.writeFile(path.join(fixture.workspace, "file"), "keep me")
	for (const project of ["linked", "dangling", "file"]) {
		const before = await fs.lstat(path.join(fixture.workspace, project), { bigint: true })
		const result = fixture.launch(project)
		assert.equal(result.status, 2, result.stdout + result.stderr)
		assert.match(result.stderr, /workspace data path.*real directory/i)
		const after = await fs.lstat(path.join(fixture.workspace, project), { bigint: true })
		assert.equal(after.ino, before.ino)
		assert.equal(after.ctimeNs, before.ctimeNs)
	}
	assert.deepEqual(await fs.readdir(target), [])
	await assert.rejects(fs.lstat(path.join(fixture.workspace, "absent")), { code: "ENOENT" })
	assert.equal(await fs.readFile(path.join(fixture.workspace, "file"), "utf8"), "keep me")
})

test("required project rejects reserved names and traversal before native preparation", async (t) => {
	const fixture = await startupFixture(t)
	for (const project of [".", "..", ".runtime", ".ide-state", "nested/project"]) {
		const result = fixture.launch(project)
		assert.equal(result.status, 2, result.stdout + result.stderr)
		assert.match(result.stderr, /workspace data directory.*non-reserved/i)
		assert.doesNotMatch(result.stdout, /NATIVE_STARTED/)
	}
	await assert.rejects(fs.lstat(path.join(fixture.workspace, "nested")), { code: "ENOENT" })
	await assert.rejects(fs.lstat(path.join(fixture.workspace, ".runtime/startup")), { code: "ENOENT" })
})

test("ordinary explicit startup still creates a missing project", async (t) => {
	const fixture = await startupFixture(t)
	const result = fixture.launch("new-project", false)
	assert.equal(result.status, 0, result.stdout + result.stderr)
	assert.equal(await fs.readFile(path.join(fixture.workspace, "new-project/startup"), "utf8"), "prepared")
})

test("explicit launcher forwards the existing-workspace requirement only when requested", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/setup-launcher-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	await fs.writeFile(path.join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', { mode: 0o755 })
	for (const required of [false, true]) {
		const capture = path.join(dir, required ? "required" : "normal")
		const result = spawnSync("python3", ["-c", ptyRunner, "bash", path.join(root, "scripts/run-runtime-tui.sh"), ...(required ? ["--require-existing-workspace"] : [])], {
			env: { PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture, RUNTIME_REQUIRE_EXISTING_PROJECT: "1", PROJECT_ID: "old-named-project" }, encoding: "utf8", timeout: 5000,
		})
		assert.equal(result.status, 0, result.stdout + result.stderr)
		const args = (await fs.readFile(capture, "utf8")).trim().split("\n")
		assert.equal(args.includes("RUNTIME_REQUIRE_EXISTING_PROJECT=1"), required)
		assert.equal(args.includes("--pull=never"), required)
		assert.ok(args.includes("RUNTIME_PROFILE=native"))
		assert.ok(args.includes("PROJECT_ID=default"))
		assert.equal(args.at(-1), "tui")
	}
})

test("explicit launcher rejects project selection through flags or engine environment before Docker", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/setup-selector-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const capture = path.join(dir, "calls")
	await fs.writeFile(path.join(dir, "docker"), '#!/bin/sh\nprintf called > "$CAPTURE"\n', { mode: 0o755 })
	for (const args of [["--project", "named"], ["--project=default"], ["--require-existing-project"], ["--engine-env", "PROJECT_ID"]]) {
		const result = spawnSync("python3", ["-c", ptyRunner, "bash", path.join(root, "scripts/run-runtime-tui.sh"), ...args], {
			env: { PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture, PROJECT_ID: "named" }, encoding: "utf8", timeout: 5000,
		})
		assert.equal(result.status, 2, result.stdout + result.stderr)
		assert.match(result.stdout, /unknown option|removed|reserved/i)
		await assert.rejects(fs.stat(capture), { code: "ENOENT" })
	}
})
