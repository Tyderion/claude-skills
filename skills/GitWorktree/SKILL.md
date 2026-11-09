---
name: {{SKILL_NAME}}
version: 1.0.0
description: Bare-repo worktree containers via the git-wt CLI and the wtc shell function: clone into <container>/.bare + one folder per branch, convert a checkout in place, add a worktree per branch, reuse a merged worktree for a new branch (keeps node_modules), share files like .env across worktrees, and prune merged local branches and their worktrees (squash merges included). USE WHEN clone a repo, clone into coding, set up a repo, bare repo, .bare, git worktree, new worktree, work on two branches at once, reuse or recycle a worktree, avoid reinstalling dependencies, convert repo to worktrees, share .env across worktrees, prune branches, delete merged branches, clean up old branches, clean up merged worktrees, delete superseded worktree, interactive prune, git-wt, wtc, start Claude in a worktree. NOT FOR general git history work.
---

# {{SKILL_NAME}}

Deterministic CLI: `git-wt` (on PATH) = `bun {{SKILL_DIR}}/Tools/GitWt.ts`. `git-wt --help` is the full contract.

## Customization

Load `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/{{SKILL_NAME}}/PREFERENCES.md` if present; it can make this layout the default for every clone.

## Workflow Routing

| Intent | Command |
|--------|---------|
| Clone a URL into the layout | `git-wt clone <url> [--dir <path>] [--base <dir>] [--name <name>]` |
| Convert an existing normal checkout | `git-wt convert [<path>]` |
| New worktree for a branch | `git-wt add <branch> [--from <start> \| --remote <name>] [-C <container>]`; reuses a clean merged worktree when `gh` finds one |
| New worktree, and never reuse | `git-wt add <branch> --fresh` |
| Start working on a branch: worktree ready (pulled, deps installed, MCP approvals copied), then Claude in it | `wtc <branch>`, a shell function from `{{SKILL_DIR}}/Tools/wtc.sh` around `git-wt open <branch>`. It runs in the principal's own shell (Claude loads a repo's `.mcp.json`, hooks and settings only from the folder it starts in), so hand over the exact command instead of running it here |
| Reuse a specific worktree for another branch | `git-wt reuse <worktree> <branch> [--from <start> \| --remote <name>]` |
| Reuse a worktree, without naming which | Don't pick one. List the container's worktrees (`git worktree list`, leaving out the default branch's) and ask the principal which to reuse, then run `git-wt reuse` |
| Share one file across worktrees (edits visible everywhere) | move it to the container root, list it under `[link]` in `<container>/.shared`, then `git-wt sync` |
| Give each worktree its own editable copy of a default | put the default in the container root, list it under `[copy]`, then `git-wt sync` |
| Throw away a worktree's edits to a copied file | `git-wt sync --reset <path>` (replaces every diverged copy with the root default) |
| Delete superseded branches and worktrees that were never merged | `git-wt prune -i` in the principal's own terminal: it asks for numbers, then a typed yes. Hand over the command and stop; never pipe answers into it, because those are the principal's choices |
| Clean up dead local branches and merged worktrees | `git-wt prune` first and show the principal the list; `git-wt prune --yes` only on their go-ahead, since it also removes merged worktrees with their ignored files. Add `--gone` only when the principal asks to drop upstream-gone branches that have no merged PR |

## Gotchas

- **Reuse refuses**, before anything changes, on tracked changes, untracked-but-not-ignored files, populated submodules, a worktree outside the container, or a target branch tracking a path that sits untracked in the worktree (an ignored file, a `[copy]` file, a shared link). From `add`, a refusal falls back to a fresh worktree.
- **Auto-reuse counts a worktree as merged only when a merged PR's head commit is its HEAD or descends from it.** Commits made after the merge disqualify it, and so does being the default branch's worktree. It asks `gh` about every github.com remote, so a fork's origin only finds PRs opened against the fork.
- **Without `-i`, `prune` judges merged by PR, never `git branch --merged`** (squash merges defeat it). `--gone` also deletes upstream-gone branches, which may hold commits never pushed, and ones `gh` could not judge; branches with no upstream go only with a merged PR or an `-i` pick. Leftover non-empty folders are listed, not removed; they usually hold files a tool wrote after the worktree was removed.
- **`prune --yes` removes merged worktrees, ignored files included, and keeps one for reuse.** node_modules, `.idea` and any ignored file you wrote by hand go with the folder, so read the preview. The default branch's worktree never goes, and neither does the most recently merged worktree that could go, which `add` reuses next unless a more recently merged one stayed for a process or its own shared file. A merged worktree also stays while it has tracked changes, untracked files, its own version of a `[copy]` or `[link]` path, a lock, or a process running in it; a commit made after the merge means it isn't merged at all. It never uses `--force`. Worktrees with no merged PR stay, `--gone` included.
- **`prune -i` is the one route that removes an unmerged worktree, uncommitted files included.** It offers every branch except the default branches, locked worktrees, and ones mid-rebase, mid-bisect or with a missing folder. Each line says what would be lost (commits on no remote branch, uncommitted files, its own version of a shared path, a running process), and a worktree that changed after it was listed is left alone. Commits can be brought back from the printed SHA until git collects them; uncommitted files can't. Without a terminal, stdin is empty and it deletes nothing.
- **Reuse starts new branches from the remote's default**; plain `add` starts from the local default, which is stale after a merge.
- **Sync aborts, nothing changed, on a real file where a link belongs.** Report the conflict and ask the principal which copy wins.
- **`[copy]` files are overwritten only by `--reset`**, which skips copies identical to the root. Removing an entry from `[copy]` leaves the files and keeps them git-excluded until no worktree has one. To commit a copied file, find it under `# copy` in the managed block of `.bare/info/exclude` and `git add -f` it.
- **Shared paths are git-excluded automatically** via a managed block in `.bare/info/exclude`, which is shared by all worktrees. Edit `.shared`, never that block.
- **A `!path` in a tracked `.gitignore` beats `info/exclude`**; `sync` warns when it re-includes a shared link. The fix is in that repo's `.gitignore`.
- **`convert` refuses** uncommitted tracked changes, detached HEAD, in-progress merge/rebase, submodules and locked linked worktrees. Existing linked worktrees move into the container under their flattened branch name; untracked and ignored files carry over, and linked worktrees keep their uncommitted changes; sparse checkouts work.
- **`convert` only renames**, so nothing is copied or deleted and a failure rolls back. An interrupted run leaves `<repo>.git-wt-convert.json`; the next `convert` only rolls it back, so run `convert` again.
- **Containers are movable** (`worktree.useRelativePaths`), which turns on `extensions.relativeWorktrees`; a GUI bundling an old git will refuse the repo.
- **`wtc` must be sourced**: `source {{SKILL_DIR}}/Tools/wtc.sh` in `~/.bashrc` or `~/.zshrc`. `WTC_COMMAND` is what starts in the worktree (default `command claude`; `""` only changes directory); personal flags such as `--permission-mode auto` go there, never in this repo.
- **`git wt --help` opens `man git-wt`** (git rewrites `--help` for every subcommand) and fails. Use `git wt -h` or `git-wt --help`.
- **This is an installed copy; the source is `{{SOURCE_DIR}}`.** Change the tool there, run `bun test Tools/` in that folder, commit, then rerun the repo's `./setup`. Setup refuses to overwrite a copy that was edited in place, so carry any such edit over to the source first.
