// Specialist results, the orchestrator's dispatch ledger, and foreground-only subagent calls (L3-4, X-5, L2-4).
// Logic in ../lib/result-protocol.js.
// A plain {id, setup} object, without @opencode/plugin: Plugin.define() is the identity in 2.0.19 and the engine
// loads such plugins (verified 2026-10-01), so the image needs no npm install for them. The engine loads every
// file in <config>/plugins/, in name order.
import { setup } from "../lib/result-protocol.js"

export default { id: "geocluster-result-protocol", setup: (ctx) => setup(ctx) }
