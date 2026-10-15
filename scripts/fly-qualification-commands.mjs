// Exec requests stay short. The detached shell records completion atomically,
// independently of the API connection, in a root-only directory.
export const outputDir = '/run/runtime/native-release-qualification'
export function launchCommand(kind, timeoutMs) {
	const executable = kind === 'native'
		? 'gosu gc-files node /opt/geocluster-runtime/scripts/qualify-native-readers.mjs'
		: 'node /opt/geocluster-runtime/scripts/qualify-workspace-files.mjs'
	const seconds = kind === 'native' ? 130 : Math.ceil(timeoutMs / 1000)
	const shell = `timeout --kill-after=5s ${seconds}s ${executable}; code=$?; printf '%s' "$code" > ${outputDir}/${kind}.done.tmp; mv ${outputDir}/${kind}.done.tmp ${outputDir}/${kind}.done`
	return ['node', '--input-type=module', '-e', `
import fs from 'node:fs'; import { spawn } from 'node:child_process';
if (process.getuid() !== 0) process.exit(1);
fs.mkdirSync('/run/runtime', { recursive: true, mode: 0o700 });
const parent = fs.lstatSync('/run/runtime');
if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022)) process.exit(1);
try { fs.mkdirSync(${JSON.stringify(outputDir)}, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
const dir = fs.lstatSync(${JSON.stringify(outputDir)});
if (!dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o077)) process.exit(1);
const out = fs.openSync(${JSON.stringify(`${outputDir}/${kind}.json`)}, 'wx', 0o600);
const err = fs.openSync(${JSON.stringify(`${outputDir}/${kind}.stderr`)}, 'wx', 0o600);
const child = spawn('/bin/sh', ['-c', ${JSON.stringify(shell)}], { detached: true, stdio: ['ignore', out, err], env: { ...process.env, NODE_OPTIONS: '' } });
child.on('error', () => process.exit(1)); child.unref(); fs.closeSync(out); fs.closeSync(err);
`]
}

export function pollCommand(kind) {
	return ['node', '--input-type=module', '-e', `
import fs from 'node:fs';
const done = ${JSON.stringify(`${outputDir}/${kind}.done`)};
if (!fs.existsSync(done)) console.log(JSON.stringify({ done: false }));
else {
	const file = ${JSON.stringify(`${outputDir}/${kind}.json`)};
	if (fs.statSync(file).size > 32768) process.exit(1);
	console.log(JSON.stringify({ done: true, exitCode: Number(fs.readFileSync(done, 'utf8')), report: JSON.parse(fs.readFileSync(file, 'utf8')) }));
}
`]
}

// Never read process environments, whole kernel command lines, or workspace files.
export const inspectCommand = ['node', '--input-type=module', '-e', `
import fs from 'node:fs'; import os from 'node:os'; import { execFileSync } from 'node:child_process';
const read = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return 'unavailable'; } };
const report = { architecture: os.arch(), kernelRelease: os.release(), lsm: read('/sys/kernel/security/lsm'), bootPolicy: read('/proc/cmdline').split(' ').filter(v => /^(lsm|security|apparmor|selinux)=/.test(v)), kernelConfig: 'unavailable' };
try {
	const config = fs.existsSync('/proc/config.gz') ? execFileSync('zcat', ['/proc/config.gz'], { maxBuffer: 4 * 1024 * 1024 }).toString() : read('/boot/config-' + os.release());
	report.kernelConfig = config === 'unavailable' ? 'unavailable' : config.split('\\n').filter(v => v === '# CONFIG_SECURITY_LANDLOCK is not set' || /^(CONFIG_SECURITY_LANDLOCK|CONFIG_LSM|CONFIG_SECCOMP|CONFIG_SECCOMP_FILTER)=/.test(v));
} catch {}
report.launchers = {};
for (const name of ['gis', 'workbook']) { try { const s = fs.statSync('/opt/geocluster-runtime/' + name + '-launcher'); report.launchers[name] = { uid: s.uid, gid: s.gid, mode: (s.mode & 0o7777).toString(8) }; } catch { report.launchers[name] = { state: 'unavailable', reason: 'not-installed' }; } }
report.daemon = null;
for (const pid of fs.readdirSync('/proc').filter(v => /^\\d+$/.test(v))) {
	if (!read('/proc/' + pid + '/cmdline').split('\\0').includes('/opt/geocluster-runtime/files-server.js')) continue;
	const status = read('/proc/' + pid + '/status'); const fields = {};
	for (const key of ['Uid', 'Gid', 'NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) { const match = status.match(new RegExp('^' + key + ':\\\\s*(.*)$', 'm')); if (match) fields[key] = match[1].trim(); }
	report.daemon = { pid: Number(pid), uid: Number(fields.Uid?.split(/\\s+/)[0]), ...fields }; break;
}
report.mountPolicy = read('/proc/mounts').split('\\n').filter(v => ['/', '/opt', '/workspace'].includes(v.split(' ')[1])).map(v => ({ path: v.split(' ')[1], options: v.split(' ')[3].split(',').filter(option => ['rw', 'ro', 'nosuid', 'nodev', 'noexec', 'suid', 'exec'].includes(option)) }));
console.log(JSON.stringify(report));
`]
