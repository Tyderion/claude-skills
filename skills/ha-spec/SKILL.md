---
name: ha-spec
description: Write a behavioral spec for a Home Assistant change, from one automation to a stateful system (queues, modes, schedulers), for a separate Claude Code session on the Home Assistant box to implement. Use when the user designs or plans Home Assistant functionality from a machine that is NOT the Home Assistant instance: "write a HA spec", "spec out an automation", "design a Home Assistant dashboard/automation/script/feature". NOT FOR writing YAML, templates or config the user will paste in themselves, or Home Assistant how-to questions.
---

# Home Assistant Spec Authoring

## Customization

Load `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/{{SKILL_NAME}}/PREFERENCES.md` if present. It names where specs go on this machine and how that location is reached, which answers *Where to write the file*.

## What you are doing

You are **designing, not implementing.** You produce one Markdown spec file. A different Claude Code session — running on the Home Assistant machine itself, with live access to entity states, service schemas, traces, and history — reads that file and builds the thing.

You have no access to that instance. Act like it.

## The hard rule: behavioral only

**Never write a concrete Home Assistant identifier.** You cannot see this user's system, so anything specific you produce is a guess, and guesses become bugs the implementer has to unpick.

Do **not** put any of these in a spec:

- Entity IDs (`light.office_ceiling`, `climate.<long numeric id>_climate`)
- Service / action names and their data fields (`light.turn_on` with `brightness_pct`)
- Jinja templates or template sensor definitions
- YAML of any kind — automation, script, or config
- Dashboard card JSON, card `type` names, or custom-card names
- Area slugs, device IDs, zone names, segment/room IDs

Real systems are full of names nobody could guess: an air conditioner whose entity ID is a long string of digits; a light group called "Apartment" that covers only two rooms; a vacuum room labelled "Hallway" whose helper is named after an abbreviation; a seasonal switch that is `unavailable` most of the year. A spec that guessed at any of these would be wrong every time.

**Instead, name things the way the user says them,** and add enough detail to disambiguate:

> "the ceiling light in the office" · "the robot vacuum" · "the flag that tracks whether someone is asleep" · "the outdoor temperature sensor" · "the living-room blinds (there are three)"

The implementer resolves those to real entities with its discovery tools.

If the user volunteers an exact entity ID, record it in **Naming hints** (below) marked as user-supplied and unverified — never inline it into the behavior as fact.

## Second rule: don't prescribe the mechanism either

You don't know which integrations, custom components or helper types are installed, so state **requirements** (persists across restart, ordered, no duplicates, readable on a dashboard), never storage. Write "an ordered list that survives a restart", not "an `input_text` helper holding the list".

## Pick the right shape: single change vs system

Before writing, decide which you have:

**Single change** — one automation, one script, one dashboard view. One trigger, one outcome. Use the *Single change* template.

**System** — state that outlives a single run, two or more automations, or two user actions touching the same state. Tells: "queue", "mode", "remember", "next", "in order", "until", "resume". Use the *System* template.

When in doubt, use the System template — its extra sections collapse to nothing if unused, whereas cramming a system into the single-change template silently loses the invariants, which is where the bugs live.

## Interview before writing

Do not write the spec from a one-line request. Ask the questions whose answers change the implementation. Batch 2–4 at a time (use `AskUserQuestion` if available), and stop asking once the answers stop changing anything.

Cover, as relevant:

- **Trigger** — what starts this? A button press, a state change, a time, a person arriving, a manual tap on a dashboard?
- **Conditions** — when should it *not* run? Time of day, sleep mode, guest mode, someone home?
- **Outcome** — what should be true afterwards?
- **Re-trigger** — what if it fires again while already running? Restart, ignore, queue?
- **Conflict** — what if the user manually overrides it mid-run?
- **Failure** — a device is offline or unavailable. Skip it, retry, notify, abort the whole thing?
- **Persistence** — must this survive a Home Assistant restart or a reload of automations, and if interrupted mid-run, resume, abandon or start over?
- **Scope** — explicitly, what is *not* part of this?

For dashboards specifically, also ask: which device is it for (phone vs desktop), what is the single most common action, and does it replace or sit alongside an existing view.

**For systems, additionally ask:**

- **What is remembered**, and for how long? What clears it?
- **Order** — does sequence matter? What happens to items added mid-run?
- **Duplicates** — can the same thing be added twice? What should happen if it is?
- **Completion** — how does the system know it's finished, and what does it reset?
- **Every way in** — list each distinct way the user interacts with it. Each becomes a flow.

## Spec file format — single change

Write exactly this structure. Omit sections that genuinely don't apply; don't pad.

```markdown
# <Short imperative title>

**Status:** ready | needs answers
**Kind:** automation | script | dashboard | mixed

## Goal
One or two sentences: what the user wants to be true afterwards, and why.

## Behavior
The core of the spec, in plain language. Numbered steps if order matters. Describe end states, not service calls.

## Triggers
What causes this to run.

## Conditions
When it must not run.

## Edge cases
Re-trigger, manual override, unavailable devices, restart, seasonal or intermittent hardware. One line each.

## Acceptance criteria
Checklist the implementer can verify against a live system. Each item must be observably true or false.
- [ ] ...

## Naming hints
Devices, rooms, and flags named the way the user refers to them, with any disambiguating detail. This is what the implementer resolves against. Mark anything user-supplied but unverified.

## Out of scope
What this deliberately does not do.

## Open questions
Anything you could not resolve. Empty is good — if this has entries, say so when you hand the file over.
```

## Spec file format — system

Same rules, more structure.

```markdown
# <Short imperative title>

**Status:** ready | needs answers
**Kind:** system

## Goal
What the user wants to be true afterwards, and why.

## State
What must be remembered between runs. For each piece:
- What it represents, in plain language
- Its shape, conceptually — a single value, an ordered list, a flag
- Whether it must survive a Home Assistant restart
- What sets it, what clears it, and its value when idle

## Flows
One subsection per distinct way the system is entered or advances. Include the automatic ones, not just the user-initiated ones.

### <Flow name>
- **Trigger:** what starts it
- **Conditions:** when it must not proceed
- **Outcome:** the resulting end state, including how it changes State above

## Invariants
Statements that must hold at all times, no matter which flow just ran. These are the cross-cutting rules that a per-flow reading will miss, and they are where the bugs live.

## Surfaces
What the user sees and touches — controls, status displays, what "idle" looks like. Behavioral, not card types.

## Edge cases
Interruption, restart mid-run, manual override, unavailable devices, empty state, seasonal or intermittent hardware. One line each.

## Acceptance criteria
Grouped by flow, plus a group for the invariants. Every item observable.
### <Flow name>
- [ ] ...
### Invariants
- [ ] ...

## Naming hints
## Out of scope
## Open questions
```

## Worked example of the shape

A room-queue system for a robot vacuum — the kind of feature that fails badly in the single-change template — decomposes like this. Note there is not one trigger but five, and that the invariants belong to no single flow:

- **State:** an ordered list of rooms waiting to be cleaned, surviving restart, empty when idle; plus a marker for the room being cleaned right now, blank when idle.
- **Flows:** add a room · start cleaning when the vacuum is docked and the list is non-empty · advance to the next room on completion · clear the list · start automatically when everyone leaves.
- **Invariants:** a room is never queued twice · the room being cleaned is not also in the waiting list · the active marker is blank whenever nothing is being cleaned · only one room is cleaned at a time.
- **Surfaces:** a readable list of what's queued and in what order; what's cleaning now; a way to add a room; a way to clear everything.

Written that way, the implementer can choose storage, decide how many automations it takes, and verify each invariant independently. Written as one flat automation, all of that is lost.

## Acceptance criteria: good vs useless

Good:

- [ ] Pressing the bathroom button twice within 2s leaves the light at full brightness
- [ ] The automation does not run between 23:00 and 06:00 while sleep mode is on
- [ ] If a light is unavailable, the remaining lights still turn off

Useless:

- [ ] The automation works correctly
- [ ] Lights behave as expected

## Where to write the file

The spec has to land where the Home Assistant session can read it: a `specs/` directory inside the Home Assistant config directory. The preferences file, when present, names the local path to it and how it is reached. Without a preferences file, ask the user where that directory is reachable locally (often an sshfs mount of the config directory).

Check the location before writing. If the config directory is reachable (`configuration.yaml` is visible) but `specs/` is missing, offer to create it. If the config directory itself is empty or absent, the mount is down: say so and offer to mount it or to write the file locally for the user to move. Never silently write somewhere else.

Use a short kebab-case slug: `bathroom-motion-timeout.md`, `morning-blinds.md`. If `<slug>.md` already exists, show its title and ask whether to replace it or choose another slug.

## Before you hand it over

Re-read your own file and check:

1. **Zero identifiers.** Search your text for `domain.object_id`-shaped tokens (regex `\b[a-z_]+\.[a-z0-9_]+\b`) and for `{{`, `entity_id`, `device_id`, `area_id`. Judge each hit: an identifier outside *Naming hints* (marked unverified) is a bug — rewrite it behaviorally.
2. **No YAML or card JSON.**
3. **No prescribed mechanism** — no helper types, integrations, or storage choices.
4. **Every acceptance criterion is observable.**
5. **Systems only:** every flow that mutates State is listed; every invariant has at least one acceptance criterion; the idle/empty state of each piece of State is defined.
6. **Open questions is empty and Status is `ready`** — otherwise Status is `needs answers` and you tell the user what's unresolved.

Then tell the user the path, and that they can hand it to the Home Assistant session as "implement `specs/<slug>.md` in the config directory".
