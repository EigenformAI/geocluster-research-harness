import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { downloadVerifiedGrid } from './build.mjs'

const bytes = Buffer.from('trusted grid fixture\n')
const pin = {
	name: 'au_icsm_fixture.tif',
	url: `https://raw.githubusercontent.com/OSGeo/PROJ-data/${'1'.repeat(40)}/au_icsm/au_icsm_fixture.tif`,
	size: bytes.length,
	sha256: createHash('sha256').update(bytes).digest('hex'),
}
async function output(t) {
	const directory = await mkdtemp(path.join(tmpdir(), 'gis-grid-checksum-'))
	t.after(() => rm(directory, { recursive: true, force: true }))
	return path.join(directory, pin.name)
}

test('a fetched fixture matching its pin is staged byte-for-byte', async t => {
	const destination = await output(t)
	await downloadVerifiedGrid(pin, destination, async (url, options) => {
		assert.equal(url, pin.url)
		assert.equal(options.redirect, 'error')
		return new Response(bytes)
	})
	assert.deepEqual(await readFile(destination), bytes)
})

test('same-length changed bytes fail their checksum without publishing a file', async t => {
	const destination = await output(t), changed = Buffer.from(bytes)
	changed[0] ^= 1
	await assert.rejects(downloadVerifiedGrid(pin, destination, async () => new Response(changed)), /SHA-256 mismatch/)
	await assert.rejects(lstat(destination), { code: 'ENOENT' })
})

test('a checksum failure leaves an existing output untouched', async t => {
	const destination = await output(t), previous = Buffer.from('previous verified fixture')
	await writeFile(destination, previous)
	const changed = Buffer.from(bytes); changed[0] ^= 1
	await assert.rejects(downloadVerifiedGrid(pin, destination, async () => new Response(changed)), /SHA-256 mismatch/)
	assert.deepEqual(await readFile(destination), previous)
})

for (const [name, body, failure] of [
	['truncated', bytes.subarray(0, -1), /byte size mismatch/],
	['empty', Buffer.alloc(0), /byte size mismatch/],
	['oversized', Buffer.concat([bytes, bytes]), /exceeds pinned size/],
]) {
	test(`${name} fetched bytes fail without publishing a file`, async t => {
		const destination = await output(t)
		await assert.rejects(downloadVerifiedGrid(pin, destination, async () => new Response(body)), failure)
		await assert.rejects(lstat(destination), { code: 'ENOENT' })
	})
}

test('HTTP failure and unavailable network fail without publishing a file', async t => {
	const destination = await output(t)
	await assert.rejects(downloadVerifiedGrid(pin, destination, async () => new Response('Not found', { status: 404 })), /HTTP 404/)
	await assert.rejects(downloadVerifiedGrid(pin, destination, async () => { throw new Error('network unavailable') }), /network unavailable/)
	await assert.rejects(lstat(destination), { code: 'ENOENT' })
})

test('an interrupted response body fails without publishing a file', async t => {
	const destination = await output(t)
	const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 2)); controller.error(new Error('connection lost')) } })
	await assert.rejects(downloadVerifiedGrid(pin, destination, async () => new Response(stream)), /connection lost/)
	await assert.rejects(lstat(destination), { code: 'ENOENT' })
})

test('missing SHA-256 and a mutable URL are rejected before any fetch', async t => {
	const destination = await output(t)
	const unexpectedFetch = async () => { assert.fail('invalid pins must not be fetched') }
	await assert.rejects(downloadVerifiedGrid({ ...pin, sha256: undefined }, destination, unexpectedFetch), /grid pin requires/)
	await assert.rejects(downloadVerifiedGrid({ ...pin, url: pin.url.replace('1'.repeat(40), 'master') }, destination, unexpectedFetch), /grid pin requires/)
	await assert.rejects(lstat(destination), { code: 'ENOENT' })
})
