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
 * Subcommands: clone, convert, add, sync. Run with --help for usage.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const USAGE = `git-wt — bare-repo worktree containers

  git-wt clone <url> [--dir <path>] [--base <dir>] [--name <name>]
      Clone into <base>/<name> (base: $GIT_WT_BASE or ~/coding; name: from the URL),
      with .bare/, the .git pointer, every branch as origin/*, and a first worktree
      on the remote's default branch.

  git-wt convert [<path>]
      Turn a normal checkout (default: cwd) into a container in place. Refuses on
      uncommitted tracked changes. Copies the tree into the new worktree, proves it
      with diff -r and a stash comparison, grafts the old HEAD reflog, then deletes
      the old tree.

  git-wt add <branch> [--from <start>] [-C <container>]
      New worktree in <container>/<branch with / -> ->. Uses the local branch, else
      tracks origin/<branch>, else creates <branch> from --from (default: the
      default branch). Then links shared files into it.

  git-wt sync [-C <container>]
      Link every path in .shared into every worktree, git-exclude them, and remove
      links for paths no longer listed. Plans first; any conflict (a real file
      where a link belongs) aborts the whole sync with nothing changed.
`;

class Fail extends Error {}
const fail = (msg: string): never => { throw new Fail(msg); };
const log = (msg: string) => console.log(msg);

function run(cmd: string, args: string[], cwd?: string, allowFail = false) {
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
  const last = url.replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  return name || fail(`cannot derive a repo name from "${url}"; pass --name`);
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

function lstatOrNull(p: string) {
  try { return lstatSync(p); } catch { return null; }
}

// ---------------------------------------------------------------- container

function isContainer(dir: string): boolean {
  const s = lstatOrNull(join(dir, ".bare"));
  return !!s?.isDirectory() && existsSync(join(dir, ".bare", "HEAD"));
}

function findContainer(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (isContainer(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) fail(`no git-wt container (a directory holding .bare/) at or above ${start}`);
    dir = up;
  }
}

function initContainerFiles(container: string) {
  writeFileSync(join(container, ".git"), "gitdir: ./.bare\n");
  const shared = join(container, ".shared");
  if (!existsSync(shared)) {
    writeFileSync(shared, "# Paths shared by every worktree, relative to a worktree root. One per line.\n# The real file lives here in the container; `git-wt sync` symlinks it into each worktree.\n");
  }
}

type Worktree = { path: string; branch?: string };

function worktrees(container: string): Worktree[] {
  const out = git(container, "worktree", "list", "--porcelain");
  const list: Worktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.includes("bare") || lines.some((l) => l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
    list.push({ path, branch });
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

export function readShared(container: string): string[] {
  const file = join(container, ".shared");
  if (!existsSync(file)) return [];
  const entries: string[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const p = normalize(line).replace(/\/+$/, "");
    if (isAbsolute(p) || p === "." || p === ".." || p.startsWith(`..${sep}`)) fail(`.shared: "${line}" must be a relative path inside the worktree`);
    if ([".git", ".bare", ".shared"].includes(p.split(sep)[0])) fail(`.shared: "${line}" collides with git-wt's own files`);
    if (!entries.includes(p)) entries.push(p);
  }
  return entries;
}

function excludeFile(container: string) {
  return join(git(container, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "exclude");
}

function readManagedBlock(container: string): { before: string; entries: string[]; after: string } {
  const file = excludeFile(container);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const s = text.indexOf(BLOCK_START);
  const e = text.indexOf(BLOCK_END);
  if (s < 0 || e < s) return { before: text, entries: [], after: "" };
  const body = text.slice(s + BLOCK_START.length, e);
  const entries = body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/"))
    .map((l) => l.slice(1).replace(/\\(.)/g, "$1"));
  return { before: text.slice(0, s), entries, after: text.slice(e + BLOCK_END.length).replace(/^\n/, "") };
}

function writeManagedBlock(container: string, entries: string[]) {
  const file = excludeFile(container);
  const { before, after } = readManagedBlock(container);
  const escaped = entries.map((p) => "/" + p.replace(/([\\*?[\]!#])/g, "\\$1"));
  const block = entries.length ? `${BLOCK_START}\n${escaped.join("\n")}\n${BLOCK_END}\n` : "";
  const head = before && !before.endsWith("\n") ? before + "\n" : before;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, head + block + after);
}

type Action = { kind: "link" | "unlink"; path: string; target: string };

export function sync(container: string, only?: string[]): { actions: Action[]; warnings: string[] } {
  const entries = readShared(container);
  const previous = readManagedBlock(container).entries;
  const removed = previous.filter((p) => !entries.includes(p));
  const trees = worktrees(container).filter((w) => !only || only.includes(w.path));

  const actions: Action[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (!lstatOrNull(join(container, entry))) warnings.push(`${entry}: not present in the container root yet, no links made`);
  }

  for (const wt of trees) {
    for (const entry of entries) {
      const real = join(container, entry);
      if (!lstatOrNull(real)) continue;
      const link = join(wt.path, entry);
      const target = relative(dirname(link), real);
      const st = lstatOrNull(link);
      if (!st) { actions.push({ kind: "link", path: link, target }); continue; }
      if (st.isSymbolicLink()) {
        const cur = readlinkSync(link);
        if (resolve(dirname(link), cur) === real) continue;
        conflicts.push(`${link}: symlink points at ${cur}, not the shared ${real}`);
      } else {
        conflicts.push(`${link}: a real ${st.isDirectory() ? "directory" : "file"} sits where the shared link belongs`);
      }
    }
    for (const entry of removed) {
      const link = join(wt.path, entry);
      const st = lstatOrNull(link);
      if (st?.isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === join(container, entry)) {
        actions.push({ kind: "unlink", path: link, target: readlinkSync(link) });
      }
    }
  }

  if (conflicts.length) {
    fail(`sync aborted, nothing changed. Resolve these by hand, then rerun:\n  ${conflicts.join("\n  ")}`);
  }

  for (const a of actions) {
    if (a.kind === "link") {
      mkdirSync(dirname(a.path), { recursive: true });
      symlinkSync(a.target, a.path);
    } else {
      unlinkSync(a.path);
    }
  }
  // Only shrink the managed block when every worktree was visited, so a single-worktree
  // sync (from `add`) can't forget entries other worktrees still need pruned.
  writeManagedBlock(container, only ? [...new Set([...previous, ...entries])] : entries);
  return { actions, warnings };
}

function reportSync(r: { actions: Action[]; warnings: string[] }) {
  for (const a of r.actions) log(`${a.kind === "link" ? "linked  " : "unlinked"} ${a.path} -> ${a.target}`);
  for (const w of r.warnings) log(`warning: ${w}`);
  if (!r.actions.length) log("shared links already up to date");
}

// ---------------------------------------------------------------- clone

export function clone(url: string, opts: { dir?: string; base?: string; name?: string }): string {
  const base = expandHome(opts.base ?? process.env.GIT_WT_BASE ?? "~/coding");
  const container = resolve(opts.dir ? expandHome(opts.dir) : join(base, opts.name ?? repoName(url)));
  if (existsSync(container) && readdirSync(container).length) fail(`${container} already exists and is not empty`);
  // `git clone` resolves a relative local path against cwd; `remote add` stores it verbatim.
  if (existsSync(url)) url = resolve(url);
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
  // branches fetch never updates, and writes no fetch refspec. `remote add` writes the
  // standard refspec, so branches land only as origin/* and stay current.
  run("git", ["init", "--quiet", "--bare", join(container, ".bare")]);
  initContainerFiles(container);
  git(container, "remote", "add", "origin", url);
  git(container, "fetch", "origin");
  const head = gitTry(container, "remote", "set-head", "origin", "--auto");
  const originHead = gitTry(container, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (!head.ok || !originHead.ok) {
    log(`cloned into ${container}; the remote has no default branch yet, so no worktree was created`);
    return container;
  }
  const def = originHead.out.replace(/^origin\//, "");
  git(container, "symbolic-ref", "HEAD", `refs/heads/${def}`); // what `add --from` defaults to
  git(container, "worktree", "add", "--track", "-b", def, flatten(def), `origin/${def}`);
  reportSync(sync(container));
  log(`cloned ${url} into ${container}, worktree ${flatten(def)}/ on ${def}`);
  return container;
}

// ---------------------------------------------------------------- add

export function add(container: string, branch: string, from?: string): string {
  const folder = join(container, flatten(branch));
  if (existsSync(folder)) fail(`${folder} already exists`);
  const has = (ref: string) => gitTry(container, "rev-parse", "--verify", "--quiet", ref).ok;

  if (has(`refs/heads/${branch}`)) {
    if (from) fail(`branch ${branch} already exists; --from only applies to new branches`);
    git(container, "worktree", "add", folder, branch);
  } else if (has(`refs/remotes/origin/${branch}`) && !from) {
    git(container, "worktree", "add", "--track", "-b", branch, folder, `origin/${branch}`);
  } else {
    const start = from ?? defaultBranch(container);
    git(container, "worktree", "add", "-b", branch, folder, start);
    log(`created new branch ${branch} from ${start}`);
  }
  reportSync(sync(container, [folder]));
  log(`worktree ${flatten(branch)}/ on ${branch}`);
  return folder;
}

// ---------------------------------------------------------------- convert

export function convert(path: string): string {
  const top = git(resolve(path), "rev-parse", "--show-toplevel");
  const gitDir = join(top, ".git");
  if (!lstatOrNull(gitDir)?.isDirectory()) fail(`${top}/.git is not a directory; convert needs a plain (non-worktree) checkout`);
  if (isContainer(top)) fail(`${top} is already a git-wt container`);
  if (worktrees(top).length > 1) fail(`${top} already has linked worktrees; remove them first (git worktree list)`);
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
  const wt = join(top, flatten(branch));
  const recover = () =>
    `The original tree is in ${old} and its .git in ${top}/.bare. To undo: rm -rf ${top}/${flatten(branch)} ${top}/.git ${top}/.shared, mv ${top}/.bare ${old}/.git, git --git-dir=${old}/.git config core.bare false, rmdir ${top}, mv ${old} ${top}.`;

  renameSync(top, old);
  try {
    mkdirSync(top);
    renameSync(join(old, ".git"), join(top, ".bare"));
    git(join(top, ".bare"), "config", "core.bare", "true");
    rmSync(join(top, ".bare", "index"), { force: true }); // the old index; the worktree gets its own
    initContainerFiles(top);
    git(top, "worktree", "add", "--no-checkout", flatten(branch), branch);

    // Reflinks make this copy free on btrfs/xfs; elsewhere it is a real copy.
    run("cp", ["-a", "--reflink=auto", `${old}/.`, `${wt}/`]);
    git(wt, "reset", "--mixed", "--quiet");
    if (git(wt, "status", "--porcelain", "--untracked-files=no")) fail("new worktree shows tracked changes after the copy");
    if (git(wt, "rev-parse", "HEAD") !== head) fail("new worktree HEAD differs from the old one");

    const d = run("diff", ["-r", "--no-dereference", old, wt], undefined, true);
    const expected = `Only in ${wt}: .git`;
    const extra = d.out.split("\n").filter((l) => l && l !== expected);
    if (extra.length || d.err.trim()) fail(`diff -r found differences:\n${[...extra, d.err.trim()].filter(Boolean).join("\n")}`);

    const after = git(wt, "stash", "list", "--format=%H %gs");
    if (after !== stashes) fail(`stash list changed:\nbefore:\n${stashes}\nafter:\n${after}`);

    // HEAD reflog is per-worktree: graft the old one in front (git counts HEAD@{n} from the end).
    const bareLog = join(top, ".bare", "logs", "HEAD");
    const wtLog = join(git(wt, "rev-parse", "--path-format=absolute", "--git-dir"), "logs", "HEAD");
    if (existsSync(bareLog)) {
      const combined = readFileSync(bareLog, "utf8") + (existsSync(wtLog) ? readFileSync(wtLog, "utf8") : "");
      mkdirSync(dirname(wtLog), { recursive: true });
      writeFileSync(wtLog, combined);
      rmSync(bareLog);
    }
  } catch (e) {
    throw new Fail(`${(e as Error).message}\n\n${recover()}`);
  }

  rmSync(old, { recursive: true, force: true });
  log(`converted ${top}: worktree ${flatten(branch)}/ on ${branch}; diff -r clean, ${stashes ? stashes.split("\n").length : 0} stash(es) intact, old tree removed`);
  return top;
}

// ---------------------------------------------------------------- cli

function parse(argv: string[]) {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") flags.help = "1";
    else if (a === "-C" || a.startsWith("--")) {
      const key = a === "-C" ? "C" : a.slice(2);
      const val = argv[++i];
      if (val === undefined) fail(`${a} needs a value`);
      flags[key] = val;
    } else pos.push(a);
  }
  return { flags, pos };
}

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { flags, pos } = parse(rest);
  if (!cmd || cmd === "-h" || cmd === "--help" || flags.help) return log(USAGE);
  const allow = (...keys: string[]) => {
    for (const k of Object.keys(flags)) if (!keys.includes(k)) fail(`unknown option for ${cmd}: ${k.length === 1 ? "-" : "--"}${k}`);
  };
  switch (cmd) {
    case "clone":
      allow("dir", "base", "name");
      if (pos.length !== 1) fail("usage: git-wt clone <url> [--dir <path>] [--base <dir>] [--name <name>]");
      return void clone(pos[0], { dir: flags.dir, base: flags.base, name: flags.name });
    case "convert":
      allow();
      if (pos.length > 1) fail("usage: git-wt convert [<path>]");
      return void convert(pos[0] ?? process.cwd());
    case "add":
      allow("from", "C");
      if (pos.length !== 1) fail("usage: git-wt add <branch> [--from <start>] [-C <container>]");
      return void add(findContainer(flags.C ?? process.cwd()), pos[0], flags.from);
    case "sync":
      allow("C");
      if (pos.length) fail("usage: git-wt sync [-C <container>]");
      return reportSync(sync(findContainer(flags.C ?? process.cwd())));
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    console.error(`git-wt: ${e.message}`);
    process.exit(1);
  }
}
