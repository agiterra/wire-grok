import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootKickoffAlreadyDelivered, deriveKickoffId, isDuplicateKickoff, kickoffTaskText, markSuppressed, readKickoff, recordKickoff } from "./kickoff-once.ts";

describe("kickoff-once (j:1507)", () => {
  test("id is content-derived and stable", () => {
    expect(deriveKickoffId("brief A")).toBe(deriveKickoffId("brief A"));
    expect(deriveKickoffId("brief A")).not.toBe(deriveKickoffId("brief B"));
  });
  test("task text extracted from object and JSON-string payloads; unknown shapes -> null", () => {
    expect(kickoffTaskText({ task: "do X", roles: ["engineer"] })).toBe("do X");
    expect(kickoffTaskText(JSON.stringify({ task: "do Y" }))).toBe("do Y");
    // the gateway's webhook envelope (what a lane actually receives) — the 0.1.1 miss
    expect(kickoffTaskText({ source: "brioche", topic: "webhook.bridge.kickoff", dest: "lane", plugin: "bridge", headers: {}, payload: { task: "do Z", roles: ["engineer"], applied_capabilities: [] } })).toBe("do Z");
    expect(kickoffTaskText({ payload: JSON.stringify({ payload: { task: "deep" } }) })).toBe("deep");
    expect(kickoffTaskText({ payload: { payload: { payload: { payload: { task: "too deep" } } } } })).toBeNull();
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
  test("suppression leaves a durable mark in the record; count accumulates; no record -> no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-kickoff-"));
    markSuppressed(dir, "lane", 7); // no record yet
    expect(readKickoff(dir, "lane")).toBeNull();
    recordKickoff(dir, "lane", deriveKickoffId("brief A"));
    markSuppressed(dir, "lane", 612465);
    markSuppressed(dir, "lane", undefined);
    const rec = readKickoff(dir, "lane");
    expect(rec?.kickoffId).toBe(deriveKickoffId("brief A"));
    expect(rec?.lastSuppressed?.count).toBe(2);
    expect(isDuplicateKickoff("brief A", rec)).toBe(true); // still dedupes after the mark
  });
});

describe("bootKickoffAlreadyDelivered (AGI-180)", () => {
  const brief = "You are eng300-1-api. Your brief is /tmp/baguette-briefs/eng300-1-api/BRIEF.md";
  test("Wire copy recorded during this boot -> boot does NOT push INITIAL_PROMPT again", () => {
    const d = mkdtempSync(join(tmpdir(), "wg-boot-"));
    const since = Date.now() - 1000;
    recordKickoff(d, "a", deriveKickoffId(brief));          // the Wire path, during conn.start()
    expect(bootKickoffAlreadyDelivered(brief, readKickoff(d, "a"), since)).toBe(true);
  });
  test("no record -> push (the normal boot)", () => {
    const d = mkdtempSync(join(tmpdir(), "wg-boot-"));
    expect(bootKickoffAlreadyDelivered(brief, readKickoff(d, "a"), 0)).toBe(false);
  });
  test("record from an EARLIER boot -> push (fresh-thread re-delivery unchanged)", () => {
    const d = mkdtempSync(join(tmpdir(), "wg-boot-"));
    recordKickoff(d, "a", deriveKickoffId(brief));
    expect(bootKickoffAlreadyDelivered(brief, readKickoff(d, "a"), Date.now() + 60_000)).toBe(false);
  });
  test("different brief recorded -> push", () => {
    const d = mkdtempSync(join(tmpdir(), "wg-boot-"));
    recordKickoff(d, "a", deriveKickoffId("other task"));
    expect(bootKickoffAlreadyDelivered(brief, readKickoff(d, "a"), 0)).toBe(false);
  });
});
