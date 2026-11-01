---
name: auto-review
description: Unattended review-loop. Same rounds and same depth words, but the main agent decides every finding itself and applies the fix it would have recommended, without asking. "soft" (also weak, short, quick) runs 1 simplicity + 1 correctness round (the default); "strong" (also hard, long, detailed) runs 2 + 2. By default it reviews the current branch (commits plus uncommitted changes) against main/master. USE WHEN auto review, auto-review, autoreview, review and fix without asking, unattended review, auto-accept review findings, strong auto review, quick auto review. NOT FOR deciding each finding yourself (use review-loop) or a one-shot review with no fixes applied.
argument-hint: "[soft|strong] [uncommitted | vs <branch> | <paths...>]"
---

# auto-review

Runs review-loop without stopping to ask. The main agent's recommendation stands in for the user's decision, so the run ends with a reviewed working tree and a report of what was decided on the user's behalf.

## 1. Load review-loop

Load the `review-loop` skill with the `Skill` tool and pass `$ARGUMENTS` through unchanged. Some installs prefix it as `_review-loop`; use the name your skill list shows. It parses the depth (`strong`, `hard`, `long`, `detailed` for 2 + 2 rounds; `soft`, `weak`, `short`, `quick` for 1 + 1, the default) and the target.

If it isn't available, stop and say so. This skill holds no review procedure of its own.

## 2. Follow it, with these changes

Everything in review-loop applies, except:

- **step 2 (Resolve the target once and freeze it):** say in the plan line that this is an auto run. Its questions about a base ref or missing paths stay, since there is nothing to review without an answer.
- **step 3b (Triage before asking):** unchanged, and it now carries more weight. No one reads the findings after you, so drop anything you wouldn't apply unsupervised.
- **step 3c (Ask the user):** do not call `AskUserQuestion`. Take the fix you would have marked `(Recommended)` as the user's answer, and record each decision for the report. When a finding has no fix you'd recommend, because it turns on a product decision or intent the code doesn't settle, treat it as `Skip` and list it under "needs you". Never stop the run to ask.
- **step 3d (Apply the decisions):** unchanged, including that nothing gets committed, staged or pushed.
- **step 4 (Final report):** for each applied fix, also name the alternative you passed over, if there was one, so a decision is easy to reverse. Add a "needs you" list when anything landed there.
