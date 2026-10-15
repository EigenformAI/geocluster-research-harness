import assert from "node:assert/strict"
import { test } from "node:test"
import { startGateway } from "./gateway-harness.mjs"

test("the agent gateway does not serve a second workspace file service", async (t) => {
	const gateway = await startGateway(t, { start: false })
	const response = await gateway.get("/files/openapi.json")
	assert.equal(response.status, 404, "file routes belong to the separately owned file daemon")
	assert.equal((await response.json()).error, "not_found")
	assert.equal((await gateway.get("/session/info")).status, 200)
})
