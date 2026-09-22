/**
 * ide-proxy.js — Lightweight reverse proxy in front of code-server
 *
 * Forwards the public container port 3000 to code-server on 127.0.0.1:3001
 * and serves /healthz, which reports healthy only once code-server actually
 * responds. Preserves Host headers and WebSocket upgrades (code-server checks
 * Origin vs Host for WebSocket CSRF protection).
 *
 * Also serves a project picker on bare "/" — /workspace holds one folder per
 * project, and code-server's own `?folder=` query param (native VS Code Web
 * behavior) opens any of them as the workspace root without restarting the
 * container. The picker's form POSTs to /api/projects to create a new
 * project folder and redirect straight into it.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PROXY_PORT = 3000;
const IDE_PORT = 3001;
const IDE_HOST = "127.0.0.1";
const WORKSPACE_ROOT = "/workspace";
const NEW_PROJECT_README = "/opt/seed-new-project-readme/README.md";

// Folder names for new projects: no dotfiles, no path separators, no "..".
const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/**
 * Lists project folders directly under /workspace (dotfolders excluded).
 */
function listProjects() {
  try {
    return fs
      .readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    console.error("[proxy] Failed to list projects:", err.message);
    return [];
  }
}

/**
 * Landing page — lists project folders under /workspace, each linking to
 * code-server's native `?folder=` param (opens that folder as the workspace
 * root in the same running instance, no restart needed), plus a form to
 * create a new one.
 */
function servePicker(res, errorMessage) {
  const projects = listProjects();
  const items = projects.length
    ? projects
        .map((name) => {
          const href = `/?folder=${encodeURIComponent(`${WORKSPACE_ROOT}/${name}`)}`;
          return `<li><a href="${href}">${escapeHtml(name)}</a></li>`;
        })
        .join("\n")
    : `<li class="empty">No projects yet — create one below.</li>`;

  const errorHtml = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : "";

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Geocluster Research Harness</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #1e1e1e; color: #ddd; margin: 0; padding: 3rem 1.5rem; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.3rem; font-weight: 600; margin-bottom: 0.25rem; }
  h2 { font-size: 0.95rem; font-weight: 600; color: #ccc; margin: 2rem 0 0.75rem; }
  p.sub { color: #999; margin-top: 0; margin-bottom: 2rem; }
  p.error { color: #f28b82; background: #3a2323; padding: 0.6rem 0.9rem; border-radius: 6px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { margin-bottom: 0.5rem; }
  li.empty { color: #999; }
  a { display: block; padding: 0.75rem 1rem; background: #2d2d2d; border-radius: 6px;
      color: #4fc3f7; text-decoration: none; }
  a:hover { background: #383838; }
  code { background: #2d2d2d; padding: 0.1rem 0.35rem; border-radius: 4px; }
  form { display: flex; gap: 0.5rem; }
  input[type=text] { flex: 1; padding: 0.65rem 0.75rem; border-radius: 6px; border: 1px solid #444;
      background: #2d2d2d; color: #ddd; font-size: 0.95rem; }
  button { padding: 0.65rem 1.1rem; border-radius: 6px; border: none; background: #0e639c;
      color: #fff; font-size: 0.95rem; cursor: pointer; }
  button:hover { background: #1177bb; }
  p.hint { color: #777; font-size: 0.8rem; margin-top: 0.5rem; }
</style>
</head>
<body>
<main>
  <h1>Choose a project</h1>
  <p class="sub">Each folder under copy-your-files-here/ is a separate project.</p>
  ${errorHtml}
  <ul>
${items}
  </ul>
  <h2>New project</h2>
  <form method="POST" action="/api/projects">
    <input type="text" name="name" placeholder="project-name" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
           maxlength="64" required autofocus>
    <button type="submit">Create</button>
  </form>
  <p class="hint">Letters, digits, dots, dashes and underscores only.</p>
</main>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * Creates a new project folder under /workspace from a picker form POST,
 * then redirects into it. Rejects anything that isn't a plain, single-level
 * folder name (no path separators or "..") to stay confined to /workspace.
 */
function handleCreateProject(req, res) {
  const chunks = [];
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    chunks.push(chunk);
    if (chunks.reduce((n, c) => n + c.length, 0) > 8192) {
      tooLarge = true;
    }
  });

  req.on("end", () => {
    if (tooLarge) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    const body = Buffer.concat(chunks).toString("utf8");
    const params = new URLSearchParams(body);
    const name = (params.get("name") || "").trim();

    if (!PROJECT_NAME_RE.test(name)) {
      return servePicker(
        res,
        "Project name must start with a letter or digit, and contain only letters, digits, dots, dashes and underscores."
      );
    }

    const dir = path.join(WORKSPACE_ROOT, name);
    // Defense in depth: confirm the resolved path is still a direct child of
    // /workspace even though PROJECT_NAME_RE already forbids "/" and "..".
    if (path.dirname(dir) !== WORKSPACE_ROOT) {
      return servePicker(res, "Invalid project name.");
    }

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
        // Match ownership of /workspace itself (entrypoint.sh chowns it to
        // 'theia', aligned to PUID/PGID if set) so the new folder isn't
        // left owned by root — this proxy runs as root.
        const { uid, gid } = fs.statSync(WORKSPACE_ROOT);
        fs.chownSync(dir, uid, gid);

        const readmePath = path.join(dir, "README.md");
        if (fs.existsSync(NEW_PROJECT_README)) {
          const template = fs.readFileSync(NEW_PROJECT_README, "utf8");
          fs.writeFileSync(readmePath, template.split("{{PROJECT_NAME}}").join(name));
          fs.chownSync(readmePath, uid, gid);
        }
      }
    } catch (err) {
      console.error("[proxy] Failed to create project:", err.message);
      return servePicker(res, `Couldn't create "${name}": ${err.message}`);
    }

    res.writeHead(303, { Location: `/?folder=${encodeURIComponent(dir)}` });
    res.end();
  });
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

  // Project picker — bare "/" with no folder/workspace chosen yet.
  // Once a folder is picked (or code-server itself navigates internally),
  // the query param is present and this falls through to the normal proxy.
  if (
    req.method === "GET" &&
    parsedUrl.pathname === "/" &&
    !parsedUrl.searchParams.has("folder") &&
    !parsedUrl.searchParams.has("workspace")
  ) {
    return servePicker(res);
  }

  // Create a new project folder from the picker form.
  if (req.method === "POST" && parsedUrl.pathname === "/api/projects") {
    return handleCreateProject(req, res);
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
