// projection is supplied by the host from a backend-builder-derived test artifact.
import http from 'node:http'
import fs from 'node:fs'
let requests = 0, inferenceRequests = 0
const server = http.createServer((req, res) => {
	if (req.method === 'POST' && req.url === '/renew' && req.headers.authorization === 'Bearer local-machine-only') {
		res.writeHead(200, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ llmToken: 'local-qualification-only', activityToken: 'local-activity-only',
			datasetToken: 'local-dataset-only', expiresAt: new Date(Date.now() + 3600000).toISOString() }))
	} else if (req.method === 'GET' && req.url === '/v1/account' && req.headers.authorization === 'Bearer local-qualification-only') {
		requests++
		res.writeHead(200, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ ...projection, as_of: new Date().toISOString() }))
	} else {
		if (req.method === 'POST') inferenceRequests++
		res.writeHead(503); res.end('{}')
	}
	fs.writeFileSync('/tmp/processor-discovery-observation.json', JSON.stringify({ requests, inferenceRequests }), { mode: 0o600 })
})
server.requestTimeout = 3000
server.maxHeadersCount = 32
server.listen(18766, '127.0.0.1', () => {
	fs.writeFileSync('/tmp/qualification-ready', '', { mode: 0o600 })
	process.stdout.write('FIXTURE_READY\n')
})
