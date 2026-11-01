# claude-skills

Claude Code skills, kept in git so every machine gets the same ones.

| Skill | What it does |
|---|---|
| `GitWorktree` | Bare-repo worktree containers through the `git-wt` CLI: clone, convert, add, reuse, prune, shared files; `wtc` opens a branch's worktree and starts Claude there (source `Tools/wtc.sh` from your bash or zsh rc) |
| `review-loop` | Multi-round review, simplicity first and correctness second, with fixes applied between rounds |
| `auto-review` | `review-loop` without the questions: applies the fix the main agent would have recommended for each finding |
| `ha-spec` | Writes a behavioral spec for a Home Assistant change, for a Claude session on the Home Assistant box to implement |

## Setup

```sh
git clone https://github.com/Tyderion/claude-skills.git
claude-skills/setup
```

Once `git-wt` is installed, later clones can use the worktree layout instead: `git-wt clone https://github.com/Tyderion/claude-skills.git`, then `claude-skills/main/setup`.

`setup` copies each `skills/<name>/` to `~/.claude/skills/`, as `_<name>` when the machine runs LifeOS and as `<name>` otherwise (`--prefix` / `--no-prefix` override). It fills in `{{SKILL_NAME}}`, `{{SKILL_DIR}}` and `{{SOURCE_DIR}}`, writes shims such as `git-wt` to `~/.local/bin`, and checks the commands each skill needs. Each copy gets a `.gitignore` holding `*`, so a `~/.claude` that is itself a git repo never commits it.

Missing commands are installed with pacman on Arch-family Linux, apt on Debian-family Linux and Homebrew on macOS, after asking (`--yes` skips the question; without a terminal, setup prints the command instead). A tool the manager has no package for can use its own installer, which is how Debian gets bun, into `~/.local/bin`. For anything else, setup prints a prompt to paste into Claude Code and exits 2.

`GitWorktree` needs git 2.48 and no Debian or Ubuntu release packages that yet, so on those systems setup ends at that prompt until you have a newer git.

Rerun `setup` after every pull. It leaves unchanged skills alone and refuses to overwrite a copy that was edited in place, or anything it didn't install; `--force` moves those to `~/.local/state/claude-skills/backup/` instead of deleting them.

## Changing a skill

Edit it here, never in `~/.claude/skills`. Run the tests, commit, run `./setup`.

```sh
bun test                      # setup's own tests, plus every skill's
```

## Adding a skill

Put it in `skills/<Name>/` with a `SKILL.md`, and an `install.conf` if it needs anything:

```
require  <command> <min version|-> [arch=<package>] [apt=<package>] [brew=<package>] [script=<https url>] [prefix-env=<var>] [needs=<command,...>]
optional <command> <min version|-> [same fields] -- <what it enables>
bin      <name> <script, relative to the skill>
```

A manager left out means it has no package for that command, so setup runs `script=` if there is one and otherwise asks Claude to install it. `prefix-env` names the variable that tells the script where to install, and `needs` lists what it runs besides curl. `setup` itself never needs to change.

## Personal details

This repo is public. Keep machine paths, usernames and anything personal out of it: skills read such things at run time (a preferences file, an env var), never from their own text.
