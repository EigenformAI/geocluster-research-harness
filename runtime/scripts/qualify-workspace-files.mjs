import { qualifyWorkspaceFiles } from './lib/workspace-qualification.mjs'

// The deployment controller invokes this privately as root. Never emit signing
// material, cookies, full source manifests, or arbitrary exception messages.
try {
	const args = process.argv.slice(2)
	if (process.getuid?.() !== 0 || args.length) throw new Error('Invalid invocation')
	const report = await qualifyWorkspaceFiles({ projectId: process.env.PROJECT_ID, gateKey: process.env.IDE_PROXY_KEY })
	const json = JSON.stringify(report)
	if (Buffer.byteLength(json) > 32768) throw new Error('Report limit')
	console.log(json)
} catch {
	console.log(JSON.stringify({ ok: false, error: 'authenticated-workspace-qualification-failed' }))
	process.exitCode = 1
}
