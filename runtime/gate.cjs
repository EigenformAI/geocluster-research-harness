/**
 * gate.cjs — access gate + reverse proxy in front of the runtime gateway (was fly-replay-proxy.js)
 *
 * Each project has its own Fly app with exactly one machine. This process listens on
 * :3000 (Fly's internal_port) as root. /files/* goes directly to the separate file daemon
 * when configured; agent traffic and health go to the gateway on 127.0.0.1:3001.
 * It is the public access control on the machine. Internal control routes are never proxied.
 *
 *   - /livez, /readyz (+ OPTIONS): public. Mirrors the gateway's answer (CORS *).
 *   - OPTIONS <anything> with Access-Control-Request-Method: CORS preflight, no auth.
 *   - POST /auth/exchange  (body {"token": "<jwt>"} or ?token=): the backend's one-time HS256
 *     token (geocluster-ai-BE app/services/runtime_gate_auth.py; key
 *     HMAC-SHA256(IDE_TOKEN_SECRET, "ide-proxy-v1:" + project_id) as lowercase hex, used as the
 *     HMAC key string). Checks: alg exactly HS256, signature, aud "ide-proxy", exp (30 s skew),
 *     project_id === PROJECT_ID, jti unused. Valid → 204 + session cookie __Host-gc_ide
 *     (12 h, stateless HMAC, survives restarts). Nothing else ever mints the cookie.
 *   - POST /auth/logout: 204, cookie cleared.
 *   - Everything else, WebSocket upgrades included: valid cookie or 401. Upgrades must also
 *     carry an allow-listed Origin when they carry one at all (the cookie is SameSite=None).
 *   - Responses carry CORS headers for allow-listed origins (credentials) and a
 *     `Content-Security-Policy: frame-ancestors …` so only our origins can frame files.
 *   - The per-boot gate secret (/run/runtime/gate, root 600, written by entrypoint.sh) is sent
 *     upstream as X-GC-Gate on every request; any client-supplied value is dropped. The
 *     gateway refuses requests without it, so the agent (same uid as the gateway) cannot talk
 *     to 127.0.0.1:3001 and approve its own permission requests.
 *   - Key file missing or empty → fail closed: 401 for everything except health and preflight.
 *   - RUNTIME_AUTH_DISABLED=1 turns the gate off, but only without FLY_MACHINE_ID (local Docker).
 *
 * Only Node built-ins. Tests: `node --test runtime/test/` (gate.test.cjs).
 */

"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const workspaceRelay = require("./lib/workspace-relay.cjs");

// =============================================================================
// Constants
// =============================================================================

const COOKIE_NAME = "__Host-gc_ide";
const COOKIE_MAX_AGE_S = 43200; // 12 h
const TOKEN_AUDIENCE = "ide-proxy";
const CLOCK_SKEW_S = 30;
const MAX_TOKEN_LENGTH = 4096;
const MAX_JTI_LENGTH = 256;
const MAX_COOKIE_CANDIDATES = 5;
const MAX_EXCHANGE_BODY = 8192;
const DEFAULT_KEY_FILE = "/run/runtime/key";
const DEFAULT_GATE_FILE = "/run/runtime/gate";
const DEFAULT_ALLOWED_ORIGINS = "https://geocluster.net,https://www.geocluster.net";
const DEFAULT_FRAME_ANCESTORS = "https://geocluster.net https://*.geocluster.net";
const GATE_HEADER = "x-gc-gate";

const HEALTH_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CORS_ALLOW_METHODS = "GET, HEAD, POST, PUT, DELETE, OPTIONS";
const CORS_ALLOW_HEADERS = "Content-Type, Accept, If-Match, If-None-Match, If-Range, Range, Last-Event-ID, X-Requested-With, X-GC-Base-Observation, X-Content-SHA256, X-GC-Require-Remote-Persistable, X-GC-Process-Document";
const CORS_EXPOSE_HEADERS = "ETag, Content-Disposition, Content-Range, Content-Length, Accept-Ranges, Location";
const CORS_MAX_AGE = "600";

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const COOKIE_VALUE_RE = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

// =============================================================================
// Pure helpers (exported for tests)
// =============================================================================

function nowSeconds() {
  return Date.now() / 1000;
}

function fail(reason) {
  return { ok: false, reason };
}

function hmacB64url(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest("base64url");
}

/** Constant-time string comparison (length is not secret here). */
function safeEqualStrings(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function decodeJsonSegment(segment) {
  if (typeof segment !== "string" || !B64URL_RE.test(segment)) return null;
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Verify a gate token. Does not mark the jti as used (exchangeToken() does).
 *
 * @param {string} token compact JWS
 * @param {{key: string, projectId: string, now?: number, usedJtis?: Map<string, number>}} opts
 * @returns {{ok: true, claims: object} | {ok: false, reason: string}}
 */
function verifyToken(token, opts) {
  const { key, projectId, usedJtis } = opts || {};
  const now = opts && typeof opts.now === "number" ? opts.now : nowSeconds();
  if (!key) return fail("no-key");
  if (!projectId) return fail("no-project-id");
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return fail("malformed");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !B64URL_RE.test(parts[2])) return fail("malformed");

  const header = decodeJsonSegment(parts[0]);
  if (!header) return fail("malformed");
  // Exactly HS256: rejects "none", "hs256", HS384/HS512 and asymmetric algs.
  if (header.alg !== "HS256") return fail("bad-alg");

  const expected = hmacB64url(key, `${parts[0]}.${parts[1]}`);
  if (!safeEqualStrings(parts[2], expected)) return fail("bad-signature");

  const claims = decodeJsonSegment(parts[1]);
  if (!claims) return fail("malformed");

  const aud = claims.aud;
  if (!(aud === TOKEN_AUDIENCE || (Array.isArray(aud) && aud.includes(TOKEN_AUDIENCE)))) {
    return fail("bad-aud");
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return fail("no-exp");
  if (claims.exp <= now - CLOCK_SKEW_S) return fail("expired");
  if (claims.nbf !== undefined && !(typeof claims.nbf === "number" && claims.nbf <= now + CLOCK_SKEW_S)) {
    return fail("not-yet-valid");
  }
  if (claims.iat !== undefined && !(typeof claims.iat === "number" && claims.iat <= now + CLOCK_SKEW_S)) {
    return fail("iat-in-future");
  }
  if (typeof claims.project_id !== "string" || claims.project_id !== projectId) {
    return fail("project-mismatch");
  }
  if (typeof claims.jti !== "string" || claims.jti.length === 0 || claims.jti.length > MAX_JTI_LENGTH) {
    return fail("no-jti");
  }
  if (usedJtis && usedJtis.has(claims.jti)) return fail("jti-reused");
  return { ok: true, claims };
}

/** Record a used jti (kept until its exp + skew, when the exp check alone rejects it). */
function markJtiUsed(usedJtis, jti, exp, now) {
  for (const [id, idExp] of usedJtis) {
    if (idExp <= now - CLOCK_SKEW_S) usedJtis.delete(id);
  }
  usedJtis.set(jti, exp);
}

function cookieSignature(key, projectId, expString) {
  return hmacB64url(key, `cookie|${projectId}|${expString}`);
}

/**
 * Mint the session cookie.
 * @param {{key: string, projectId: string, now?: number}} opts
 * @returns {{name: string, value: string, exp: number, header: string}}
 */
function issueCookie(opts) {
  const { key, projectId } = opts || {};
  if (!key || !projectId) throw new Error("issueCookie requires key and projectId");
  const now = typeof opts.now === "number" ? opts.now : nowSeconds();
  const exp = Math.floor(now) + COOKIE_MAX_AGE_S;
  const value = `v1.${exp}.${cookieSignature(key, projectId, String(exp))}`;
  // __Host- prefix: Secure + Path=/ + no Domain (host-only). SameSite=None so cross-origin
  // fetch/WebSocket from the app origin send it; Partitioned (CHIPS) so browsers that block
  // third-party cookies keep it for cross-site app origins (Vercel previews).
  const header =
    `${COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${COOKIE_MAX_AGE_S}`;
  return { name: COOKIE_NAME, value, exp, header };
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0`;
}

/**
 * Verify a session cookie value ("v1.<exp>.<sig>").
 * @returns {{ok: true, exp: number} | {ok: false, reason: string}}
 */
function verifyCookie(value, opts) {
  const { key, projectId } = opts || {};
  const now = opts && typeof opts.now === "number" ? opts.now : nowSeconds();
  if (!key) return fail("no-key");
  if (!projectId) return fail("no-project-id");
  const match = typeof value === "string" ? COOKIE_VALUE_RE.exec(value) : null;
  if (!match) return fail("malformed");
  if (!safeEqualStrings(match[2], cookieSignature(key, projectId, match[1]))) {
    return fail("bad-signature");
  }
  const exp = Number(match[1]);
  if (exp <= now) return fail("expired");
  return { ok: true, exp };
}

/** All values of cookie `name` in a Cookie header (string or array), in order. */
function getCookieValues(cookieHeader, name) {
  if (!cookieHeader) return [];
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(";") : String(cookieHeader);
  const values = [];
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }
    values.push(value);
  }
  return values;
}

/** Cookie header without cookie `name` (undefined when nothing is left). */
function stripCookie(cookieHeader, name) {
  if (!cookieHeader) return undefined;
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(";") : String(cookieHeader);
  const kept = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (part === "") return false;
      const eq = part.indexOf("=");
      return (eq === -1 ? part : part.slice(0, eq)).trim() !== name;
    });
  return kept.length ? kept.join("; ") : undefined;
}

function checkCookieHeader(cookieHeader, opts) {
  const values = getCookieValues(cookieHeader, COOKIE_NAME).slice(0, MAX_COOKIE_CANDIDATES);
  if (values.length === 0) return fail("no-cookie");
  let last = null;
  for (const value of values) {
    const verdict = verifyCookie(value, opts);
    if (verdict.ok) return verdict;
    last = verdict;
  }
  return fail(`cookie-${last.reason}`);
}

/** Split a request target into raw path and raw query (null when unusable). */
function splitRequestUrl(rawUrl) {
  let url = typeof rawUrl === "string" ? rawUrl : "";
  if (!url.startsWith("/")) {
    try {
      const parsed = new URL(url);
      url = parsed.pathname + parsed.search;
    } catch {
      return null;
    }
  }
  const hash = url.indexOf("#");
  if (hash !== -1) url = url.slice(0, hash);
  const q = url.indexOf("?");
  return q === -1 ? { path: url, query: "" } : { path: url.slice(0, q), query: url.slice(q + 1) };
}

function isHealthPath(path) {
  return path === "/livez" || path === "/readyz";
}

/** Parse the allow-list: exact origins, or `https://*.example.com` for any subdomain. */
function parseAllowedOrigins(value) {
  return String(value === undefined || value === null ? DEFAULT_ALLOWED_ORIGINS : value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/.test(entry));
}

function originAllowed(origin, allowed) {
  if (typeof origin !== "string" || !origin) return false;
  const value = origin.toLowerCase();
  for (const entry of allowed) {
    if (entry === value) return true;
    const star = entry.indexOf("://*.");
    if (star !== -1) {
      const scheme = entry.slice(0, star + 3);
      const suffix = entry.slice(star + 4); // ".example.com"
      if (value.startsWith(scheme) && value.endsWith(suffix) && value.length > scheme.length + suffix.length) return true;
    }
  }
  return false;
}

/** CORS headers for an allow-listed origin (credentialed); empty otherwise. */
function corsHeaders(origin, allowed) {
  if (!originAllowed(origin, allowed)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS,
    Vary: "Origin",
  };
}

function preflightHeaders(origin, allowed) {
  if (!originAllowed(origin, allowed)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": CORS_MAX_AGE,
    Vary: "Origin",
  };
}

function deny(reason) {
  return { action: "deny", status: 401, reason };
}

/**
 * Decide what to do with an HTTP request. Pure.
 *
 * @param {{method?: string, url: string, headers?: object}} req
 * @param {{key: string, projectId: string, authDisabled?: boolean, now?: number}} ctx
 * @returns {{action: "health"|"preflight"|"exchange"|"logout"|"proxy"|"deny"|"bad-request",
 *            status?: number, via?: string, reason?: string}}
 */
function authorize(req, ctx) {
  const parts = splitRequestUrl(req && req.url);
  if (!parts) return { action: "bad-request", status: 400, reason: "bad-url" };
  const method = req.method || "GET";
  const headers = req.headers || {};

  if (isHealthPath(parts.path)) {
    return method === "OPTIONS" ? { action: "preflight", status: 204, health: true } : { action: "health" };
  }
  if (method === "OPTIONS" && headers["access-control-request-method"]) {
    return { action: "preflight", status: 204 };
  }
  if (parts.path === "/auth/logout" && method === "POST") return { action: "logout", status: 204 };
  if (parts.path === "/auth/exchange") {
    return method === "POST" ? { action: "exchange" } : { action: "deny", status: 405, reason: "method" };
  }
  if (ctx.authDisabled) return { action: "proxy", via: "auth-disabled" };
  if (!ctx.key) return deny("no-key");
  if (!ctx.projectId) return deny("no-project-id");

  const now = typeof ctx.now === "number" ? ctx.now : nowSeconds();
  const cookie = checkCookieHeader(headers.cookie, { key: ctx.key, projectId: ctx.projectId, now });
  const pathname = routingPath(req.url);
  if (cookie.ok && ((method === "PUT" && pathname === "/files/upload") || (method === "POST" && pathname.startsWith("/files/processing/"))) && headers.origin !== undefined && !originAllowed(headers.origin, ctx.allowedOrigins || [])) {
    return { action: "deny", status: 403, reason: "bad-origin" };
  }
  return cookie.ok ? { action: "proxy", via: "cookie" } : deny(cookie.reason);
}

/**
 * Exchange a one-time token for the session cookie. Records the jti in ctx.usedJtis.
 * @returns {{ok: true, setCookie: string, sub?: string} | {ok: false, reason: string}}
 */
function exchangeToken(token, ctx) {
  if (ctx.authDisabled) return { ok: true, setCookie: "", via: "auth-disabled" };
  if (!ctx.key) return fail("no-key");
  if (!ctx.projectId) return fail("no-project-id");
  if (!(ctx.usedJtis instanceof Map)) return fail("no-replay-store");
  const now = typeof ctx.now === "number" ? ctx.now : nowSeconds();
  const auth = { key: ctx.key, projectId: ctx.projectId, now };
  const verdict = verifyToken(token, { ...auth, usedJtis: ctx.usedJtis });
  if (!verdict.ok) return verdict;
  markJtiUsed(ctx.usedJtis, verdict.claims.jti, verdict.claims.exp, now);
  return {
    ok: true,
    setCookie: issueCookie(auth).header,
    sub: typeof verdict.claims.sub === "string" ? verdict.claims.sub : undefined,
  };
}

/**
 * Decide on a WebSocket upgrade: cookie, plus an allow-listed Origin when the client sends
 * one (browsers always do; the cookie is SameSite=None, so this is the CSRF check).
 */
function authorizeUpgrade(req, ctx) {
  if (!splitRequestUrl(req && req.url)) return deny("bad-url");
  const origin = req.headers ? req.headers.origin : undefined;
  if (origin !== undefined && !ctx.authDisabled && !originAllowed(origin, ctx.allowedOrigins || [])) {
    return { action: "deny", status: 403, reason: "bad-origin" };
  }
  if (ctx.authDisabled) return { action: "proxy", via: "auth-disabled" };
  if (!ctx.key) return deny("no-key");
  if (!ctx.projectId) return deny("no-project-id");
  const now = typeof ctx.now === "number" ? ctx.now : nowSeconds();
  const cookie = checkCookieHeader(req.headers ? req.headers.cookie : undefined, {
    key: ctx.key,
    projectId: ctx.projectId,
    now,
  });
  return cookie.ok ? { action: "proxy", via: "cookie" } : deny(cookie.reason);
}

/** Source list for frame-ancestors; strips anything that could add a directive or policy. */
function sanitizeFrameAncestors(value) {
  const cleaned = String(value || "")
    .replace(/[\r\n;,]/g, " ")
    .replace(/[^\x21-\x7e ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || DEFAULT_FRAME_ANCESTORS;
}

/** Response headers plus our frame-ancestors policy, never replacing an upstream CSP. */
function withFrameAncestors(headers, cspValue) {
  const out = { ...headers };
  const existing = out["content-security-policy"];
  out["content-security-policy"] =
    existing === undefined || existing === "" ? cspValue : [].concat(existing, cspValue);
  return out;
}

function parsePort(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

/** Runtime configuration from the environment. */
function loadConfig(env = process.env) {
  const machineId = env.FLY_MACHINE_ID || "";
  const authDisabledRequested = env.RUNTIME_AUTH_DISABLED === "1";
  return {
    listenHost: "0.0.0.0",
    listenPort: parsePort(env.RUNTIME_GATE_PORT, 3000),
    upstreamHost: "127.0.0.1",
    upstreamPort: parsePort(env.RUNTIME_GATEWAY_PORT, 3001),
    // The entrypoint supplies 3002. An omitted endpoint retains single-upstream test/local setups.
    filesPort: env.RUNTIME_FILES_PORT ? parsePort(env.RUNTIME_FILES_PORT, 3002) : undefined,
    keyFile: env.RUNTIME_GATE_KEY_FILE || DEFAULT_KEY_FILE,
    gateFile: env.RUNTIME_GATE_SECRET_FILE || DEFAULT_GATE_FILE,
    filesControlFile: env.RUNTIME_FILES_CONTROL_FILE || "/run/runtime/files-control",
    projectId: env.PROJECT_ID || "",
    machineId,
    authDisabledRequested,
    // The escape hatch never works on Fly, whatever the env says.
    authDisabled: authDisabledRequested && !machineId,
    allowedOrigins: parseAllowedOrigins(env.RUNTIME_ALLOWED_ORIGINS),
    frameAncestors: sanitizeFrameAncestors(env.RUNTIME_FRAME_ANCESTORS),
  };
}

/**
 * File-backed secret loader: reads on first use and caches. While the file is missing or
 * empty it is re-read on every call (a late-written file starts working without a restart)
 * and the error is logged once.
 */
function createSecretLoader(file, label, logger = console, { hexKey = false } = {}) {
  let secret = "";
  let reportedMissing = false;
  return function getSecret() {
    if (secret) return secret;
    let value = "";
    try {
      value = fs.readFileSync(file, "utf8").trim();
    } catch {
      value = "";
    }
    if (value) {
      secret = value;
      if (reportedMissing) logger.log(`[gate] ${label} loaded from ${file}`);
      if (hexKey && !/^[0-9a-f]{64}$/.test(value)) {
        logger.warn(`[gate] WARNING: ${label} is not 64 lowercase hex chars (backend contract)`);
      }
      return secret;
    }
    if (!reportedMissing) {
      reportedMissing = true;
      logger.error(`[gate] ERROR: no ${label} at ${file}`);
    }
    return "";
  };
}

function createKeyLoader(keyFile, logger = console) {
  return createSecretLoader(keyFile, "access key (IDE_PROXY_KEY)", logger, { hexKey: true });
}

// =============================================================================
// HTTP / WebSocket handling
// =============================================================================

/** Request path without the query string (never log tokens). */
function logPath(url) {
  return String(url || "").split("?")[0].slice(0, 200);
}

function forwardedHeaders(reqHeaders, gateSecret, rawHeaders) {
  const headers = { ...reqHeaders };
  const cookie = stripCookie(headers.cookie, COOKIE_NAME);
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;
  delete headers[GATE_HEADER];
  delete headers["x-gc-files-control"];
  delete headers["x-gc-runtime-control"];
  delete headers["x-ide-proxy-key"];
  // These are narrowing preconditions, not authority. Preserve repeated fields so
  // the file boundary can reject duplicates even when their values are identical.
  if (rawHeaders) for (const name of ["x-gc-workspace-id", "x-gc-workspace-epoch"]) {
    const values = [];
    for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name) values.push(rawHeaders[i + 1]);
    if (values.length) headers[name] = values;
  }
  if (gateSecret) headers[GATE_HEADER] = gateSecret;
  return headers;
}

function sendJson(res, status, body, extra = {}) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end(payload);
}

/** Health: mirror the gateway's /livez or /readyz (status and body); 503 when it is unreachable. */
function handleHealth(req, res, config, gateSecret) {
  let responded = false;
  const respond = (statusCode, body) => {
    if (responded || res.headersSent) return;
    responded = true;
    sendJson(res, statusCode, body, HEALTH_CORS_HEADERS);
  };
  const path = splitRequestUrl(req.url).path;
  const probe = http.request(
    {
      hostname: config.upstreamHost,
      port: config.upstreamPort,
      path,
      method: "GET",
      timeout: 10000,
      headers: gateSecret ? { [GATE_HEADER]: gateSecret } : {},
    },
    (probeRes) => {
      let raw = "";
      probeRes.setEncoding("utf8");
      probeRes.on("data", (chunk) => {
        if (raw.length < 65536) raw += chunk;
      });
      probeRes.on("end", () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = { status: probeRes.statusCode === 200 ? "ok" : "not_ready", raw: raw.slice(0, 200) };
        }
        respond(probeRes.statusCode, { ...body, gate: "up", machine_id: config.machineId });
      });
    }
  );
  probe.on("error", () => {
    respond(503, {
      status: path === "/livez" ? "gateway_down" : "not_ready",
      ready: false,
      gate: "up",
      reason: "runtime gateway not reachable",
      timestamp: new Date().toISOString(),
      machine_id: config.machineId,
    });
  });
  probe.on("timeout", () => probe.destroy());
  probe.end();
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let data = "";
    let overflow = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        overflow = true;
        req.destroy();
      }
    });
    req.on("end", () => resolve(overflow ? null : data));
    req.on("error", () => resolve(null));
    req.on("close", () => resolve(overflow ? null : data));
  });
}

async function handleExchange(req, res, ctxFn, cors, logger) {
  const parts = splitRequestUrl(req.url);
  let token = new URLSearchParams(parts.query).get("token") || "";
  if (!token) {
    const body = await readBody(req, MAX_EXCHANGE_BODY);
    if (body === null) return sendJson(res, 413, { error: "body_too_large" }, cors);
    try {
      const parsed = body ? JSON.parse(body) : {};
      token = typeof parsed.token === "string" ? parsed.token : "";
    } catch {
      return sendJson(res, 400, { error: "bad_json" }, cors);
    }
  }
  if (!token) return sendJson(res, 400, { error: "missing_token" }, cors);
  const result = exchangeToken(token, ctxFn());
  if (!result.ok) {
    logger.log(`[gate] exchange rejected (${result.reason})`);
    return sendJson(res, 401, { error: "invalid_token", reason: result.reason }, cors);
  }
  const headers = { "Cache-Control": "no-store", ...cors };
  if (result.setCookie) headers["Set-Cookie"] = result.setCookie;
  res.writeHead(204, headers);
  res.end();
  logger.log(`[gate] token accepted (sub=${result.sub || "?"}): session cookie issued`);
}

/** Normalize dot segments the same way as the receiving Node HTTP adapters. */
function routingPath(rawUrl) {
  const parts = splitRequestUrl(rawUrl);
  try {
    return parts ? new URL(parts.path, "http://gate").pathname : "";
  } catch {
    return "";
  }
}

function internalPath(rawUrl) {
  const pathname = routingPath(rawUrl);
  return pathname === "/internal" || pathname.startsWith("/internal/");
}

function singleHeader(req, name) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
  return values.length === 1 ? values[0] : null;
}

/** One server-authenticated lifecycle route; cookies and local auth bypass never admit it. */
async function lifecycleDrain(req, res, config, getKey, getFilesControl) {
  const key = getKey(), supplied = singleHeader(req, "x-ide-proxy-key");
  if (!key || !supplied || !safeEqualStrings(supplied, key) || req.headers.cookie !== undefined || req.headers.origin !== undefined) return sendJson(res, 404, { error: "not_found" });
  if (singleHeader(req, "x-gc-project-id") !== config.projectId || !config.machineId || singleHeader(req, "x-gc-machine-id") !== config.machineId) return sendJson(res, 409, { error: "runtime_changed" });
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  const control = getFilesControl();
  if (!config.filesPort || !/^[0-9a-f]{64}$/.test(control)) return sendJson(res, 503, { error: "lifecycle_unavailable" });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) { req.resume(); return sendJson(res, 413, { error: "body_too_large" }); }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return sendJson(res, 400, { error: "invalid_request" }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !["deadline", "admissionOnly", "runtimeId"].includes(k)) || typeof body.deadline !== "string" || !Number.isFinite(Date.parse(body.deadline)) || body.admissionOnly !== true || typeof body.runtimeId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.runtimeId)) return sendJson(res, 400, { error: "invalid_request" });
  const remaining = Date.parse(body.deadline) - Date.now();
  if (remaining <= 0) return sendJson(res, 503, { error: "drain_timeout" });
  const bytes = Buffer.from(JSON.stringify(body));
  await new Promise((resolve) => {
    const done = (status, value) => { if (!res.destroyed && !res.headersSent) sendJson(res, status, value); resolve(); };
    const upstream = http.request({ host: "127.0.0.1", port: config.filesPort, path: "/internal/files/drain", method: "POST", headers: { "content-type": "application/json", "content-length": bytes.length, "x-gc-files-control": control } }, (reply) => {
      const parts = []; let total = 0;
      reply.on("data", (b) => { total += b.length; if (total > 65536) reply.destroy(new Error("lifecycle response limit")); else parts.push(b); });
      reply.on("error", () => { clearTimeout(timer); done(503, { error: "lifecycle_unavailable" }); });
      reply.on("end", () => {
        clearTimeout(timer);
        try {
          const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
          if (reply.statusCode === 200 && (value.publicationFenced !== true || value.admittingMutations !== false || value.projectId !== config.projectId || value.machineId !== config.machineId)) return done(503, { error: "invalid_lifecycle_fence" });
          done(reply.statusCode, value);
        } catch { done(503, { error: "invalid_lifecycle_fence" }); }
      });
    });
    const timer = setTimeout(() => upstream.destroy(new Error("lifecycle deadline")), Math.min(remaining, 2147483647));
    upstream.on("error", () => { clearTimeout(timer); done(503, { error: "lifecycle_unavailable" }); });
    res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.end(bytes);
  });
}

/** Match one transport-encoded ID using the file backend's bounded identifier alphabet. */
function voxelRecordPath(pathname, family) {
  const prefix = `/voxels/${family}/`;
  if (!pathname.startsWith(prefix)) return false;
  const raw = pathname.slice(prefix.length);
  if (raw.length > 384 || raw.includes("/")) return false;
  try { return /^[A-Za-z0-9_.:-]{1,128}$/.test(decodeURIComponent(raw)); }
  catch { return false; }
}

/** Proxy a streaming HTTP request to its private upstream. */
function proxyRequest(req, res, config, cspValue, cors, gateSecret, logger, bootstrapControl) {
  const pathname = routingPath(req.url);
  const voxel = pathname === "/voxels" || pathname === "/voxels/member" || /^\/voxels\/operations\/[^/]+$/.test(pathname) ||
    (req.method === "GET" && (pathname === "/voxels/named" || pathname === "/voxels/artifacts" || voxelRecordPath(pathname, "named"))) ||
    (["GET", "DELETE"].includes(req.method) && voxelRecordPath(pathname, "artifacts"));
  const useFiles = config.filesPort !== undefined && (pathname === "/files" || pathname.startsWith("/files/") || voxel);
  const component = useFiles ? "file service" : "runtime gateway";
  const options = {
    hostname: config.upstreamHost,
    port: useFiles ? config.filesPort : config.upstreamPort,
    path: req.url,
    method: req.method,
    headers: { ...forwardedHeaders(req.headers, gateSecret, req.rawHeaders), ...(bootstrapControl ? { "x-gc-files-control": bootstrapControl } : {}) },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = withFrameAncestors(proxyRes.headers, cspValue);
    for (const [name, value] of Object.entries(cors)) headers[name.toLowerCase()] = value;
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.on("error", () => res.destroy());
    proxyRes.on("aborted", () => res.destroy());
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    if (proxyReq.abortedByClient) return; // we cut it: the browser left
    logger.error(`[gate] Error proxying to ${component}:`, err.message);
    if (!res.headersSent) {
      sendJson(res, 502, { error: "bad_gateway", message: `${component} not ready`, agent: "access-gate", tool: "proxy", action: `Check the ${component} process and retry.` }, { "Content-Security-Policy": cspValue, ...cors });
    } else res.destroy();
  });

  // The browser went away before the response finished (a closed EventSource, an aborted upload or
  // download): cut the upstream request too. Left open, the gateway kept a watch client per closed
  // tab and an aborted upload's body never ended.
  res.on("close", () => {
    if (res.writableFinished || proxyReq.destroyed) return;
    proxyReq.abortedByClient = true;
    proxyReq.destroy();
  });

  req.pipe(proxyReq, { end: true });
}

/** Proxy a WebSocket upgrade to the gateway. */
function proxyUpgrade(req, socket, head, config, gateSecret, logger, fence, epochCheckMs = workspaceRelay.WORKSPACE_WS_EPOCH_CHECK_MS) {
  const options = {
    hostname: config.upstreamHost,
    port: config.upstreamPort,
    path: req.url,
    method: req.method,
    headers: forwardedHeaders(req.headers, gateSecret, req.rawHeaders),
  };

  const proxyReq = http.request(options);
  socket.once("close", () => proxyReq.destroy());

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    let rawHeaders = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      rawHeaders += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
    }
    rawHeaders += "\r\n";

    socket.write(rawHeaders);
    if (proxyHead && proxyHead.length > 0) socket.write(proxyHead);
    if (head && head.length > 0) proxySocket.write(head);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    socket.on("close", () => proxySocket.destroy());
    proxySocket.on("close", () => socket.destroy());
    if (fence) {
      const abort = new AbortController();
      let checking = false;
      const timer = setInterval(async () => {
        if (checking || socket.destroyed || proxySocket.destroyed) return;
        checking = true;
        try { await workspaceRelay.checkWorkspaceFence({ filesPort: config.filesPort, gateSecret, signal: abort.signal }, fence); }
        catch (error) {
          if (!abort.signal.aborted) logger.log(`[gate] WebSocket epoch fence closed (${error.error})`);
          socket.destroy(); proxySocket.destroy();
        } finally { checking = false; }
      }, epochCheckMs);
      timer.unref();
      const cleanup = () => { clearInterval(timer); abort.abort(); };
      socket.once("close", cleanup); proxySocket.once("close", cleanup);
    }

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
  });

  proxyReq.on("response", (res) => {
    logger.error(`[gate] WebSocket got HTTP response instead of upgrade: ${res.statusCode}`);
    let rawHeaders = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n`;
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      rawHeaders += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
    }
    rawHeaders += "\r\n";
    socket.write(rawHeaders);
    res.pipe(socket);
  });

  proxyReq.on("error", (err) => {
    logger.error("[gate] WebSocket upgrade error:", err.message);
    socket.destroy();
  });

  proxyReq.end();
}

function rejectUpgrade(socket, status = 401) {
  if (socket.destroyed) return;
  const text = status === 403 ? "Forbidden" : "Unauthorized";
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
}

/**
 * Build the gate server (not listening).
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{logger?: Console, now?: () => number}} [deps] now() in seconds
 */
function createGateServer(config, deps = {}) {
  const logger = deps.logger || console;
  const nowFn = deps.now || nowSeconds;
  const getKey = createKeyLoader(config.keyFile, logger);
  const getGateSecret = createSecretLoader(config.gateFile, "gate secret", logger);
  const getFilesControl = createSecretLoader(config.filesControlFile || "/run/runtime/files-control", "files control", logger);
  const usedJtis = new Map();
  const cspValue = `frame-ancestors ${config.frameAncestors}`;

  function context() {
    return {
      key: config.authDisabled ? "" : getKey(),
      projectId: config.projectId,
      authDisabled: config.authDisabled,
      allowedOrigins: config.allowedOrigins,
      usedJtis,
      now: nowFn(),
    };
  }

  const server = http.createServer((req, res) => {
    if (!routingPath(req.url)) {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (req.url === "/files/info" && req.headers["x-ide-proxy-key"] !== undefined) {
      const supplied = singleHeader(req, "x-ide-proxy-key"), key = getKey();
      if (!key || !supplied || !safeEqualStrings(supplied, key) || req.headers.cookie !== undefined || req.headers.origin !== undefined) return sendJson(res, 404, { error: "not_found" });
      if (singleHeader(req, "x-gc-project-id") !== config.projectId || !config.machineId || singleHeader(req, "x-gc-machine-id") !== config.machineId) return sendJson(res, 409, { error: "runtime_changed" });
      if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
      const control = getFilesControl();
      if (!/^[0-9a-f]{64}$/.test(control) || !config.filesPort) return sendJson(res, 503, { error: "lifecycle_unavailable" });
      proxyRequest(req, res, config, cspValue, {}, getGateSecret(), logger, control);
      return;
    }
    if (internalPath(req.url)) {
      if (req.url === "/internal/files/drain") {
        lifecycleDrain(req, res, config, getKey, getFilesControl).catch(() => { if (!res.headersSent && !res.destroyed) sendJson(res, 503, { error: "lifecycle_unavailable" }); });
        return;
      }
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    let decision;
    try {
      decision = authorize(req, context());
    } catch (err) {
      logger.error("[gate] authorize failed:", err.message);
      decision = deny("internal-error");
    }
    const cors = corsHeaders(req.headers.origin, config.allowedOrigins);

    switch (decision.action) {
      case "preflight":
        res.writeHead(204, decision.health ? HEALTH_CORS_HEADERS : preflightHeaders(req.headers.origin, config.allowedOrigins));
        res.end();
        return;
      case "health":
        handleHealth(req, res, config, getGateSecret());
        return;
      case "bad-request":
        sendJson(res, 400, { error: "bad_request" });
        return;
      case "exchange":
        handleExchange(req, res, context, cors, logger).catch((err) => {
          logger.error("[gate] exchange failed:", err.message);
          sendJson(res, 500, { error: "internal" }, cors);
        });
        return;
      case "logout":
        res.writeHead(204, { "Set-Cookie": clearCookieHeader(), "Cache-Control": "no-store", ...cors });
        res.end();
        return;
      case "proxy":
        proxyRequest(req, res, config, cspValue, cors, getGateSecret(), logger);
        return;
      default:
        logger.log(`[gate] ${decision.status || 401} (${decision.reason}) ${req.method} ${logPath(req.url)}`);
        sendJson(
          res,
          decision.status || 401,
          { error: decision.status === 405 ? "method_not_allowed" : "unauthorized", reason: decision.reason },
          { "Content-Security-Policy": cspValue, ...cors }
        );
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => {});
    if (!routingPath(req.url)) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (internalPath(req.url)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    let decision;
    try {
      decision = authorizeUpgrade(req, context());
    } catch (err) {
      logger.error("[gate] authorizeUpgrade failed:", err.message);
      decision = deny("internal-error");
    }
    if (decision.action !== "proxy") {
      logger.log(`[gate] WebSocket ${decision.status || 401} (${decision.reason}) ${logPath(req.url)}`);
      rejectUpgrade(socket, decision.status || 401);
      return;
    }
    const abort = new AbortController();
    const gone = () => abort.abort();
    socket.once("close", gone);
    socket.pause();
    try {
      const fence = workspaceRelay.parseWorkspaceFence(req);
      const gateSecret = getGateSecret();
      await workspaceRelay.checkWorkspaceFence({ filesPort: config.filesPort, gateSecret, signal: abort.signal }, fence);
      if (!socket.destroyed) proxyUpgrade(req, socket, head, config, gateSecret, logger, fence, deps.workspaceEpochCheckMs);
    } catch (error) {
      logger.log(`[gate] WebSocket epoch fence rejected (${error.error || "workspace_fence_unavailable"})`);
      workspaceRelay.rejectWorkspaceUpgrade(socket, error instanceof workspaceRelay.WorkspaceFenceError ? error : new workspaceRelay.WorkspaceFenceError(503, "workspace_fence_unavailable", "The current workspace identity could not be verified."));
    } finally { socket.off("close", gone); }
  });

  server.on("error", (err) => {
    logger.error("[gate] Server error:", err.message);
  });

  server.gateState = { getKey, getGateSecret, usedJtis, cspValue };
  return server;
}

// =============================================================================
// Entry point
// =============================================================================

function main() {
  process.on("uncaughtException", (err) => {
    console.error("[gate] uncaughtException (non-fatal):", err.message);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[gate] unhandledRejection (non-fatal):", reason);
  });

  const config = loadConfig(process.env);
  if (config.authDisabledRequested && config.machineId) {
    console.error("[gate] RUNTIME_AUTH_DISABLED=1 ignored: FLY_MACHINE_ID is set (local Docker only)");
  }
  if (config.authDisabled) {
    console.warn("[gate] WARNING: RUNTIME_AUTH_DISABLED=1 — access gate is OFF (local dev only).");
  } else if (!config.projectId) {
    console.error("[gate] ERROR: PROJECT_ID is not set: every token and cookie will be rejected");
  }

  const server = createGateServer(config);
  if (!config.authDisabled) server.gateState.getKey(); // loud error now if the key is missing
  server.gateState.getGateSecret();

  server.listen(config.listenPort, config.listenHost, () => {
    console.log(
      `[gate] Listening on :${server.address().port}, forwarding to the runtime gateway on :${config.upstreamPort}` +
        (config.filesPort === undefined ? "" : `, files on :${config.filesPort}`) +
        (config.machineId ? ` (machine=${config.machineId})` : " (local dev)") +
        (config.authDisabled ? " [access gate OFF]" : " [access gate on]") +
        ` origins=${config.allowedOrigins.join(",")}`
    );
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  // pure helpers
  verifyToken,
  exchangeToken,
  issueCookie,
  clearCookieHeader,
  verifyCookie,
  authorize,
  authorizeUpgrade,
  markJtiUsed,
  getCookieValues,
  stripCookie,
  forwardedHeaders,
  parseAllowedOrigins,
  originAllowed,
  corsHeaders,
  preflightHeaders,
  sanitizeFrameAncestors,
  withFrameAncestors,
  loadConfig,
  createKeyLoader,
  createSecretLoader,
  // server
  createGateServer,
  // constants
  COOKIE_NAME,
  COOKIE_MAX_AGE_S,
  CLOCK_SKEW_S,
  GATE_HEADER,
  DEFAULT_KEY_FILE,
  DEFAULT_GATE_FILE,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_FRAME_ANCESTORS,
};
