import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveKickoffId, isDuplicateKickoff, kickoffTaskText, readKickoff, recordKickoff } from "./kickoff-once.ts";

describe("kickoff-once (j:1507)", () => {
  test("id is content-derived and stable", () => {
    expect(deriveKickoffId("brief A")).toBe(deriveKickoffId("brief A"));
    expect(deriveKickoffId("brief A")).not.toBe(deriveKickoffId("brief B"));
  });
  test("task text extracted from object and JSON-string payloads; unknown shapes -> null", () => {
    expect(kickoffTaskText({ task: "do X", roles: ["engineer"] })).toBe("do X");
    expect(kickoffTaskText(JSON.stringify({ task: "do Y" }))).toBe("do Y");
    expect(kickoffTaskText({ text: "not a kickoff" })).toBeNull();
    expect(kickoffTaskText("plain text")).toBeNull();
  });
  test("second delivery of the same brief is a duplicate; a different brief is not; no record -> not duplicate", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-kickoff-"));
    expect(readKickoff(dir, "lane")).toBeNull();
    expect(isDuplicateKickoff("brief A", readKickoff(dir, "lane"))).toBe(false);
    recordKickoff(dir, "lane", deriveKickoffId("brief A"));
    expect(isDuplicateKickoff("brief A", readKickoff(dir, "lane"))).toBe(true);
    expect(isDuplicateKickoff("brief B", readKickoff(dir, "lane"))).toBe(false);
  });
});
