---
name: review-loop
description: Multi-round code review in two phases, simplicity first and correctness second. Each round starts a fresh read-only reviewer subagent. The main agent triages its findings, asks the user about each one with suggested fixes (the user can also write their own), applies the chosen fixes and starts the next round. "soft" runs 1 simplicity + 1 correctness round (the default); "strong" runs 2 + 2. By default it reviews the current branch (commits plus uncommitted changes) against main/master. USE WHEN review loop, review my changes, simplicity review, correctness review, strong review, soft review, review this branch, review before PR. NOT FOR a single one-shot review with no fixes applied.
argument-hint: "[soft|strong] [uncommitted | vs <branch> | <paths...>]"
---

# review-loop

Runs a code review in rounds. A reviewer subagent finds issues, the user decides what to do about each one, the main agent applies the decisions, and the next round reviews the result. Simplicity comes first, because simpler code is easier to check for correctness.

This skill only uses git and Claude Code's built-in tools (`Agent`, `AskUserQuestion`, `Read`, `Edit`, `Bash`). It works in any repo on any machine.

## 1. Parse the arguments

From `$ARGUMENTS`:

- **Depth:** `strong` means 2 simplicity rounds, then 2 correctness rounds. `soft` means 1 + 1. If neither is given, use `soft`.
- **Target:** the default is **branch vs base**. `uncommitted` (also "uncommitted files", "working tree") means **uncommitted only**. `vs <ref>` or `base <ref>` means **branch vs** the named ref. Anything that looks like file or directory paths means **paths**.

## 2. Resolve the target once and freeze it

Run each git command in its own `Bash` call, and paste each result into the next command as a literal value. Do not use `$(...)` substitution. It is shell-specific, and some harnesses flag it.

**Branch vs base** (the default):

1. If the user named a ref, use it. Otherwise pick the first of these that resolves: `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, then `git rev-parse --verify --quiet` on each of `origin/main`, `origin/master`, `main`, `master`. `origin/HEAD` is often unset, especially in bare-repo or worktree clones, so the fallbacks matter. If nothing resolves, ask the user which branch to use.
2. `git merge-base HEAD <base>` gives the **fork-point SHA**. Freeze it for the whole run. Later rounds diff against the same SHA, even if fixes get committed along the way.
3. The review scope is `git diff <sha>` (branch commits plus uncommitted changes, compared with the working tree), plus the untracked files listed by `git ls-files --others --exclude-standard`.
4. If the fork point equals `HEAD`, you are on the base branch. Tell the user that only uncommitted changes are in scope.

**Uncommitted only:** freeze the SHA from `git rev-parse HEAD`. The scope is `git diff <sha>` plus the untracked files.

**Paths:** the named files are reviewed in full, as they currently are. No diff is involved.

**Not a git repo:** only the paths target works. Ask for paths if none were given.

**Empty scope:** say so and stop.

Before round 1, tell the user the plan in one line: depth, target, base ref and short SHA, number of files in scope.

## 3. Run the rounds

Rounds run in this order: simplicity × N, then correctness × N.

### 3a. Dispatch the reviewer

For each round, start one fresh `Agent` (general-purpose). Build its prompt from:

- the brief for the current phase, read from this skill's folder: `SimplicityBrief.md` or `CorrectnessBrief.md`
- the frozen target: the exact diff command with the literal SHA, the untracked-files command, or the list of paths, plus the repo root
- the **declined list**: findings the user skipped in earlier rounds of this run, one line each, so they are not raised again
- a line saying this is round k of N for this phase

The reviewer is read-only. It must never edit, write, commit or stage anything, and the prompt says so.

### 3b. Triage before asking

Do not forward the reviewer's findings as they come in. For each one, read the cited code yourself and drop it if:

- the claim is wrong
- it duplicates another finding
- it is already on the declined list
- it is out of scope (outside the target, or the wrong phase)

A finding that survives is one you would defend. Sort the survivors by severity.

If none survive, tell the user in one line and skip the rest of this phase. Another round would only find the same nothing.

### 3c. Ask the user

Use `AskUserQuestion`, one question per finding. The limits: at most 4 questions per call, and 2–4 options per question.

- **question:** `[severity] file:line — the problem in one sentence`
- **header:** a short tag of up to 12 characters, e.g. `S1 regex`, `C3 race`
- **options:** the reviewer's 1–3 fixes, rewritten by you if they are unclear. The one you'd recommend goes first, with `(Recommended)` at the end of its label. Always add a last option `Skip` with the description "Leave as is; won't be raised again this run". When a fix is a concrete code change, put a short before/after snippet in `preview`.
- The user can always pick "Other" and write their own fix. Treat that text as the instruction for that finding.

With more than 4 findings, ask in consecutive calls of up to 4, most severe first.

### 3d. Apply the decisions

- Apply every chosen fix. Where a custom answer is ambiguous, pick the reading that fits the finding and mention that you did.
- Add skipped findings to the declined list.
- Do not commit, stage or push. The user owns git history.
- Then run the project's own checks, if it has any: tests, typecheck, lint. Discover them from the project (package manifests, Makefile, justfile, task runner configs, CI workflow) and use what it already defines. If a fix breaks a check, fix it or undo that fix before the next round, and tell the user which.
- If nothing was applied this round (everything skipped), end the phase early.

## 4. Final report

Once the last round is done, give one short summary:

- rounds run per phase, and any that ended early and why
- the fixes applied, one line each, with file
- the findings skipped
- the check results: which commands ran, pass or fail
- anything the reviewer raised that you dropped in triage as out of scope but may still matter

No diffs in the report. The user can inspect the working tree themselves.
