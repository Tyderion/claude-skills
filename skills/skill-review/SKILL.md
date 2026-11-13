---
name: skill-review
description: Reviews the text of a skill, or of any instruction file or doc page (CLAUDE.md, README, wiki page), with one fresh reviewer per lens on the most capable model. The lenses are triggering, clarity, and whether the text matches the tool. Applies the suggestions it is sure of and asks about the rest. USE WHEN skill review, review the skill, review the skill description, review the USE WHEN, review the triggers, review the CLAUDE.md, review the README, top-model or max-model review of a skill or doc, review or analyze a doc page for clarity or redundancy, simplicity or redundancy review of a skill or doc, improve the wording of a skill, clarity review, does the skill match the tool. NOT FOR reviewing code, including a skill's own scripts and tests or a simplicity review of code (use review-loop), or writing a new skill.
argument-hint: "[triggering|clarity|tool ...] [<skill name> | <paths...>]"
---

# skill-review

## 1. Parse the arguments

Arguments: `$ARGUMENTS`. If that is empty, take lenses and target from the user's request.

- **Target:** a skill name means that skill's folder: its `SKILL.md`, frontmatter included, and every other text file the skill tells Claude to read. Paths mean those files, whatever they are: a `CLAUDE.md`, a README, a wiki page. With no target, take the skills the current repo's uncommitted changes touch; if there are none, ask.
- **Review the source, never an installed copy.** If the skill's folder holds a `.skill-install` file, its `source=` line names the folder to review and edit instead. If that folder is missing, say so and stop.
- **Lenses:** `triggering`, `clarity` and `tool`. If any are named, run only those. With none named, run every lens that applies:
  - `triggering` applies to a skill only: it needs a frontmatter `description`.
  - `clarity` always applies.
  - `tool` applies when the text describes code the reviewer can read: the scripts in the skill's folder, or, for a named file, the repo or tool the user says it documents.

Tell the user the plan in one line: the target, the lenses, and the model the reviewers will run on. If the request asked for the review by a model's name, add that `top model` or `max model` asks for the same thing and keeps working when the models are renamed.

## 2. Dispatch the reviewers

Start one fresh `Agent` (general-purpose) per lens, all in the same message so they run in parallel. Set each one's `model` to the most capable alias the `Agent` tool offers, even when the session itself runs on a smaller one. Never omit `model`: an omitted one inherits the session's.

Build each prompt from:

- the path of the brief for its lens in this skill's folder (`TriggeringBrief.md`, `ClarityBrief.md` or `ToolBrief.md`), with a line telling the reviewer to read it first and follow it
- the paths of the target files
- for `triggering`: the paths of the other skills' `SKILL.md` files in the same parent folder, for their frontmatter, so the reviewer can see which skills compete for the same requests
- for `tool`: the paths of the code the text describes
- the **declined list**: findings the user answered with `Skip` earlier in this session for the same target, as `file:line — problem`, with a line telling the reviewer not to raise them again

## 3. Triage

If a reply is neither `NO FINDINGS` nor findings in the brief's shape, that lens has not run. Dispatch it once more; if that fails too, report the lens as not reviewed, never as clean.

Read the cited text yourself before acting on any finding, and drop it if the claim is wrong, it is on the declined list, or it belongs to another lens. Two lenses often flag the same sentence: merge those into one finding and keep both reasons.

## 4. Decide

Apply a finding without asking when one fix is clearly the best and it changes how the text reads but not what Claude will do.

Ask about every other finding with `AskUserQuestion`, one question per finding, your recommendation first and `Skip` last. Always ask when:

- the fix removes a trigger phrase, or a rule whose reason you can't see. It may be there because something went wrong once.
- the fix changes when the skill loads.
- two lenses want opposite things for the same text.
- the text and the code disagree and you can't tell which one is right.

Add skipped findings to the declined list.

## 5. Apply

Edit the text only. Never change the code: when the text is wrong about the code, fix the text; when the code looks wrong, report it.

Then run the project's own checks if it has any, since tests can assert on a skill's wording. If a check fails because of your edit, repair the text or reverse the edit, and say which. Report failures your edit did not cause without fixing them.

Do not commit, stage or push.

## 6. Report

One short summary:

- each lens: the model its reviewer ran on, or why it did not run. Say so if the harness gave it a smaller model than asked for.
- the changes applied, one line each with the file, and the alternative you passed over if there was one
- the findings the user decided, and the ones skipped
- the check results
- problems in the code that the `tool` lens turned up

No diffs in the report.
