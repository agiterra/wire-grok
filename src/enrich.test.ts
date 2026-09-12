import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { enrichInjectedPrompt, findKnowledgePlugin } from "./enrich.js";
import { formatChannelEvent } from "./gate.js";

const savedRules = process.env.KNOWLEDGE_ENRICH_RULES;
const savedDirs = process.env.GROK_PLUGIN_DIRS;

afterEach(() => {
  if (savedRules === undefined) delete process.env.KNOWLEDGE_ENRICH_RULES;
  else process.env.KNOWLEDGE_ENRICH_RULES = savedRules;
  if (savedDirs === undefined) delete process.env.GROK_PLUGIN_DIRS;
  else process.env.GROK_PLUGIN_DIRS = savedDirs;
});

describe("findKnowledgePlugin", () => {
  test("returns null when GROK_PLUGIN_DIRS is empty", () => {
    expect(findKnowledgePlugin("")).toBeNull();
  });

  test("KNOWLEDGE_PLUGIN_ROOT wins even when GROK_PLUGIN_DIRS is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "kx-plugin-root-"));
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "channel-enrichment.ts"), "");
    const prev = process.env.KNOWLEDGE_PLUGIN_ROOT;
    process.env.KNOWLEDGE_PLUGIN_ROOT = root;
    try {
      expect(findKnowledgePlugin("")).toBe(root);
    } finally {
      if (prev === undefined) delete process.env.KNOWLEDGE_PLUGIN_ROOT;
      else process.env.KNOWLEDGE_PLUGIN_ROOT = prev;
    }
  });

  test("picks the dir that actually has channel-enrichment.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "wire-grok-enrich-"));
    const indexer = join(root, "knowledge-indexer", "1.0.0");
    const knowledge = join(root, "knowledge", "0.7.13");
    mkdirSync(join(indexer, "hooks"), { recursive: true });
    mkdirSync(join(knowledge, "hooks"), { recursive: true });
    writeFileSync(join(knowledge, "hooks", "channel-enrichment.ts"), "");
    expect(findKnowledgePlugin(`${indexer}:${knowledge}`)).toBe(knowledge);
  });
});

describe("formatChannelEvent", () => {
  test("emits user= as well as from= so the knowledge hook matches", () => {
    const xml = formatChannelEvent({
      text: "hello",
      topic: "webhook.slack",
      source: "mivid-studios",
      seq: 1,
    });
    expect(xml).toContain('topic="webhook.slack"');
    expect(xml).toContain('from="mivid-studios"');
    expect(xml).toContain('user="mivid-studios"');
  });
});

describe("enrichInjectedPrompt", () => {
  test("no-op when KNOWLEDGE_ENRICH_RULES is unset", async () => {
    delete process.env.KNOWLEDGE_ENRICH_RULES;
    const text = "A Wire channel event arrived";
    expect(await enrichInjectedPrompt(text, { cwd: process.cwd(), log() {} })).toBe(text);
  });

  test("prepends hook stdout when rules are set", async () => {
    const root = mkdtempSync(join(tmpdir(), "wire-grok-hooks-"));
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, "hooks", "channel-enrichment.ts"),
      `console.log("[Channel Enrichment]");`,
    );
    process.env.KNOWLEDGE_ENRICH_RULES = '{"webhook.slack":{}}';
    process.env.GROK_PLUGIN_DIRS = root;
    const out = await enrichInjectedPrompt("prompt body", {
      cwd: root,
      log() {},
    });
    expect(out.startsWith("[Channel Enrichment]")).toBe(true);
    expect(out.endsWith("prompt body")).toBe(true);
  });
});
