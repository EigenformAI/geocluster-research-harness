/**
 * Tests for gate.cjs (the machine's access gate). Run: `node --test runtime/test/`
 * Only Node built-ins; not copied into the image.
 * Contract: the token vector is shared with geocluster-ai-BE tests (test_runtime_gate_auth.py).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const GATE_PATH = path.join(__dirname, "..", "gate.cjs");
const gate = require(GATE_PATH);

// ---- Contract test vector (shared with geocluster-ai-BE tests) ----------------
const KEY = "6f96944431396a28c4a6911585debf8c7426330c5b838111d52a8c83c2def9f9";
const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const CONTRACT_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyX3Rlc3QiLCJwcm9qZWN0X2lkIjoiMTExMTExMTEtMjIyMi0zMzMzLTQ0NDQtNTU1NTU1NTU1NTU1IiwiYXVkIjoiaWRlLXByb3h5IiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjQxMDI0NDQ4MDAsImp0aSI6Imp0aS1maXhlZC0xIn0.yklrlDH5zSw9BpoQ79YE9sQoG9ajZfhZ9NivODf4YNY";
const ORIGIN = "https://geocluster.net";
const GATE_SECRET = "a".repeat(64);

const silent = { log() {}, warn() {}, error() {} };

test("lifecycle root route requires one server key, exact target, bounded JSON, and a verified private admission acknowledgement", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "root-lifecycle-gate-"));
  const keyFile = path.join(dir, "key"), filesControlFile = path.join(dir, "control");
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 }); fs.writeFileSync(filesControlFile, "c".repeat(64), { mode: 0o600 });
  const calls = []; let validReply = true;
  const files = http.createServer(async (req, res) => {
    const chunks = []; for await (const b of req) chunks.push(b);
    calls.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ admittingMutations: false, ...(validReply ? { publicationFenced: true } : {}), projectId: PROJECT_ID, machineId: "machine-1" }));
  });
  await new Promise((r) => files.listen(0, "127.0.0.1", r));
  const server = gate.createGateServer({ ...gate.loadConfig({ PROJECT_ID }), keyFile, filesControlFile, filesPort: files.address().port, machineId: "machine-1", authDisabled: true }, { logger: silent });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); files.closeAllConnections(); await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => files.close(r))]); fs.rmSync(dir, { recursive: true, force: true }); });
  const headers = { "x-ide-proxy-key": KEY, "x-gc-project-id": PROJECT_ID, "x-gc-machine-id": "machine-1", "content-type": "application/json", "x-gc-files-control": "caller-spoof" };
  const body = JSON.stringify({ admissionOnly: true, runtimeId: "owner-1", deadline: new Date(Date.now() + 5000).toISOString() });
  const request = (target, supplied = headers, payload = body, method = "POST") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: target, method, headers: { ...supplied, "content-length": Buffer.byteLength(payload) } }, (res) => { const chunks = []; res.on("data", (b) => chunks.push(b)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) })); });
    req.on("error", reject); req.end(payload);
  });
  for (const supplied of [{ ...headers, "x-ide-proxy-key": [KEY, KEY] }, { ...headers, cookie: cookieHeaderFor() }, { ...headers, origin: ORIGIN }, { ...headers, "x-ide-proxy-key": "bad" }, { "x-gc-gate": GATE_SECRET, "content-type": "application/json" }]) assert.equal((await request("/internal/files/drain", supplied)).status, 404);
  for (const target of ["/files/../internal/files/drain", "/files/%2e%2e/internal/files/drain", "/internal/files/drain?x=1", "/internal/files/storage"]) assert.equal((await request(target)).status, 404);
  assert.equal((await request("/internal/files/drain", { ...headers, "x-gc-project-id": "other-project" })).status, 409);
  assert.equal((await request("/internal/files/drain", headers, body, "GET")).status, 405);
  assert.equal((await request("/internal/files/drain", headers, " ".repeat(4097))).status, 413);
  assert.equal((await request("/internal/files/drain", headers, JSON.stringify({ admissionOnly: false, runtimeId: "owner-1", deadline: new Date(Date.now() + 5000).toISOString() }))).status, 400);
  assert.equal(calls.length, 0, "No rejected root request may reach the private file controller.");
  const accepted = await request("/internal/files/drain"); assert.equal(accepted.status, 200); assert.equal(accepted.body.publicationFenced, true);
  assert.equal(accepted.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(calls[0].body, JSON.parse(body)); assert.equal(calls[0].path, "/internal/files/drain");
  assert.equal(calls[0].headers["x-gc-files-control"], "c".repeat(64)); assert.equal(calls[0].headers["x-ide-proxy-key"], undefined); assert.equal(calls[0].headers.cookie, undefined);
  assert.equal(gate.forwardedHeaders({ "x-ide-proxy-key": KEY }, GATE_SECRET)["x-ide-proxy-key"], undefined);
  validReply = false; assert.equal((await request("/internal/files/drain")).status, 503, "A plain old 200 response is not publication fence evidence.");
});

// ---- helpers ------------------------------------------------------------------
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const nowS = () => Math.floor(Date.now() / 1000);

function signJwt(payload, { key = KEY, header = { alg: "HS256", typ: "JWT" } } = {}) {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", key).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

function claims(overrides = {}) {
  const t = nowS();
  return { sub: "user_test", project_id: PROJECT_ID, aud: "ide-proxy", iat: t, exp: t + 300, jti: crypto.randomUUID(), ...overrides };
}

function ctx(overrides = {}) {
  return {
    key: KEY,
    projectId: PROJECT_ID,
    authDisabled: false,
    usedJtis: new Map(),
    allowedOrigins: gate.parseAllowedOrigins(undefined),
    now: nowS(),
    ...overrides,
  };
}

function verify(token, overrides = {}) {
  return gate.verifyToken(token, { key: KEY, projectId: PROJECT_ID, usedJtis: new Map(), ...overrides });
}

function cookieHeaderFor(opts = {}) {
  const c = gate.issueCookie({ key: KEY, projectId: PROJECT_ID, ...opts });
  return `${gate.COOKIE_NAME}=${c.value}`;
}

function flipLastChar(s) {
  const last = s[s.length - 1];
  return s.slice(0, -1) + (last === "A" ? "B" : "A");
}

// =============================================================================
// Token + cookie contract (unchanged from the proxy era)
// =============================================================================

test("contract: the access gate accepts the shared token vector signed with the hex key string", () => {
  const r = verify(CONTRACT_TOKEN);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.claims.sub, "user_test");
});

test("verifyToken rejects other projects, expiry beyond 30 s skew, bad signatures, non-HS256, bad aud, jti reuse", () => {
  const t = nowS();
  assert.equal(verify(CONTRACT_TOKEN, { projectId: "99999999-2222-3333-4444-555555555555" }).reason, "project-mismatch");
  assert.equal(verify(signJwt(claims({ exp: t - 31 })), { now: t }).reason, "expired");
  assert.equal(verify(signJwt(claims({ exp: t - 10 })), { now: t }).ok, true);
  assert.equal(verify(signJwt(claims(), { key: "0".repeat(64) })).reason, "bad-signature");
  assert.equal(verify(flipLastChar(CONTRACT_TOKEN)).reason, "bad-signature");
  assert.equal(verify(signJwt(claims(), { key: Buffer.from(KEY, "hex") })).reason, "bad-signature");
  for (const alg of ["none", "hs256", "HS512", "RS256", undefined]) {
    assert.equal(verify(signJwt(claims(), { header: { alg, typ: "JWT" } })).ok, false, String(alg));
  }
  assert.equal(verify(signJwt(claims({ aud: "llm-proxy" }))).reason, "bad-aud");
  assert.equal(verify(signJwt(claims({ aud: ["x", "ide-proxy"] }))).ok, true);
  const c = claims();
  assert.equal(verify(signJwt(c), { usedJtis: new Map([[c.jti, c.exp]]) }).reason, "jti-reused");
  assert.equal(verify(signJwt(claims({ jti: undefined }))).reason, "no-jti");
  assert.equal(verify(signJwt(claims({ iat: t + 3600 }))).reason, "iat-in-future");
  for (const bad of ["", "a.b", "a.b.c.d", "x".repeat(5000), null, 42]) assert.equal(verify(bad).ok, false, String(bad));
  assert.equal(verify(CONTRACT_TOKEN, { key: "" }).reason, "no-key");
});

test("issueCookie sets every attribute and a 12 h exp; verifyCookie round-trips and rejects tampering", () => {
  const t = 1_800_000_000.7;
  const c = gate.issueCookie({ key: KEY, projectId: PROJECT_ID, now: t });
  assert.equal(c.exp, 1_800_000_000 + 43200);
  assert.equal(c.header, `__Host-gc_ide=${c.value}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=43200`);
  assert.deepEqual(gate.verifyCookie(c.value, { key: KEY, projectId: PROJECT_ID, now: t + 60 }), { ok: true, exp: c.exp });
  assert.equal(gate.verifyCookie(flipLastChar(c.value), { key: KEY, projectId: PROJECT_ID, now: t }).reason, "bad-signature");
  assert.equal(gate.verifyCookie(c.value, { key: KEY, projectId: "other", now: t }).reason, "bad-signature");
  assert.equal(gate.verifyCookie(c.value, { key: KEY, projectId: PROJECT_ID, now: c.exp + 1 }).reason, "expired");
  assert.equal(gate.clearCookieHeader(), "__Host-gc_ide=; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0");
  assert.equal(gate.stripCookie(`a=1; ${gate.COOKIE_NAME}=v1.x.y; b=2`, gate.COOKIE_NAME), "a=1; b=2");
});

// =============================================================================
// exchangeToken / authorize / authorizeUpgrade
// =============================================================================

test("exchangeToken: valid token → cookie + jti recorded; replay, bad token and missing key fail", () => {
  const c = ctx();
  const tok = claims();
  const first = gate.exchangeToken(signJwt(tok), c);
  assert.equal(first.ok, true);
  assert.match(first.setCookie, /^__Host-gc_ide=v1\.\d+\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=43200$/);
  assert.equal(first.sub, "user_test");
  assert.ok(c.usedJtis.has(tok.jti));
  assert.deepEqual(gate.exchangeToken(signJwt(tok), c), { ok: false, reason: "jti-reused" });
  assert.equal(gate.exchangeToken(signJwt(claims({ project_id: "other" })), c).reason, "project-mismatch");
  assert.equal(gate.exchangeToken(signJwt(claims()), ctx({ key: "" })).reason, "no-key");
  assert.equal(gate.exchangeToken(signJwt(claims()), ctx({ usedJtis: undefined })).reason, "no-replay-store");
  assert.equal(gate.exchangeToken("junk", ctx({ authDisabled: true })).ok, true, "local dev: nothing to exchange");
});

test("authorize: health and CORS preflight are public; exchange/logout route; ?token= no longer grants access", () => {
  for (const c of [ctx(), ctx({ key: "" }), ctx({ projectId: "" })]) {
    assert.equal(gate.authorize({ method: "GET", url: "/livez", headers: {} }, c).action, "health");
    assert.equal(gate.authorize({ method: "GET", url: "/readyz?x=1", headers: {} }, c).action, "health");
    assert.deepEqual(gate.authorize({ method: "OPTIONS", url: "/readyz", headers: {} }, c), { action: "preflight", status: 204, health: true });
    assert.deepEqual(
      gate.authorize({ method: "OPTIONS", url: "/files/list", headers: { "access-control-request-method": "GET", origin: ORIGIN } }, c),
      { action: "preflight", status: 204 }
    );
  }
  assert.equal(gate.authorize({ method: "GET", url: "/healthz", headers: {} }, ctx()).action, "deny", "old health path is gone");
  assert.equal(gate.authorize({ method: "POST", url: "/auth/exchange", headers: {} }, ctx()).action, "exchange");
  assert.equal(gate.authorize({ method: "GET", url: "/auth/exchange?token=x", headers: {} }, ctx()).status, 405);
  assert.deepEqual(gate.authorize({ method: "POST", url: "/auth/logout", headers: {} }, ctx()), { action: "logout", status: 204 });
  // a token in the query is not an exchange any more: no redirect, no cookie
  const d = gate.authorize({ method: "GET", url: `/files/list?token=${signJwt(claims())}`, headers: {} }, ctx());
  assert.deepEqual(d, { action: "deny", status: 401, reason: "no-cookie" });
});

test("authorize: cookie → proxy; missing/expired/tampered cookie → 401; missing key fails closed", () => {
  const c = ctx();
  assert.deepEqual(gate.authorize({ method: "GET", url: "/files/list", headers: { cookie: cookieHeaderFor() } }, c), { action: "proxy", via: "cookie" });
  assert.deepEqual(gate.authorize({ method: "GET", url: "/", headers: {} }, c), { action: "deny", status: 401, reason: "no-cookie" });
  assert.equal(gate.authorize({ method: "GET", url: "/", headers: { cookie: cookieHeaderFor({ now: nowS() - 50000 }) } }, c).reason, "cookie-expired");
  assert.equal(gate.authorize({ method: "GET", url: "/", headers: { cookie: flipLastChar(cookieHeaderFor()) } }, c).reason, "cookie-bad-signature");
  assert.equal(gate.authorize({ method: "GET", url: "/", headers: { cookie: cookieHeaderFor() } }, ctx({ key: "" })).reason, "no-key");
  assert.equal(gate.authorize({ method: "GET", url: "*", headers: {} }, c).action, "bad-request");
  assert.equal(gate.authorize({ method: "GET", url: "/", headers: {} }, ctx({ key: "", authDisabled: true })).action, "proxy");
});

test("authorizeUpgrade: cookie required; Origin must be allow-listed when present", () => {
  const c = ctx();
  assert.equal(gate.authorizeUpgrade({ url: "/agent", headers: {} }, c).reason, "no-cookie");
  assert.deepEqual(gate.authorizeUpgrade({ url: "/agent", headers: { cookie: cookieHeaderFor(), origin: ORIGIN } }, c), { action: "proxy", via: "cookie" });
  assert.equal(gate.authorizeUpgrade({ url: "/agent", headers: { cookie: cookieHeaderFor() } }, c).action, "proxy", "non-browser clients send no Origin");
  assert.deepEqual(gate.authorizeUpgrade({ url: "/agent", headers: { cookie: cookieHeaderFor(), origin: "https://evil.example" } }, c), {
    action: "deny",
    status: 403,
    reason: "bad-origin",
  });
  assert.equal(gate.authorizeUpgrade({ url: "/agent", headers: { origin: "https://evil.example" } }, ctx({ authDisabled: true })).action, "proxy");
});

test("processing mutations reject an untrusted Origin before cookie-authenticated forwarding", () => {
  for (const [method, url] of [["PUT", "/files/upload?path=a.csv&operationId=one"], ["POST", "/files/processing/jobs"], ["POST", "/files/processing/jobs/processing_one/cancel"], ["POST", "/files/other/../processing/jobs"]]) {
    const request = { method, url, headers: { cookie: cookieHeaderFor(), origin: "https://evil.example" } };
    assert.deepEqual(gate.authorize(request, ctx()), { action: "deny", status: 403, reason: "bad-origin" });
    assert.equal(gate.authorize({ ...request, headers: { cookie: cookieHeaderFor(), origin: ORIGIN } }, ctx()).action, "proxy");
    assert.equal(gate.authorize({ ...request, headers: { cookie: cookieHeaderFor() } }, ctx()).action, "proxy");
  }
  assert.equal(gate.authorize({ method: "GET", url: "/files/processing/jobs", headers: { cookie: cookieHeaderFor(), origin: "https://evil.example" } }, ctx()).action, "proxy");
  const preflight = gate.preflightHeaders(ORIGIN, ctx().allowedOrigins);
  assert.match(preflight["Access-Control-Allow-Headers"], /X-GC-Process-Document/i);
  assert.match(gate.corsHeaders(ORIGIN, ctx().allowedOrigins)["Access-Control-Expose-Headers"], /Location/);
  const forwarded = gate.forwardedHeaders({ "x-gc-files-control": "spoof", "x-gc-runtime-control": "spoof", "x-gc-gate": "spoof" }, GATE_SECRET);
  assert.deepEqual(forwarded, { "x-gc-gate": GATE_SECRET });
});

test("CORS: allow-list parsing, wildcard subdomains, credentialed headers only for allowed origins", () => {
  const allowed = gate.parseAllowedOrigins("https://geocluster.net, https://*.vercel.app,junk, http://localhost:3000");
  assert.deepEqual(allowed, ["https://geocluster.net", "https://*.vercel.app", "http://localhost:3000"]);
  assert.equal(gate.originAllowed("https://geocluster.net", allowed), true);
  assert.equal(gate.originAllowed("https://GeoCluster.net", allowed), true);
  assert.equal(gate.originAllowed("https://preview-abc.vercel.app", allowed), true);
  assert.equal(gate.originAllowed("https://vercel.app", allowed), false);
  assert.equal(gate.originAllowed("https://geocluster.net.evil.example", allowed), false);
  assert.equal(gate.originAllowed(undefined, allowed), false);
  const h = gate.corsHeaders("https://geocluster.net", allowed);
  assert.equal(h["Access-Control-Allow-Origin"], "https://geocluster.net");
  assert.equal(h["Access-Control-Allow-Credentials"], "true");
  assert.match(h["Access-Control-Expose-Headers"], /ETag/);
  assert.deepEqual(gate.corsHeaders("https://evil.example", allowed), { Vary: "Origin" });
  assert.match(gate.preflightHeaders("https://geocluster.net", allowed)["Access-Control-Allow-Methods"], /PUT/);
  assert.equal(gate.parseAllowedOrigins(undefined).join(","), gate.DEFAULT_ALLOWED_ORIGINS);
});

test("CORS: file saves and streamed uploads allow observation, digest and persistence preconditions", () => {
  const headers = gate.preflightHeaders(ORIGIN, gate.parseAllowedOrigins(undefined));
  const allowed = headers["Access-Control-Allow-Headers"].split(",").map((value) => value.trim().toLowerCase());
  for (const name of ["x-gc-base-observation", "x-content-sha256", "x-gc-require-remote-persistable"]) {
    assert.ok(allowed.includes(name), `${name} missing from CORS preflight`);
  }
});

test("forwardedHeaders: session cookie stripped, client X-GC-Gate dropped, our secret injected", () => {
  const out = gate.forwardedHeaders({ cookie: `a=1; ${gate.COOKIE_NAME}=v1.x.y`, "x-gc-gate": "spoof", host: "h" }, GATE_SECRET);
  assert.deepEqual(out, { cookie: "a=1", host: "h", "x-gc-gate": GATE_SECRET });
  const none = gate.forwardedHeaders({ "x-gc-gate": "spoof" }, "");
  assert.equal(none["x-gc-gate"], undefined, "no secret loaded → header absent, never the client's value");
});

test("loadConfig: RUNTIME_* names, defaults, auth escape hatch only off Fly", () => {
  const d = gate.loadConfig({});
  assert.equal(d.listenPort, 3000);
  assert.equal(d.upstreamPort, 3001);
  assert.equal(d.keyFile, "/run/runtime/key");
  assert.equal(d.gateFile, "/run/runtime/gate");
  assert.equal(d.frameAncestors, gate.DEFAULT_FRAME_ANCESTORS);
  assert.deepEqual(d.allowedOrigins, gate.parseAllowedOrigins(undefined));
  const o = gate.loadConfig({
    RUNTIME_GATE_PORT: "0",
    RUNTIME_GATEWAY_PORT: "4001",
    RUNTIME_GATE_KEY_FILE: "/tmp/k",
    RUNTIME_GATE_SECRET_FILE: "/tmp/g",
    RUNTIME_ALLOWED_ORIGINS: "https://a.example",
    RUNTIME_FRAME_ANCESTORS: "https://a.example",
    PROJECT_ID,
  });
  assert.equal(o.upstreamPort, 4001);
  assert.equal(o.keyFile, "/tmp/k");
  assert.equal(o.gateFile, "/tmp/g");
  assert.deepEqual(o.allowedOrigins, ["https://a.example"]);
  assert.equal(gate.loadConfig({ RUNTIME_AUTH_DISABLED: "1" }).authDisabled, true);
  const onFly = gate.loadConfig({ RUNTIME_AUTH_DISABLED: "1", FLY_MACHINE_ID: "m" });
  assert.equal(onFly.authDisabled, false);
  assert.equal(onFly.authDisabledRequested, true);
  assert.equal(gate.loadConfig({ RUNTIME_FILES_PORT: "4002" }).filesPort, 4002);
  assert.equal(d.filesPort, undefined, "without a file endpoint, single-upstream deployments keep routing to the gateway");
});

test("createSecretLoader: fail-closed until the file appears, error logged once, cached afterwards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-key-"));
  const file = path.join(dir, "key");
  const logs = [];
  const logger = { log: (m) => logs.push(["log", m]), warn: (m) => logs.push(["warn", m]), error: (m) => logs.push(["error", m]) };
  try {
    const getKey = gate.createKeyLoader(file, logger);
    assert.equal(getKey(), "");
    assert.equal(getKey(), "");
    assert.equal(logs.filter(([l]) => l === "error").length, 1);
    fs.writeFileSync(file, `${KEY}\n`);
    assert.equal(getKey(), KEY);
    fs.rmSync(file);
    assert.equal(getKey(), KEY, "cached once loaded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// Integration: real servers on ephemeral ports
// =============================================================================

function listen(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.destroySockets = () => {
    for (const socket of sockets) socket.destroy();
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function closeServer(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  if (typeof server.destroySockets === "function") server.destroySockets();
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port, { method = "GET", path: reqPath = "/", headers = {}, body, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: reqPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("HTTP test request timed out")));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function upgrade(port, { path: reqPath = "/agent", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, agent: false, headers: { Connection: "Upgrade", Upgrade: "websocket", ...headers } });
    req.on("upgrade", (res, socket) => resolve({ upgraded: true, status: res.statusCode, socket }));
    req.on("response", (res) => {
      res.resume();
      resolve({ upgraded: false, status: res.statusCode });
    });
    req.on("error", reject);
    req.end();
  });
}

function rawHeaderValues(rawHeaders, name) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name) out.push(rawHeaders[i + 1]);
  return out;
}

/** Fake gateway: echoes what it received; health endpoints; upgrades answered with 101 + echo. */
function startUpstream() {
  const seen = [];
  const closed = []; // urls of streams whose request the gate closed
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith("/stream") || req.url.startsWith("/files/watch")) {
      // like /files/watch: headers and a first event, then open until the client goes away
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: ready\ndata: {}\n\n");
      req.on("close", () => closed.push(req.url));
      return;
    }
    if (req.url === "/livez") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "live", runtime: "gateway" }));
    }
    if (req.url === "/readyz") {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "not_ready", ready: false, components: { agent: { state: "starting" } } }));
    }
    if (req.url.startsWith("/csp")) {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Security-Policy": "default-src 'self'" });
      return res.end("csp");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin || null, cookie: req.headers.cookie || null, gate: req.headers["x-gc-gate"] || null }));
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, upgrade: true });
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d));
  });
  return { server, seen, closed };
}

test("integration: files use their own authenticated upstream while ACP is unavailable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-files-"));
  const keyFile = path.join(dir, "key");
  const gateFile = path.join(dir, "gate");
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
  fs.writeFileSync(gateFile, GATE_SECRET, { mode: 0o600 });
  const gateway = startUpstream();
  const files = startUpstream();
  const gatewayPort = await listen(gateway.server);
  const filesPort = await listen(files.server);
  const config = gate.loadConfig({ RUNTIME_GATEWAY_PORT: String(gatewayPort), RUNTIME_FILES_PORT: String(filesPort), RUNTIME_GATE_KEY_FILE: keyFile, RUNTIME_GATE_SECRET_FILE: gateFile, PROJECT_ID });
  const server = gate.createGateServer(config, { logger: silent });
  const port = await listen(server);
  t.after(async () => {
    await closeServer(server);
    await closeServer(gateway.server);
    await closeServer(files.server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cookie = cookieHeaderFor();

  await t.test("file access still requires the cookie; health and agent routes stay on the gateway", async () => {
    assert.equal((await request(port, { path: "/files/info" })).status, 401);
    assert.equal(files.seen.length, 0);
    assert.equal((await request(port, { path: "/readyz" })).status, 503);
    assert.equal((await request(port, { path: "/session/info", headers: { Cookie: cookie } })).status, 200);
    assert.ok(gateway.seen.some((entry) => entry.url === "/session/info"));
    const upgraded = await upgrade(port, { headers: { Cookie: cookie, Origin: ORIGIN } });
    assert.equal(upgraded.upgraded, true);
    upgraded.socket.destroy();
    assert.ok(gateway.seen.some((entry) => entry.upgrade));
    assert.ok(!files.seen.some((entry) => entry.upgrade));
  });

  await t.test("info and uploads bypass the gateway with the same cookie, secret and CORS envelope", async () => {
    const before = gateway.seen.length;
    for (const options of [{ path: "/files/info" }, { method: "PUT", path: "/files/upload?path=report.txt", body: "report bytes" }]) {
      const response = await request(port, { ...options, headers: { Cookie: `other=1; ${cookie}`, Origin: ORIGIN, "X-GC-Gate": "spoof", "X-GC-Base-Observation": "base", "X-Content-SHA256": "digest", "X-GC-Require-Remote-Persistable": "true" } });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).gate, GATE_SECRET);
      assert.equal(JSON.parse(response.body).cookie, "other=1");
      assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
      assert.equal(response.headers["access-control-allow-credentials"], "true");
      assert.match(response.headers["content-security-policy"], /frame-ancestors/);
    }
    assert.equal(gateway.seen.length, before, "files never enter the ACP gateway");
    assert.equal(files.seen.at(-1).headers["x-gc-base-observation"], "base");
    assert.equal(files.seen.at(-1).headers["x-content-sha256"], "digest");
    assert.equal(files.seen.at(-1).headers["x-gc-require-remote-persistable"], "true");
  });

  await t.test("browser cookies and gate tokens never forward lifecycle drain, including traversal aliases", async () => {
    const before = gateway.seen.length + files.seen.length;
    for (const target of ["/internal/files/drain", "/files/../internal/files/drain", "/files/%2e%2e/internal/files/drain", "/internal/voxels/reconcile", "/voxels/../internal/voxels/reconcile", "/voxels/%2e%2e/internal/voxels/reconcile"]) {
      const response = await request(port, { method: "POST", path: target, headers: { Cookie: cookie, "X-GC-Gate": GATE_SECRET }, body: "{}" });
      assert.equal(response.status, 404, target);
    }
    assert.equal(gateway.seen.length + files.seen.length, before);
  });

  await t.test("artifact DELETE uses only the authenticated file upstream", async () => {
    const target = "/voxels/artifacts/vox-one", body = JSON.stringify({ generation: "a".repeat(64), idempotencyKey: "delete-one" });
    const before = gateway.seen.length + files.seen.length;
    assert.equal((await request(port, { method: "DELETE", path: target, body, headers: { "Content-Length": Buffer.byteLength(body) } })).status, 401);
    assert.equal(gateway.seen.length + files.seen.length, before);
    const gatewayBefore = gateway.seen.length;
    const deleted = await request(port, { method: "DELETE", path: target, body, headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-GC-Files-Control": "spoof", "X-GC-Runtime-Control": "spoof" } });
    assert.equal(deleted.status, 200);
    assert.equal(gateway.seen.length, gatewayBefore, "DELETE bypasses ACP");
    assert.equal(files.seen.at(-1).url, target);
    assert.equal(files.seen.at(-1).headers["x-gc-files-control"], undefined);
    assert.equal(files.seen.at(-1).headers["x-gc-runtime-control"], undefined);
  });

  await t.test("named reads and artifact inventory/GET/DELETE use the authenticated file upstream with bounded IDs", async () => {
    const targets = [
      "/voxels/named", "/voxels/named?limit=2&name=Pattern", "/voxels/named/named-one",
      "/voxels/artifacts/vox-one?generation=abc", "/voxels/artifacts/vox-one?manifest=%7B%7D",
      "/voxels/artifacts", "/voxels/artifacts?limit=2&cursor=opaque",
      `/voxels/artifacts/${"x".repeat(128)}`, "/voxels/artifacts/one_.:-2", "/voxels/artifacts/%76ox-one",
    ];
    for (const target of targets) {
      const before = gateway.seen.length + files.seen.length;
      assert.equal((await request(port, { path: target })).status, 401, target);
      assert.equal(gateway.seen.length + files.seen.length, before, "unauthenticated reads reach neither upstream");
      const gatewayBefore = gateway.seen.length;
      const response = await request(port, { path: target, headers: { Cookie: cookie, Origin: ORIGIN, "X-GC-Gate": "spoof", "X-GC-Workspace-Id": "workspace-one", "X-GC-Workspace-Epoch": "epoch-one" } });
      assert.equal(response.status, 200, target);
      assert.equal(gateway.seen.length, gatewayBefore, `${target} bypasses ACP`);
      assert.equal(files.seen.at(-1).url, target, "query bindings are forwarded intact");
      assert.equal(files.seen.at(-1).headers["x-gc-gate"], GATE_SECRET);
      assert.equal(files.seen.at(-1).headers["x-gc-workspace-id"], "workspace-one");
      assert.equal(files.seen.at(-1).headers["x-gc-workspace-epoch"], "epoch-one");
      assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
    }
    const rejected = [
      "/voxels/named-extra", "/voxels/named/", "/voxels/named/one/extra",
      "/voxels/artifacts/", "/voxels/artifacts-extra/one",
      "/voxels/artifacts/one/extra", "/voxels/unknown", "/agent/voxels",
      `/voxels/artifacts/${"x".repeat(129)}`, "/voxels/artifacts/one%2Ftwo", "/voxels/artifacts/one%00",
      "/voxels/artifacts/%FF", "/voxels/artifacts/one%", "/voxels/artifacts/one%20two",
      `/voxels/named/${"x".repeat(129)}`, "/voxels/named/one%2Ftwo",
    ];
    const filesBefore = files.seen.length;
    for (const target of rejected) {
      for (const method of ["GET", "DELETE"]) {
        await request(port, { method, path: target, headers: { Cookie: cookie } });
        assert.equal(gateway.seen.at(-1).url, target, `${method} ${target} stays outside the file route allowlist`);
      }
    }
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      for (const target of ["/voxels/named", "/voxels/named/one", "/voxels/artifacts", ...(method === "DELETE" ? [] : ["/voxels/artifacts/one"])]) {
        await request(port, { method, path: target, headers: { Cookie: cookie } });
        assert.equal(gateway.seen.at(-1).url, target, `${method} ${target} is not a GET route`);
      }
    }
    assert.equal(files.seen.length, filesBefore, "lookalikes and unsupported methods never reach the file daemon");
  });

  await t.test("malformed routing targets return 400 without reaching either upstream", async () => {
    const before = gateway.seen.length + files.seen.length;
    assert.equal((await request(port, { path: "//[", headers: { Cookie: cookie }, timeoutMs: 500 })).status, 400);
    assert.equal(gateway.seen.length + files.seen.length, before);
  });

  await t.test("file SSE abort propagates to the daemon", async () => {
    const req = http.request({ host: "127.0.0.1", port, path: "/files/watch", headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => {
      req.on("response", (res) => res.once("data", resolve));
      req.on("error", reject);
      req.end();
    });
    assert.ok(files.seen.some((entry) => entry.url === "/files/watch"));
    req.destroy();
    const started = Date.now();
    while (!files.closed.includes("/files/watch")) {
      assert.ok(Date.now() - started < 3000, "daemon stream remained open");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  await t.test("file service remains reachable when the gateway process is down", async () => {
    await closeServer(gateway.server);
    assert.equal((await request(port, { path: "/readyz" })).status, 503);
    assert.equal((await request(port, { path: "/files/info", headers: { Cookie: cookie } })).status, 200);
    const before = files.seen.length;
    assert.equal((await request(port, { path: "/files-other/info", headers: { Cookie: cookie } })).status, 502);
    assert.equal(files.seen.length, before, "prefix lookalikes must not route to the file service");
  });
});

test("integration: exchange → cookie → proxied with CORS/CSP/X-GC-Gate; health mirrored; WebSocket gate", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-it-"));
  const keyFile = path.join(dir, "key");
  const gateFile = path.join(dir, "gate");
  fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  fs.writeFileSync(gateFile, `${GATE_SECRET}\n`, { mode: 0o600 });
  const upstream = startUpstream();
  const upPort = await listen(upstream.server);
  const config = gate.loadConfig({ RUNTIME_GATEWAY_PORT: String(upPort), RUNTIME_GATE_KEY_FILE: keyFile, RUNTIME_GATE_SECRET_FILE: gateFile, PROJECT_ID });
  const server = gate.createGateServer(config, { logger: silent });
  const port = await listen(server);
  t.after(async () => {
    await closeServer(server);
    await closeServer(upstream.server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const fa = `frame-ancestors ${gate.DEFAULT_FRAME_ANCESTORS}`;
  let cookie;

  await t.test("health mirrors the gateway (status and body), public with CORS *", async () => {
    const live = await request(port, { path: "/livez" });
    assert.equal(live.status, 200);
    assert.equal(JSON.parse(live.body).runtime, "gateway");
    assert.equal(JSON.parse(live.body).gate, "up");
    assert.equal(live.headers["access-control-allow-origin"], "*");
    const ready = await request(port, { path: "/readyz" });
    assert.equal(ready.status, 503);
    assert.equal(JSON.parse(ready.body).components.agent.state, "starting");
    assert.equal((await request(port, { method: "OPTIONS", path: "/readyz" })).status, 204);
    assert.equal((await request(port, { path: "/healthz" })).status, 401, "old path is gated like everything else");
  });

  await t.test("CORS preflight needs no auth and echoes an allowed origin only", async () => {
    const ok = await request(port, { method: "OPTIONS", path: "/files/list", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(ok.headers["access-control-allow-credentials"], "true");
    assert.match(ok.headers["access-control-allow-headers"], /Range/);
    const bad = await request(port, { method: "OPTIONS", path: "/files/list", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
    assert.equal(bad.status, 204);
    assert.equal(bad.headers["access-control-allow-origin"], undefined);
  });

  await t.test("no credentials → 401 JSON (no-store, frame-ancestors), upstream untouched", async () => {
    const before = upstream.seen.length;
    const r = await request(port, { path: "/files/list", headers: { Origin: ORIGIN } });
    assert.equal(r.status, 401);
    assert.deepEqual(JSON.parse(r.body), { error: "unauthorized", reason: "no-cookie" });
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["content-security-policy"], fa);
    assert.equal(r.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(upstream.seen.length, before);
  });

  const token = signJwt(claims());
  await t.test("POST /auth/exchange with a JSON body → 204 + Set-Cookie + CORS; replay → 401", async () => {
    const r = await request(port, { method: "POST", path: "/auth/exchange", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(r.status, 204);
    assert.equal(r.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(r.headers["access-control-allow-credentials"], "true");
    const setCookie = r.headers["set-cookie"];
    assert.equal(setCookie.length, 1);
    assert.match(setCookie[0], /^__Host-gc_ide=v1\.\d+\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=43200$/);
    cookie = setCookie[0].split(";")[0];
    const replay = await request(port, { method: "POST", path: "/auth/exchange", body: JSON.stringify({ token }) });
    assert.equal(replay.status, 401);
    assert.equal(JSON.parse(replay.body).reason, "jti-reused");
    assert.equal((await request(port, { method: "POST", path: "/auth/exchange", body: "{" })).status, 400);
    assert.equal((await request(port, { method: "POST", path: "/auth/exchange", body: "{}" })).status, 400);
    assert.ok(!upstream.seen.some((s) => s.url.includes("token=")), "token never reaches the gateway");
  });

  await t.test("query-string exchange also works", async () => {
    const r = await request(port, { method: "POST", path: `/auth/exchange?token=${signJwt(claims())}` });
    assert.equal(r.status, 204);
    assert.equal(r.headers["set-cookie"].length, 1);
  });

  await t.test("cookie → proxied; CORS + frame-ancestors added; cookie stripped; gate secret injected; spoofed header dropped", async () => {
    const r = await request(port, { path: "/files/list?path=", headers: { Origin: ORIGIN, Cookie: `other=1; ${cookie}`, "X-GC-Gate": "spoof" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-security-policy"], fa);
    assert.equal(r.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(r.headers["access-control-allow-credentials"], "true");
    const echoed = JSON.parse(r.body);
    assert.equal(echoed.cookie, "other=1");
    assert.equal(echoed.gate, GATE_SECRET);
    assert.equal(echoed.url, "/files/list?path=");
  });

  await t.test("upstream CSP kept, ours appended as a separate header", async () => {
    const r = await request(port, { path: "/csp", headers: { Cookie: cookie } });
    assert.deepEqual(rawHeaderValues(r.rawHeaders, "content-security-policy"), ["default-src 'self'", fa]);
  });

  await t.test("logout clears the cookie", async () => {
    const r = await request(port, { method: "POST", path: "/auth/logout", headers: { Origin: ORIGIN } });
    assert.equal(r.status, 204);
    assert.equal(r.headers["set-cookie"][0], gate.clearCookieHeader());
  });

  await t.test("WebSocket: no cookie → 401; bad Origin → 403; cookie + allowed Origin → 101 with gate secret upstream", async () => {
    const before = upstream.seen.length;
    assert.equal((await upgrade(port, { headers: { Origin: ORIGIN } })).status, 401);
    assert.equal((await upgrade(port, { headers: { Origin: "https://evil.example", Cookie: cookie } })).status, 403);
    assert.equal(upstream.seen.length, before);
    const r = await upgrade(port, { headers: { Origin: ORIGIN, Cookie: cookie, "X-GC-Gate": "spoof" } });
    assert.equal(r.upgraded, true);
    const echoed = await new Promise((resolve) => {
      r.socket.once("data", (d) => resolve(d.toString()));
      r.socket.write("ping");
    });
    assert.equal(echoed, "ping");
    r.socket.destroy();
    const last = upstream.seen[upstream.seen.length - 1];
    assert.equal(last.upgrade, true);
    assert.equal(last.headers.cookie, undefined);
    assert.equal(last.headers["x-gc-gate"], GATE_SECRET);
  });

  await t.test("a browser that leaves mid-stream closes the upstream request too (EventSource, aborted upload)", async () => {
    const req = http.request({ port, path: "/stream?w=1", headers: { Cookie: cookie, Origin: ORIGIN } });
    const firstChunk = await new Promise((resolve, reject) => {
      req.on("response", (res) => res.once("data", (d) => resolve(d.toString())));
      req.on("error", reject);
      req.end();
    });
    assert.match(firstChunk, /event: ready/);
    assert.deepEqual(upstream.closed, []);
    req.destroy();
    const started = Date.now();
    while (!upstream.closed.includes("/stream?w=1")) {
      assert.ok(Date.now() - started < 3000, "upstream request still open after the client left");
      await new Promise((r) => setTimeout(r, 20));
    }
    // a finished response is not cut: normal requests keep working
    assert.equal((await request(port, { path: "/files/list", headers: { Cookie: cookie } })).status, 200);
  });

  await t.test("CORS allows the resumable-watch and conditional-read headers", async () => {
    const ok = await request(port, { method: "OPTIONS", path: "/files/watch", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" } });
    assert.match(ok.headers["access-control-allow-headers"], /Last-Event-ID/);
    assert.match(ok.headers["access-control-allow-headers"], /If-Range/);
  });
});

// =============================================================================
// Entry-point mode: `node gate.cjs` configured by env (as entrypoint.sh runs it)
// =============================================================================

function spawnGate(env) {
  const child = spawn(process.execPath, [GATE_PATH], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "" };
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gate did not start: ${out.stdout} ${out.stderr}`)), 5000);
    child.stdout.on("data", (d) => {
      out.stdout += d;
      const m = /Listening on :(\d+)/.exec(out.stdout);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on("data", (d) => {
      out.stderr += d;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gate exited (${code}): ${out.stderr}`));
    });
  });
  ready.catch(() => {});
  return { child, ready, out };
}

test("entry point on Fly: AUTH_DISABLED ignored, key + gate secret from files, contract token accepted", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-main-"));
  const keyFile = path.join(dir, "key");
  const gateFile = path.join(dir, "gate");
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
  fs.writeFileSync(gateFile, GATE_SECRET, { mode: 0o600 });
  const upstream = startUpstream();
  const upPort = await listen(upstream.server);
  const p = spawnGate({
    RUNTIME_GATE_PORT: "0",
    RUNTIME_GATEWAY_PORT: String(upPort),
    RUNTIME_GATE_KEY_FILE: keyFile,
    RUNTIME_GATE_SECRET_FILE: gateFile,
    PROJECT_ID,
    FLY_MACHINE_ID: "m-test",
    RUNTIME_AUTH_DISABLED: "1",
  });
  t.after(async () => {
    p.child.kill();
    await closeServer(upstream.server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await p.ready;
  assert.match(p.out.stderr, /RUNTIME_AUTH_DISABLED=1 ignored/);
  assert.equal((await request(port, { path: "/files/list" })).status, 401);
  const live = await request(port, { path: "/livez" });
  assert.equal(live.status, 200);
  assert.equal(JSON.parse(live.body).machine_id, "m-test");
  const r = await request(port, { method: "POST", path: "/auth/exchange", body: JSON.stringify({ token: CONTRACT_TOKEN }) });
  assert.equal(r.status, 204, "contract token accepted by the running gate");
  const cookie = r.headers["set-cookie"][0].split(";")[0];
  const proxied = await request(port, { path: "/files/list", headers: { Cookie: cookie } });
  assert.equal(proxied.status, 200);
  assert.equal(JSON.parse(proxied.body).gate, GATE_SECRET);
});

test("entry point without key file: fails closed, then accepts a late-written key", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-nokey-"));
  const keyFile = path.join(dir, "key");
  const upstream = startUpstream();
  const upPort = await listen(upstream.server);
  const p = spawnGate({ RUNTIME_GATE_PORT: "0", RUNTIME_GATEWAY_PORT: String(upPort), RUNTIME_GATE_KEY_FILE: keyFile, RUNTIME_GATE_SECRET_FILE: path.join(dir, "gate"), PROJECT_ID });
  t.after(async () => {
    p.child.kill();
    await closeServer(upstream.server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await p.ready;
  assert.match(p.out.stderr, /no access key/);
  assert.equal((await request(port, { method: "POST", path: "/auth/exchange", body: JSON.stringify({ token: signJwt(claims()) }) })).status, 401);
  assert.equal((await request(port, { path: "/livez" })).status, 200);
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
  assert.equal((await request(port, { method: "POST", path: "/auth/exchange", body: JSON.stringify({ token: signJwt(claims()) }) })).status, 204);
});

test("entry point local dev: RUNTIME_AUTH_DISABLED=1 without FLY_MACHINE_ID proxies with a warning", async (t) => {
  const upstream = startUpstream();
  const upPort = await listen(upstream.server);
  const p = spawnGate({ RUNTIME_GATE_PORT: "0", RUNTIME_GATEWAY_PORT: String(upPort), RUNTIME_AUTH_DISABLED: "1", RUNTIME_GATE_SECRET_FILE: "/nonexistent/gate" });
  t.after(async () => {
    p.child.kill();
    await closeServer(upstream.server);
  });
  const port = await p.ready;
  assert.match(p.out.stderr, /access gate is OFF/);
  assert.equal((await request(port, { path: "/files/list" })).status, 200);
});
