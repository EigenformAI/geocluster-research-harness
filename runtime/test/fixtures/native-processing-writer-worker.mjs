import { acquireNativeProcessingLease } from "../../lib/native-processing-receipts.js"

const lease = await acquireNativeProcessingLease({ clientDir: process.argv[2] })
const helper = lease.spawnEffect(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000)"])
helper.once("spawn", () => process.send({ helper: helper.pid }))
process.on("message", () => {})
