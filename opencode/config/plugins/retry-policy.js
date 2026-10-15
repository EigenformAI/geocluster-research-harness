// Model-request retries: bounded and logged. Logic in ../lib/retry-policy.js.
// A plain {id, setup} object, without @opencode/plugin: Plugin.define() is the identity in 2.0.19 and the engine
// loads such plugins (verified 2026-10-01), so the image needs no npm install for them. The engine loads every
// file in <config>/plugins/, in name order.
import { setup } from "../lib/retry-policy.js"

export default { id: "geocluster-retry-policy", setup: (ctx) => setup(ctx) }
