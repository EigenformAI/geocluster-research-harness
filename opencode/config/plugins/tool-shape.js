// Per-agent tool lists beyond the permission rules (L3-3). Logic in ../lib/tool-shape.js.
// A plain {id, setup} object, without @opencode/plugin: Plugin.define() is the identity in 2.0.19 and the engine
// loads such plugins (verified 2026-10-01), so the image needs no npm install for them. The engine loads every
// file in <config>/plugins/, in name order.
import { setup } from "../lib/tool-shape.js"

export default { id: "geocluster-tool-shape", setup: (ctx) => setup(ctx) }
