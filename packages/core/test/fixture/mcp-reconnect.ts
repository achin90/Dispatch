import { appendFileSync } from "node:fs"
import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

// Records each start so a test can kill this process and observe the replacement.
const log = process.env.MCP_RECONNECT_LOG
if (log) appendFileSync(log, `${process.pid}\n`)

const server = new Server({ name: "reconnect", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler("tools/list", () =>
  Promise.resolve({ tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] }),
)
server.setRequestHandler("tools/call", () => Promise.resolve({ content: [{ type: "text", text: "ok" }] }))

await server.connect(new StdioServerTransport())
