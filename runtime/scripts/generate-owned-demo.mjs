// Immutable distribution bytes. Runtime supplies captures/products at first authorized open.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateWattleCreek, SEED } from "./lib/wattle-creek.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2), check = args.includes("--check");
if (args.some((arg, i) => !["--check", "--out"].includes(arg) && args[i - 1] !== "--out") || args.includes("--out") && !args[args.indexOf("--out") + 1]) throw new Error("Usage: node scripts/generate-owned-demo.mjs [--check] [--out directory]");
const destination = resolve(root, args.includes("--out") ? args[args.indexOf("--out") + 1] : "demo-bundles/wattle-creek/v1");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const sortedHashes = (members) => Object.fromEntries(Object.keys(members).sort().map((key) => [key, sha(members[key])]));
const { files, stats, point } = generateWattleCreek();
const ring = [[-2500, -1400], [-2500, 1400], [2500, 1400], [2500, -1400], [-2500, -1400]].map(([along, across]) => point(along, across));
const geographic = JSON.parse(execFileSync("uv", ["run", "--script", resolve(root, "scripts/owned-demo-outline.py")], { input: JSON.stringify(ring), encoding: "utf8" }));
const common = { sourceCrs: { code: "EPSG:7851", axisOrder: "xy" }, unit: { name: "ppm", basis: "source-declared" }, numbers: { missingTokens: ["", "NA", "N/A", "NULL"], sentinels: [] }, allowApproximate: false };
const style = { kind: "assay", scale: "linear", breaks: [0.01, 0.1, 1], colors: ["#f4e7bb", "#d1b467", "#bf713c", "#a92d32"], symbol: "circle", size: 7, unit: "ppm", belowDetectionColor: "#668b9c", missingColor: "#a6a6a6", invalidColor: "#923a96" };
const layer = (id, title, paths, type, options, layerStyle, query) => ({ id, title, paths, locationRecipe: { prepare: { type, options }, query }, style: layerStyle, visible: true, opacity: 1, ownership: "client-owned", credits: ["Synthetic Wattle Creek training data — CC0-1.0"] });
const [lon, lat] = geographic.ring.reduce(([x, y], p, i) => i === 4 ? [x, y] : [x + p[0] / 4, y + p[1] / 4], [0, 0]);
const recipe = {
  schemaVersion: 1, id: "wattle-creek-overview-v1", title: "Wattle Creek overview", destination: "maps/overview.map.json",
  camera: { crs: "EPSG:3857", center: [6378137 * lon * Math.PI / 180, 6378137 * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))], zoom: 12, rotation: 0 }, context: "off",
  layers: [
    layer("surface-au", "Surface Au (ppm)", ["assays/surface_samples.csv"], "assay", { ...common, mode: "surface", columns: { id: "sample_id", x: "mga_east", y: "mga_north", analyte: "au_ppm" } }, style, { operation: "preview" }),
    layer("collar-au", "Highest detected Au at each collar (ppm)", ["drilling/assays.csv", "drilling/collars.csv"], "assay", { ...common, mode: "collar-summary", columns: { hole: "hole_id", from: "from_m", to: "to_m", analyte: "au_ppm" }, collars: { member: "collars.csv", columns: { hole: "hole_id", x: "east", y: "north" } }, depthUnit: "m", depthWindow: { kind: "whole-hole" } }, { ...style, symbol: "diamond", size: 9 }, { operation: "preview" }),
    layer("training-outline", "Synthetic training area", ["gis/training_area.geojson"], "vector", {}, { kind: "vector", color: "#537060", width: 2, pointSize: 6 }, { operation: "preview", displayOptions: { allowApproximate: false } }),
  ], output: { layerIds: ["surface-au", "collar-au", "training-outline"], format: "png" },
};
const members = {
  "assays/surface_samples.csv": files.SURFACE_SAMPLES_CSV,
  "drilling/collars.csv": files.COLLARS_CSV,
  "drilling/assays.csv": files.ASSAYS_CSV,
  "gis/training_area.geojson": json({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Wattle Creek synthetic training area", purpose: "Invented training outline, not a legal tenement" }, geometry: { type: "Polygon", coordinates: [geographic.ring] } }] }),
  "examples/copper_by_sample_type.csv": "sample_type,count,min_cu_ppm,median_cu_ppm,max_cu_ppm\n" + stats.copper.map((row) => [row.type, row.count, row.min, row.median, row.max].join(",")).join("\n") + "\n",
  "overview.recipe.json": json(recipe),
};
members["examples/copper_summary.md"] = `# Copper by sample type\n\nThis precomputed example summarizes reported integer Cu values in \`assays/surface_samples.csv\`. It is an editable example, not an agent run.\n\n| Sample type | Count | Minimum Cu (ppm) | Median Cu (ppm) | Maximum Cu (ppm) |\n| --- | ---: | ---: | ---: | ---: |\n${stats.copper.map((r) => `| ${r.type} | ${r.count} | ${r.min} | ${r.median} | ${r.max} |`).join("\n")}\n\nGroup by the exact \`sample_type\` text. Read \`cu_ppm\` as reported integer ppm; sort numerically. For an even count, the median is the arithmetic mean of the two middle values. No substitution or rounding is applied to the median.\n\nSource SHA-256: \`${sha(members["assays/surface_samples.csv"])}\`.\nOutput table: \`examples/copper_by_sample_type.csv\`.\n`;
members["README.md"] = `# Wattle Creek\n\nExplore sample data, maps, and reports in your own project. All measurements and the training outline are synthetic. You can edit these files, add your data, and save new outputs.\n\n## 1. Inspect the data\n\nOpen \`assays/surface_samples.csv\`, \`drilling/collars.csv\`, and \`drilling/assays.csv\`. Coordinates are GDA2020 / MGA zone 51 (EPSG:7851), in metres. Au, Cu, and As are parts per million (ppm). Blank Au values are missing; \`<0.005\` and \`<0.01\` are reported below detection, not zero.\n\nThe collar elevation \`rl\` is an invented height in metres with no surveyed vertical datum. Hole depths are measured downhole in metres; holes are vertical (dip -90 degrees). WC141 has assay intervals but no recorded collar; preserve these intervals when checking the files.\n\nOpen \`maps/overview.map.json\` when sample map preparation finishes. A collar symbol shows the highest detected Au value in that hole at its collar, not the interval position or an interpolated orebody. The \`gis/training_area.geojson\` outline is invented; it is not a legal tenement. Its longitude/latitude uses the recorded GDA2020/WGS84 map-context approximation.\n\n## 2. Ask a question\n\nOpen Agent, copy a question into the composer, edit it, and choose Send. Sending uses your ordinary account and model access.\n\n### Find samples above a threshold\n\nRead \`assays/surface_samples.csv\`. Select reported numeric Au values at least 0.1 ppm and sort highest first. Keep blank and below-detection values separate. Save a CSV and a Markdown summary in this conversation's output folder. Include source hashes, counts, and the threshold. Leave the input unchanged.\n\nThe 0.1 ppm threshold is a filter for this exercise, not an economic cutoff.\n\n### Check the drilling inputs\n\nCompare \`drilling/assays.csv\` with \`drilling/collars.csv\` by \`hole_id\`. Check collar uniqueness and interval depths. Save unmatched intervals and a Markdown QA report in this conversation's output folder. Preserve reported assay values and do not invent missing collars.\n\n## 3. Save or export an output\n\nInspect the output table. In the map, choose Add layers, then Locate on that CSV. Select its ID, easting, northing, Au field, ppm unit, and EPSG:7851 reference. Compare it with the original samples layer. Save a new view or explicitly replace a view you choose.\n\nUse Create visual to download a PNG. The export excludes public context and background layers. Upload the downloaded image through the normal project upload action if you want it saved in your project. Open a Markdown report and use Print to print or save a PDF.\n\nFor an example you can inspect immediately, open \`examples/copper_by_sample_type.csv\` and \`examples/copper_summary.md\`. These are precomputed Cu summaries, not an agent conversation.\n\n## Sources and reuse\n\n\`provenance/manifest.json\` records this seed's identity, hashes, schemas, coordinate assumptions, and calculations. The generated sample assets are dedicated under CC0-1.0; see \`LICENSE.txt\`. Your edits are ordinary project work. Updates to the sample template do not update these files.\n`;
members["LICENSE.txt"] = readFileSync(resolve(root, "scripts/licenses/CC0-1.0.txt"), "utf8");
const schemas = {
  "assays/surface_samples.csv": { rows: 196, columns: ["sample_id", "sample_type", "mga_east", "mga_north", "au_ppm", "cu_ppm", "as_ppm"], id: "sample_id", coordinates: { x: "mga_east", y: "mga_north", crs: "EPSG:7851", unit: "m" }, analytes: { au_ppm: "ppm", cu_ppm: "ppm", as_ppm: "ppm" }, missingTokens: [""], belowDetection: "<0.005" },
  "drilling/collars.csv": { rows: 140, columns: ["hole_id", "east", "north", "rl", "total_depth", "azimuth", "dip"], id: "hole_id", coordinates: { x: "east", y: "north", crs: "EPSG:7851", unit: "m" }, vertical: "invented elevation; no surveyed vertical datum", geometry: "vertical holes; dip=-90 degrees; depth measured downhole in metres" },
  "drilling/assays.csv": { rows: 3152, columns: ["hole_id", "from_m", "to_m", "au_ppm", "cu_ppm"], hole: "hole_id", intervals: "from_m inclusive, to_m exclusive; metres", analytes: { au_ppm: "ppm", cu_ppm: "ppm" }, belowDetection: "<0.01", unmatchedHole: "WC141" },
};
const manifest = {
  schemaVersion: 1, template: { id: "wattle-creek", version: 1 },
  generator: { seed: SEED, upstreamCommit: "a1b5c205c82e84cdda8683f212a8888ce83de3e6", upstreamGeneratorSha256: "be61723a70f7db42acc5883d940b0e73e016eba2e34848de234a669d9d88985d", sourceSha256: sha(readFileSync(resolve(root, "scripts/lib/wattle-creek.mjs"))), bundleGeneratorSha256: sha(readFileSync(fileURLToPath(import.meta.url))), outlineGeneratorSha256: sha(readFileSync(resolve(root, "scripts/owned-demo-outline.py"))) },
  license: { id: "CC0-1.0", rightsOwner: "EigenformAI", approval: "Rights-owner representative approved CC0-1.0 for generated sample assets on 2026-10-10", scope: "generated CSV inputs, outline, example outputs, README, recipes, and provenance" },
  coordinateReferences: { horizontal: "EPSG:7851", horizontalUnit: "m", vertical: "Synthetic collar elevations have no surveyed vertical datum; depths are measured downhole in metres" },
  transformations: [geographic.transformation], calculations: { copper: "Reported integer cu_ppm grouped by exact sample_type; numeric min/max; sorted median, mean of middle pair for even count" },
  publication: { overviewRecipe: "overview.recipe.json", mapDestination: "maps/overview.map.json", createFrom: "Destination workspace captures and prepared representations only", recipeIsWorkspaceMember: false },
  memberHashes: sortedHashes(members),
  members: Object.keys(members).sort().map((name) => ({ path: name, sizeBytes: Buffer.byteLength(members[name]), sha256: sha(members[name]), ...(schemas[name] ? { schema: schemas[name] } : {}) })),
};
members["provenance/manifest.json"] = json(manifest);
const fullHashes = sortedHashes(members);
// Manifest hashes every other member. The external digest includes the manifest without self-reference.
const bundleSha256 = sha(JSON.stringify(fullHashes));
if (check) {
  const enumerate = (dir, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? enumerate(resolve(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
  const actual = enumerate(destination).sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(members).sort())) throw new Error("Unexpected or missing bundle members");
  for (const [name, bytes] of Object.entries(members)) if (!readFileSync(resolve(destination, name)).equals(Buffer.from(bytes))) throw new Error(`Generated bundle differs: ${name}`);
} else {
  for (const [name, bytes] of Object.entries(members)) { mkdirSync(dirname(resolve(destination, name)), { recursive: true }); writeFileSync(resolve(destination, name), bytes); }
}
console.log(JSON.stringify({ template: manifest.template, bundleSha256, files: Object.keys(members).length, publishedFiles: Object.keys(members).length - 1, memberHashes: fullHashes, check }, null, 2));
