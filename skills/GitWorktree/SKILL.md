---
name: GitWorktree
version: 1.0.0
description: Sets up and maintains bare-repo worktree containers (<container>/.bare + one peer folder per branch + files shared across worktrees) via the git-wt CLI — clone a URL into the layout, convert an existing checkout in place without losing stashes or reflog, add a worktree per branch, and sync shared files like .env or local databases as symlinks into every worktree. USE WHEN clone a repo, clone into coding, set up a repo, worktree setup, bare repo, .bare, git worktree, new worktree, work on two branches at once, convert repo to worktrees, share .env across worktrees, shared files between worktrees, git-wt. NOT FOR removing worktrees (plain `git worktree remove`) or general git history work.
---

# GitWorktree

Deterministic CLI: `git-wt` (on PATH) = `bun ~/.claude/skills/GitWorktree/Tools/GitWt.ts`. `git-wt --help` is the full contract.

## Customization

Load `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/GitWorktree/PREFERENCES.md` if present; it can make this layout the default for every clone.

## Workflow Routing

| Intent | Command |
|--------|---------|
| Clone a URL into the layout | `git-wt clone <url> [--dir <path>] [--base <dir>] [--name <name>]` |
| Convert an existing normal checkout | `git-wt convert [<path>]` |
| New worktree for a branch | `git-wt add <branch> [--from <start>] [-C <container>]` |
| Share a file across worktrees | move it to the container root, add its path to `<container>/.shared`, then `git-wt sync` |

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

## Gotchas

- **Sync never overwrites a real file.** A real file where a shared link belongs aborts the whole sync with nothing changed. Resolving it (which copy wins, where it moves) is the principal's call; report the conflict and ask.
- **Shared paths are git-excluded automatically** via a managed block in `.bare/info/exclude`, which is shared by all worktrees. Edit `.shared`, never that block.
- **`info/exclude` has the lowest precedence.** A `!path` in a tracked `.gitignore` re-includes a shared link, so it shows as untracked and `git add -A` would commit the symlink. `sync` warns per worktree when this happens; the fix is in that repo's `.gitignore`.
- **`convert` refuses** uncommitted tracked changes, detached HEAD, in-progress merge/rebase, submodules, and repos that already have linked worktrees (stale ones are pruned first). Untracked and ignored files are carried over. Sparse checkouts (`extensions.worktreeConfig`) work: `core.bare` goes into `.bare/config.worktree`, and the old sparse settings and patterns move to the new worktree.
- **`convert` only renames**: the tree becomes the first worktree, `.git` becomes `.bare`, and the index (with skip-worktree/assume-unchanged bits) and HEAD reflog carry over. Nothing is copied or deleted. On failure it rolls every rename back; if the rollback itself stops, it prints where the tree and repository are.
- **`clone` is `git clone --no-checkout --separate-git-dir=.bare` + `core.bare true`, not `clone --bare`.** A bare clone copies every remote branch into `refs/heads` as local branches that fetch never updates, and writes no fetch refspec. This route leaves only the default branch local, everything else as `origin/*`, and `git worktree add <dir> <branch>` creates tracking branches on demand.
- **Containers are movable.** `clone` and `convert` set `worktree.useRelativePaths`, so worktree links are relative. This enables `extensions.relativeWorktrees`, which older git versions cannot read; a GUI with an old bundled git will refuse the repo (Sublime Merge on this machine was confirmed working).
- **`git wt --help` opens `man git-wt`** (git rewrites `--help` for every subcommand) and fails. Use `git wt -h` or `git-wt --help`.
- **Run the tests after changing the tool:** `bun test ~/.claude/skills/GitWorktree/Tools/`.
