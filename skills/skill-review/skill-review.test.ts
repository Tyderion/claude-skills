import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");
const skill = read("SKILL.md");
const briefs = readdirSync(import.meta.dir).filter((f) => f.endsWith("Brief.md"));
const lenses = [...(skill.match(/^- \*\*Lenses:\*\*.*$/m)?.[0] ?? "").matchAll(/`([a-z]+)`/g)].map((m) => m[1]);

describe("skill-review's lenses and briefs stay in step", () => {
  test("there are lenses", () => {
    expect(lenses.length).toBeGreaterThan(0);
  });

  // A lens without a brief would dispatch a reviewer with nothing to follow; a brief without a lens never runs.
  test("every lens has exactly one brief, and the dispatch step names it", () => {
    const named = lenses.map((l) => `${l[0].toUpperCase()}${l.slice(1)}Brief.md`);
    expect(briefs.sort()).toEqual([...named].sort());
    for (const file of named) expect(skill).toContain(`\`${file}\``);
  });

  test("every lens is in the argument hint, and says when it applies", () => {
    const hint = skill.match(/^argument-hint: .*$/m)?.[0] ?? "";
    for (const lens of lenses) {
      expect(hint).toContain(lens);
      expect(skill).toMatch(new RegExp(`^  - \`${lens}\` .*applies`, "m"));
    }
  });
});

describe("the briefs", () => {
  // Triage in SKILL.md step 3 tells a run from a non-run by these two shapes.
  test.each(briefs)("%s returns findings or NO FINDINGS, and forbids edits", (file) => {
    const brief = read(file);
    expect(brief).toMatch(/^FINDING [A-Z]<n>$/m);
    expect(brief).toContain("`NO FINDINGS`");
    expect(brief).toContain("**read-only**");
    for (const field of ["severity:", "location:", "problem:", "why:", "fix 1:"]) expect(brief).toContain(`\n${field}`);
  });

  test("each brief has its own finding prefix", () => {
    const prefixes = briefs.map((f) => read(f).match(/^FINDING ([A-Z])<n>$/m)?.[1]);
    expect(new Set(prefixes).size).toBe(briefs.length);
  });
});
