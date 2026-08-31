#!/usr/bin/env bun
import { startServer } from "./src/mcp-server.ts";

startServer().catch((e) => {
  console.error("[wire-grok] fatal:", e);
  process.exit(1);
});
