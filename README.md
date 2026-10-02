# claude-skills

Claude Code skills, kept in git so every machine gets the same ones.

| Skill | What it does |
|---|---|
| `GitWorktree` | Bare-repo worktree containers through the `git-wt` CLI: clone, convert, add, reuse, shared files |
| `review-loop` | Multi-round review, simplicity first and correctness second, with fixes applied between rounds |

## Setup

```sh
git clone https://github.com/Tyderion/claude-skills.git
claude-skills/setup
```

Once `git-wt` is installed, later clones can use the worktree layout instead: `git-wt clone https://github.com/Tyderion/claude-skills.git`, then `claude-skills/main/setup`.

`setup` copies each `skills/<name>/` to `~/.claude/skills/`, as `_<name>` when the machine runs LifeOS and as `<name>` otherwise (`--prefix` / `--no-prefix` override). It fills in `{{SKILL_NAME}}`, `{{SKILL_DIR}}` and `{{SOURCE_DIR}}`, writes shims such as `git-wt` to `~/.local/bin`, and checks the commands each skill needs.

Missing commands are installed with pacman on Arch-family Linux and with Homebrew on macOS, after asking (`--yes` skips the question; without a terminal, setup prints the command instead). On any other system, or for something those managers can't provide, setup prints a prompt to paste into Claude Code and exits 2.

Rerun `setup` after every pull. It leaves unchanged skills alone and refuses to overwrite a copy that was edited in place, or anything it didn't install; `--force` moves those to `~/.local/state/claude-skills/backup/` instead of deleting them.

## Changing a skill

Edit it here, never in `~/.claude/skills`. Run the tests, commit, run `./setup`.

```sh
bun test                      # setup's own tests, plus every skill's
```

## Adding a skill

Put it in `skills/<Name>/` with a `SKILL.md`, and an `install.conf` if it needs anything:

```
require  <command> <min version|-> [arch=<package>] [brew=<package>]
optional <command> <min version|-> [arch=<package>] [brew=<package>] -- <what it enables>
bin      <name> <script, relative to the skill>
```

A manager left out means it has no package for that command, so setup asks Claude to install it. `setup` itself never needs to change.

## Personal details

This repo is public. Keep machine paths, usernames and anything personal out of it: skills read such things at run time (a preferences file, an env var), never from their own text.
