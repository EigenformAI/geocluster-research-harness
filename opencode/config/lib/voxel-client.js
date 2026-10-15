import http from "node:http"
import { VOXEL_ENDPOINT, VOXEL_SOCKET } from "./voxel-contract.js"

/** Fixed Unix HTTP address, no credential, URL or private-store path supplied by the model. Never retries mutations. */
export function request(body, { signal } = {}) {
	const bytes = Buffer.from(JSON.stringify(body))
	if (bytes.length > 1024 * 1024) return Promise.reject(new Error("Voxel request exceeds 1 MiB; use a smaller recipe or supported source."))
	return new Promise((resolve, reject) => {
		const req = http.request({ socketPath: VOXEL_SOCKET, path: VOXEL_ENDPOINT, method: "POST", signal, headers: { "content-type": "application/json", "content-length": bytes.length } }, (res) => {
			const chunks = []; let size = 0
			res.on("data", (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error("Voxel response exceeds 2 MiB; request bounded inspection.")); else chunks.push(chunk) })
			res.on("error", reject)
			res.on("end", () => {
				try {
					const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
					if (res.statusCode < 200 || res.statusCode >= 300) {
						const error = new Error(value.reason || value.message || "Voxel runtime request failed.")
						error.status = res.statusCode; error.code = value.error; error.retryAfter = res.headers["retry-after"]
						reject(error)
					} else resolve(value)
				} catch (error) { reject(error) }
			})
		})
		req.on("error", reject)
		req.end(bytes)
	})
}
