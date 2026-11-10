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

  // A new question step in review-loop would otherwise stop an unattended run.
  test("every step that asks the user is overridden", () => {
    const overridden = new Set(cited.map((m) => m[1]));
    let step: string | undefined;
    for (const line of loop.split("\n")) {
      step = line.match(/^#+ (\d[a-z]?)\. /)?.[1] ?? step;
      if (step && line.includes("AskUserQuestion")) expect(overridden).toContain(step);
    }
  });
});

describe("review-loop's description", () => {
  // "quick review" only reaches the loop because the description lists it as a trigger.
  test("lists every depth word step 1 accepts", () => {
    const depth = loop.match(/^- \*\*Depth:\*\*.*$/m)?.[0] ?? "";
    const words = new Set([...depth.matchAll(/`([a-z]+)`/g)].map((m) => m[1]));
    const description = loop.match(/^description: .*$/m)?.[0] ?? "";
    expect(words.size).toBeGreaterThan(0);
    for (const word of words) expect(description).toContain(`${word} review`);
  });
});
