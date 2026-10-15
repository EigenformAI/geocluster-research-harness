import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

test("an interrupted initial profile write cannot strand a volume behind a partial marker", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-marker-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const helper = new URL("../lifecycle-lock.py", import.meta.url).pathname
	const program = `import importlib.util,os,sys
s=importlib.util.spec_from_file_location('lock',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
write=os.write
def interrupted(fd,value):
    write(fd,value[:2]);os._exit(19)
m.os.write=interrupted
sys.argv=[sys.argv[1],sys.argv[2],'native',sys.argv[3],'-e','']
m.main()
`
	const interrupted = spawnSync("python3", ["-I", "-c", program, helper, root, process.execPath], { encoding: "utf8", timeout: 5000 })
	assert.equal(interrupted.status, 19, interrupted.stderr)
	const recovered = spawnSync("python3", ["-I", helper, root, "native", process.execPath, "-e", ""], { encoding: "utf8", timeout: 5000 })
	assert.equal(recovered.status, 0, recovered.stderr)
	assert.equal(await fs.readFile(path.join(root, ".runtime/profile"), "utf8"), "native\n")
})
