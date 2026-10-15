import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { generateWattleCreek } from "./lib/wattle-creek.mjs";

const generator = fileURLToPath(new URL("./generate-owned-demo.mjs", import.meta.url));
const rows = (text) => text.trimEnd().split("\n").slice(1).map((line) => line.split(","));

test("owned sources preserve independently calculated sample outcomes", () => {
  const first = generateWattleCreek();
  const samples = rows(first.files.SURFACE_SAMPLES_CSV);
  assert.equal(samples.length, 196);
  assert.equal(samples.filter((row) => row[4] === "").length, 9);
  assert.equal(samples.filter((row) => row[4] === "<0.005").length, 27);
  const selected = samples.filter((row) => /^\d+(\.\d+)?$/.test(row[4]) && Number(row[4]) >= 0.1).sort((a, b) => Number(b[4]) - Number(a[4]));
  assert.equal(selected.length, 35);
  assert.deepEqual([selected[0][0], selected[0][4]], ["WCS0114", "2.79"]);
  const collars = rows(first.files.COLLARS_CSV), assays = rows(first.files.ASSAYS_CSV);
  assert.equal(collars.length, 140); assert.equal(assays.length, 3152);
  const ids = new Set(collars.map((row) => row[0]));
  const unmatched = assays.filter((row) => !ids.has(row[0]));
  assert.equal(unmatched.length, 12); assert.ok(unmatched.every((row) => row[0] === "WC141"));
});

test("distributed bytes are reproducible, verified, and contain only portable map recipes", () => {
  const result = JSON.parse(execFileSync(process.execPath, [generator, "--check"], { stdio: "pipe", encoding: "utf8" }));
  assert.equal(result.bundleSha256, "101d5b89bddff69f98c66be050cd152767d85bb09384f3e0c6427330fe61ee52");
  const base = new URL("../demo-bundles/wattle-creek/v1/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("provenance/manifest.json", base)));
  assert.equal(manifest.license.id, "CC0-1.0");
  const recipe = JSON.parse(readFileSync(new URL("overview.recipe.json", base)));
  const text = JSON.stringify(recipe);
  assert.ok(!/captureId|workspaceId|workspaceEpoch|representationId/.test(text));
  const summary = readFileSync(new URL("examples/copper_by_sample_type.csv", base), "utf8");
  assert.match(summary, /Soil,169,35,51,302/);
  assert.match(summary, /Rock chip,27,35,58,226/);
  const outline = JSON.parse(readFileSync(new URL("gis/training_area.geojson", base)));
  const ring = outline.features[0].geometry.coordinates[0];
  assert.deepEqual(ring[0], ring.at(-1));
  assert.ok(ring.every(([lon, lat]) => lon > 120 && lon < 124 && lat > -34 && lat < -30));
});

test("bundle check rejects changed bytes and an unexpected member", () => {
  const temporary = mkdtempSync(join(tmpdir(), "owned-demo-seed-"));
  try {
    cpSync(new URL("../demo-bundles/wattle-creek/v1/", import.meta.url), temporary, { recursive: true });
    writeFileSync(join(temporary, "README.md"), "Replaced member\n");
    assert.throws(() => execFileSync(process.execPath, [generator, "--check", "--out", temporary], { stdio: "pipe" }), /Generated bundle differs: README\.md/);
    cpSync(new URL("../demo-bundles/wattle-creek/v1/README.md", import.meta.url), join(temporary, "README.md"));
    writeFileSync(join(temporary, "extra.csv"), "x\n1\n");
    assert.throws(() => execFileSync(process.execPath, [generator, "--check", "--out", temporary], { stdio: "pipe" }), /Unexpected or missing bundle members/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
