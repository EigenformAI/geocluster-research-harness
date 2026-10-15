# Source-pinned OpenCode engine

Build the production engine from the pinned recipe in `source-build.json`.
Preserve its artifact identity and upstream license when deploying it.

## Build the production artifact

From the repository root, export the engine-only Docker target:

```sh
docker build --platform linux/amd64 \
	--target opencode-engine-artifact \
	--output type=local,dest=/tmp/opencode-engine .
```

The output contains `opencode`, the upstream `LICENSE`, and `build-identity.json`.
The full runtime Dockerfile copies those same outputs into the production image.
The engine-only target does not require the preprocessing build context.

Clean builds use pinned inputs but do not produce byte-identical Bun bytecode.
Retain `build-identity.json` alongside each binary. Use the runtime's
`build.engineDigest` and engine version to identify the deployed artifact.

`package.json` and `package-lock.json` retain the official unmodified `2.0.19`
binary as the negative regression baseline. They do not install the production
engine. Automatic engine updates remain disabled.

## Qualify an artifact

Run the real engine through the gateway with the local scripted provider:

```sh
OPENCODE_BIN=/tmp/opencode-engine/opencode npm --prefix runtime run test:engine
OPENCODE_BIN=/tmp/opencode-engine/opencode npm --prefix opencode run smoke
npm --prefix opencode run test:invariants
npm --prefix opencode run check
```

Install runtime dependencies before running these commands. Engine tests require
Linux and an explicit executable `OPENCODE_BIN`; skipped tests do not qualify an
artifact. The scripted provider makes no paid model calls.

Record the runtime git SHA, gateway digest, engine version/digest, configuration
digest, and actual child frames when qualifying a deployed runtime. Local tests
with a scripted provider do not qualify a paid provider or deployed service.
Browser acceptance must separately establish visibility before completion.

Create a fresh test sandbox after changing configuration. A sandbox's copied
configuration is not refreshed in place. Preserve the old sandbox only when
intentionally testing restart against the same retained state.
