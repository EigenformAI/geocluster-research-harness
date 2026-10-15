import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { FileEvents } from "../lib/file-events.js"

const identity = { workspaceId: "workspace", workspaceEpoch: "epoch" }

class Response extends EventEmitter {
	constructor() { super(); this.blocks = []; this.writableLength = 0; this.blocked = false; this.destroyed = false }
	writeHead(status, headers) { this.status = status; this.headers = headers; this.onHeaders?.() }
	write(block) {
		this.blocks.push(block)
		this.onWrite?.(block)
		if (this.blocked) this.writableLength += Buffer.byteLength(block)
		return !this.blocked
	}
	end() { this.ended = true; this.emit("close") }
	destroy() { this.destroyed = true; this.emit("close") }
	drain() { this.blocked = false; this.writableLength = 0; this.emit("drain") }
	events() {
		return this.blocks.filter((block) => block.startsWith("id:")).map((block) => ({
			id: /^id: (.*)$/m.exec(block)[1], type: /^event: (.*)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]),
		}))
	}
}

function connect(t, events, path = "", cursor, queryCursor) {
	const req = new EventEmitter()
	req.headers = cursor === undefined ? {} : { "last-event-id": cursor }
	const res = new Response()
	const url = new URL("http://files/files/watch")
	url.searchParams.set("path", path)
	if (queryCursor !== undefined) url.searchParams.set("lastEventId", queryCursor)
	t.after(() => res.destroy())
	return { req, res, url, attach: () => events.attach(req, res, url) }
}

test("events: artifact-only deletion invalidates scoped subscribers and replays without a path change", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot" }); t.after(() => events.close())
	const client = connect(t, events, "ordinary/folder"); await client.attach(); const cursor = client.res.events().at(-1).id
	const hint = { changes: [], artifactId: "vox-exact", namedIds: ["voxel-current"], reason: "artifact-deleted" }
	events.publish("invalidation", hint)
	assert.deepEqual(client.res.events().filter((e) => e.type === "invalidation").map((e) => e.data.payload), [hint])
	client.res.destroy(); const next = connect(t, events, "ordinary/folder", cursor); await next.attach()
	assert.deepEqual(next.res.events().filter((e) => e.type === "invalidation").map((e) => e.data.payload), [hint])
})

test("events: scoped replay precedes racing live events and header cursor wins", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot" })
	t.after(() => events.close())
	const first = connect(t, events, "a")
	await first.attach()
	const cursor = first.res.events().at(-1).id
	first.res.destroy()
	events.publish("invalidation", { changes: [{ type: "add", path: "a/old.txt" }, { type: "add", path: "ab/hidden.txt" }], indexGeneration: "1" })
	const next = connect(t, events, "a", cursor, "other.other.900")
	let raced = false
	next.res.onWrite = () => {
		if (raced) return
		raced = true
		events.publish("invalidation", { changes: [{ type: "change", path: "a/new.txt" }], indexGeneration: "2" })
	}
	await next.attach()
	const seen = next.res.events()
	assert.equal(seen.find((event) => event.type === "ready").data.payload.resumed, true)
	const invalidations = seen.filter((event) => event.type === "invalidation")
	assert.deepEqual(invalidations.flatMap((event) => event.data.payload.changes.map((change) => change.path)), ["a/old.txt", "a/new.txt"])
	assert.ok(invalidations[0].data.seq < invalidations[1].data.seq)
	for (const event of seen) {
		assert.equal(event.id, `epoch.boot.${event.data.seq}`)
		assert.equal(event.data.filesContractVersion, 1)
		assert.equal(event.data.workspaceId, "workspace")
		assert.equal(event.data.workspaceEpoch, "epoch")
		assert.equal(event.data.bootId, "boot")
		assert.ok(Number.isFinite(Date.parse(event.data.observedAt)))
	}
})

test("events: restart, epoch, malformed, future, evicted, and scan-error cursors reset", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot", limits: { eventCount: 2, eventBytes: 4096 } })
	t.after(() => events.close())
	for (let n = 0; n < 4; n++) events.publish("index", { generation: String(n), state: "ready" })
	for (const [cursor, reason] of [["epoch.previous.4", "restart"], ["previous.boot.4", "epoch"], ["broken", "bad-cursor"], ["epoch.boot.90", "gap"], ["epoch.boot.0", "gap"]]) {
		const client = connect(t, events, "", cursor)
		await client.attach()
		assert.equal(client.res.events().find((event) => event.type === "ready").data.payload.reason, reason)
		assert.ok(client.res.events().some((event) => event.type === "reset"))
	}
	events.publish("reset", { path: "", reason: "scan-error" })
	const uncertain = connect(t, events, "", "epoch.boot.4")
	await uncertain.attach()
	assert.equal(uncertain.res.events().find((event) => event.type === "ready").data.payload.resumed, false)
	assert.equal(uncertain.res.events().find((event) => event.type === "reset").data.payload.reason, "scan-error")
})

test("events: subscribe before headers, trim move changes by component scope, and freeze publication", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot" })
	t.after(() => events.close())
	const client = connect(t, events, "a/b")
	client.res.onHeaders = () => events.publish("invalidation", { changes: [{ type: "unlink", path: "a" }] })
	await client.attach()
	assert.ok(client.res.events().some((event) => event.data.payload.changes?.[0].path === "a"))
	const payload = { changes: [{ type: "move", from: "a/b/file", path: "elsewhere/file" }, { type: "change", path: "a/bb/file" }] }
	events.publish("invalidation", payload)
	payload.changes[0].path = "mutated"
	assert.deepEqual(client.res.events().at(-1).data.payload.changes, [{ type: "move", from: "a/b/file", path: "elsewhere/file" }])
	assert.throws(() => events.publish("invalidation\nmalicious", {}), { error: "invalid_event" })
})

test("events: bound replay bytes and slow subscriber buffers; draining preserves order", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot", limits: { eventCount: 100, eventBytes: 1100, subscriberBytes: 900 } })
	t.after(() => events.close())
	const slow = connect(t, events)
	await slow.attach()
	slow.res.blocked = true
	for (let n = 0; n < 10; n++) events.publish("index", { generation: String(n), padding: "x".repeat(100) })
	await wait(0)
	assert.ok(slow.res.destroyed || slow.res.ended, "slow clients cannot retain an unbounded live queue")
	assert.ok(slow.res.writableLength <= 900)
	const gap = connect(t, events, "", "epoch.boot.0")
	await gap.attach()
	assert.equal(gap.res.events().find((event) => event.type === "ready").data.payload.resumed, false)

	const draining = new FileEvents({ identity, bootId: "draining" })
	t.after(() => draining.close())
	const client = connect(t, draining)
	await client.attach()
	client.res.blocked = true
	draining.publish("index", { generation: "1" })
	draining.publish("index", { generation: "2" })
	draining.publish("index", { generation: "3" })
	client.res.drain()
	assert.deepEqual(client.res.events().filter((event) => event.type === "index").map((event) => event.data.payload.generation), ["1", "2", "3"])
})

test("events: heartbeat is a comment without an ID and closing releases subscriptions", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot", limits: { heartbeatMs: 10 } })
	const client = connect(t, events)
	await client.attach()
	await wait(25)
	assert.ok(client.res.blocks.some((block) => block === ": keepalive\n\n"))
	await events.close()
	const count = client.res.blocks.length
	await wait(25)
	assert.equal(client.res.blocks.length, count)
	assert.ok(client.res.ended || client.res.destroyed)
})

test("events: changed or ambiguous cursor scope forces re-list instead of a false resume", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot" })
	t.after(() => events.close())
	const a = connect(t, events, "a")
	await a.attach()
	const cursor = a.res.events()[0].id
	const b = connect(t, events, "b", cursor)
	await b.attach()
	assert.equal(b.res.events().find((event) => event.type === "ready").data.payload.resumed, false)
	const ambiguous = connect(t, events, "a", cursor)
	await ambiguous.attach()
	assert.equal(ambiguous.res.events().find((event) => event.type === "ready").data.payload.resumed, false)
	assert.ok(ambiguous.res.events().some((event) => event.type === "reset"))
})

test("events: replay streams incrementally to fast clients within the subscriber byte cap", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot", limits: { subscriberBytes: 900 } })
	t.after(() => events.close())
	const first = connect(t, events)
	await first.attach()
	const cursor = first.res.events()[0].id
	first.res.destroy()
	for (let n = 0; n < 20; n++) events.publish("index", { generation: String(n), state: "ready" })
	const replay = connect(t, events, "", cursor)
	await replay.attach()
	assert.deepEqual(replay.res.events().filter((event) => event.type === "index").map((event) => event.data.payload.generation), Array.from({ length: 20 }, (_, n) => String(n)))
	assert.equal(replay.res.destroyed, false)
	assert.ok(!replay.res.events().some((event) => event.type === "reset"))
})

test("events: a fresh nonempty-ring boundary requires re-list and preserves subsequent replay", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot" })
	t.after(() => events.close())
	events.publish("index", { generation: "before-boundary" })
	const baseline = connect(t, events)
	await baseline.attach()
	assert.equal(baseline.res.events()[0].data.payload.resumed, false)
	assert.ok(!baseline.res.events().some((event) => event.data.payload.generation === "before-boundary"), "fresh streams must not replay pre-baseline history")
	const fresh = connect(t, events)
	fresh.res.onWrite = (block) => {
		if (!block.includes("event: ready\n")) return
		events.publish("index", { generation: "after-boundary" })
		fresh.res.destroy()
	}
	await fresh.attach()
	const ready = fresh.res.events()[0]
	assert.equal(ready.data.payload.resumed, false, "fresh ready mandates an initial re-list, not historical replay")
	const reconnect = connect(t, events, "", ready.id)
	await reconnect.attach()
	assert.deepEqual(reconnect.res.events().filter((event) => event.type === "index").map((event) => event.data.payload.generation), ["after-boundary"])
})

test("events: subscriber overflow stays local while its reconnect receives reset", async (t) => {
	const events = new FileEvents({ identity, bootId: "boot", limits: { subscriberBytes: 900 } })
	t.after(() => events.close())
	const healthy = connect(t, events)
	await healthy.attach()
	const slow = connect(t, events)
	await slow.attach()
	const cursor = slow.res.events()[0].id
	slow.res.blocked = true
	for (let n = 0; n < 10; n++) events.publish("index", { generation: String(n), padding: "x".repeat(100) })
	await wait(0)
	assert.equal(healthy.res.events().filter((event) => event.type === "index").length, 10)
	assert.ok(!healthy.res.events().some((event) => event.type === "reset"), "one slow client must not reset healthy subscribers")
	const reconnect = connect(t, events, "", cursor)
	await reconnect.attach()
	assert.equal(reconnect.res.events()[0].data.payload.resumed, false)
	assert.ok(reconnect.res.events().some((event) => event.type === "reset"))
})
