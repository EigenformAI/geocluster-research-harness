# Building from source

Most users never need this — use the prebuilt image
(`ghcr.io/eigenformai/geocluster-research-harness`) or the release VSIX.
CI (`.github/workflows/`) is the source of truth for these steps.

## Full image

```bash
git clone --recurse-submodules https://github.com/EigenformAI/geocluster-research-harness.git
cd geocluster-research-harness
docker compose up --build       # first build takes a while (npm ci + webview build)
```

The multi-stage Dockerfile builds everything from source: the agent VSIX, the
specialist CLI bundle, and the helper extensions in a builder stage; the
runtime stage assembles them onto code-server. Nothing prebuilt is committed
to the repo.

If the build fails at `COPY mcp-server/`, the submodule is missing:
`git submodule update --init`.

## Agent extension only (VSIX)

Requires Node 20.

```bash
cd agent
npm ci && (cd webview-ui && npm ci) && (cd cli && npm ci)
npm run protos                       # generates src/generated/ (not committed)
NODE_OPTIONS=--max-old-space-size=4096 npm run package
npx vsce package --allow-package-secrets sendgrid --no-dependencies --out geology-agent.vsix
```

Gotchas:

- The esbuild/type-check pass needs the enlarged `NODE_OPTIONS` old-space or
  it can OOM.
- `npm run protos` must run before `package` on a fresh clone — the generated
  gRPC bindings are gitignored.
- `--allow-package-secrets sendgrid` suppresses a false-positive in vsce's
  secret scanner.

## Specialist CLI

The CLI **must be built from the same source tree as the VSIX** — the
dispatch protocol between extension and CLI is version-coupled.

```bash
cd agent
npm run cli:build:production         # → cli/dist/cli.mjs
```

Runtime layout (what the Dockerfile and the release tarball assemble):

```
cline-cli/
├── dist/            # bundled cli.mjs + tree-sitter wasm files
├── package.json
└── node_modules/    # npm install --production inside the layout
```

The binary keeps the name `cline` (the dispatch handler invokes `cline` on
PATH).

## Tests

```bash
cd agent
npm run test:unit          # unit suite (includes the design-invariants tests)
npm run test:invariants    # just the specialist-system invariants
```

Before changing anything in the specialist system, read
[DESIGN_INVARIANTS.md](DESIGN_INVARIANTS.md) — the invariants tests enforce it.

## Helper extensions

```bash
cd extensions/geology-formats && npm ci && npm run package
cd extensions/csv-viewer     && npm ci && npm run package
```
