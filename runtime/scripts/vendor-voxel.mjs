/** Baseline bootstrap only. Deployment uses maintained runtime JS, not this compiler. */
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const [sourceRoot, compiler] = process.argv.slice(2)
if (!sourceRoot || !compiler) throw new Error("Usage: node scripts/vendor-voxel.mjs FRONTEND_CHECKOUT TYPESCRIPT_MODULE")
const target = fileURLToPath(new URL("../lib/voxel/", import.meta.url))
// The indexed schema/reader extends these baseline modules. Re-vendoring the
// frontend snapshot would silently erase the runtime's authoritative contract.
try {
	await fs.access(path.join(target, "voxel-indexed.js"))
	throw new Error("Baseline vendoring cannot overwrite runtime-owned indexed extensions. Port numerical changes explicitly into lib/voxel instead.")
} catch (error) { if (error.code !== "ENOENT") throw error }
const ts = createRequire(import.meta.url)(path.resolve(compiler))
await fs.mkdir(target, { recursive: true })
const provenance = { compiler: ts.version, frontendCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(), computeRevision: execFileSync("git", ["rev-parse", "6daff31^"], { cwd: sourceRoot, encoding: "utf8" }).trim(), modules: {} }
for (const name of ["voxel-types", "voxel-grid", "voxel-recipe", "npy", "voxel-artifact", "voxel-compute"]) {
	const source = name === "voxel-compute" ? execFileSync("git", ["show", "6daff31^:src/lib/server/voxel-compute.ts"], { cwd: sourceRoot, encoding: "utf8" }) : await fs.readFile(path.join(sourceRoot, "src/lib", `${name}.ts`), "utf8")
	const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, removeComments: false }, fileName: `${name}.ts`, reportDiagnostics: true })
	if (result.diagnostics?.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, { getCurrentDirectory: () => target, getCanonicalFileName: (n) => n, getNewLine: () => "\n" }))
	const code = result.outputText.replace(/from "(?:\.\/|\.\.\/)(voxel-[a-z-]+|npy)"/g, 'from "./$1.js"')
	const output = `// Runtime-owned deterministic module. Reproduce with scripts/vendor-voxel.mjs.\n${code}`
	await fs.writeFile(path.join(target, `${name}.js`), output)
	provenance.modules[name] = { sourceSha256: crypto.createHash("sha256").update(source).digest("hex"), outputSha256: crypto.createHash("sha256").update(output).digest("hex") }
}
await fs.writeFile(path.join(target, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n")
console.log(`Imported ${Object.keys(provenance.modules).length} standalone numerical modules (TypeScript ${ts.version}).`)
