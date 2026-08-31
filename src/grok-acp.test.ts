import { describe, expect, test } from "bun:test";
import { buildGrokAgentStdioArgs } from "./grok-acp.js";

describe("buildGrokAgentStdioArgs", () => {
  test("puts flags on grok agent BEFORE the stdio subcommand", () => {
    expect(buildGrokAgentStdioArgs({
      model: "grok-4.6",
      effort: "high",
      alwaysApprove: true,
    })).toEqual([
      "agent",
      "--always-approve",
      "--no-leader",
      "-m", "grok-4.6",
      "--reasoning-effort", "high",
      "stdio",
    ]);
  });

  test("omits model/effort when unset, still always-approve + no-leader + stdio", () => {
    expect(buildGrokAgentStdioArgs({})).toEqual([
      "agent",
      "--always-approve",
      "--no-leader",
      "stdio",
    ]);
  });

  test("GROK_ACP_ALWAYS_APPROVE=0 equivalent: alwaysApprove false", () => {
    expect(buildGrokAgentStdioArgs({ alwaysApprove: false, model: "grok-4.6" })).toEqual([
      "agent",
      "--no-leader",
      "-m", "grok-4.6",
      "stdio",
    ]);
  });

  test("plugin-dir flags precede stdio and are repeatable", () => {
    expect(buildGrokAgentStdioArgs({
      model: "grok-4.6",
      pluginDirs: [
        "/Users/fondant/.claude/plugins/cache/agiterra/knowledge/0.7.13",
        "/Users/fondant/.claude/plugins/cache/agiterra/knowledge-indexer/1.2.0",
      ],
    })).toEqual([
      "agent",
      "--always-approve",
      "--no-leader",
      "-m", "grok-4.6",
      "--plugin-dir", "/Users/fondant/.claude/plugins/cache/agiterra/knowledge/0.7.13",
      "--plugin-dir", "/Users/fondant/.claude/plugins/cache/agiterra/knowledge-indexer/1.2.0",
      "stdio",
    ]);
  });

  test("noLeader false omits --no-leader", () => {
    expect(buildGrokAgentStdioArgs({ alwaysApprove: true, noLeader: false })).toEqual([
      "agent",
      "--always-approve",
      "stdio",
    ]);
  });
});
