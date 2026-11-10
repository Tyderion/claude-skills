---
name: review-loop
description: Runs a multi-round code review, simplicity then correctness, at soft (default) or strong depth. Asks about each finding, applies the chosen fixes, then commits them. USE WHEN review loop, review my changes, review this branch, review before PR, simplicity review, correctness review, soft review, weak review, short review, quick review, strong review, hard review, long review, detailed review. NOT FOR a review explicitly asked to be one-shot, or applying fixes without asking (use auto-review).
argument-hint: "[soft|strong] [uncommitted | vs <branch> | <paths...>]"
---

# review-loop

## 1. Parse the arguments

Arguments: `$ARGUMENTS` (none means every default below).

- **Depth:** `strong` (also `hard`, `long`, `detailed`) means 2 simplicity rounds, then 2 correctness rounds. `soft` (also `weak`, `short`, `quick`) means 1 + 1. If neither is given, use `soft`. A bare depth word is always the depth, even if a file has that name; write `./quick` to target the file.
- **Target:** the default is **branch vs base**. `uncommitted` (also "uncommitted files", "working tree") means **uncommitted only**. `vs <ref>` or `base <ref>` means **branch vs** the named ref. Paths on their own mean **paths**: the named files, and every file under a named directory, reviewed in full. Paths after `uncommitted` or `vs` restrict that diff to them (`git diff <sha> -- <paths>`).

## 2. Resolve the target once and freeze it

Run each git command in its own `Bash` call and paste its result into the next as a literal; no `$(...)` substitution, which some harnesses flag.

**Branch vs base** (the default):

1. If the user named a ref, use it. Otherwise pick the first of these that resolves: `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, then `git rev-parse --verify --quiet` on each of `origin/main`, `origin/master`, `main`, `master`. If nothing resolves, ask the user which branch to use.
2. `git merge-base HEAD <base>` gives the **fork-point SHA**. Freeze it for the whole run.
3. The review scope is `git diff <sha>`, plus the untracked files listed by `git ls-files --others --exclude-standard`.
4. If the fork point equals `HEAD`, tell the user only uncommitted changes are in scope.

**Uncommitted only:** freeze the SHA from `git rev-parse HEAD`. The scope is `git diff <sha>` plus the untracked files.

**Not a git repo:** only the paths target works. Ask for paths if none were given.

**Empty scope:** say so and stop.

Before round 1, tell the user the plan in one line: depth, target, base ref and short SHA, number of files in scope. Run the project's own checks (tests, typecheck, lint) once now, so you know what already fails. In a git repo, also note the files `git status --porcelain` lists: they hold the user's own uncommitted work, which step 4 leaves out.

## 3. Run the rounds

### 3a. Dispatch the reviewer

For each round, start one fresh `Agent` (general-purpose). Build its prompt from:

- the brief for the current phase, read from this skill's folder: `SimplicityBrief.md` or `CorrectnessBrief.md`
- the frozen target: the exact diff command with the literal SHA, the untracked-files command, or the list of paths, plus the repo root
- the **declined list**: findings the user skipped in earlier rounds of this run, as `file:line — problem` so the fresh reviewer can match them, with a line telling it not to raise them again
- a line saying this is round k of N for this phase

### 3b. Triage before asking

Read the cited code yourself before forwarding any finding, and drop it if:

- the claim is wrong
- it duplicates another finding
- it is already on the declined list
- it is out of scope (a problem the target neither contains nor causes, or the wrong phase)

A finding that survives is one you would defend. Sort the survivors by severity.

If none survive, tell the user in one line and skip the rest of this phase.

### 3c. Ask the user

Use `AskUserQuestion`, one question per finding, in calls of at most 4 questions (most severe first) with 2–4 options each.

- **question:** `[severity] file:line — the problem in one sentence`
- **header:** a short tag of up to 12 characters, e.g. `S1 regex`, `C3 race`
- **options:** the reviewer's 1–3 fixes, rewritten by you if they are unclear. The one you'd recommend goes first, with `(Recommended)` at the end of its label. Always add a last option `Skip` with the description "Leave as is; won't be raised again this run". When a fix is a concrete code change, put a short before/after snippet in `preview`.
- A free-text "Other" answer is the instruction for that finding.

### 3d. Apply the decisions

- Add skipped findings to the declined list. If nothing else is left (everything skipped), end the phase early.
- Apply every chosen fix. Where a custom answer is ambiguous, pick the reading that fits the finding and mention that you did.
- Do not commit, stage or push here; step 4 commits once, at the end.
- Then run the project's own checks (tests, typecheck, lint), using what it already defines. If a check that passed before round 1 now fails, fix it or undo that fix before the next round, and tell the user which.

## 4. Commit the fixes

Once the last round is done, commit the fixes in one commit. Skip this step if no fix was applied or the target isn't in a git repo. Never push.

Stage only the files your fixes changed, by path, leaving out every file noted as dirty before round 1. Run `git add -- <paths>`, then `git commit --only -m "<message>" -- <paths>` so anything else already staged stays out, with a message in the style `git log` shows. If a commit hook fails, report it; don't bypass it with `--no-verify`.

## 5. Final report

Give one short summary:

- rounds run per phase, and any that ended early and why
- the fixes applied, one line each, with file
- the commit's short SHA, and any fixed files left uncommitted because they held the user's own changes
- the findings skipped
- the check results: which commands ran, pass or fail
- anything the reviewer raised that you dropped in triage as out of scope but may still matter

No diffs in the report.
