# wtc <branch> [git-wt open options]: get <branch>'s worktree in the git-wt container you are in
# ready (see `git-wt open`), cd there and start Claude. Claude loads a repo's MCP servers, hooks
# and settings only from the folder it starts in, so it has to start in the worktree.
#
# Source this from ~/.bashrc or ~/.zshrc; a script can't change its caller's directory.
# WTC_COMMAND is what runs in the worktree, evaluated by the shell (default: command claude).
# Set it to "" to only change directory.
wtc() {
  if [ $# -lt 1 ]; then
    echo "usage: wtc <branch> [--from <start> | --remote <name>] [--fresh] [-C <container>]" >&2
    return 2
  fi
  local wt
  wt=$(git-wt open "$@") || return
  cd "$wt" || return
  eval "${WTC_COMMAND-command claude}"
}
