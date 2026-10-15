import { loadFilesConfig, createFilesServer } from "../files-server.js"
const config = loadFilesConfig({ WORKSPACE_DIR: process.env.TEST_WORKSPACE, FILES_STATE_DIR: process.env.TEST_STATE, FILES_AGENT_UIDS: "999", FILES_WORKER_UIDS: "997", FILES_WORKER_UID: "997" })
config.controlSecret = process.env.TEST_SECRET
const logger = { info() {}, warn() {}, error(...args) { console.error(...args) }, child() { return this } }
const app = await createFilesServer({ config, secret: process.env.TEST_SECRET, logger })
await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve))
process.send({ port: app.server.address().port })
