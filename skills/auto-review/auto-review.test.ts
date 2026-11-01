import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const wrapper = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
const loop = readFileSync(join(import.meta.dir, "../review-loop/SKILL.md"), "utf8");

describe("auto-review stays in step with review-loop", () => {
  const cited = [...wrapper.matchAll(/step (\d[a-z]?) \(([^)]+)\)/g)];

  test("cites the steps it overrides", () => {
    expect(cited.length).toBeGreaterThan(0);
  });

  // A renumbered or renamed step would otherwise leave the override pointing at nothing, silently.
  test.each(cited.map((m) => [m[1], m[2]]))("step %s is still called %s", (number, title) => {
    expect(loop).toMatch(new RegExp(`^#+ ${number}\\. ${title}$`, "m"));
  });

  test.each([
    ["auto-review", wrapper],
    ["review-loop", loop],
  ])("%s lists the depth synonyms", (_, skill) => {
    expect(skill).toContain('"soft" (also weak, short, quick)');
    expect(skill).toContain('"strong" (also hard, long, detailed)');
  });
});
