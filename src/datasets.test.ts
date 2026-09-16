import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGroundingPrompt } from "./grounding.js";
import { buildJudgePrompt, FAITHFULNESS } from "./rubric.js";
import type { Case } from "./types.js";
import { validateDataset } from "./validation.js";

interface AnnotatedCase extends Case {
  sourceId: string;
  scenarioId: string;
  split: string;
  categories: string[];
  note: string;
}
interface Source {
  sourceId: string; scenarioId: string; split: string; title: string; content: string;
  kind: string; provenance: string; license: string;
}
const read = (file: string) => readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8");
const development = JSON.parse(read("development.json")) as AnnotatedCase[];
const heldout = JSON.parse(read("heldout.json")) as AnnotatedCase[];
const catalog = JSON.parse(read("sources.json")) as { version: string; sources: Source[] };
const all = [...development, ...heldout];

describe("calibration dataset integrity", () => {
  it("retains the original smoke suite byte for byte", () => {
    expect(validateDataset(JSON.parse(read("cases.json")))).toHaveLength(18);
    expect(createHash("sha256").update(read("cases.json")).digest("hex"))
      .toBe("e7bc8e0f90683e0e557ef0029d73820095cda00608602c87c65415114fd82564");
  });

  it("has valid, globally unique cases and a complete synthetic source catalog", () => {
    expect(validateDataset(all)).toHaveLength(48);
    expect(catalog.version).toBe("calibration-v1");
    expect(catalog.sources).toHaveLength(12);
    expect(new Set(catalog.sources.map((s) => s.sourceId)).size).toBe(12);
    for (const source of catalog.sources) {
      for (const field of [source.sourceId, source.scenarioId, source.title, source.content, source.provenance]) {
        expect(typeof field).toBe("string");
        expect(field.trim().length).toBeGreaterThan(0);
      }
      expect(source.kind).toBe("synthetic");
      expect(source.license).toBe("MIT");
      expect(all.filter((c) => c.sourceId === source.sourceId)).toHaveLength(4);
    }
  });

  it.each([{ split: "development", cases: development }, { split: "heldout", cases: heldout }])
    ("keeps annotations and source context consistent in $split", ({ split, cases }) => {
      expect(cases).toHaveLength(24);
      expect(cases.filter((c) => c.label === "faithful")).toHaveLength(12);
      expect(cases.filter((c) => c.label === "unfaithful")).toHaveLength(12);
      for (const c of cases) {
        expect(c.split).toBe(split);
        expect(c.note.trim().length).toBeGreaterThan(20);
        expect(Array.isArray(c.categories) && c.categories.length > 0).toBe(true);
        expect(c.categories.every((tag) => typeof tag === "string" && /^[a-z]+(?:-[a-z]+)*$/.test(tag))).toBe(true);
        const source = catalog.sources.find((s) => s.sourceId === c.sourceId);
        expect(source).toBeDefined();
        expect(c.context).toBe(source?.content);
        expect(c.scenarioId).toBe(source?.scenarioId);
        expect(source?.split).toBe(split);
      }
    });

  it("keeps related sources, scenarios, and duplicate contexts on one side of the split", () => {
    for (const field of ["sourceId", "scenarioId", "context"] as const) {
      const developmentValues = new Set(development.map((c) => c[field]));
      expect(heldout.filter((c) => developmentValues.has(c[field]))).toEqual([]);
    }
    const smokeContexts = new Set(validateDataset(JSON.parse(read("cases.json"))).map((c) => c.context));
    expect(all.some((c) => smokeContexts.has(c.context))).toBe(false);
  });

  it.each([{ split: "development", cases: development }, { split: "heldout", cases: heldout }])
    ("covers difficult input families in $split", ({ cases }) => {
      const categories = new Set(cases.flatMap((c) => c.categories));
      for (const tag of ["supported-omission", "correct-refusal", "ambiguity", "conflicting-sources", "numerical-transformation", "misattribution", "long-answer", "prompt-injection", "unperformed-action"]) {
        expect(categories.has(tag), tag).toBe(true);
      }
      for (const tag of ["long-answer", "prompt-injection", "numerical-transformation"]) {
        expect(new Set(cases.filter((c) => c.categories.includes(tag)).map((c) => c.label))).toEqual(new Set(["faithful", "unfaithful"]));
      }
      for (const c of cases.filter((c) => c.categories.includes("long-answer"))) {
        expect(c.answer.trim().split(/\s+/).length).toBeGreaterThan(250);
      }
    });

  it("does not expose annotations or split membership to either grader", () => {
    for (const c of all) {
      const rubricData = JSON.parse(buildJudgePrompt(FAITHFULNESS, c).data);
      const groundingData = JSON.parse(buildGroundingPrompt(c.answer, c.context).data);
      expect(rubricData).toEqual({ context: c.context, question: c.question, answer: c.answer });
      expect(groundingData).toEqual({ context: c.context, answer: c.answer });
    }
  });
});
