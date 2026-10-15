/** Offline machine renewal, schema-2 discovery and scripted inference for image qualification. */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { startFakeLlm } from "../engine/fake-llm.mjs"

export async function startImageBackend({ port = 7799, directory = "/tmp" } = {}) {
	const projection = JSON.parse(fs.readFileSync(new URL("./processor-discovery-fixture.json", import.meta.url), "utf8")).projection
	const llmToken = "local-qualification-only"
	const llm = await startFakeLlm({ log: path.join(directory, "fake-llm.ndjson"), requiredBearer: llmToken })
	const observation = { renewals: 0, discoveries: 0, inferenceRequests: 0 }
	const record = () => fs.writeFileSync(path.join(directory, "image-backend-observation.json"), JSON.stringify(observation), { mode: 0o600 })
	const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
	const server = http.createServer((req, res) => {
		if (req.method === "POST" && req.url === "/renew") {
			if (req.headers.authorization !== "Bearer local-machine-only") return json(res, 401, {})
			observation.renewals++; record()
			return json(res, 200, { llmToken, activityToken: "local-activity-only", datasetToken: "local-dataset-only", expiresAt: new Date(Date.now() + 3600000).toISOString() })
		}
		if (req.headers.authorization !== `Bearer ${llmToken}`) return json(res, 401, {})
		if (req.method === "GET" && ["/v1/account", "/v1/models"].includes(req.url)) {
			observation.discoveries++; record()
			return json(res, 200, { ...projection, as_of: new Date().toISOString() })
		}
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(res, 404, {})
		observation.inferenceRequests++; record()
		const upstream = http.request(new URL(req.url, llm.url), { method: req.method, headers: req.headers }, response => {
			res.writeHead(response.statusCode, response.headers)
			response.on("error", () => res.destroy())
			response.pipe(res)
		})
		upstream.on("error", () => { if (!res.headersSent) json(res, 502, {}); else res.destroy() })
		req.on("aborted", () => upstream.destroy())
		res.on("close", () => { if (!res.writableFinished) upstream.destroy() })
		req.pipe(upstream)
	})
	server.requestTimeout = 0 // HANG exercises gateway cancellation, not fixture timeouts.
	try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) }) }
	catch (error) { await llm.close(); throw error }
	record()
	// The PID-1 wrapper must not start the real entrypoint until both listeners are ready.
	fs.writeFileSync(path.join(directory, "image-backend-ready"), "", { mode: 0o600 })
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await llm.close() },
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await startImageBackend({ port: Number(process.env.IMAGE_BACKEND_PORT || 7799) })
	console.log("FIXTURE_READY")
}
