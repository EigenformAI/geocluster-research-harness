import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, chown, lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const parent = '/opt/geocluster-reader-jails', runtime = '/opt/geocluster-runtime'
const environment = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' }
const libraryDirectories = ['/lib', '/lib64', '/usr/lib', '/usr/lib64', '/usr/local/lib']
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const inside = (file, directory) => file === directory || file.startsWith(`${directory}/`)

function absolute(file) {
	if (!path.isAbsolute(file) || path.normalize(file) !== file || /[\x00-\x1f\x7f]/.test(file)) {
		throw new Error(`Invalid absolute dependency path: ${JSON.stringify(file)}`)
	}
	return file
}

// System library aliases (including Debian's merged /usr) are permitted only
// when both the named path and its resolved path have root-controlled ancestors.
async function controlled(file, allowSymlinks = false) {
	absolute(file)
	const parts = file.split('/').filter(Boolean)
	for (let i = 0; i <= parts.length; i++) {
		const component = `/${parts.slice(0, i).join('/')}`, st = await lstat(component)
		if (st.uid !== 0 || st.gid !== 0 || (st.isSymbolicLink() ? !allowSymlinks : st.mode & 0o022)) {
			throw new Error(`Dependency path is not root-controlled: ${component}`)
		}
		if (i < parts.length && !st.isDirectory() && !(allowSymlinks && st.isSymbolicLink())) {
			throw new Error(`Dependency ancestor is not a directory: ${component}`)
		}
	}
}

async function sourceFile(file, allowedDirectories, allowSymlinks = false) {
	await controlled(file, allowSymlinks)
	const resolved = await realpath(file)
	if (!allowedDirectories.some(directory => inside(resolved, directory))) {
		throw new Error(`Dependency resolves outside its installed source directories: ${file} -> ${resolved}`)
	}
	await controlled(resolved)
	if (!(await lstat(resolved)).isFile()) throw new Error(`Dependency is not a regular file: ${file}`)
	return resolved
}

function command(program, args) {
	const result = spawnSync(program, args, {
		env: environment, cwd: '/', encoding: 'utf8', timeout: 120_000,
		maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (result.error || result.status !== 0) {
		throw new Error(`${program} ${args.join(' ')} failed: ${result.error?.message || result.stderr.trim() || `status=${result.status}, signal=${result.signal}`}`)
	}
	return result.stdout
}

// Read PT_INTERP directly as well as parsing ldd's transitive dependency list.
// A shared preload has no interpreter, whereas each fixed executable must have one.
async function interpreter(file) {
	const handle = await open(file, 'r')
	try {
		const header = Buffer.alloc(64)
		if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length
			|| !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
			|| ![1, 2].includes(header[4]) || ![1, 2].includes(header[5])) {
			throw new Error(`Expected an installed ELF file: ${file}`)
		}
		const wide = header[4] === 2, little = header[5] === 1
		const u16 = (buffer, offset) => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
		const u32 = (buffer, offset) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
		const word = (buffer, offset) => {
			const value = wide ? Number(little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset)) : u32(buffer, offset)
			if (!Number.isSafeInteger(value)) throw new Error(`ELF offset exceeds safe integer range: ${file}`)
			return value
		}
		const offset = word(header, wide ? 32 : 28), size = u16(header, wide ? 54 : 42), count = u16(header, wide ? 56 : 44)
		if (size !== (wide ? 56 : 32) || !count || count > 1024) throw new Error(`Invalid ELF program headers: ${file}`)
		const entries = Buffer.alloc(size * count)
		if ((await handle.read(entries, 0, entries.length, offset)).bytesRead !== entries.length) throw new Error(`Truncated ELF program headers: ${file}`)
		let result = null
		for (let i = 0; i < count; i++) {
			const entry = entries.subarray(i * size, (i + 1) * size)
			if (u32(entry, 0) !== 3) continue
			if (result !== null) throw new Error(`Duplicate ELF interpreter: ${file}`)
			const start = word(entry, wide ? 8 : 4), length = word(entry, wide ? 32 : 16)
			if (length < 2 || length > 4096) throw new Error(`Invalid ELF interpreter length: ${file}`)
			const name = Buffer.alloc(length)
			if ((await handle.read(name, 0, length, start)).bytesRead !== length || name[length - 1] !== 0) throw new Error(`Truncated ELF interpreter: ${file}`)
			result = absolute(name.subarray(0, -1).toString('utf8'))
		}
		return result
	} finally { await handle.close() }
}

async function linkedFiles(file, executable) {
	const loader = await interpreter(file), files = new Set()
	if (executable && !loader) throw new Error(`Fixed executable has no ELF interpreter: ${file}`)
	for (const line of command('/usr/bin/ldd', [file]).split('\n').map(line => line.trim()).filter(Boolean)) {
		if (/\bnot found\b|unresolved/i.test(line)) throw new Error(`Unresolved ELF dependency for ${file}: ${line}`)
		if (/^linux-(?:vdso|gate)(?:64)?\.so\.\d+\s+\(0x[0-9a-f]+\)$/.test(line)) continue
		const match = /^(?:\S+\s+=>\s+)?(\/\S+)\s+\(0x[0-9a-f]+\)$/.exec(line)
		if (!match) throw new Error(`Unrecognized ldd dependency for ${file}: ${line}`)
		const dependency = absolute(match[1])
		if (!libraryDirectories.some(directory => inside(dependency, directory))) throw new Error(`ELF dependency is outside installed library directories: ${dependency}`)
		files.add(dependency)
	}
	if (loader && !files.has(loader)) throw new Error(`ldd omitted the ELF interpreter for ${file}: ${loader}`)
	return { files: [...files].sort(compare), loader }
}

async function plan(kind) {
	const files = new Map(), directories = new Set(['/'])
	async function add(file, executable = false, scopes = libraryDirectories, aliases = true) {
		const source = await sourceFile(file, scopes, aliases), previous = files.get(file)
		if (previous && previous.source !== source) throw new Error(`Conflicting dependency sources: ${file}`)
		files.set(file, { source, executable: executable || previous?.executable || false })
	}
	async function elf(file, executable, scopes) {
		await add(file, executable, scopes)
		const linked = await linkedFiles(files.get(file).source, executable)
		for (const dependency of linked.files) await add(dependency, dependency === linked.loader)
	}
	async function tree(directory, packageTree = false) {
		await controlled(directory)
		if (!(await lstat(directory)).isDirectory()) throw new Error(`Installed data tree is not a directory: ${directory}`)
		directories.add(directory)
		for (const name of (await readdir(directory)).sort(compare)) {
			if (packageTree && name === 'node_modules') throw new Error(`Unexpected nested Node dependencies in selected package: ${directory}`)
			const file = absolute(path.join(directory, name)), st = await lstat(file)
			if (st.isDirectory()) await tree(file, packageTree)
			else if (st.isFile()) await add(file, false, [directory], false)
			else throw new Error(`Installed data/package tree contains a symlink or special file: ${file}`)
		}
	}
	if (kind === 'gis') {
		await elf(`${runtime}/gis-worker`, true, [runtime])
		await tree('/usr/share/gdal')
		await tree('/usr/share/proj')
	} else {
		await elf('/usr/local/bin/node', true, ['/usr/local/bin', '/usr/bin'])
		await elf(`${runtime}/workbook-policy.so`, false, [runtime])
		await add(`${runtime}/lib/workbook-reader-worker.cjs`, false, [runtime], false)
		for (const name of ['xlsx', 'saxes', 'xmlchars']) await tree(`${runtime}/node_modules/${name}`, true)
		directories.add('/dev')
	}
	// Debian's BLAS/LAPACK alternatives can resolve through non-default library
	// directories. Keep the fixed loader index so the mirrored ldd paths are found;
	// no unselected library or other /etc contents are copied with it.
	await add('/etc/ld.so.cache', false, ['/etc'], false)
	for (const file of [...files.keys(), ...directories]) {
		for (let directory = path.dirname(file); directory !== '/'; directory = path.dirname(directory)) directories.add(directory)
	}
	return { kind, files, directories }
}

async function materialize({ kind, files, directories }) {
	const root = `${parent}/${kind}`, entries = []
	for (const directory of [...directories].sort(compare)) {
		const destination = path.join(root, directory)
		await mkdir(destination, { recursive: true, mode: 0o700 })
		await chown(destination, 0, 0)
		entries.push({ path: directory, type: 'directory', mode: '0555', uid: 0, gid: 0 })
	}
	for (const [file, { source, executable }] of [...files].sort(([a], [b]) => compare(a, b))) {
		const bytes = await readFile(source), destination = path.join(root, file), mode = executable ? 0o555 : 0o444
		await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
		await chown(destination, 0, 0); await chmod(destination, mode)
		entries.push({ path: file, type: 'file', mode: executable ? '0555' : '0444', uid: 0, gid: 0, sha256: createHash('sha256').update(bytes).digest('hex') })
	}
	const sentinel = '/.geocluster-isolation-sentinel', bytes = Buffer.from('Native reader isolation sentinel.\n')
	await writeFile(path.join(root, sentinel), bytes, { flag: 'wx', mode: 0o600 })
	await chown(path.join(root, sentinel), 0, 0); await chmod(path.join(root, sentinel), 0)
	entries.push({ path: sentinel, type: 'file', mode: '0000', uid: 0, gid: 0, sha256: createHash('sha256').update(bytes).digest('hex') })
	if (kind === 'workbook') {
		const device = path.join(root, '/dev/null')
		command('/usr/bin/mknod', ['--mode=0444', device, 'c', '1', '3'])
		await chown(device, 0, 0); await chmod(device, 0o444)
		const st = await lstat(device)
		if (!st.isCharacterDevice() || st.rdev !== 259) throw new Error('Workbook /dev/null must be the real Linux character device 1:3.')
		entries.push({ path: '/dev/null', type: 'character-device', mode: '0444', uid: 0, gid: 0, major: 1, minor: 3 })
	}
	for (const directory of [...directories].sort(compare).reverse()) await chmod(path.join(root, directory), 0o555)
	entries.sort((a, b) => compare(a.path, b.path))
	for (const entry of entries) {
		const st = await lstat(path.join(root, entry.path))
		const typeMatches = entry.type === 'directory' ? st.isDirectory() : entry.type === 'file' ? st.isFile() : st.isCharacterDevice()
		if (!typeMatches || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o7777) !== parseInt(entry.mode, 8)) throw new Error(`Incorrect installed jail entry: ${kind}:${entry.path}`)
	}
	return entries
}

async function build() {
	if (process.platform !== 'linux' || process.getuid() !== 0 || process.getgid() !== 0) throw new Error('Run the reader-jail packager as root:root during the Linux image build, after installing the fixed workers and policy.')
	const args = process.argv.slice(2)
	if (args.length > 1 || (args.length === 1 && args[0] !== '--workbook-only')) throw new Error('Usage: node lib/reader-jails/build.mjs [--workbook-only]')
	await controlled('/opt')
	try { await controlled(parent) } catch (error) { if (error.code !== 'ENOENT') throw error }
	await sourceFile('/usr/bin/ldd', ['/usr/bin'])
	await sourceFile('/usr/bin/mknod', ['/usr/bin'])
	const plans = []
	for (const kind of args.length ? ['workbook'] : ['gis', 'workbook']) plans.push(await plan(kind))
	// Replace the whole fixed parent, including any inherited base-image jail or
	// manifest. A workbook-only build never retains an older GIS root.
	await rm(parent, { recursive: true, force: true })
	await mkdir(parent, { mode: 0o700 }); await chown(parent, 0, 0)
	const manifest = { version: 1, jails: {} }
	for (const selected of plans) manifest.jails[selected.kind] = await materialize(selected)
	const destination = `${parent}/manifest.json`
	await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
	await chown(destination, 0, 0); await chmod(destination, 0o444); await chmod(parent, 0o555)
	console.log(`Reader jails packaged: ${Object.keys(manifest.jails).join(', ')}; manifest=${destination}`)
}

try { await build() } catch (error) { console.error(`Reader jail build failed: ${error.message}`); process.exitCode = 1 }
