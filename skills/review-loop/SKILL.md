---
name: review-loop
description: Runs a multi-round code review, simplicity then correctness, at soft (default) or strong depth. Asks about each finding, applies the chosen fixes, then commits them. USE WHEN review loop, review my changes, review this branch, review before PR, simplicity review, correctness review, soft review, weak review, short review, quick review, strong review, hard review, long review, detailed review. NOT FOR a review explicitly asked to be one-shot, or applying fixes without asking (use auto-review).
argument-hint: "[soft|strong] [uncommitted | vs <branch> | <paths...>]"
---

# review-loop

## 1. Parse the arguments

Arguments: `$ARGUMENTS` (none means every default below).

- **Depth:** `strong` (also `hard`, `long`, `detailed`) means 2 simplicity rounds, then 2 correctness rounds. `soft` (also `weak`, `short`, `quick`) means 1 + 1. If neither is given, use `soft`. A bare depth word is always the depth, even if a file has that name; write `./quick` to target the file.
- **Target:** the default is **branch vs base**. `uncommitted` (also "uncommitted files", "working tree") means **uncommitted only**. `vs <ref>` or `base <ref>` means **branch vs** the named ref. Paths on their own mean **paths**: the named files, and every file under a named directory, reviewed in full. Paths after `uncommitted` or `vs` restrict that scope to them: `-- <paths>` on both the diff and the untracked listing.

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

Before round 1, tell the user the plan in one line: depth, target, base ref and short SHA, number of files in scope. Run the project's own checks (tests, typecheck, lint) once now and record which failures each one reports. In a git repo, also note the files `git status --porcelain --untracked-files=all` lists: they hold the user's own uncommitted work, which step 4 leaves out.

## 3. Run the rounds

A round that applies no fix (nothing survived triage, or the user skipped everything) ends its phase; tell the user in one line.

### 3a. Dispatch the reviewer

For each round, start one fresh `Agent` (general-purpose). Build its prompt from:

- the brief for the current phase, read from this skill's folder: `SimplicityBrief.md` or `CorrectnessBrief.md`
- the repo root and the frozen target: for a git target, both the exact diff command with the literal SHA and the untracked-files command, each ending in `-- <paths>` if the user restricted it; for a paths target, the list of paths
- the **declined list**: findings the user skipped in earlier rounds of this run, as `file:line — problem` so the fresh reviewer can match them, with a line telling it not to raise them again
- a line saying this is round k of N for this phase

### 3b. Triage before asking

If the reviewer's reply is neither `NO FINDINGS` nor findings in the brief's shape, the round has not run. Dispatch it once more; if that fails too, tell the user and report the phase as not reviewed, never as clean.

Read the cited code yourself before forwarding any finding, and drop it if:

- the claim is wrong
- it duplicates another finding
- it is already on the declined list
- it is out of scope (a problem the target neither contains nor causes, or the wrong phase)

### 3c. Ask the user

Use `AskUserQuestion`, one question per finding, most severe first.

- **question:** `[severity] file:line — the problem in one sentence`
- **header:** the finding id and a keyword, e.g. `S1 regex`, `C3 race`
- **options:** the reviewer's 1–3 fixes, rewritten by you if they are unclear. Mark your recommendation `(Recommended)`. Always add a last option `Skip` with the description "Leave as is; won't be raised again this run". When a fix is a concrete code change, put a short before/after snippet in `preview`.

### 3d. Apply the decisions

- Add skipped findings to the declined list.
- Apply every chosen fix. A free-text answer is the instruction for that finding; where it is ambiguous, pick the reading that fits the finding and mention that you did.
- Do not commit or stage yet; step 4 does that once.
- Then re-run the checks. If one reports a failure that wasn't in the record from before round 1, repair the code or revert the fix that caused it before the next round, and tell the user which fix and what you did. Revert by reversing your own edits. Never use `git restore`, `git checkout --`, `git stash` or `git reset`: nothing is committed yet, so they also discard the user's uncommitted work and every earlier fix in that file.

## 4. Commit the fixes

After the last round, make one commit of the fixes. Never push.

Leave out every file noted as dirty before round 1, and leave out a fix whole if it touched any of them: none of its files go in, so the commit never holds half a fix. Commit the rest with `git add -- <paths>`, then `git commit --only -m "<message>" -- <paths>`, so anything else already staged stays out. If no paths remain, or the target isn't in a git repo, skip the commit and say so. If a commit hook fails, leave the fixes uncommitted and report it; don't bypass it with `--no-verify`.

## 5. Final report

Give one short summary:

- rounds run per phase, any that ended early, and any phase not reviewed, each with why
- the fixes applied, one line each, with file
- the commit's short SHA, and any fixes left uncommitted because they touched the user's own changes
- the findings skipped
- the check results: which commands ran, pass or fail
- anything you dropped in triage as outside the target or the wrong phase that may still matter

No diffs in the report.
