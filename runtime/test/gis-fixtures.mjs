import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export async function retained(directory, names) {
	const members = []
	for (const name of names) {
		const handle = await fs.open(path.join(directory, name), 'r')
		const bytes = await handle.readFile()
		members.push({ name, handle, source: { sizeBytes: bytes.length, digest: { state: 'ready', sha256: crypto.createHash('sha256').update(bytes).digest('hex') } } })
	}
	return { members, close: () => Promise.all(members.map(m => m.handle.close())) }
}

export async function bundleNames(directory, primary) {
	const names = await fs.readdir(directory), stem = primary.replace(/\.[^.]+$/, '')
	const extensions = primary.endsWith('.shp') ? ['shx', 'dbf', 'prj', 'cpg'] : primary.endsWith('.tab') ? [names.includes(`${stem}.dat`) ? 'dat' : 'dbf', 'map', 'id'] : primary.endsWith('.mif') ? ['mid'] : []
	return [primary, ...names.filter(n => extensions.some(ext => n.toLowerCase() === `${stem}.${ext}`)) , ...(primary.endsWith('.ers') ? [stem] : [])]
}
