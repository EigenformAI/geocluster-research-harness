import { createHash } from 'node:crypto'
import { chmod, chown, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), projDirectory = '/usr/share/proj'

function validateGrid(grid) {
	if (!grid || !/^au_icsm_[A-Za-z0-9_]+\.tif$/.test(grid.name)
		|| !/^[a-f0-9]{64}$/.test(grid.sha256)
		|| !Number.isSafeInteger(grid.size) || grid.size <= 0
		|| !new RegExp(`^https://raw\\.githubusercontent\\.com/OSGeo/PROJ-data/[a-f0-9]{40}/au_icsm/${grid.name.replaceAll('.', '\\.')}$`).test(grid.url)) {
		throw new Error('GIS grid pin requires an ICSM filename, immutable official HTTPS URL, byte size, and SHA-256.')
	}
}

// The destination is a private staging file, never a live PROJ grid.
export async function downloadVerifiedGrid(grid, destination, fetchImpl = fetch) {
	validateGrid(grid)
	try {
		const response = await fetchImpl(grid.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
		if (response.status !== 200 || !response.body) throw new Error(`download failed (HTTP ${response.status}, grid body required)`)
		const chunks = [], hash = createHash('sha256'); let size = 0
		for await (const chunk of response.body) {
			size += chunk.byteLength
			if (size > grid.size) throw new Error(`download exceeds pinned size ${grid.size}`)
			hash.update(chunk); chunks.push(Buffer.from(chunk))
		}
		if (size !== grid.size) throw new Error(`byte size mismatch (expected ${grid.size}, got ${size})`)
		const digest = hash.digest('hex')
		if (digest !== grid.sha256) throw new Error(`SHA-256 mismatch (expected ${grid.sha256}, got ${digest})`)
		await writeFile(destination, Buffer.concat(chunks, size), { flag: 'wx', mode: 0o600 })
	} catch (error) {
		throw new Error(`${grid.name}: ${error.message}; no grid installed. Verify the pin and network, then retry the build.`, { cause: error })
	}
}

async function build() {
	if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Run the GIS grid installer as root in the Linux overlay build.')
	const directory = await lstat(projDirectory), database = await lstat(path.join(projDirectory, 'proj.db'))
	if (!directory.isDirectory() || !database.isFile() || [directory, database].some(st => st.uid !== 0 || st.gid !== 0 || st.mode & 0o022)) {
		throw new Error('GIS grids require the root-controlled /usr/share/proj directory and proj.db from the base image.')
	}
	const lockBytes = await readFile(path.join(here, 'grids.lock.json')), lock = JSON.parse(lockBytes)
	if (lock.version !== 1 || !/^[a-f0-9]{40}$/.test(lock.source_commit) || !Array.isArray(lock.grids) || !lock.grids.length) {
		throw new Error('GIS grid lock requires version 1, an immutable source commit, and nonempty grid pins.')
	}
	const names = new Set()
	for (const grid of lock.grids) {
		validateGrid(grid)
		if (names.has(grid.name) || grid.url !== `https://raw.githubusercontent.com/OSGeo/PROJ-data/${lock.source_commit}/au_icsm/${grid.name}`) {
			throw new Error('GIS grid lock contains a duplicate filename or a URL outside its pinned commit.')
		}
		names.add(grid.name)
	}
	const credit = await readFile(path.join(here, 'LICENSE.txt'))
	const staging = await mkdtemp(path.join(projDirectory, '.gis-grids-'))
	try {
		// Verify the entire fetched set before replacing any installed grid.
		for (const grid of lock.grids) await downloadVerifiedGrid(grid, path.join(staging, grid.name))
		await writeFile(path.join(staging, 'gis-grids.lock.json'), lockBytes, { flag: 'wx', mode: 0o600 })
		await writeFile(path.join(staging, 'gis-grids-LICENSE.txt'), credit, { flag: 'wx', mode: 0o600 })
		const files = [...names, 'gis-grids.lock.json', 'gis-grids-LICENSE.txt']
		for (const name of files) {
			const file = path.join(staging, name)
			await chown(file, 0, 0); await chmod(file, 0o444)
		}
		for (const name of files) await rename(path.join(staging, name), path.join(projDirectory, name))
		await chmod(projDirectory, 0o555)
		for (const name of files) {
			const installed = await lstat(path.join(projDirectory, name))
			if (!installed.isFile() || installed.uid !== 0 || installed.gid !== 0 || (installed.mode & 0o777) !== 0o444) {
				throw new Error(`${name}: installed grid or credit is not root:root mode 0444.`)
			}
		}
		for (const grid of lock.grids) {
			const installed = await readFile(path.join(projDirectory, grid.name))
			if (installed.length !== grid.size || createHash('sha256').update(installed).digest('hex') !== grid.sha256) {
				throw new Error(`${grid.name}: installed bytes differ from the pin.`)
			}
			console.log(`GIS grid installed: ${grid.name} SHA-256=${grid.sha256} root:root mode=0444`)
		}
	} finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	try { await build() } catch (error) { console.error(`GIS grid build failed: ${error.message}`); process.exitCode = 1 }
}
