// X-7 run folders. The logic is in ../lib/run-dir.js, tested without the engine (test/plugins.test.mjs).
// A plain {id, setup} object, without @opencode/plugin: Plugin.define() is the identity in 2.0.19 and the engine
// loads such plugins (verified 2026-10-01), so the image needs no npm install for them. The engine loads every
// file in <config>/plugins/, in name order.
import { setup } from "../lib/run-dir.js"

export default { id: "geocluster-run-dir", setup: (ctx) => setup(ctx) }
