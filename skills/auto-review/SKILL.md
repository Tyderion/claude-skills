---
name: auto-review
description: Runs review-loop unattended, with the same arguments, applying its own recommended fix for each finding instead of asking. USE WHEN auto review, review and fix without asking, unattended review. NOT FOR letting the user decide each finding (use review-loop), or a review explicitly asked to be one-shot.
argument-hint: "[soft|strong] [uncommitted | vs <branch> | <paths...>]"
---

# auto-review

Runs review-loop without stopping to ask; the main agent's recommendation stands in for the user's decision.

## 1. Load review-loop

Load the `review-loop` skill with the `Skill` tool and pass the arguments through unchanged: `$ARGUMENTS`. If there are none, pass the depth and target words from the user's request. Some installs prefix it as `_review-loop`; use the name your skill list shows.

If it isn't available, stop and say so.

## 2. Follow it, with these changes

Everything in review-loop applies, except the points below. Its text will still tell you to ask; these points win:

- **step 2 (Resolve the target once and freeze it):** say in the plan line that this is an auto run. Its questions about a base ref or missing paths stay.
- **step 3b (Triage before asking):** unchanged. Drop only for the four reasons it lists. A surviving finding you wouldn't apply unsupervised is not dropped; it goes to "needs you" under 3c.
- **step 3c (Ask the user):** never stop to ask, with `AskUserQuestion` or otherwise. Take the fix you would have marked `(Recommended)` as the user's answer, and record each decision for the report. When a finding has no fix you'd recommend, because it turns on a product decision or intent the code doesn't settle, or its recommended fix is one you wouldn't apply without the user seeing it, treat it as `Skip` and list it under "needs you".
- **step 3d (Apply the decisions):** unchanged, including that nothing gets committed or staged before step 4 (Commit the fixes), and nothing gets pushed at all.
- **step 5 (Final report):** for each applied fix, also name the alternative you passed over, if there was one, so a decision is easy to reverse. Add a "needs you" list when anything landed there.
