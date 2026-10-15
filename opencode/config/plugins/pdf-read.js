// Plain OpenCode 2.0.19 {id, setup} plugin; the engine loads each config/plugins file automatically.
import { setup } from "../lib/pdf-read.js"

export default { id: "geocluster-pdf-read", setup: (ctx) => setup(ctx) }
