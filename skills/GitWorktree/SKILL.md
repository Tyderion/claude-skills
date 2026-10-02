---
name: _GitWorktree
version: 1.0.0
description: Bare-repo worktree containers via the git-wt CLI: clone into <container>/.bare + one folder per branch, convert a checkout in place, add a worktree per branch, reuse a merged worktree for a new branch (keeps node_modules), and share files like .env across worktrees. USE WHEN clone a repo, clone into coding, set up a repo, bare repo, .bare, git worktree, new worktree, work on two branches at once, reuse or recycle a worktree, avoid reinstalling dependencies, convert repo to worktrees, share .env across worktrees, git-wt. NOT FOR removing worktrees or general git history work.
---

# _GitWorktree

Deterministic CLI: `git-wt` (on PATH) = `bun ~/.claude/skills/_GitWorktree/Tools/GitWt.ts`. `git-wt --help` is the full contract.

## Customization

Load `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/_GitWorktree/PREFERENCES.md` if present; it can make this layout the default for every clone.

## Workflow Routing

| Intent | Command |
|--------|---------|
| Clone a URL into the layout | `git-wt clone <url> [--dir <path>] [--base <dir>] [--name <name>]` |
| Convert an existing normal checkout | `git-wt convert [<path>]` |
| New worktree for a branch | `git-wt add <branch> [--from <start> \| --remote <name>] [-C <container>]`: tracks the branch from whichever remote has it; `--remote` picks when several do. On a GitHub remote it reuses a clean worktree whose PR was merged, if there is one |
| New worktree, and never reuse | `git-wt add <branch> --fresh` |
| Reuse a specific worktree for another branch | `git-wt reuse <worktree> <branch> [--from <start> \| --remote <name>]`: `<worktree>` is a folder, path or branch name |
| Share one file across worktrees (edits visible everywhere) | move it to the container root, list it under `[link]` in `<container>/.shared`, then `git-wt sync` |
| Give each worktree its own editable copy of a default | put the default in the container root, list it under `[copy]`, then `git-wt sync` |
| Throw away a worktree's edits to a copied file | `git-wt sync --reset <path>` (replaces every diverged copy with the root default) |

Base directory for `clone` defaults to `$GIT_WT_BASE`, else `~/coding`. Worktree folders are the branch name with `/` → `-` (`feature/x` → `feature-x/`).

## Examples

```
User: "clone git@github.com:org/tool.git"
→ git-wt clone git@github.com:org/tool.git
→ ~/coding/tool/{.bare, .git, .shared, main/}
```

```
User: "I want to work on feature/login in parallel"
→ git-wt add feature/login -C ~/coding/tool   → ~/coding/tool/feature-login/
```

```
User: "both worktrees should use the same .env"
→ one real .env at ~/coding/tool/.env (if a worktree holds the only copy, move it there first)
→ append ".env" to ~/coding/tool/.shared → git-wt sync
```

```
User: "start on feature/y" (feature-x/'s PR is merged on GitHub)
→ git-wt add feature/y   → reuses feature-x/ as ~/coding/tool/feature-y/, node_modules intact
```

## Gotchas

- **Reuse keeps ignored files only, and never lets git overwrite one.** Tracked changes, untracked-but-not-ignored files, populated submodules, or a worktree outside the container folder make `reuse` refuse. So does a target branch that tracks a path sitting untracked in the worktree (an ignored file, a `[copy]` file, a shared link), which a plain checkout would silently replace. All refusals happen before anything changes; from `add`, a refusal falls back to a fresh worktree. The old local branch is never deleted.
- **Auto-reuse counts a worktree as merged only when a merged PR's head commit is its HEAD or descends from it.** Commits made after the merge disqualify it, and so does being the default branch's worktree. It asks `gh` about every github.com remote, so a fork's origin only finds PRs opened against the fork. A PR head that isn't local (a review suggestion applied on GitHub) is fetched from `refs/pull/<n>/head`. When `gh` is missing or fails, `add` says so and creates a fresh worktree.
- **Reuse fetches every remote and starts new branches from the remote's default branch**, unlike plain `add`, which starts from the local default. After a merge the local default is stale. A failed fetch is a warning; reuse carries on with local refs.

- **Sync never overwrites a real file.** A real file where a shared link belongs aborts the whole sync with nothing changed. Resolving it (which copy wins, where it moves) is the principal's call; report the conflict and ask.
- **`[copy]` files are copied once, then belong to the worktree.** Sync never overwrites an existing copy; only `--reset` does, and it skips copies identical to the root. Removing an entry from `[copy]` leaves the files and keeps them git-excluded until no worktree has one. To commit a copied file, find it under `# copy` in the managed block of `.bare/info/exclude` and `git add -f` it.
- **Shared paths are git-excluded automatically** via a managed block in `.bare/info/exclude`, which is shared by all worktrees. Edit `.shared`, never that block.
- **`info/exclude` has the lowest precedence.** A `!path` in a tracked `.gitignore` re-includes a shared link, so it shows as untracked and `git add -A` would commit the symlink. `sync` warns per worktree when this happens; the fix is in that repo's `.gitignore`.
- **`convert` refuses** uncommitted tracked changes, detached HEAD, in-progress merge/rebase, submodules, and locked linked worktrees. Existing linked worktrees (e.g. a sibling `project.2` from `git worktree add`) move into the container under their flattened branch name and are reconnected with `git worktree repair`; stale ones are pruned first. Untracked and ignored files, and uncommitted changes in linked worktrees, are carried over. Sparse checkouts (`extensions.worktreeConfig`) work: `core.bare` goes into `.bare/config.worktree`, and the old sparse settings and patterns move to the new worktree.
- **`convert` only renames**: the tree becomes the first worktree, `.git` becomes `.bare`, and the index (with skip-worktree/assume-unchanged bits) and HEAD reflog carry over. Nothing is copied or deleted. On failure it rolls every rename back; if the rollback itself stops, it prints where the tree and repository are. Ctrl-C cannot stop it between renames. A hard kill leaves `<repo>.git-wt-convert.json`; the next `git-wt convert <repo>` rolls that back first and asks for a rerun.
- **`clone` is `git clone --no-checkout --separate-git-dir=.bare` + `core.bare true`, not `clone --bare`.** A bare clone copies every remote branch into `refs/heads` as local branches that fetch never updates, and writes no fetch refspec. This route leaves only the default branch local, everything else as `origin/*`, and `git worktree add <dir> <branch>` creates tracking branches on demand.
- **Containers are movable.** `clone` and `convert` set `worktree.useRelativePaths`, so worktree links are relative. This enables `extensions.relativeWorktrees`, which older git versions cannot read; a GUI with an old bundled git will refuse the repo (Sublime Merge on this machine was confirmed working).
- **`git wt --help` opens `man git-wt`** (git rewrites `--help` for every subcommand) and fails. Use `git wt -h` or `git-wt --help`.
- **Run the tests after changing the tool:** `bun test ~/.claude/skills/_GitWorktree/Tools/`.
