import assert from "node:assert/strict"
import { test } from "node:test"
import { VoxelService } from "../lib/voxels.js"
const workspace = (shared, voxelLimits = {}) => ({ identity: {}, config: { voxelLimits }, captures: { limits: { retainedBytes: shared }, availability: { state: "available" } }, state: {}, workbooks: { availability: { state: "unavailable" } } })
test("schema category ceiling and shared-store ceiling are enforced", () => {
	assert.throws(() => new VoxelService(workspace(1024 ** 3, { categories: 65537 })), { error: "invalid_budget" })
	assert.equal(new VoxelService(workspace(1024 ** 3, { categories: 65536 })).limits.categories, 65536)
	assert.throws(() => new VoxelService(workspace(1024 ** 3, { artifactRetainedBytes: 1024 ** 3 + 1 })), { error: "invalid_budget" })
})
test("artifact budget defaults to half the shared store but permits an explicit override", () => {
	assert.equal(new VoxelService(workspace(1024 ** 3)).limits.artifactRetainedBytes, 512 * 1024 ** 2)
	assert.equal(new VoxelService(workspace(1024 ** 3, { artifactRetainedBytes: 1024 ** 3 })).limits.artifactRetainedBytes, 1024 ** 3)
})
