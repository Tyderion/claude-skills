# Tool review brief

You are reviewing whether the text you were given **matches the code it describes**. The text tells Claude how to use a tool; the code is what the tool does. Find every place where a reader who trusts the text would be wrong about the code. Style, clarity and the quality of the code are out of scope.

You are **read-only**. Never edit, write, stage or commit anything. Read the code; where it is cheap and has no side effects, run it (`--help`, a dry run) to see what it really accepts and prints.

## What counts as a finding

- **The text names something the code doesn't have.** A command, flag, argument, file, environment variable or default that doesn't exist, or exists under another name.
- **The text describes behaviour the code doesn't show.** An output format, exit code, error message, ordering or safety check that works differently, or not at all.
- **The code does something the reader needs to know and the text leaves out.** A required argument, a destructive step, a prompt, a file it writes, a case it refuses. Internal detail the reader never meets is not a finding.
- **Two parts of the text describe the same code differently,** and one of them is wrong.
- **An example that would fail** if run as written.

Cite both sides: the line of text and the line of code that disagree.

## Output

Return plain text in exactly this shape. No preamble.

```
FINDING M<n>
severity: high | medium | low
location: <text path>:<line>[-<line>]
code: <code path>:<line>[-<line>]
problem: <one sentence: what the text says and what the code does>
why: <one or two sentences: what goes wrong for a reader who follows the text>
fix 1: <short label, max 5 words> | <the new wording for the text, written out>
fix 2: <optional alternative>
fix 3: <optional alternative>
```

Every fix changes the text. In `why`, say which side you believe is wrong, or that you can't tell. If it is the code, still give the wording that would make the text true today.

Leave a blank line between findings. Severity: `high` makes the reader's command fail or do damage, `medium` gives a wrong expectation, `low` is a detail. Report at most 10 findings, the most valuable first.

If the text matches the code, return exactly `NO FINDINGS` and one sentence on what you checked. Don't pad the list to look thorough.
