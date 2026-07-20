/**
 * ide-proxy.js — Lightweight reverse proxy in front of code-server
 *
 * Forwards the public container port 3000 to code-server on 127.0.0.1:3001
 * and serves /healthz, which reports healthy only once code-server actually
 * responds. Preserves Host headers and WebSocket upgrades (code-server checks
 * Origin vs Host for WebSocket CSRF protection).
 */

const http = require("http");
const { URL } = require("url");

const PROXY_PORT = 3000;
const IDE_PORT = 3001;
const IDE_HOST = "127.0.0.1";

// Prevent proxy from crashing the container on unexpected errors.
process.on("uncaughtException", (err) => {
  console.error("[proxy] uncaughtException (non-fatal):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[proxy] unhandledRejection (non-fatal):", reason);
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Health check — probes code-server on localhost before reporting healthy.
 * Returns 200 only if code-server responds, 503 otherwise.
 */
function handleHealthCheck(res) {
  let responded = false;

  function respond(statusCode, body) {
    if (responded || res.headersSent) return;
    responded = true;
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    });
    res.end(JSON.stringify(body));
  }

  const probe = http.request(
    { hostname: IDE_HOST, port: IDE_PORT, path: "/", method: "HEAD", timeout: 10000 },
    () => {
      respond(200, {
        status: "healthy",
        timestamp: new Date().toISOString(),
      });
    }
  );

  probe.on("error", () => {
    respond(503, {
      status: "unhealthy",
      reason: "IDE not ready",
      timestamp: new Date().toISOString(),
    });
  });

  probe.on("timeout", () => {
    probe.destroy();
    // destroy fires 'error' which calls respond() — the guard prevents double-write
  });

  probe.end();
}

/**
 * Proxy an HTTP request to code-server.
 */
function proxyRequest(req, res) {
  const options = {
    hostname: IDE_HOST,
    port: IDE_PORT,
    path: req.url,
    method: req.method,
    // Preserve original Host header — code-server checks Origin vs Host
    // for WebSocket CSRF protection. Rewriting breaks the check (403).
    headers: { ...req.headers },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("[proxy] Error proxying to code-server:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway — IDE not ready");
    }
  });

  req.pipe(proxyReq, { end: true });
}

/**
 * Proxy a WebSocket upgrade to code-server.
 */
function proxyUpgrade(req, socket, head) {
  const options = {
    hostname: IDE_HOST,
    port: IDE_PORT,
    path: req.url,
    method: req.method,
    // Preserve original Host header — see proxyRequest comment.
    headers: { ...req.headers },
  };

  const proxyReq = http.request(options);

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    console.log(`[proxy] WebSocket upstream upgrade: ${proxyRes.statusCode}`);
    let rawHeaders = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      rawHeaders += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
    }
    rawHeaders += "\r\n";

    socket.write(rawHeaders);
    if (proxyHead && proxyHead.length > 0) {
      socket.write(proxyHead);
    }

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
  });

  proxyReq.on("response", (res) => {
    console.error(`[proxy] WebSocket got HTTP response instead of upgrade: ${res.statusCode}`);
    let rawHeaders = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n`;
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      rawHeaders += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
    }
    rawHeaders += "\r\n";
    socket.write(rawHeaders);
    res.pipe(socket);
  });

  proxyReq.on("error", (err) => {
    console.error("[proxy] WebSocket upgrade error:", err.message);
    socket.destroy();
  });

  proxyReq.end();
}

// =============================================================================
// Server
// =============================================================================

const server = http.createServer((req, res) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  // CORS preflight for health check
  if (req.method === "OPTIONS" && (parsedUrl.pathname === "/healthz" || parsedUrl.pathname === "/health")) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check — handle directly
  if (parsedUrl.pathname === "/healthz" || parsedUrl.pathname === "/health") {
    return handleHealthCheck(res);
  }

  // Proxy everything else to code-server
  proxyRequest(req, res);
});

// Handle WebSocket upgrades (code-server remote connection, socket.io)
server.on("upgrade", (req, socket, head) => {
  console.log(`[proxy] WebSocket upgrade: ${req.url}`);
  proxyUpgrade(req, socket, head);
});

server.on("error", (err) => {
  console.error("[proxy] Server error:", err.message);
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`[proxy] Listening on :${PROXY_PORT}, proxying to code-server on :${IDE_PORT}`);
});
