#!/usr/bin/env bun
import { $ } from "bun"
import { mkdir, mkdtemp } from "node:fs/promises"
import path from "node:path"
import manifest from "./source-build.json"

export async function verifySha256(file: string, expected: string) {
  const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${file}: expected ${expected}, got ${actual}`)
  return actual
}

if (import.meta.main) {
  if (Bun.version !== manifest.bunVersion) throw new Error(`Requires Bun ${manifest.bunVersion}; got ${Bun.version}`)
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Requires linux-x64 builder")
  const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
  const work = path.resolve(argument("workdir") ?? await mkdtemp("/tmp/opencode-engine-"))
  const output = path.resolve(argument("output") ?? path.join(work, "output"))
  const source = path.join(work, "source")
  // An explicit fresh build directory avoids overwriting a checkout or silently reusing patched source.
  await mkdir(source, { recursive: false }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    await mkdir(work, { recursive: true })
    await mkdir(source)
  })
  const archive = path.join(work, "source.tar.gz")
  await $`curl --fail --location --retry 2 ${manifest.sourceArchive.url} --output ${archive}`
  await verifySha256(archive, manifest.sourceArchive.sha256)
  await $`tar -xzf ${archive} --strip-components=1 -C ${source}`
  await verifySha256(path.join(source, "bun.lock"), manifest.lockfileSha256)
  for (const entry of manifest.patches) {
    const patch = path.join(import.meta.dir, entry.file)
    await verifySha256(patch, entry.sha256)
    await $`git apply --check ${patch}`.cwd(source)
    await $`git apply ${patch}`.cwd(source)
  }
  await $`bun install --frozen-lockfile`.cwd(source).env({ ...process.env, HUSKY: "0" })
  await verifySha256(path.join(source, "bun.lock"), manifest.lockfileSha256)
  const cli = path.join(source, "packages/cli")
  await $`bun test ${manifest.tests}`.cwd(cli)
  await $`bun typecheck`.cwd(cli)
  // Explicit file paths also work in source archives where there is no Git index for discovery.
  await $`bunx --no-install oxlint ${[
    path.join(cli, "src/acp/event.ts"),
    path.join(cli, "test/acp/event-behavior.test.ts"),
    path.join(cli, "test/acp/event-observation-background.test.ts"),
    path.join(cli, "test/acp/sse-fixture.ts"),
    path.join(cli, "src/acp/service.ts"),
    path.join(cli, "test/acp/service-reconciliation.test.ts"),
  ]}`.cwd(source)
  await $`bun run script/build.ts ${manifest.buildArguments}`.cwd(cli).env({
    ...process.env,
    OPENCODE_VERSION: manifest.version,
    OPENCODE_CHANNEL: manifest.channel,
    BUN_COMPILE_RELEASE: "",
  })
  const binary = path.join(cli, "dist/cli-linux-x64/bin/opencode")
  await mkdir(output, { recursive: true })
  await $`install -m 0755 ${binary} ${path.join(output, "opencode")}`
  await $`install -m 0644 ${path.join(source, "LICENSE")} ${path.join(output, "LICENSE")}`
  const check = await mkdtemp(path.join(work, "version-check-"))
  const version = (await $`${path.join(output, "opencode")} --version`.env({
    PATH: process.env.PATH ?? "",
    HOME: check,
    TMPDIR: check,
    XDG_DATA_HOME: path.join(check, "data"),
    XDG_CONFIG_HOME: path.join(check, "config"),
    XDG_STATE_HOME: path.join(check, "state"),
    XDG_CACHE_HOME: path.join(check, "cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  }).text()).trim().replace(/^opencode v/, "")
  if (version !== manifest.version) throw new Error(`Unexpected binary version: ${version}`)
  const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex")
  const identity = { ...manifest, buildScriptSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(import.meta.filename).arrayBuffer()).digest("hex"), binarySha256: sha256 }
  await Bun.write(path.join(output, "build-identity.json"), JSON.stringify(identity, null, 2) + "\n")
  console.log(JSON.stringify({ binary: path.join(output, "opencode"), version, sha256 }, null, 2))
}
