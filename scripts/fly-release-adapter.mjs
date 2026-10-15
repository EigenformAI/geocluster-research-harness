import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

export function createFlyAdapter(token) {
	if (!token) throw new Error('missing-fly-token')
	async function run(binary, args) {
		try {
			const { stdout } = await exec(binary, args, { timeout: 600000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { ...process.env, FLY_API_TOKEN: token, NO_COLOR: '1' } })
			return stdout
		} catch { throw new Error('external-command-failed') }
	}
	return {
		async api(method, path, body, { timeoutMs = 30000 } = {}) {
			let response
			try {
				response = await fetch(`https://api.machines.dev/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(30000, Math.max(1, Math.floor(timeoutMs)))) })
				if (response.status === 404 && (method === 'DELETE' || method === 'GET' && /\/(machines|volumes)\/[^/]+$|^\/apps\/[^/]+$/.test(path))) return null
				if (!response.ok) throw new Error('api-status')
				// Error bodies and raw Machine configurations never reach logs/artifacts.
				const text = await response.text()
				if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('api-output-limit')
				return text ? JSON.parse(text) : null
			} catch { throw new Error(`machines-api-${method.toLowerCase()}-failed`) }
		},
		async cli(args) {
			const output = await run('flyctl', args)
			if (args[0] === 'releases') {
				try { const value = JSON.parse(output); if (!Array.isArray(value)) throw new Error(); return value } catch { throw new Error('invalid-release-output') }
			}
			return ''
		},
		async resolveImage(ref) {
			if (!/^registry\.fly\.io\/geocluster-ai-ide(?:@sha256:[a-f0-9]{64}|:[a-zA-Z0-9_.-]+)$/.test(ref)) throw new Error('invalid-release-image')
			const output = await run('docker', ['buildx', 'imagetools', 'inspect', ref])
			const match = output.match(/^Digest:\s+(sha256:[a-f0-9]{64})\s*$/m)
			if (!match) throw new Error('unresolved-release-image')
			return `registry.fly.io/geocluster-ai-ide@${match[1]}`
		},
	}
}
