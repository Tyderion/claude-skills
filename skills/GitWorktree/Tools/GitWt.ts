#!/usr/bin/env bun
/**
 * git-wt — bare-repo worktree containers.
 *
 * Layout it creates and maintains:
 *   <container>/.bare/      the repository (core.bare = true)
 *   <container>/.git        "gitdir: ./.bare"
 *   <container>/.shared     paths shared by every worktree (one per line, # comments)
 *   <container>/<file>      a shared file's single real copy
 *   <container>/<worktree>/ one folder per branch, named after the branch with / -> -
 *
 * Subcommands: clone, convert, add, reuse, sync, prune, open. Run with --help for usage.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const USAGE = `git-wt — bare-repo worktree containers

  git-wt clone <url> [--dir <path>] [--base <dir>] [--name <name>]
      Clone into <base>/<name> (base: $GIT_WT_BASE or ~/coding; name: from the URL),
      with .bare/, the .git pointer, every branch as origin/*, and a first worktree
      on the remote's default branch.

  git-wt convert [<path>]
      Turn a normal checkout (default: cwd) into a container in place. Refuses on
      uncommitted tracked changes. Only renames: the tree becomes the first worktree,
      .git becomes .bare, the index and HEAD reflog carry over. Rolls back on failure.

  git-wt add <branch> [--from <start> | --remote <name>] [--fresh] [-C <container>]
      New worktree in <container>/<branch with / -> ->. Uses the local branch, else
      tracks <remote>/<branch> from whichever remote has it (--remote picks one when
      several do), else creates <branch> from --from (default: the default branch).
      Then links shared files into it. With a GitHub remote, it first asks gh for a
      clean worktree whose branch has a merged PR and reuses that one instead;
      --fresh skips this.

  git-wt reuse <worktree> <branch> [--from <start> | --remote <name>] [-C <container>]
      Hand an existing worktree (folder, path or branch name) to <branch>: fetch,
      check <branch> out in it (resolved like add, but new branches start from the
      remote's default), then rename the folder. Ignored files such as node_modules
      stay; tracked changes, untracked files, or untracked paths the branch would
      overwrite refuse, before anything changes. The old branch is deleted when gh
      finds a merged PR that contains it (as add checks), and kept otherwise.

  git-wt sync [--reset <path>] [-C <container>]
      Apply .shared to every worktree. Bare lines and [link] entries become symlinks
      to the container root; [copy] entries are copied once and then belong to the
      worktree. Everything listed is git-excluded. Links for paths no longer listed
      are removed; copies are kept (and stay excluded). --reset <path> replaces every
      worktree's copy of a [copy] entry with the root default. Plans first; any
      conflict aborts the whole sync with nothing changed.

  git-wt prune [--yes] [--gone] [-C <container>]
      Find dead local branches: fetch --prune, then ask gh which branches have a
      merged PR containing their tip, which works for squash merges. Lists every
      local branch with the reason it would be deleted or kept, and folders in the
      container that aren't worktrees. Deletes nothing without
      --yes, which deletes the merged branches (printing each SHA) and empty
      folders. --gone also deletes the upstream-gone ones. Never touched: the
      default branch (.bare/HEAD and every remote's HEAD) and branches a worktree
      has checked out, is rebasing or is bisecting, even if its folder is missing.

  git-wt open <branch> [--from <start> | --remote <name>] [--fresh] [-C <container>]
      Get <branch>'s worktree ready and print its path, alone, on stdout (the rest
      goes to stderr). An existing worktree is used as it is. Otherwise the default
      branch's worktree is pulled first (when it is dirty, the remote is fetched and
      a new branch starts from <remote>/<default>), then add runs, reuse included.
      Then: direnv allow when .envrc is the shared one, an install with the
      lockfile's package manager for a new or reused worktree or one without
      node_modules, and Claude Code's MCP approvals copied from the default
      branch's worktree when the target has none. Tools/wtc.sh wraps it as wtc.
`;

class Fail extends Error {}
const fail = (msg: string): never => { throw new Fail(msg); };
/** A refusal raised before anything changed, so a caller may safely try another route. */
class Refused extends Fail {}
const refuse = (msg: string): never => { throw new Refused(msg); };
// `open` points this at stderr: its stdout is the worktree path alone, for `cd "$(git-wt open …)"`.
let log = (msg: string) => console.log(msg);

function run(cmd: string, args: string[], cwd?: string, allowFail = false) {
  // spawn reports a missing cwd as the *command* being missing ("git: ENOENT").
  if (cwd && !existsSync(cwd)) fail(`${cwd} does not exist`);
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    fail(`${cmd} ${args.join(" ")} failed (exit ${r.status}):\n${(r.stderr || r.stdout).trim()}`);
  }
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\n$/, ""), err: r.stderr ?? "" };
}
const git = (cwd: string, ...args: string[]) => run("git", args, cwd).out;
const gitTry = (cwd: string, ...args: string[]) => run("git", args, cwd, true);

export const flatten = (branch: string) => branch.replace(/\//g, "-");

export function repoName(url: string): string {
  const last = url.replace(/[?#].*$/, "").replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  return name || fail(`cannot derive a repo name from "${url}"; pass --name`);
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

function lstatOrNull(p: string) {
  try { return lstatSync(p); } catch { return null; }
}

// Test-only fault injection: GIT_WT_TEST=crash:<at> dies without rollback, fail:<at> throws.
function inject(at: string) {
  const v = process.env.GIT_WT_TEST;
  if (v === `crash:${at}`) process.exit(137);
  if (v === `fail:${at}`) fail("injected test failure");
}

// ---------------------------------------------------------------- container

// git reports the common dir as a real path, so symlinked routes to the container resolve too.
function findContainer(start: string): string {
  const dir = resolve(start);
  if (!existsSync(dir)) fail(`${dir} does not exist`);
  const r = gitTry(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!r.ok || basename(r.out) !== ".bare") fail(`no git-wt container (a repository at <dir>/.bare) at or above ${dir}`);
  return dirname(r.out);
}

function initContainerFiles(container: string) {
  writeFileSync(join(container, ".git"), "gitdir: ./.bare\n");
  // Worktree links become relative, so the whole container can be moved or renamed. Sets
  // extensions.relativeWorktrees on the first `worktree add`; older git can't read the repo then.
  git(container, "config", "worktree.useRelativePaths", "true");
  const shared = join(container, ".shared");
  if (!existsSync(shared)) {
    writeFileSync(shared, [
      "# Paths shared by every worktree, relative to a worktree root. One per line; apply with `git-wt sync`.",
      "# The default lives here in the container root.",
      "# [link] (also any line before a header): every worktree symlinks the one real file.",
      "# [copy]: each worktree gets its own copy once, then edits stay local. `git-wt sync --reset <path>` re-copies.",
      "",
      "[link]",
      "",
      "[copy]",
      "",
    ].join("\n"));
  }
}

type Worktree = { path: string; branch?: string; head?: string; locked: boolean };

function worktrees(container: string): Worktree[] {
  const out = git(container, "worktree", "list", "--porcelain");
  const list: Worktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.includes("bare") || lines.some((l) => l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5);
    list.push({ path, branch, head, locked: lines.some((l) => l === "locked" || l.startsWith("locked ")) });
  }
  return list;
}

function defaultBranch(container: string): string {
  const r = gitTry(container, "symbolic-ref", "--short", "HEAD");
  return r.ok ? r.out : fail("cannot read the default branch from .bare/HEAD");
}

// ---------------------------------------------------------------- sync

const BLOCK_START = "# >>> git-wt shared (managed by git-wt sync; edit .shared instead)";
const BLOCK_END = "# <<< git-wt shared";

/** `.shared`: bare lines and `[link]` entries are symlinked, `[copy]` entries are copied once. */
export type Shared = { link: string[]; copy: string[] };

export function readShared(container: string): Shared {
  const file = join(container, ".shared");
  const shared: Shared = { link: [], copy: [] };
  if (!existsSync(file)) return shared;
  let section: keyof Shared = "link";
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      const name = header[1].trim().toLowerCase();
      if (name !== "link" && name !== "copy") fail(`.shared: unknown section [${header[1]}]; use [link] or [copy]`);
      section = name;
      continue;
    }
    const p = normalize(line).replace(/\/+$/, "");
    if (isAbsolute(p) || p === "." || p === ".." || p.startsWith(`..${sep}`)) fail(`.shared: "${line}" must be a relative path inside the worktree`);
    if ([".git", ".bare", ".shared"].includes(p.split(sep)[0])) fail(`.shared: "${line}" collides with git-wt's own files`);
    const other = section === "link" ? "copy" : "link";
    if (shared[other].includes(p)) fail(`.shared: "${p}" is listed under both [link] and [copy]`);
    if (!shared[section].includes(p)) shared[section].push(p);
  }
  // A link for `a` would make `a/b` resolve through it into the root copy itself,
  // and a copied `a` would already contain `a/b`.
  const all = [...shared.link, ...shared.copy];
  for (const a of all) for (const b of all) {
    if (b.startsWith(a + sep)) fail(`.shared: "${b}" is inside "${a}", which is already shared; list only one of them`);
  }
  return shared;
}

// Every container holds its repository at .bare (findContainer checks; clone and convert create it).
const excludeFile = (container: string) => join(container, ".bare", "info", "exclude");

type Block = Shared & { before: string; after: string };

function readManagedBlock(container: string): Block {
  const file = excludeFile(container);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const s = text.indexOf(BLOCK_START);
  const e = s < 0 ? -1 : text.indexOf(BLOCK_END, s);
  const odd = (why: string) => fail(`${file}: ${why}. Fix the git-wt block by hand (or delete both marker lines and everything between), then rerun`);
  if (s < 0) {
    if (text.includes(BLOCK_END)) odd("end marker without a start marker");
    return { before: text, after: "", link: [], copy: [] };
  }
  if (e < 0) odd("start marker without an end marker");
  if (text.indexOf(BLOCK_START, s + 1) >= 0 || text.indexOf(BLOCK_END, e + 1) >= 0) odd("more than one git-wt block");
  const block: Block = { before: text.slice(0, s), after: text.slice(e + BLOCK_END.length).replace(/^\n/, ""), link: [], copy: [] };
  let section: keyof Shared = "link"; // blocks written before [copy] existed hold only links
  for (const l of text.slice(s + BLOCK_START.length, e).split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (l === "# link" || l === "# copy") section = l.slice(2) as keyof Shared;
    else if (l.startsWith("/")) block[section].push(l.slice(1).replace(/\\(.)/g, "$1"));
    else odd("unexpected lines inside the git-wt block");
  }
  return block;
}

function writeManagedBlock(container: string, { before, after }: Block, { link, copy }: Shared) {
  const file = excludeFile(container);
  const esc = (p: string) => "/" + p.replace(/([\\*?[\]!#])/g, "\\$1");
  const body = [
    ...(link.length ? ["# link", ...link.map(esc)] : []),
    ...(copy.length ? ["# copy", ...copy.map(esc)] : []),
  ];
  const block = body.length ? `${BLOCK_START}\n${body.join("\n")}\n${BLOCK_END}\n` : "";
  const head = before && !before.endsWith("\n") ? before + "\n" : before;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, head + block + after);
}

type Action = { kind: "link" | "unlink" | "copy" | "reset"; path: string; target: string };

const union = (...lists: string[][]) => [...new Set(lists.flat())];

export function sync(container: string, opts: { only?: string[]; reset?: string } = {}): { actions: Action[]; warnings: string[] } {
  const { only } = opts;
  const { link, copy } = readShared(container);
  const reset = opts.reset === undefined ? undefined : normalize(opts.reset).replace(/\/+$/, "");
  if (reset !== undefined && !copy.includes(reset)) fail(`--reset ${reset}: not listed under [copy] in .shared`);
  const previous = readManagedBlock(container);
  const removedLinks = previous.link.filter((p) => !link.includes(p));
  const all = worktrees(container);
  const trees = all.filter((w) => !only || only.includes(w.path));

  const actions: Action[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const pointsAt = (path: string, real: string) => resolve(dirname(path), readlinkSync(path)) === real;

  for (const entry of [...link, ...copy]) {
    if (!existsSync(join(container, entry))) warnings.push(`${entry}: not present in the container root yet, nothing linked or copied`);
  }

  for (const wt of trees) {
    // Unlinks first: an entry moved from [link] to [copy] is unlinked, then copied.
    for (const entry of removedLinks) {
      const path = join(wt.path, entry);
      if (lstatOrNull(path)?.isSymbolicLink() && pointsAt(path, join(container, entry))) {
        actions.push({ kind: "unlink", path, target: readlinkSync(path) });
      }
    }
    for (const entry of link) {
      const real = join(container, entry);
      if (!existsSync(real)) continue; // follows links: a dangling default counts as missing
      const path = join(wt.path, entry);
      const st = lstatOrNull(path);
      if (!st) actions.push({ kind: "link", path, target: relative(dirname(path), real) });
      else if (st.isSymbolicLink()) {
        if (!pointsAt(path, real)) conflicts.push(`${path}: symlink points at ${readlinkSync(path)}, not the shared ${real}`);
      } else conflicts.push(`${path}: a real ${st.isDirectory() ? "directory" : "file"} sits where the shared link belongs`);
    }
    for (const entry of copy) {
      const real = join(container, entry);
      if (!existsSync(real)) continue; // follows links: a dangling default counts as missing
      const path = join(wt.path, entry);
      const st = lstatOrNull(path);
      // Seen through a link that is about to go (the entry, or a parent dir moved from [link]).
      const beingUnlinked = actions.some((a) => a.kind === "unlink" && (a.path === path || path.startsWith(a.path + sep)));
      // A symlinked default would be copied as a (dangling) link; copy what it points at.
      const source = realpathSync(real);
      if (!st || beingUnlinked) actions.push({ kind: "copy", path, target: source });
      else if (st.isSymbolicLink()) conflicts.push(`${path}: a symlink sits where the worktree's own copy belongs`);
      // A real file is this worktree's own version; only --reset replaces it.
      else if (entry === reset && !run("diff", ["-rq", "--no-dereference", source, path], undefined, true).ok) {
        actions.push({ kind: "reset", path, target: source });
      }
    }
  }

  if (conflicts.length) {
    fail(`sync aborted, nothing changed. Resolve these by hand, then rerun:\n  ${conflicts.join("\n  ")}`);
  }

  for (const a of actions) {
    if (a.kind === "unlink") unlinkSync(a.path);
    else if (a.kind === "link") {
      mkdirSync(dirname(a.path), { recursive: true });
      symlinkSync(a.target, a.path);
    } else {
      if (a.kind === "reset") rmSync(a.path, { recursive: true });
      mkdirSync(dirname(a.path), { recursive: true });
      run("cp", ["-a", "--reflink=auto", a.target, a.path]); // free on btrfs/xfs until edited
    }
  }

  // Only shrink the block when every worktree was visited, so a single-worktree sync (from
  // `add`) can't forget links other worktrees still need pruned. Copies stay excluded while
  // any worktree still holds one, even after leaving .shared, so they never turn untracked.
  const stillCopied = previous.copy.filter((p) => !link.includes(p) && all.some((w) => lstatOrNull(join(w.path, p))));
  writeManagedBlock(container, previous, {
    link: only ? union(previous.link, link) : link,
    copy: only ? union(previous.copy, copy) : union(copy, stillCopied),
  });

  // info/exclude has the lowest precedence: a `!path` in a tracked .gitignore wins over it.
  for (const wt of trees) {
    for (const entry of [...link, ...copy]) {
      if (lstatOrNull(join(wt.path, entry)) && !gitTry(wt.path, "check-ignore", "-q", "--no-index", entry).ok) {
        warnings.push(`${join(wt.path, entry)}: not ignored (a .gitignore rule re-includes it), so it shows as untracked; git add -A would commit it`);
      }
    }
  }
  return { actions, warnings };
}

function reportSync(r: { actions: Action[]; warnings: string[] }) {
  const verb = { link: "linked  ", unlink: "unlinked", copy: "copied  ", reset: "reset   " };
  for (const a of r.actions) log(`${verb[a.kind]} ${a.path}${a.kind === "link" || a.kind === "unlink" ? ` -> ${a.target}` : ""}`);
  for (const w of r.warnings) log(`warning: ${w}`);
  if (!r.actions.length) log("shared files already up to date");
}

// ---------------------------------------------------------------- clone

export function clone(url: string, opts: { dir?: string; base?: string; name?: string }): string {
  const base = expandHome(opts.base ?? process.env.GIT_WT_BASE ?? "~/coding");
  const container = resolve(opts.dir ? expandHome(opts.dir) : join(base, opts.name ?? repoName(url)));
  const st = lstatOrNull(container);
  if (st && !st.isDirectory()) fail(`${container} exists and is not a directory`);
  if (st && readdirSync(container).length) fail(`${container} already exists and is not empty`);
  const created = !existsSync(container);
  mkdirSync(container, { recursive: true });
  try {
    return cloneInto(container, url);
  } catch (e) {
    // Remove only what this call made; a pre-existing empty target dir stays.
    const made = created ? [container] : [".bare", ".git", ".shared"].map((f) => join(container, f));
    for (const p of made) rmSync(p, { recursive: true, force: true });
    throw e;
  }
}

function cloneInto(container: string, url: string): string {
  // Not `git clone --bare`: that copies every remote branch into refs/heads as local
  // branches fetch never updates, and writes no fetch refspec. A normal clone with its
  // git dir placed at .bare gets the standard refspec, origin/*, and a tracking default
  // branch; flipping core.bare makes every checkout a peer worktree.
  run("git", ["clone", "--quiet", "--no-checkout", `--separate-git-dir=${join(container, ".bare")}`, url, container]);
  git(join(container, ".bare"), "config", "core.bare", "true");
  initContainerFiles(container); // replaces clone's absolute gitdir pointer
  const def = defaultBranch(container);
  if (!gitTry(container, "rev-parse", "--verify", "--quiet", `refs/heads/${def}`).ok) {
    log(`cloned into ${container}; the remote has no commits yet, so no worktree was created`);
    return container;
  }
  git(container, "worktree", "add", flatten(def), def);
  reportSync(sync(container));
  log(`cloned ${url} into ${container}, worktree ${flatten(def)}/ on ${def}`);
  return container;
}

// ---------------------------------------------------------------- add

/** What to pass after `worktree add <folder>` / `checkout` to land on a branch: options, then the ref. */
type Checkout = { opts: string[]; ref: string; note?: string };

/** The local branch, else <remote>/<branch> tracked from whichever remote has it, else a new
 *  branch from `from` or the default branch. `remoteDefault` prefers <remote>/<default> over the
 *  local default, for callers that just fetched and know the local one may be stale. */
function planCheckout(container: string, branch: string, from?: string, remote?: string, remoteDefault = false): Checkout {
  if (from && remote) fail("--from starts a new branch and --remote tracks an existing one; pass only one");
  const has = (ref: string) => gitTry(container, "rev-parse", "--verify", "--quiet", ref).ok;
  // Which remotes carry a branch; a remote name can't be read off a ref, since it may contain '/'.
  const remotes = git(container, "remote").split("\n").filter(Boolean);
  const on = (b: string) => remotes.filter((r) => has(`refs/remotes/${r}/${b}`));

  const carriers = on(branch);
  if (has(`refs/heads/${branch}`)) {
    if (from || remote) fail(`branch ${branch} already exists locally; --from and --remote only apply when creating it`);
    return { opts: [], ref: branch };
  }
  if (!from && (remote || carriers.length)) {
    if (remote && !carriers.includes(remote)) {
      fail(`${remote}/${branch} does not exist${carriers.length ? `; it is on ${carriers.join(", ")}` : remotes.includes(remote) ? " (git fetch first?)" : `: no remote named ${remote}`}`);
    }
    if (!remote && carriers.length > 1) fail(`${branch} exists on ${carriers.join(", ")}; pick one with --remote <name>`);
    const r = remote ?? carriers[0];
    return { opts: ["--track", "-b", branch], ref: `${r}/${branch}`, note: `tracking ${r}/${branch}` };
  }
  const def = defaultBranch(container);
  // After convert on a feature branch the default may exist only on a remote (origin preferred).
  const defRemotes = on(def).sort((a, b) => Number(b === "origin") - Number(a === "origin"));
  const local = has(`refs/heads/${def}`) ? def : undefined;
  const tracked = defRemotes[0] ? `${defRemotes[0]}/${def}` : undefined;
  const start = from ?? (remoteDefault ? tracked ?? local : local ?? tracked)
    ?? fail(`default branch ${def} not found locally or on any remote; pass --from <start>`);
  return { opts: ["--no-track", "-b", branch], ref: start, note: `created new branch ${branch} from ${start}` };
}

function folderFree(container: string, folder: string, branch: string) {
  if (!existsSync(folder)) return;
  const owner = worktrees(container).find((w) => w.path === folder);
  fail(owner?.branch && owner.branch !== branch
    ? `${folder} is already the worktree for ${owner.branch}, which flattens to the same folder name`
    : `${folder} already exists${owner ? ` (worktree for ${owner.branch ?? "a detached HEAD"})` : ""}`);
}

export function add(container: string, branch: string, from?: string, remote?: string, fresh = false): string {
  const folder = join(container, flatten(branch));
  folderFree(container, folder, branch);
  git(container, "worktree", "prune");
  if (!fresh) {
    const merged = findMerged(container);
    if (merged) {
      const name = basename(merged.wt.path);
      log(`reusing ${name}/: ${merged.wt.branch} was merged in ${merged.repo}#${merged.pr} (pass --fresh for a new worktree)`);
      try {
        return reuse(container, merged.wt.path, branch, from, remote, merged);
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        log(`not reusing ${name}/ after all, nothing changed: ${e.message}`);
      }
    }
  }
  const plan = planCheckout(container, branch, from, remote);
  git(container, "worktree", "add", ...plan.opts, folder, plan.ref);
  if (plan.note) log(plan.note);
  reportSync(sync(container, { only: [folder] }));
  log(`worktree ${flatten(branch)}/ on ${branch}`);
  return folder;
}

// ---------------------------------------------------------------- reuse

/** Why a worktree can't be handed to another branch, or undefined when it can. Ignored files
 *  (node_modules, build output) are what reuse exists to keep, so only tracked changes and
 *  untracked-but-not-ignored files count; shared paths are git-wt's own and never count. */
function notReusable(container: string, wt: Worktree): string | undefined {
  if (wt.locked) return "is locked";
  // Shared links are relative to a folder directly in the container; elsewhere they'd dangle after the move.
  if (dirname(wt.path) !== container) return "sits outside the container folder";
  // `git worktree move` refuses these; finding out after the checkout means a rollback.
  if (gitTry(wt.path, "submodule", "status").out.split("\n").some((l) => l && !l.startsWith("-"))) return "has populated submodules, which git cannot move";
  for (const f of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
    if (existsSync(resolve(wt.path, git(wt.path, "rev-parse", "--git-path", f)))) return `has an operation in progress (${f})`;
  }
  const { link, copy } = readShared(container);
  const ours = [...link, ...copy];
  const dirty = git(wt.path, "status", "--porcelain").split("\n").filter(Boolean)
    .filter((l) => !ours.some((p) => l.slice(3).replace(/\/$/, "") === p || l.slice(3).startsWith(p + "/")));
  return dirty.length ? `has uncommitted changes or untracked files:\n  ${dirty.join("\n  ")}` : undefined;
}

/** Paths present in `dir` but untracked there (ignored files, shared links and copies) that
 *  checking out `ref` would replace with tracked ones. Git overwrites those without asking. */
function wouldOverwrite(dir: string, ref: string): string[] {
  const tracked = new Set(git(dir, "ls-files", "-z").split("\0").filter(Boolean));
  const seen = new Map<string, boolean>();
  const inTheWay = (p: string, isLeaf: boolean): boolean => {
    if (tracked.has(p)) return false;
    const key = `${isLeaf}:${p}`;
    if (!seen.has(key)) {
      const st = lstatOrNull(join(dir, p));
      // A leaf is in the way if anything sits there; a parent only if it isn't a directory.
      seen.set(key, !!st && (isLeaf || !st.isDirectory()));
    }
    return seen.get(key)!;
  };
  const hits = new Set<string>();
  for (const p of git(dir, "ls-tree", "-r", "-z", "--name-only", ref).split("\0").filter(Boolean)) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (inTheWay(parent, false)) hits.add(parent);
    }
    if (inTheWay(p, true)) hits.add(p);
  }
  return [...hits];
}

/** `merged` is the old branch's proof when the caller already has one; otherwise reuse asks gh. */
export function reuse(container: string, which: string, branch: string, from?: string, remote?: string, merged?: Proof): string {
  const all = worktrees(container);
  const paths = [existsSync(which) ? realpathSync(which) : "", join(container, which), join(container, flatten(which))];
  const wt = all.find((w) => paths.includes(w.path)) ?? all.find((w) => w.branch === which)
    ?? fail(`no worktree "${which}" in ${container}; name it by folder, path or branch`);
  const folder = join(container, flatten(branch));
  if (folder !== wt.path) folderFree(container, folder, branch);
  const why = notReusable(container, wt);
  if (why) refuse(`${wt.path} ${why}\nreuse keeps ignored files only; commit, stash or remove the rest first`);

  // Reuse usually follows a merge, so the local default branch is behind: fetch, then start new
  // branches from the remote's default. Offline still works, from whatever refs are local.
  const fetched = gitTry(container, "fetch", "--all", "--prune", "--quiet");
  if (!fetched.ok) log(`warning: fetch failed, using local refs:\n  ${fetched.err.trim()}`);
  git(container, "worktree", "prune");
  const plan = planCheckout(container, branch, from, remote, true);
  const was = wt.branch ?? wt.head!;
  const clobbered = wouldOverwrite(wt.path, plan.ref);
  if (clobbered.length) {
    refuse(`${plan.ref} tracks paths that exist untracked in ${wt.path}, and checking it out would overwrite them:\n  ${clobbered.join("\n  ")}\nmove them aside first, or start a fresh worktree`);
  }

  // Checkout before the move: it is the step that can still refuse (branch in use elsewhere),
  // and undoing it is one checkout.
  git(wt.path, "checkout", "--quiet", ...plan.opts, plan.ref);
  if (folder !== wt.path) {
    try {
      inject("move");
      git(container, "worktree", "move", wt.path, folder);
    } catch (e) {
      const back = gitTry(wt.path, "checkout", "--quiet", ...(wt.branch ? [wt.branch] : ["--detach", wt.head!]));
      // A branch this call created holds no commits yet; anything else is left alone.
      if (back.ok && plan.opts.includes("-b")) gitTry(container, "branch", "-D", branch);
      throw new Fail(`${(e as Error).message}\n${back.ok ? `${wt.path} is back on ${was}` : `could not switch ${wt.path} back to ${was}: ${back.err.trim()}`}`);
    }
  }
  if (plan.note) log(plan.note);
  // Links are relative and every worktree sits at the same depth, so the moved ones still resolve;
  // this only adds entries .shared gained since.
  try {
    reportSync(sync(container, { only: [folder] }));
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    throw new Fail(`worktree ${basename(wt.path)}/ is now ${flatten(branch)}/ on ${branch}, but its shared files need attention:\n${e.message}`);
  }
  if (wt.branch && wt.branch !== branch) dropReused(container, wt.branch, wt.head!, merged);
  log(`worktree ${basename(wt.path)}/ is now ${flatten(branch)}/ on ${branch}`);
  const cwd = process.cwd();
  if (cwd === wt.path || cwd.startsWith(wt.path + sep)) log(`your shell's directory moved; run: cd ${JSON.stringify(join(folder, relative(wt.path, cwd)))}`);
  return folder;
}

/** `owner/repo` on github.com, from a clone URL, or undefined for any other host. */
export function githubRepo(url: string): string | undefined {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** GitHub repos behind the container's remotes, each with one remote to fetch PR heads from. Read
 *  raw from config: `git remote get-url` applies url.*.insteadOf, which can hide the GitHub address. */
function githubRemotes(container: string): GithubRemote[] {
  const byRepo = new Map<string, string>();
  for (const line of gitTry(container, "config", "--get-regexp", "^remote\\..*\\.url$").out.split("\n").filter(Boolean)) {
    const [, remote, url] = /^remote\.(.*)\.url\s+(.*)$/.exec(line) ?? [];
    const repo = url && githubRepo(url);
    if (repo && !byRepo.has(repo)) byRepo.set(repo, remote);
  }
  return [...byRepo].map(([repo, remote]) => ({ repo, remote }));
}

type GithubRemote = { repo: string; remote: string };
/** A merged PR whose head commit is a branch's tip or descends from it. */
type Proof = { repo: string; pr: number; mergedAt: string; base?: string };
type Merged = Proof & { wt: Worktree };
/** A merged PR of the branch that lacks `ahead` commits the branch made after it. */
type Miss = { repo: string; pr: number; ahead: number };
/** gh's reply, shaped like spawnSync's result so the sync and async routes share one reader. */
type GhReply = { error?: Error; status: number | null; stdout: string; stderr: string };

const gh = () => process.env.GIT_WT_GH ?? "gh"; // tests point this at a fake
const mergedPrsArgs = (repo: string, branch: string) =>
  ["pr", "list", "--repo", repo, "--head", branch, "--state", "merged", "--json", "number,headRefOid,mergedAt,baseRefName", "--limit", "20"];
const askSync = (remotes: GithubRemote[], branch: string): [GithubRemote, GhReply][] =>
  remotes.map((r) => [r, spawnSync(gh(), mergedPrsArgs(r.repo, branch), { encoding: "utf8" })]);

function askAsync(args: string[], timeoutMs = 60_000): Promise<GhReply> {
  return new Promise((done) => {
    const p = spawn(gh(), args);
    let stdout = "", stderr = "";
    p.stdout.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
    p.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
    const timer = setTimeout(() => {
      p.kill();
      done({ error: new Error(`gh gave no answer within ${timeoutMs / 1000}s`), status: null, stdout, stderr });
    }, timeoutMs);
    p.on("error", (error) => { clearTimeout(timer); done({ error, status: null, stdout, stderr }); });
    p.on("close", (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
}

/** The most recently merged PR that contains `branch` at `tip`, so commits made after the merge
 *  disqualify it; undefined when there is none, or why gh couldn't say. `replies` holds gh's
 *  answer from each GitHub remote. Merged PRs that miss commits made after them go to `misses`. */
function mergedProof(container: string, branch: string, tip: string, replies: [GithubRemote, GhReply][], misses?: Miss[]): Proof | string | undefined {
  const known = (oid: string) => gitTry(container, "cat-file", "-e", `${oid}^{commit}`).ok;
  let best: Proof | undefined;
  for (const [{ repo, remote }, r] of replies) {
    if (r.error || r.status !== 0) return `cannot ask GitHub for merged PRs (${r.error?.message ?? (r.stderr || r.stdout).trim()})`;
    let prs: { number: number; headRefOid: string; mergedAt: string; baseRefName?: string }[];
    try {
      prs = JSON.parse(r.stdout);
      if (!Array.isArray(prs)) throw new Error("not a list");
    } catch (e) {
      return `gh pr list gave unreadable output (${(e as Error).message})`;
    }
    for (const pr of prs) {
      // A head made on GitHub (an applied review suggestion) or pushed from elsewhere isn't local,
      // and its branch may be deleted; GitHub keeps every PR head at refs/pull/<n>/head.
      if (pr.headRefOid !== tip && !known(pr.headRefOid)) {
        gitTry(container, "fetch", "--quiet", remote, `refs/pull/${pr.number}/head`);
        if (!known(pr.headRefOid)) {
          log(`warning: cannot fetch the head of ${repo}#${pr.number}, so ${branch} is not counted as merged`);
          continue;
        }
      }
      const contained = pr.headRefOid === tip || gitTry(container, "merge-base", "--is-ancestor", tip, pr.headRefOid).ok;
      if (contained && (!best || pr.mergedAt > best.mergedAt)) best = { repo, pr: pr.number, mergedAt: pr.mergedAt, base: pr.baseRefName };
      if (!contained) misses?.push({ repo, pr: pr.number, ahead: Number(gitTry(container, "rev-list", "--count", `${pr.headRefOid}..${tip}`).out) });
    }
  }
  return best;
}

/** The clean worktree whose branch was merged most recently on GitHub (see mergedProof). The
 *  default branch's worktree is never a candidate. */
function findMerged(container: string): Merged | undefined {
  const remotes = githubRemotes(container);
  if (!remotes.length) return;
  const defaults = defaultBranches(container);
  const candidates = worktrees(container).filter((w) => w.branch && !defaults.has(w.branch) && w.head && !notReusable(container, w));
  let best: Merged | undefined;
  for (const wt of candidates) {
    const p = mergedProof(container, wt.branch!, wt.head!, askSync(remotes, wt.branch!));
    if (typeof p === "string") return void log(`warning: ${p}; not reusing a worktree`);
    if (p && (!best || p.mergedAt > best.mergedAt)) best = { ...p, wt };
  }
  return best;
}

/** After a reuse, delete the worktree's old branch if a merged PR contains it; otherwise keep it. */
function dropReused(container: string, branch: string, tip: string, known?: Proof) {
  const kept = () => log(`${branch} is still a local branch; nothing was deleted`);
  // A release PR from master into production would otherwise count as proof.
  if (defaultBranches(container).has(branch)) return kept();
  const remotes = githubRemotes(container);
  const p = known ?? (remotes.length ? mergedProof(container, branch, tip, askSync(remotes, branch)) : undefined);
  if (typeof p === "string") log(`warning: ${p}`);
  if (!p || typeof p === "string") return kept();
  const del = gitTry(container, "branch", "-D", branch);
  if (!del.ok) return log(`warning: ${branch} was merged in ${prRef(p)} but could not be deleted: ${del.err.trim()}`);
  log(`deleted ${branch} (was ${git(container, "rev-parse", "--short", tip)}; merged in ${prRef(p)})`);
}

const prRef = (p: Proof) => `${p.repo}#${p.pr}${p.base ? ` into ${p.base}` : ""}`;

/** Branches never deleted, with why: the default per .bare/HEAD, plus each remote's HEAD, which stays
 *  right when .bare/HEAD doesn't (after convert on a feature branch, or a default renamed on GitHub). */
function defaultBranches(container: string): Map<string, string> {
  const map = new Map<string, string>();
  const head = gitTry(container, "symbolic-ref", "--short", "HEAD");
  if (head.ok) map.set(head.out, "default branch");
  for (const r of git(container, "remote").split("\n").filter(Boolean)) {
    const t = gitTry(container, "symbolic-ref", "--short", `refs/remotes/${r}/HEAD`);
    const b = t.ok && t.out.startsWith(`${r}/`) ? t.out.slice(r.length + 1) : "";
    if (b && !map.has(b)) map.set(b, `default branch of ${r}`);
  }
  return map;
}

/** Branches some worktree holds, with which one: checked out, or mid-rebase or mid-bisect, which git
 *  lists as a detached HEAD. Read from the admin dirs, so a worktree whose folder is missing still counts. */
function busyBranches(container: string): Map<string, string> {
  const bare = join(container, ".bare");
  const admin = join(bare, "worktrees");
  const dirs = [bare, ...(existsSync(admin) ? readdirSync(admin).map((n) => join(admin, n)) : [])];
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");
  const map = new Map<string, string>();
  for (const d of dirs) {
    // <admin>/gitdir names the worktree's .git file, relative to the admin dir with relative worktrees.
    const folder = d === bare ? container : dirname(resolve(d, read(join(d, "gitdir"))));
    const where = `${folder === container ? "the container" : `${relative(container, folder).startsWith("..") ? folder : relative(container, folder)}/`}${existsSync(folder) ? "" : " (folder missing)"}`;
    const held: [string, string][] = [
      ["checked out", read(join(d, "HEAD")).replace(/^ref: /, "")],
      ["rebasing", read(join(d, "rebase-merge", "head-name"))],
      ["rebasing", read(join(d, "rebase-apply", "head-name"))],
      ["bisecting", read(join(d, "BISECT_START")).replace(/^(?!refs\/)/, "refs/heads/")], // bisect stores a bare name
    ];
    for (const [how, ref] of held) {
      const b = ref.startsWith("refs/heads/") ? ref.slice(11) : "";
      if (b && !map.has(b)) map.set(b, `${how} in ${where}`);
    }
  }
  return map;
}

// ---------------------------------------------------------------- prune

type Branch = { name: string; tip: string; short: string; upstream: string; gone: boolean };

/** Run `fn` over `items` with at most `width` running at once, keeping the order. */
async function mapLimit<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const countFiles = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(join(dir, e.name)) : 1), 0);
/** Remove a tree of empty folders bottom-up. rmdir refuses a folder holding anything, so a file
 *  written since it was counted stops the removal instead of being lost. */
const removeEmpty = (dir: string): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmpty(join(dir, e.name));
  rmdirSync(dir);
};

export async function prune(container: string, { yes = false, gone = false } = {}): Promise<void> {
  // No `git worktree prune`: it drops the registration of a worktree whose folder is only missing
  // for now (an unmounted volume), which would free its branch for deletion.
  const fetched = gitTry(container, "fetch", "--all", "--prune", "--quiet");
  if (!fetched.ok) log(`warning: fetch failed, so "upstream gone" is as of the last fetch:\n  ${fetched.err.trim()}`);
  const defaults = defaultBranches(container);
  const busy = busyBranches(container);
  const { link, copy } = readShared(container); // read first: a bad .shared must fail before any deletion
  const branches: Branch[] = git(container, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(objectname:short)%00%(upstream)%00%(upstream:track)", "refs/heads")
    .split("\n").filter(Boolean).map((line) => {
      const [ref, tip, short, upstream, track] = line.split("\0");
      return { name: ref.replace(/^refs\/heads\//, ""), tip, short, upstream, gone: track === "[gone]" };
    });
  const candidates = branches.filter((b) => !defaults.has(b.name) && !busy.has(b.name));

  const remotes = githubRemotes(container);
  if (!remotes.length) log("no GitHub remote, so no branch can be shown merged; --gone deletes branches whose upstream is gone");
  // One gh call per branch and remote, ~0.5s each; a backlog of 100 branches would take a minute in a row.
  const replies = await mapLimit(candidates, 8, (b) =>
    Promise.all(remotes.map(async (r): Promise<[GithubRemote, GhReply]> => [r, await askAsync(mergedPrsArgs(r.repo, b.name))])));
  const misses: Miss[][] = candidates.map(() => []);
  const proofs = candidates.map((b, i) => mergedProof(container, b.name, b.tip, replies[i], misses[i]));
  const errors = proofs.filter((p) => typeof p === "string");
  if (errors.length) log(`warning: ${errors[0]}${errors.length > 1 ? `, and ${errors.length - 1} more like it` : ""}; those branches count as not merged`);

  // Every branch lands in exactly one list, with the reason that put it there.
  const merged: [Branch, Proof][] = [];
  const goneOnly: [Branch, string][] = [];
  const kept: [Branch, string][] = [];
  const index = new Map(candidates.map((b, i) => [b.name, i]));
  for (const b of branches) {
    const i = index.get(b.name);
    if (i === undefined) {
      kept.push([b, defaults.get(b.name) ?? busy.get(b.name)!]);
      continue;
    }
    const p = proofs[i];
    if (p && typeof p !== "string") {
      merged.push([b, p]);
      continue;
    }
    const miss = misses[i].sort((x, y) => x.ahead - y.ahead)[0];
    const unmerged = p ? "GitHub not asked (see warning)"
      : miss ? `${miss.repo}#${miss.pr} merged, but ${miss.ahead} commit${miss.ahead === 1 ? "" : "s"} came after it`
      : "no merged PR";
    if (b.gone) goneOnly.push([b, `upstream gone, ${unmerged}`]);
    else kept.push([b, `${b.upstream ? `tracking ${b.upstream.replace(/^refs\/remotes\//, "")}` : "no upstream"}, ${unmerged}`]);
  }

  const failed: string[] = [];
  const drop = (b: Branch, why: string) => {
    // The gh calls took a while; a branch that moved since is not the one that was checked.
    if (gitTry(container, "rev-parse", "--verify", "--quiet", `refs/heads/${b.name}`).out !== b.tip) {
      return void failed.push(`${b.name}: moved since prune read it at ${b.short}; left alone`);
    }
    const r = gitTry(container, "branch", "-D", b.name);
    if (r.ok) log(`deleted ${b.name} (was ${b.short}; ${why})`);
    else failed.push(`${b.name}: ${r.err.trim()}`);
  };
  const width = Math.min(50, Math.max(0, ...branches.map((b) => b.name.length)));
  const list = (title: string, rows: [Branch, string][]) => {
    if (rows.length) log(`${title} (${rows.length}):\n${rows.map(([b, why]) => `  ${b.name.padEnd(width)}  ${b.short}  ${why}`).join("\n")}`);
  };

  if (yes) for (const [b, p] of merged) drop(b, `merged in ${prRef(p)}`);
  else list("deleted by --yes", merged.map(([b, p]) => [b, `merged in ${prRef(p)}`]));
  if (yes && gone) for (const [b, why] of goneOnly) drop(b, why);
  else list(yes ? "kept without --gone" : "deleted by --yes --gone", goneOnly);
  list("kept", kept);

  // Folders here that aren't worktrees: what git worktree remove leaves when something wrote into
  // the folder after removal. Empty ones go; anything with files is left for a person to look at.
  const roots = new Set([...link, ...copy].map((p) => p.split(sep)[0]));
  const treePaths = new Set(worktrees(container).map((w) => w.path));
  let empty = 0;
  for (const e of readdirSync(container, { withFileTypes: true })) {
    const dir = join(container, e.name);
    if (!e.isDirectory() || e.name.startsWith(".") || roots.has(e.name) || treePaths.has(dir)) continue;
    const files = countFiles(dir);
    if (files) log(`not a worktree, left alone: ${e.name}/ holds ${files} file${files === 1 ? "" : "s"}`);
    else if (!yes) {
      empty++;
      log(`not a worktree, removed by --yes: ${e.name}/ (empty)`);
    } else {
      try {
        removeEmpty(dir);
        log(`removed empty folder ${e.name}/`);
      } catch (err) {
        failed.push(`${e.name}/: ${(err as Error).message}`);
      }
    }
  }

  if (failed.length) fail(`could not delete:\n  ${failed.join("\n  ")}`);
  if (yes) return;
  const would = [
    merged.length && `${merged.length} merged branch${merged.length === 1 ? "" : "es"}`,
    empty && `${empty} empty folder${empty === 1 ? "" : "s"}`,
  ].filter(Boolean);
  if (would.length) log(`nothing changed; run again with --yes to delete ${would.join(" and ")}${goneOnly.length ? `, and add --gone for the ${goneOnly.length} upstream-gone one${goneOnly.length === 1 ? "" : "s"}` : ""}`);
  else if (goneOnly.length) log(`nothing changed; --yes --gone deletes the ${goneOnly.length} upstream-gone branch${goneOnly.length === 1 ? "" : "es"}`);
}

// ---------------------------------------------------------------- open

/** Run a command for what it does, with its output on stderr so stdout stays free for the path. */
function runAside(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, stdio: ["inherit", 2, 2] });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed in ${cwd} (exit ${r.status})`);
}
const onPath = (cmd: string) => !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
const sameFile = (a: string, b: string) => existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);

const LOCKFILES: [string, string][] = [["yarn.lock", "yarn"], ["pnpm-lock.yaml", "pnpm"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];

/** Copy the project's MCP server approvals (Claude Code's settings.local.json) from one worktree to
 *  another that recorded none, so a new worktree starts without the approval prompt. */
function inheritMcpDecisions(from: string, to: string) {
  const src = join(from, ".claude", "settings.local.json");
  const dst = join(to, ".claude", "settings.local.json");
  if (!existsSync(src) || sameFile(src, dst)) return;
  const readJson = (p: string) => {
    try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { return fail(`${p}: ${(e as Error).message}`); }
  };
  const keys = ["enabledMcpjsonServers", "disabledMcpjsonServers"];
  const target = existsSync(dst) ? readJson(dst) : {};
  if (keys.some((k) => k in target)) return;
  const source = readJson(src);
  const picked = keys.filter((k) => source[k] != null);
  if (!picked.length) return;
  for (const k of picked) target[k] = source[k];
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(`${dst}.git-wt-tmp`, `${JSON.stringify(target, null, 2)}\n`);
  renameSync(`${dst}.git-wt-tmp`, dst);
  log(`copied ${picked.join(" and ")} from ${basename(from)}/`);
}

/** The worktree for `branch`, made ready to work in: created (or reused) when missing, its
 *  dependencies installed, its MCP approvals inherited. Returns its path; logs go to stderr. */
export function open(container: string, branch: string, opts: { from?: string; remote?: string; fresh?: boolean } = {}): string {
  const all = worktrees(container);
  const od = gitTry(container, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  const def = od.ok ? od.out.replace(/^origin\//, "") : defaultBranch(container);
  const defWt = all.find((w) => w.branch === def)?.path;
  let wt = all.find((w) => w.branch === branch)?.path;
  const created = !wt;
  if (!wt) {
    let from = opts.from;
    // A new branch should start from the remote's latest default, not a stale local one.
    if (defWt && git(defWt, "status", "--porcelain") === "") {
      runAside("git", ["pull", "--ff-only"], defWt);
    } else {
      const remotes = git(container, "remote").split("\n").filter(Boolean);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (remote) {
        runAside("git", ["fetch", remote], container);
        const has = (ref: string) => gitTry(container, "rev-parse", "--verify", "--quiet", ref).ok;
        const exists = has(`refs/heads/${branch}`) || remotes.some((r) => has(`refs/remotes/${r}/${branch}`));
        if (!from && !opts.remote && !exists && has(`refs/remotes/${remote}/${def}`)) from = `${remote}/${def}`;
      }
    }
    wt = add(container, branch, from, opts.remote, opts.fresh);
  }

  const envrc = join(wt, ".envrc");
  if (sameFile(envrc, join(container, ".envrc")) && onPath("direnv")) runAside("direnv", ["allow", wt], wt);
  // A reused worktree keeps the previous branch's node_modules, so it installs too.
  if (created || !existsSync(join(wt, "node_modules"))) {
    const pm = LOCKFILES.find(([file]) => existsSync(join(wt!, file)));
    if (pm) runAside(pm[1], ["install"], wt);
  }
  if (defWt) inheritMcpDecisions(defWt, wt);
  return wt;
}

// ---------------------------------------------------------------- convert

const journalFor = (top: string) => `${top}.git-wt-convert.json`;

/** A convert killed mid-way (SIGKILL, power loss) leaves a journal; roll it back first. */
function resumeInterrupted(path: string): void {
  const p = resolve(path);
  for (const top of [p, p.replace(/\.pre-wt$/, ""), dirname(p)]) {
    const journal = journalFor(top);
    if (!existsSync(journal)) continue;
    let state: ConvertState;
    try {
      state = JSON.parse(readFileSync(journal, "utf8"));
    } catch (e) {
      fail(`found an interrupted convert of ${top}, but its journal ${journal} is unreadable (${(e as Error).message}). Restore by hand: the tree is ${top}.pre-wt or a folder inside ${top}, the repository ${top}/.bare or ${top}.pre-wt/.git.`);
    }
    fail(`found an interrupted convert of ${top}. ${rollback(state!, journal)}\nOnce it is rolled back, run convert again.`);
  }
}

export function convert(path: string): string {
  resumeInterrupted(path);
  const top = git(resolve(path), "rev-parse", "--show-toplevel");
  const gitDir = join(top, ".git");
  if (!lstatOrNull(gitDir)?.isDirectory()) fail(`${top}/.git is not a directory; convert needs a plain (non-worktree) checkout`);
  git(top, "worktree", "prune"); // stale entries for deleted folders would otherwise pin their branches
  const others = worktrees(top).filter((w) => w.path !== top);
  const locked = others.filter((w) => w.locked).map((w) => w.path);
  if (locked.length) fail(`linked worktrees are locked; unlock them first (git worktree unlock): ${locked.join(", ")}`);
  if (existsSync(join(gitDir, "modules"))) fail(`${top} has submodules; their gitdirs would not survive the move`);
  for (const f of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
    if (existsSync(join(gitDir, f))) fail(`an operation is in progress (${f}); finish or abort it first`);
  }
  if (git(top, "status", "--porcelain", "--untracked-files=no")) fail(`uncommitted changes to tracked files; commit or stash them first`);
  const branchR = gitTry(top, "symbolic-ref", "--short", "HEAD");
  if (!branchR.ok) fail("HEAD is detached; check out a branch first");
  const branch = branchR.out;
  const stashes = git(top, "stash", "list", "--format=%H %gs");
  const head = git(top, "rev-parse", "HEAD");

  const old = `${top}.pre-wt`;
  if (existsSync(old)) fail(`${old} already exists; it is the staging name convert needs`);
  const flat = flatten(branch);
  // Existing linked worktrees move into the container too, named like `add` would name them.
  const taken = new Set([flat, ".bare", ".git", ".shared"]);
  const within = (p: string, dir: string) => p.startsWith(dir + sep);
  const host = others.find((w) => within(top, w.path));
  if (host) fail(`${top} sits inside its own linked worktree ${host.path}; move one of them apart first`);
  // Outermost first: a worktree nested in the main tree or in an earlier linked one travels
  // with it, so its source is wherever its innermost moved ancestor ends up.
  const movers: { orig: string; now: string }[] = [{ orig: top, now: join(top, flat) }];
  const linked = [...others].sort((a, b) => a.path.length - b.path.length).map((w) => {
    const name = w.branch ? flatten(w.branch) : basename(w.path);
    if (taken.has(name)) fail(`linked worktree ${w.path} would become ${join(top, name)}, which is already taken; move or rename it first`);
    taken.add(name);
    const anc = movers.filter((m) => within(w.path, m.orig)).sort((a, b) => b.orig.length - a.orig.length)[0];
    const to = join(top, name);
    movers.push({ orig: w.path, now: to });
    const link = readFileSync(join(w.path, ".git"), "utf8").replace(/^gitdir: /, "").trim();
    return {
      orig: w.path, from: anc ? join(anc.now, relative(anc.orig, w.path)) : w.path, to,
      head: w.head ?? "", branch: w.branch, relative: !isAbsolute(link),
    };
  });
  // Convert requires .git at the top level, so any core.worktree can only name this same
  // tree: redundant here, and contradictory next to core.bare. Dropped (rollback restores config).
  const coreWorktree = gitTry(top, "config", "--local", "--get", "core.worktree").out || undefined;
  // Sparse checkout turns this on. Then per-worktree settings live in config.worktree,
  // so core.bare must go there too, or every linked worktree would read it as bare.
  const worktreeConfig = gitTry(top, "config", "--get", "--type=bool", "extensions.worktreeConfig").out === "true";
  const x: ConvertState = {
    top, old, wt: join(top, flat), bare: join(top, ".bare"),
    adminDir: "", // set from git's own answer after `worktree add`; a guess could name another worktree's
    moved: [],
    wroteBareWorktreeConfig: false,
    // Rollback writes this back verbatim: core.bare, core.worktree, and the relative-paths
    // extension (which older git can't read) all come off together.
    config: readFileSync(join(gitDir, "config"), "utf8"),
    linked,
  };
  const { wt, bare } = x;
  // Write-ahead: the journal records each step before it happens, so a hard kill at any
  // point leaves enough for the next run to roll back. Rollback tolerates steps not taken.
  const journal = journalFor(top);
  const save = () => { // atomic: a kill mid-write must not leave half a journal
    writeFileSync(`${journal}.tmp`, JSON.stringify(x));
    renameSync(`${journal}.tmp`, journal);
  };
  const move = (from: string, to: string) => {
    if (!existsSync(from)) return;
    x.moved.push([from, to]);
    save();
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  };
  // Ctrl-C would otherwise kill us between two renames. With a listener installed the
  // signal no longer terminates; Bun delivers it to JS only after this synchronous run, so
  // the listener stays for the life of the process. Ctrl-C still reaches the git child in
  // the foreground group, so that step fails and the normal rollback runs.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => {});

  // Every step is a rename, so nothing is copied or deleted and each step can be reversed.
  // `rename(2)` can't move a directory into its own child, hence the .pre-wt staging name.
  save();
  try {
    renameSync(top, old);
  } catch (e) {
    rmSync(journal, { force: true }); // nothing has changed yet
    fail(`cannot rename ${top} to ${old}: ${(e as Error).message}`);
  }
  try {
    inject("early");
    mkdirSync(top);
    renameSync(join(old, ".git"), bare);
    if (worktreeConfig) {
      move(join(bare, "config.worktree"), join(bare, "config.worktree.git-wt")); // the old main worktree's settings
      x.wroteBareWorktreeConfig = true;
      save();
      git(bare, "config", "--worktree", "core.bare", "true");
    } else {
      git(bare, "config", "core.bare", "true");
    }
    if (coreWorktree !== undefined) git(bare, "config", "--unset", "core.worktree");
    initContainerFiles(top);
    inject("repo"); // .git is now .bare, the new worktree not yet registered
    git(top, "worktree", "add", "--no-checkout", flat, branch);
    x.adminDir = resolve(wt, readFileSync(join(wt, ".git"), "utf8").replace(/^gitdir: /, "").trim());
    save();
    renameSync(join(wt, ".git"), join(old, ".git")); // the new worktree's pointer file
    rmdirSync(wt);
    renameSync(old, wt);
    // The old index still matches the tree and keeps skip-worktree/assume-unchanged bits.
    move(join(bare, "index"), join(x.adminDir, "index"));
    // The old main worktree's own settings and sparse patterns now belong to this worktree.
    move(join(bare, "config.worktree.git-wt"), join(x.adminDir, "config.worktree"));
    move(join(bare, "info", "sparse-checkout"), join(x.adminDir, "info", "sparse-checkout"));
    // HEAD reflog is per-worktree; the old history replaces the one line `worktree add` wrote.
    move(join(bare, "logs", "HEAD"), join(x.adminDir, "logs", "HEAD"));
    // Linked worktrees: rename into the container, then let git fix both halves of the link.
    for (const l of x.linked) {
      renameSync(l.from, l.to);
      git(top, "worktree", "repair", l.to);
    }

    inject("late");
    const dirty = git(wt, "status", "--porcelain", "--untracked-files=no");
    if (dirty) fail(`new worktree shows tracked changes:\n${dirty}`);
    if (git(wt, "rev-parse", "HEAD") !== head) fail("new worktree HEAD differs from the old one");
    for (const l of x.linked) {
      // A branch with no commits yet (orphan) has no HEAD commit; staying on the branch is the check.
      const unborn = /^0+$/.test(l.head);
      const ok = (l.branch === undefined || gitTry(l.to, "symbolic-ref", "HEAD").out === `refs/heads/${l.branch}`)
        && (unborn || gitTry(l.to, "rev-parse", "HEAD").out === l.head);
      if (!ok) fail(`linked worktree ${l.to} is not on its old HEAD after repair`);
    }
    const after = git(wt, "stash", "list", "--format=%H %gs");
    if (after !== stashes) fail(`stash list changed:\nbefore:\n${stashes}\nafter:\n${after}`);
  } catch (e) {
    throw new Fail(`${(e as Error).message}\n\n${rollback(x, journal)}`);
  }
  rmSync(journal, { force: true });

  // .bare/HEAD still names the branch that was checked out; point it at the remote's default.
  const originHead = gitTry(top, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  // No reflog: the bare HEAD log was just grafted into the worktree and should stay gone.
  if (originHead.ok) git(top, "-c", "core.logAllRefUpdates=false", "symbolic-ref", "HEAD", `refs/heads/${originHead.out.replace(/^origin\//, "")}`);
  else log(`note: origin/HEAD is unknown, so new branches will start from ${branch}; run git remote set-head origin --auto to fix`);

  if (coreWorktree !== undefined) log(`removed core.worktree=${coreWorktree} (redundant, and it conflicts with core.bare)`);
  for (const l of x.linked) log(`moved linked worktree ${l.orig} -> ${l.to}`);
  const n = stashes ? stashes.split("\n").length : 0;
  log(`converted ${top}: worktree ${flat}/ on ${branch}, ${n} stash(es) intact`);
  if (process.cwd().startsWith(top)) log(`your shell's directory moved; run: cd ${JSON.stringify(wt)}`);
  return top;
}

type ConvertState = {
  top: string; old: string; wt: string; bare: string; adminDir: string;
  moved: [from: string, to: string][]; // per-worktree files relocated, in order
  wroteBareWorktreeConfig: boolean; // .bare/config.worktree is ours (holds only core.bare)
  config: string; // the original .git/config
  // Existing linked worktrees. `relative`: whether their .git link was relative before.
  linked: { orig: string; from: string; to: string; head: string; branch?: string; relative: boolean }[];
};

/** Reverse whatever convert got through, newest step first. Deletes the journal once the
 *  original is back, keeps it when a step stops. Returns a status line. */
function rollback({ top, old, wt, bare, adminDir, moved, wroteBareWorktreeConfig, config, linked }: ConvertState, journal: string): string {
  const done = (msg: string) => { rmSync(journal, { force: true }); return msg; };
  const stopped = (name: string, e: unknown) => {
    const tree = existsSync(old) ? old : lstatOrNull(join(top, ".git"))?.isDirectory() ? top : wt;
    const repo = existsSync(bare) ? bare : existsSync(join(old, ".git")) ? join(old, ".git") : join(top, ".git");
    return `ROLLBACK STOPPED at "${name}": ${(e as Error).message}\nState: tree in ${JSON.stringify(tree)}, repository in ${JSON.stringify(repo)}. Nothing was deleted. Journal kept at ${journal}.`;
  };
  // Point linked worktrees back at the restored repo, keeping each link's original form.
  // Idempotent, so it also runs when an earlier rollback stopped right before it.
  const relink = () => {
    for (const rel of [true, false]) {
      const paths = linked.filter((l) => l.relative === rel).map((l) => l.orig);
      if (paths.length) run("git", ["-c", `worktree.useRelativePaths=${rel}`, "worktree", "repair", ...paths], top);
    }
  };
  // The original is back in place (never touched, or a previous rollback got this far).
  // A real subdirectory may share wt's name here, so nothing below may run.
  if (!existsSync(old) && lstatOrNull(join(top, ".git"))?.isDirectory()) {
    try { relink(); } catch (e) { return stopped("linked worktrees relinked", e); }
    return done(`Nothing left to roll back: ${top} is the original checkout.`);
  }
  const steps: [string, () => void][] = [
    ["linked worktrees back", () => {
      for (const l of [...linked].reverse()) if (existsSync(l.to) && !existsSync(l.from)) renameSync(l.to, l.from);
    }],
    ["per-worktree settings back", () => {
      if (wroteBareWorktreeConfig) rmSync(join(bare, "config.worktree"), { force: true });
      // `to` can pre-exist (worktree add writes its own logs/HEAD), so only a missing `from`
      // proves the rename happened; a journaled-but-not-done move must not clobber it.
      for (const [from, to] of [...moved].reverse()) if (existsSync(to) && !existsSync(from)) renameSync(to, from);
    }],
    ["tree back", () => { if (!existsSync(old) && existsSync(wt)) renameSync(wt, old); }],
    ["worktree registration", () => {
      if (lstatOrNull(join(old, ".git"))?.isFile()) rmSync(join(old, ".git"));
      if (lstatOrNull(join(wt, ".git"))?.isFile()) rmSync(join(wt, ".git"));
      if (existsSync(wt)) rmdirSync(wt); // empty by now; fails loudly if not
      if (adminDir) rmSync(adminDir, { recursive: true, force: true }); // only ever the one git made for us
    }],
    ["repository back", () => {
      if (existsSync(bare)) {
        writeFileSync(join(bare, "config"), config);
        renameSync(bare, join(old, ".git"));
      }
    }],
    ["container files", () => {
      if (!existsSync(old)) return; // top is already the original again
      for (const f of [".git", ".shared"]) rmSync(join(top, f), { force: true });
      if (existsSync(top)) rmdirSync(top);
    }],
    ["original name", () => { if (existsSync(old)) renameSync(old, top); }],
    ["linked worktrees relinked", relink],
  ];
  for (const [name, step] of steps) {
    try { step(); } catch (e) { return stopped(name, e); }
  }
  return done(`Rolled back: ${top} is the original checkout again.`);
}

// ---------------------------------------------------------------- cli

const str = { type: "string" } as const;
const container = { type: "string", short: "C" } as const;
const OPTIONS = {
  clone: { dir: str, base: str, name: str },
  convert: {},
  add: { from: str, remote: str, fresh: { type: "boolean" }, C: container },
  reuse: { from: str, remote: str, C: container },
  sync: { reset: str, C: container },
  prune: { yes: { type: "boolean" }, gone: { type: "boolean" }, C: container },
  open: { from: str, remote: str, fresh: { type: "boolean" }, C: container },
} as const;

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") return log(USAGE);
  if (!(cmd in OPTIONS)) fail(`unknown command "${cmd}"\n\n${USAGE}`);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...OPTIONS[cmd as keyof typeof OPTIONS], help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  } catch (e) {
    fail(`${cmd}: ${(e as Error).message}`);
  }
  const { values, positionals: pos } = parsed!;
  if (values.help) return log(USAGE);
  const flags = values as Record<string, string | undefined>;
  switch (cmd) {
    case "clone":
      if (pos.length !== 1) fail("usage: git-wt clone <url> [--dir <path>] [--base <dir>] [--name <name>]");
      return void clone(pos[0], { dir: flags.dir, base: flags.base, name: flags.name });
    case "convert":
      if (pos.length > 1) fail("usage: git-wt convert [<path>]");
      return void convert(pos[0] ?? process.cwd());
    case "add":
      if (pos.length !== 1) fail("usage: git-wt add <branch> [--from <start> | --remote <name>] [--fresh] [-C <container>]");
      return void add(findContainer(flags.C ?? process.cwd()), pos[0], flags.from, flags.remote, Boolean(values.fresh));
    case "reuse":
      if (pos.length !== 2) fail("usage: git-wt reuse <worktree> <branch> [--from <start> | --remote <name>] [-C <container>]");
      return void reuse(findContainer(flags.C ?? process.cwd()), pos[0], pos[1], flags.from, flags.remote);
    case "sync":
      if (pos.length) fail("usage: git-wt sync [--reset <path>] [-C <container>]");
      return reportSync(sync(findContainer(flags.C ?? process.cwd()), { reset: flags.reset }));
    case "prune":
      if (pos.length) fail("usage: git-wt prune [--yes] [--gone] [-C <container>]");
      return prune(findContainer(flags.C ?? process.cwd()), { yes: Boolean(values.yes), gone: Boolean(values.gone) });
    case "open": {
      if (pos.length !== 1) fail("usage: git-wt open <branch> [--from <start> | --remote <name>] [--fresh] [-C <container>]");
      log = (msg) => console.error(msg);
      return void console.log(open(findContainer(flags.C ?? process.cwd()), pos[0], { from: flags.from, remote: flags.remote, fresh: Boolean(values.fresh) }));
    }
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    console.error(`git-wt: ${e.message}`);
    process.exit(1);
  }
}
