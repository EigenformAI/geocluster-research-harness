// Writes the synthetic "Wattle Creek" project shown on the public landing page.
// Every value is invented. The prospect uses GDA2020 / MGA zone 51 metres so the
// files look like ordinary exploration data. Output is deterministic for SEED.
export const SEED = 20261008;

export function generateWattleCreek() {

// mulberry32: small, seedable and identical on every JavaScript engine.
let state = SEED;
function random() {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const uniform = (low, high) => low + (high - low) * random();
const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
const lognormal = (sigma) => Math.exp(sigma * gauss());
const pick = (values) => values[Math.floor(random() * values.length)];

// Prospect centre and a strike of about 345 degrees. `along` runs up strike, `across` to the east of it.
const CENTRE = [377820, 6447190];
const strike = (345 * Math.PI) / 180;
const point = (along, across) => [
  CENTRE[0] + along * Math.sin(strike) + across * Math.cos(strike),
  CENTRE[1] + along * Math.cos(strike) - across * Math.sin(strike),
];
const shear = (along) => 40 * Math.sin(along / 700);

// Gold enriched along the shear, strongest between about -900 and 1300 m along strike.
function gold(along, across, { base, peak, width }) {
  const distance = Math.abs(across - shear(along));
  const envelope = Math.exp(-(((along - 250) / 1100) ** 2));
  return base * lognormal(0.9) + peak * envelope * Math.exp(-((distance / width) ** 2)) * lognormal(0.6);
}
const reported = (value, limit) => (value < limit ? `<${limit}` : value < 1 ? value.toFixed(3) : value.toFixed(2));
const csv = (header, rows) => [header.join(","), ...rows.map((row) => row.join(","))].join("\n") + "\n";

// Surface soil and rock-chip samples on a rotated grid with gaps.
const samples = [];
for (let along = -2200; along <= 2200; along += 200) {
  for (let across = -1100; across <= 1100; across += 220) {
    if (random() < 0.2) continue;
    const [east, north] = point(along + uniform(-40, 40), across + uniform(-40, 40));
    const au = gold(along, across, { base: 0.007, peak: 2.2, width: 220 });
    const cu = 35 + 140 * Math.exp(-(((across + 300) / 400) ** 2)) * lognormal(0.4);
    samples.push({
      id: `WCS${String(samples.length + 1).padStart(4, "0")}`,
      type: random() < 0.15 ? "Rock chip" : "Soil",
      east: east.toFixed(1), north: north.toFixed(1),
      au, auText: random() < 0.03 ? "" : reported(au, 0.005),
      cu: cu.toFixed(0), as: Math.max(2, au * 180 + 8 + 3 * gauss()).toFixed(0),
    });
  }
}

// Vertical holes on fences across the shear, 100 m apart along strike and 50 m apart across it.
const holes = [];
for (let along = -700; along <= 1200; along += 100) {
  for (let offset = -150; offset <= 150; offset += 50) {
    const across = shear(along) + offset;
    const [east, north] = point(along + uniform(-5, 5), across + uniform(-5, 5));
    holes.push({ id: `WC${String(holes.length + 1).padStart(3, "0")}`, along, across, east, north, rl: uniform(288, 300), depth: pick([80, 100, 120, 140]) });
  }
}
// Assays for one more hole whose collar was never recorded.
const orphan = { id: `WC${String(holes.length + 1).padStart(3, "0")}`, along: 1500, across: 40, depth: 60 };

const intervals = [];
for (const hole of [...holes, orphan]) {
  for (let from = 0; from < hole.depth; from += 5) {
    const to = Math.min(hole.depth, from + 5), middle = (from + to) / 2;
    // Leached near surface, a supergene blanket at 20-45 m, then a primary zone dipping east.
    const zone = middle < 20 ? 0.6 : middle <= 45 ? 1.7 : 1;
    const au = gold(hole.along, hole.across - middle * 0.6, { base: 0.003, peak: 1.4, width: 90 }) * zone;
    intervals.push([hole.id, from, to, reported(au, 0.01), (30 + uniform(0, 90)).toFixed(0)]);
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const collared = intervals.filter((row) => row[0] !== orphan.id && !String(row[3]).startsWith("<"));
const best = collared.reduce((top, row) => (Number(row[3]) > Number(top[3]) ? row : top));
const depths = holes.map((hole) => hole.depth);

const THRESHOLD = 0.1;
const numeric = samples.filter((sample) => sample.auText && !sample.auText.startsWith("<"));
const anomalies = numeric.filter((sample) => Number(sample.auText) >= THRESHOLD).sort((a, b) => Number(b.auText) - Number(a.auText));
const stats = {
  samples: samples.length,
  blankGold: samples.filter((sample) => !sample.auText).length,
  censoredGold: samples.filter((sample) => sample.auText.startsWith("<")).length,
  anomalyThreshold: THRESHOLD,
  anomalies: anomalies.length,
  highest: { id: anomalies[0].id, gold: anomalies[0].auText },
  holes: holes.length,
  intervals: intervals.length,
  censoredIntervals: intervals.filter((row) => String(row[3]).startsWith("<")).length,
  orphanHole: orphan.id,
  orphanIntervals: intervals.filter((row) => row[0] === orphan.id).length,
  drilledMetres: depths.reduce((sum, depth) => sum + depth, 0),
  shallowestHole: Math.min(...depths),
  deepestHole: Math.max(...depths),
  deepestHoles: depths.filter((depth) => depth === Math.max(...depths)).length,
  bestInterval: { hole: best[0], from: best[1], to: best[2], gold: best[3] },
  copper: ["Soil", "Rock chip"].map((type) => {
    const values = samples.filter((sample) => sample.type === type).map((sample) => Number(sample.cu));
    return { type, count: values.length, min: Math.min(...values), median: median(values), max: Math.max(...values) };
  }),
};

const files = {
  SURFACE_SAMPLES_CSV: csv(["sample_id", "sample_type", "mga_east", "mga_north", "au_ppm", "cu_ppm", "as_ppm"],
    samples.map((s) => [s.id, s.type, s.east, s.north, s.auText, s.cu, s.as])),
  COLLARS_CSV: csv(["hole_id", "east", "north", "rl", "total_depth", "azimuth", "dip"],
    holes.map((h) => [h.id, h.east.toFixed(1), h.north.toFixed(1), h.rl.toFixed(1), h.depth, 0, -90])),
  ASSAYS_CSV: csv(["hole_id", "from_m", "to_m", "au_ppm", "cu_ppm"], intervals),
  GOLD_ANOMALIES_CSV: csv(["sample_id", "sample_type", "mga_east", "mga_north", "au_ppm"],
    anomalies.map((s) => [s.id, s.type, s.east, s.north, s.auText])),
};

return { files, stats, point };
}
