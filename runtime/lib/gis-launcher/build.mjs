import { spawn } from 'node:child_process'
import { mkdir, rename, chmod, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux') throw new Error('GIS worker requires Linux confinement; no fallback.')
const here = path.dirname(fileURLToPath(import.meta.url)), output = path.join(here, 'build')
await mkdir(output, { recursive: true })
async function command(program, args, capture = false) {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' }); let text = ''
		child.stdout?.on('data', b => { text += b }); child.once('error', reject); child.once('close', code => code === 0 ? resolve(text.trim()) : reject(new Error(`${program} exited ${code}`)))
	})
}
const flags = (await command('pkg-config', ['--cflags', '--libs', 'gdal', 'json-c', 'proj', 'openssl'], true)).split(/\s+/)
const hardening = ['-O2', '-Wall', '-Wextra', '-Werror', '-Wno-misleading-indentation', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong', '-fPIE', '-pie', '-Wl,-z,relro,-z,now']
// Compile-time decode probes embed genuine driver-produced bytes in the fixed binary.
// This unconfined fixture producer is a build tool, never an installed dependency.
const producer = path.join(output, 'gis-fixture-producer'), fixtures = path.join(output, 'fixtures')
await command(process.env.CXX || 'c++', ['-std=c++17', ...hardening, path.join(here, '../gis-worker/fixtures.cpp'), ...flags, '-o', producer])
await rm(fixtures, { recursive: true, force: true }); await mkdir(fixtures)
await command(producer, [fixtures])
let header = '// Generated trusted compile-time fixtures.\n'
const entries = []
for (const [i, name] of (await readdir(fixtures)).sort().entries()) {
	if (name.endsWith('.aux.xml') || ['work.tif', 'palette.tif', 'dimensions.gpkg', 'json-range.gpkg', 'dense.geojson', 'many.geojson', 'positions.geojson'].includes(name)) continue
	const bytes = await readFile(path.join(fixtures, name))
	header += `static const unsigned char probe_${i}[] = {${[...bytes].join(',')}};\n`
	entries.push(`{${JSON.stringify(name)}, Bytes(probe_${i}, probe_${i}+sizeof(probe_${i}))}`)
}
// The header precedes worker aliases, so declare its complete standard types here.
header += `static const std::map<std::string,std::vector<unsigned char>> PROBE_FILES = {${entries.join(',').replaceAll('Bytes(', 'std::vector<unsigned char>(')}};\n`
await writeFile(path.join(output, 'probe-fixtures.h'), header)
for (const [name, compiler, args] of [
	['gis-launcher', process.env.CC || 'cc', ['-std=c11', path.join(here, 'launcher.c')]],
	['gis-worker', process.env.CXX || 'c++', ['-std=c++17', path.join(here, '../gis-worker/worker.cpp'), ...flags]],
]) {
	const temporary = path.join(output, `${name}.${process.pid}`)
	try { await command(compiler, [...hardening, ...args, '-o', temporary]); await chmod(temporary, 0o755); await rename(temporary, path.join(output, name)) } finally { await rm(temporary, { force: true }) }
}
console.log(`GIS fixed native launcher/worker built at ${output}; install worker=0555 launcher=4755 under /opt/geocluster-runtime.`)
