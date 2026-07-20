# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" on the repo's Security tab). Do not open public
issues for security problems. We aim to acknowledge reports within a week.

## Scope and deployment model

The harness is designed for **local, single-user use**:

- code-server runs with `--auth none`; the container has no authentication
  layer. The compose file publishes port 3000 on 127.0.0.1 only. Exposing
  port 3000 to a network hands full IDE (and therefore shell) access to
  anyone who can reach it — if you must host the harness, put it behind a
  reverse proxy that enforces authentication.
- The agent executes commands and edits files inside the container as an
  unprivileged user; the workspace volume is the blast radius.
- API keys you enter are stored in code-server's SecretStorage inside the
  container volume, and mirrored (mode 600) to the agent CLI's secret store
  when specialists are dispatched. Keys are never written to logs or passed
  on command lines.
- The MCP server only accesses paths under `MCP_WORKSPACE_ROOT`.

## Supported versions

Only the latest release is supported with security fixes.
