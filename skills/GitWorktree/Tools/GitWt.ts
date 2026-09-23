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
  renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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
  const shared = join(container, ".shared");
  if (!existsSync(shared)) {
    writeFileSync(shared, "# Paths shared by every worktree, relative to a worktree root. One per line.\n# The real file lives here in the container; `git-wt sync` symlinks it into each worktree.\n");
  }
}

/** Worktree links become relative, so the whole container can be moved or renamed.
 *  Sets extensions.relativeWorktrees on the first `worktree add`; older git versions can't read the repo then. */
function enableRelativePaths(container: string) {
  git(container, "config", "worktree.useRelativePaths", "true");
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
  // A link for `a` would make `a/b` resolve through it into the root copy itself.
  for (const a of entries) for (const b of entries) {
    if (b.startsWith(a + sep)) fail(`.shared: "${b}" is inside "${a}", which is already shared; list only one of them`);
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
  const e = s < 0 ? -1 : text.indexOf(BLOCK_END, s);
  const odd = (why: string) => fail(`${file}: ${why}. Fix the git-wt block by hand (or delete both marker lines and everything between), then rerun`);
  if (s < 0) {
    if (text.includes(BLOCK_END)) odd("end marker without a start marker");
    return { before: text, entries: [], after: "" };
  }
  if (e < 0) odd("start marker without an end marker");
  if (text.indexOf(BLOCK_START, s + 1) >= 0 || text.indexOf(BLOCK_END, e + 1) >= 0) odd("more than one git-wt block");
  const lines = text.slice(s + BLOCK_START.length, e).split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => !l.startsWith("/"))) odd("unexpected lines inside the git-wt block");
  const entries = lines.map((l) => l.slice(1).replace(/\\(.)/g, "$1"));
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
  // info/exclude has the lowest precedence: a `!path` in a tracked .gitignore wins over it.
  for (const wt of trees) {
    for (const entry of entries) {
      if (lstatOrNull(join(wt.path, entry))?.isSymbolicLink() && !gitTry(wt.path, "check-ignore", "-q", "--no-index", entry).ok) {
        warnings.push(`${join(wt.path, entry)}: not ignored (a .gitignore rule re-includes it), so it shows as untracked; git add -A would commit the link`);
      }
    }
  }
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
  enableRelativePaths(container);
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

export function add(container: string, branch: string, from?: string): string {
  const folder = join(container, flatten(branch));
  if (existsSync(folder)) {
    const owner = worktrees(container).find((w) => w.path === folder);
    fail(owner?.branch && owner.branch !== branch
      ? `${folder} is already the worktree for ${owner.branch}, which flattens to the same folder name`
      : `${folder} already exists${owner ? ` (worktree for ${owner.branch ?? "a detached HEAD"})` : ""}`);
  }
  const has = (ref: string) => gitTry(container, "rev-parse", "--verify", "--quiet", ref).ok;
  git(container, "worktree", "prune");

  // `worktree add <dir> <branch>` checks out a local branch, or creates one tracking
  // origin/<branch> when only that exists. Only a genuinely new name needs -b.
  if (!from && (has(`refs/heads/${branch}`) || has(`refs/remotes/origin/${branch}`))) {
    git(container, "worktree", "add", folder, branch);
  } else {
    const def = defaultBranch(container);
    // After convert on a feature branch the default may exist only as origin/<def>.
    const start = from ?? (has(`refs/heads/${def}`) ? def : `origin/${def}`);
    git(container, "worktree", "add", "--no-track", "-b", branch, folder, start);
    log(`created new branch ${branch} from ${start}`);
  }
  reportSync(sync(container, [folder]));
  log(`worktree ${flatten(branch)}/ on ${branch}`);
  return folder;
}

// ---------------------------------------------------------------- convert

const journalFor = (top: string) => `${top}.git-wt-convert.json`;

/** A convert killed mid-way (SIGKILL, power loss) leaves a journal; roll it back first. */
function resumeInterrupted(path: string): void {
  const p = resolve(path);
  for (const top of [p, p.replace(/\.pre-wt$/, ""), dirname(p)]) {
    const journal = journalFor(top);
    if (!existsSync(journal)) continue;
    const result = rollback(JSON.parse(readFileSync(journal, "utf8")) as ConvertState);
    if (!result.startsWith("ROLLBACK STOPPED")) rmSync(journal);
    fail(`found an interrupted convert of ${top}. ${result}${result.startsWith("ROLLBACK STOPPED") ? `\nJournal kept at ${journal}.` : "\nRun convert again."}`);
  }
}

export function convert(path: string): string {
  resumeInterrupted(path);
  const top = git(resolve(path), "rev-parse", "--show-toplevel");
  const gitDir = join(top, ".git");
  if (!lstatOrNull(gitDir)?.isDirectory()) fail(`${top}/.git is not a directory; convert needs a plain (non-worktree) checkout`);
  git(top, "worktree", "prune"); // stale entries for deleted folders would otherwise pin their branches
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
  const flat = flatten(branch);
  const x: ConvertState = {
    top, old, wt: join(top, flat), bare: join(top, ".bare"),
    adminDir: join(top, ".bare", "worktrees", flat), // git may suffix it; read back after add
    // Convert requires .git at the top level, so any core.worktree can only name this same
    // tree: redundant here, and contradictory next to core.bare. Dropped, restored on rollback.
    coreWorktree: gitTry(top, "config", "--local", "--get", "core.worktree").out || undefined,
    // Sparse checkout turns this on. Then per-worktree settings live in config.worktree,
    // so core.bare must go there too, or every linked worktree would read it as bare.
    worktreeConfig: gitTry(top, "config", "--get", "--type=bool", "extensions.worktreeConfig").out === "true",
    moved: [],
    wroteBareWorktreeConfig: false,
  };
  const { wt, bare } = x;
  // Write-ahead: the journal records each step before it happens, so a hard kill at any
  // point leaves enough for the next run to roll back. Rollback tolerates steps not taken.
  const journal = journalFor(top);
  const save = () => writeFileSync(journal, JSON.stringify(x));
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
  const crash = (at: string) => { if (process.env.GIT_WT_TEST_CRASH === at) process.exit(137); };

  // Every step is a rename, so nothing is copied or deleted and each step can be reversed.
  // `rename(2)` can't move a directory into its own child, hence the .pre-wt staging name.
  save();
  renameSync(top, old);
  try {
    crash("early");
    mkdirSync(top);
    renameSync(join(old, ".git"), bare);
    if (x.worktreeConfig) {
      move(join(bare, "config.worktree"), join(bare, "config.worktree.git-wt")); // the old main worktree's settings
      x.wroteBareWorktreeConfig = true;
      save();
      git(bare, "config", "--worktree", "core.bare", "true");
    } else {
      git(bare, "config", "core.bare", "true");
    }
    if (x.coreWorktree !== undefined) git(bare, "config", "--unset", "core.worktree");
    initContainerFiles(top);
    enableRelativePaths(top);
    git(top, "worktree", "add", "--no-checkout", flat, branch);
    x.adminDir = resolve(wt, readFileSync(join(wt, ".git"), "utf8").replace(/^gitdir: /, "").trim());
    save();
    renameSync(join(wt, ".git"), join(old, ".git")); // the new worktree's pointer file
    rmdirSync(wt);
    renameSync(old, wt);
    // The old index still matches the tree and keeps skip-worktree/assume-unchanged bits.
    renameSync(join(bare, "index"), join(x.adminDir, "index"));
    // The old main worktree's own settings and sparse patterns now belong to this worktree.
    move(join(bare, "config.worktree.git-wt"), join(x.adminDir, "config.worktree"));
    move(join(bare, "info", "sparse-checkout"), join(x.adminDir, "info", "sparse-checkout"));

    crash("late");
    if (process.env.GIT_WT_TEST_FAIL === "convert") fail("injected test failure");
    const dirty = git(wt, "status", "--porcelain", "--untracked-files=no");
    if (dirty) fail(`new worktree shows tracked changes:\n${dirty}`);
    if (git(wt, "rev-parse", "HEAD") !== head) fail("new worktree HEAD differs from the old one");
    const after = git(wt, "stash", "list", "--format=%H %gs");
    if (after !== stashes) fail(`stash list changed:\nbefore:\n${stashes}\nafter:\n${after}`);
  } catch (e) {
    const result = rollback(x);
    if (!result.startsWith("ROLLBACK STOPPED")) rmSync(journal, { force: true });
    throw new Fail(`${(e as Error).message}\n\n${result}`);
  }
  rmSync(journal, { force: true });
  const { adminDir, coreWorktree } = x;

  // HEAD reflog is per-worktree: graft the old one in front (git counts HEAD@{n} from the end).
  const bareLog = join(bare, "logs", "HEAD");
  const wtLog = join(adminDir, "logs", "HEAD");
  if (existsSync(bareLog)) {
    const combined = readFileSync(bareLog, "utf8") + (existsSync(wtLog) ? readFileSync(wtLog, "utf8") : "");
    mkdirSync(dirname(wtLog), { recursive: true });
    writeFileSync(wtLog, combined);
    rmSync(bareLog);
  }

  // .bare/HEAD still names the branch that was checked out; point it at the remote's default.
  const originHead = gitTry(top, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  // No reflog: the bare HEAD log was just grafted into the worktree and should stay gone.
  if (originHead.ok) git(top, "-c", "core.logAllRefUpdates=false", "symbolic-ref", "HEAD", `refs/heads/${originHead.out.replace(/^origin\//, "")}`);
  else log(`note: origin/HEAD is unknown, so new branches will start from ${branch}; run git remote set-head origin --auto to fix`);

  if (coreWorktree !== undefined) log(`removed core.worktree=${coreWorktree} (redundant, and it conflicts with core.bare)`);
  const n = stashes ? stashes.split("\n").length : 0;
  log(`converted ${top}: worktree ${flat}/ on ${branch}, ${n} stash(es) intact`);
  if (process.cwd().startsWith(top)) log(`your shell's directory moved; run: cd ${JSON.stringify(wt)}`);
  return top;
}

type ConvertState = {
  top: string; old: string; wt: string; bare: string; adminDir: string;
  coreWorktree?: string; worktreeConfig: boolean;
  moved: [from: string, to: string][]; // per-worktree files relocated, in order
  wroteBareWorktreeConfig: boolean; // .bare/config.worktree is ours (holds only core.bare)
};

/** Reverse whatever convert got through, newest step first. Returns a status line. */
function rollback({ top, old, wt, bare, adminDir, coreWorktree, worktreeConfig, moved, wroteBareWorktreeConfig }: ConvertState): string {
  // Crashed before the first rename: nothing moved, and wt may name a real subdirectory.
  if (!existsSync(old) && lstatOrNull(join(top, ".git"))?.isDirectory()) return `Nothing to roll back: ${top} was never touched.`;
  const steps: [string, () => void][] = [
    ["index back", () => { if (existsSync(join(adminDir, "index"))) renameSync(join(adminDir, "index"), join(bare, "index")); }],
    ["per-worktree settings back", () => {
      if (wroteBareWorktreeConfig) rmSync(join(bare, "config.worktree"), { force: true });
      for (const [from, to] of [...moved].reverse()) if (existsSync(to)) renameSync(to, from);
    }],
    ["tree back", () => { if (!existsSync(old) && existsSync(wt)) renameSync(wt, old); }],
    ["worktree registration", () => {
      if (lstatOrNull(join(old, ".git"))?.isFile()) rmSync(join(old, ".git"));
      if (lstatOrNull(join(wt, ".git"))?.isFile()) rmSync(join(wt, ".git"));
      if (existsSync(wt)) rmdirSync(wt); // empty by now; fails loudly if not
      rmSync(adminDir, { recursive: true, force: true });
    }],
    ["repository back", () => {
      if (existsSync(bare)) {
        if (!worktreeConfig) run("git", ["--git-dir", bare, "config", "core.bare", "false"]);
        if (coreWorktree !== undefined) run("git", ["--git-dir", bare, "config", "core.worktree", coreWorktree]);
        renameSync(bare, join(old, ".git"));
      }
    }],
    ["container files", () => {
      if (!existsSync(old)) return; // top is already the original again
      for (const f of [".git", ".shared"]) rmSync(join(top, f), { force: true });
      if (existsSync(top)) rmdirSync(top);
    }],
    ["original name", () => { if (existsSync(old)) renameSync(old, top); }],
  ];
  for (const [name, step] of steps) {
    try { step(); } catch (e) {
      return `ROLLBACK STOPPED at "${name}": ${(e as Error).message}\nState: tree in ${JSON.stringify(existsSync(old) ? old : wt)}, repository in ${JSON.stringify(existsSync(bare) ? bare : join(old, ".git"))}. Nothing was deleted.`;
    }
  }
  return `Rolled back: ${top} is the original checkout again.`;
}

// ---------------------------------------------------------------- cli

function parse(argv: string[]) {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") flags.help = "1";
    else if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a === "-C" || a.startsWith("--")) {
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
