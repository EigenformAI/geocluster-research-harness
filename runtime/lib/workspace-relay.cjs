/** Shared narrowing identity preconditions for files, WebSocket admission and ACP dispatch. */
const http = require("node:http");

const WORKSPACE_INFO_TIMEOUT_MS = 2000;
const WORKSPACE_WS_EPOCH_CHECK_MS = 5000;
const MAX_INFO_BYTES = 64 * 1024;

class WorkspaceFenceError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
  toJSON() {
    return { filesContractVersion: 1, error: this.error, message: this.message, agent: "workspace-relay", tool: "workspace-fence", action: "Reconnect to the current workspace; inspect the private file service if it is unavailable.", state: "rejected" };
  }
}

function parseWorkspaceFence(req) {
  const fields = ["x-gc-workspace-id", "x-gc-workspace-epoch"].map((name) => {
    const values = [];
    for (let i = 0; i < (req.rawHeaders?.length || 0); i += 2) if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
    return req.rawHeaders ? values : req.headers[name] === undefined ? [] : [req.headers[name]];
  });
  if (fields.every((values) => values.length === 0)) return null;
  if (fields.some((values) => values.length !== 1 || typeof values[0] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(values[0]))) throw new WorkspaceFenceError(400, "invalid_workspace_fence", "Supply X-GC-Workspace-ID and X-GC-Workspace-Epoch exactly once each, using 1–128 ASCII letters, digits, underscores or hyphens.");
  return Object.freeze({ workspaceId: fields[0][0], workspaceEpoch: fields[1][0] });
}

const unavailable = () => new WorkspaceFenceError(503, "workspace_fence_unavailable", "The current workspace identity could not be verified.");
const changed = () => new WorkspaceFenceError(409, "workspace_changed", "The requested workspace identity or epoch does not match this file service.");

/** Never cache a successful check across messages. The private file boundary owns the match. */
function checkWorkspaceFence({ filesPort, gateSecret, signal }, expected) {
  if (!expected) return Promise.resolve();
  if (!filesPort || !gateSecret) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const req = http.request({ hostname: "127.0.0.1", port: filesPort, path: "/files/info", method: "GET", signal, headers: { "x-gc-gate": gateSecret, "x-gc-workspace-id": expected.workspaceId, "x-gc-workspace-epoch": expected.workspaceEpoch } }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_INFO_BYTES) { finish(unavailable()); req.destroy(); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on("error", () => finish(unavailable()));
      res.on("aborted", () => finish(unavailable()));
      res.on("end", () => {
        if (res.statusCode === 409) return finish(changed());
        if (res.statusCode !== 200) return finish(unavailable());
        let info;
        try { info = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); } catch { return finish(unavailable()); }
        if (info?.filesContractVersion !== 1 || info?.relayEpochFencingVersion !== 1) return finish(unavailable());
        if (info.workspaceId !== expected.workspaceId || info.workspaceEpoch !== expected.workspaceEpoch) return finish(changed());
        finish();
      });
    });
    const timer = setTimeout(() => { finish(unavailable()); req.destroy(); }, WORKSPACE_INFO_TIMEOUT_MS);
    req.on("error", () => finish(unavailable()));
    req.end();
  });
}

function rejectWorkspaceUpgrade(socket, error) {
  if (socket.destroyed) return;
  const payload = JSON.stringify(error.toJSON());
  socket.end(`HTTP/1.1 ${error.status} ${http.STATUS_CODES[error.status]}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
}

module.exports = { parseWorkspaceFence, checkWorkspaceFence, rejectWorkspaceUpgrade, WorkspaceFenceError, WORKSPACE_INFO_TIMEOUT_MS, WORKSPACE_WS_EPOCH_CHECK_MS };
