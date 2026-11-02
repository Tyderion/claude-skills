import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOL = join(import.meta.dir, "GitWt.ts");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};
let root: string;

function sh(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const git = (cwd: string, ...a: string[]) => {
  const r = sh("git", a, cwd);
  if (r.code !== 0) throw new Error(`git ${a.join(" ")}: ${r.err}`);
  return r.out;
};
const wt = (cwd: string, ...a: string[]) => sh("bun", [TOOL, ...a], cwd);
/** Convert with test fault injection: GIT_WT_TEST=crash:<at> | fail:<at>. */
const convertWith = (inject: string, dir: string) => sh("bun", [TOOL, "convert", dir], root, { GIT_WT_TEST: inject });

/** A remote with master (2 commits) and feature/x, plus a .gitignore for .env. */
function makeRemote(name: string) {
  const src = join(root, `${name}-src`);
  mkdirSync(src);
  git(src, "init", "-q", "-b", "master");
  writeFileSync(join(src, "a.txt"), "a\n");
  writeFileSync(join(src, ".gitignore"), ".env\nbuild/\n");
  git(src, "add", "."); git(src, "commit", "-qm", "one");
  writeFileSync(join(src, "a.txt"), "a2\n");
  git(src, "commit", "-qam", "two");
  git(src, "checkout", "-qb", "feature/x");
  writeFileSync(join(src, "x.txt"), "x\n");
  git(src, "add", "."); git(src, "commit", "-qm", "x");
  git(src, "checkout", "-q", "master");
  const bare = join(root, `${name}.git`);
  git(root, "clone", "-q", "--bare", src, bare);
  return bare;
}

/** A fake gh at <dir>/gh: answers `pr list --head <b>` from <dir>/<b with / -> ->.json (else "[]")
 *  and logs every call to <dir>/calls. */
function fakeGh(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gh"), [
    "#!/bin/sh",
    'echo "$@" >> "$GH_LOG"',
    'while [ $# -gt 0 ]; do [ "$1" = --head ] && b=$2; shift; done',
    'f="$GH_FIXTURES/$(printf %s "$b" | tr / -).json"',
    'if [ -f "$f" ]; then cat "$f"; else echo "[]"; fi',
    "",
  ].join("\n"), { mode: 0o755 });
  const calls = join(dir, "calls");
  const fixture = (branch: string) => join(dir, `${branch.replace(/\//g, "-")}.json`);
  return {
    env: { GIT_WT_GH: join(dir, "gh"), GH_FIXTURES: dir, GH_LOG: calls },
    fixture,
    merged: (branch: string, oid: string, n = 7, at = "2026-10-01T00:00:00Z") =>
      writeFileSync(fixture(branch), JSON.stringify([{ number: n, headRefOid: oid, mergedAt: at }])),
    unmerge: (branch: string) => rmSync(fixture(branch), { force: true }),
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : ""),
    clearCalls: () => writeFileSync(calls, ""),
  };
}
type FakeGh = ReturnType<typeof fakeGh>;

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "git-wt-test-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("clone + add + sync", () => {
  let c: string;
  test("clone builds the container with a default-branch worktree", () => {
    const url = makeRemote("proj");
    const r = wt(root, "clone", url, "--base", join(root, "coding"));
    expect(r.code).toBe(0);
    c = join(root, "coding", "proj");
    expect(readFileSync(join(c, ".git"), "utf8")).toBe("gitdir: ./.bare\n");
    expect(git(c, "config", "core.bare")).toBe("true");
    expect(git(c, "config", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(existsSync(join(c, "master", "a.txt"))).toBe(true);
    expect(git(join(c, "master"), "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/master");
    // No local copies of other branches: they exist only as origin/*.
    expect(git(c, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/master");
    expect(git(c, "rev-parse", "--verify", "origin/feature/x")).toMatch(/^[0-9a-f]{40}$/);
  });

  test("clone resolves a relative local URL, and cleans up after a failed clone", () => {
    git(root, "clone", "-q", "--bare", join(root, "proj.git"), join(root, "rel.git"));
    expect(wt(root, "clone", "./rel.git", "--dir", join(root, "rel")).code).toBe(0);
    expect(existsSync(join(root, "rel", "master", "a.txt"))).toBe(true);
    const r = wt(root, "clone", "./nope.git", "--dir", join(root, "nope"));
    expect(r.code).toBe(1);
    expect(existsSync(join(root, "nope"))).toBe(false);
  });

  test("plain errors for a missing path, a file as --dir, and a URL query", () => {
    const missing = wt(root, "convert", join(root, "nope-dir"));
    expect(missing.err).toContain("nope-dir does not exist");
    expect(missing.err).not.toContain("ENOENT");
    writeFileSync(join(root, "a-file"), "x");
    const file = wt(root, "clone", join(root, "proj.git"), "--dir", join(root, "a-file"));
    expect(file.code).toBe(1);
    expect(file.err).toContain("is not a directory");
    expect(file.err).not.toContain("    at ");
  });

  test("repoName ignores query strings and fragments", async () => {
    const { repoName } = await import("./GitWt.ts");
    expect(repoName("https://h/org/repo.git?x=1")).toBe("repo");
    expect(repoName("https://h/org/repo#readme")).toBe("repo");
    expect(repoName("git@github.com:org/repo.git")).toBe("repo");
  });

  test("clone refuses a non-empty target", () => {
    expect(wt(root, "clone", join(root, "proj.git"), "--base", join(root, "coding")).code).toBe(1);
  });

  test("add tracks a remote branch in a flattened folder", () => {
    const r = wt(join(c, "master"), "add", "feature/x");
    expect(r.code).toBe(0);
    expect(existsSync(join(c, "feature-x", "x.txt"))).toBe(true);
    expect(git(join(c, "feature-x"), "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/feature/x");
  });

  test("add creates a new branch from the default branch", () => {
    expect(wt(c, "add", "fresh/one").code).toBe(0);
    expect(git(join(c, "fresh-one"), "rev-parse", "HEAD")).toBe(git(c, "rev-parse", "master"));
  });

  test("sync links shared paths (incl. nested) relatively and git-excludes them", () => {
    writeFileSync(join(c, ".env"), "SECRET=1\n");
    mkdirSync(join(c, "config"));
    writeFileSync(join(c, "config", "local.yaml"), "k: v\n");
    writeFileSync(join(c, ".shared"), "# comment\n.env\nconfig/local.yaml\nmissing.db\n");
    const r = wt(c, "sync");
    expect(r.code).toBe(0);
    expect(r.out).toContain("warning: missing.db");
    for (const w of ["master", "feature-x", "fresh-one"]) {
      expect(readlinkSync(join(c, w, ".env"))).toBe("../.env");
      expect(readlinkSync(join(c, w, "config", "local.yaml"))).toBe("../../config/local.yaml");
      expect(readFileSync(join(c, w, ".env"), "utf8")).toBe("SECRET=1\n");
      expect(git(join(c, w), "status", "--porcelain")).toBe("");
    }
    expect(existsSync(join(c, "master", "missing.db"))).toBe(false);
    expect(wt(c, "sync").out).toContain("already up to date");
  });

  test("new worktrees get the shared links on add", () => {
    expect(wt(c, "add", "later").code).toBe(0);
    expect(readlinkSync(join(c, "later", ".env"))).toBe("../.env");
  });

  test("a real file in the way aborts the whole sync, changing nothing", () => {
    writeFileSync(join(c, "db.sqlite"), "shared\n");
    writeFileSync(join(c, "feature-x", "db.sqlite"), "local copy\n");
    writeFileSync(join(c, ".shared"), ".env\nconfig/local.yaml\ndb.sqlite\n");
    const r = wt(c, "sync");
    expect(r.code).toBe(1);
    expect(r.err).toContain("feature-x/db.sqlite");
    expect(existsSync(join(c, "master", "db.sqlite"))).toBe(false); // nothing applied elsewhere
    expect(readFileSync(join(c, "feature-x", "db.sqlite"), "utf8")).toBe("local copy\n");
    rmSync(join(c, "feature-x", "db.sqlite"));
    expect(wt(c, "sync").code).toBe(0);
    expect(lstatSync(join(c, "master", "db.sqlite")).isSymbolicLink()).toBe(true);
  });

  test("nested .shared entries are rejected before anything changes", () => {
    const before = readFileSync(join(c, ".shared"), "utf8");
    writeFileSync(join(c, ".shared"), before + "config\n");
    const r = wt(c, "sync");
    expect(r.code).toBe(1);
    expect(r.err).toContain('"config/local.yaml" is inside "config"');
    expect(lstatSync(join(c, "master", "config")).isSymbolicLink()).toBe(false);
    writeFileSync(join(c, ".shared"), before);
  });

  test("an odd exclude block stops sync without touching the file", () => {
    const file = join(c, ".bare", "info", "exclude");
    const good = readFileSync(file, "utf8");
    const bad = `/mine\n# >>> git-wt shared (managed by git-wt sync; edit .shared instead)\n/also-mine\n${good}`;
    writeFileSync(file, bad);
    const r = wt(c, "sync");
    expect(r.code).toBe(1);
    expect(r.err).toContain("more than one git-wt block");
    expect(readFileSync(file, "utf8")).toBe(bad);
    writeFileSync(file, good);
  });

  test("add prunes a deleted worktree so its branch is free again", () => {
    expect(wt(c, "add", "gone").code).toBe(0);
    rmSync(join(c, "gone"), { recursive: true });
    expect(wt(c, "add", "gone").code).toBe(0);
    expect(existsSync(join(c, "gone", "a.txt"))).toBe(true);
  });

  test("add names the branch that owns a colliding folder, and accepts --from=x", () => {
    const r = wt(c, "add", "feature-x");
    expect(r.code).toBe(1);
    expect(r.err).toContain("already the worktree for feature/x");
    expect(wt(c, "add", "eqform", "--from=master").code).toBe(0);
  });

  test("sync warns when a .gitignore re-includes a shared path", () => {
    const w = join(c, "master");
    writeFileSync(join(w, ".gitignore"), readFileSync(join(w, ".gitignore"), "utf8") + "!.env\n");
    const r = wt(c, "sync");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${join(w, ".env")}: not ignored`);
    expect(r.out).not.toContain(`${join(c, "feature-x", ".env")}: not ignored`);
    git(w, "checkout", "--", ".gitignore");
  });

  test("a symlinked route to the container still links correctly", () => {
    symlinkSync(c, join(root, "via-link"));
    expect(wt(join(root, "via-link"), "add", "vialink").code).toBe(0);
    expect(readlinkSync(join(c, "vialink", ".env"))).toBe("../.env");
    expect(wt(c, "sync").out).toContain("already up to date");
  });

  test("sync removes links for paths dropped from .shared, never real files", () => {
    writeFileSync(join(c, ".shared"), ".env\n");
    const r = wt(c, "sync");
    expect(r.code).toBe(0);
    for (const w of ["master", "feature-x", "fresh-one", "later"]) {
      expect(existsSync(join(c, w, "db.sqlite"))).toBe(false);
      expect(existsSync(join(c, w, "config", "local.yaml"))).toBe(false);
      expect(lstatSync(join(c, w, ".env")).isSymbolicLink()).toBe(true);
    }
    expect(existsSync(join(c, "db.sqlite"))).toBe(true); // root copy untouched
    const exclude = readFileSync(join(c, ".bare", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.env");
    expect(exclude).not.toContain("db.sqlite");
  });
});

describe("add with several remotes", () => {
  let c: string;
  beforeAll(() => {
    c = join(root, "multi");
    expect(wt(root, "clone", makeRemote("multi-origin"), "--dir", c).code).toBe(0);
    const fork = makeRemote("multi-fork"); // also has master and feature/x
    git(fork, "branch", "fork-only", "master");
    git(c, "remote", "add", "fork", fork);
    git(c, "fetch", "-q", "fork");
  });

  test("tracks a branch that exists only on a non-origin remote", () => {
    const r = wt(c, "add", "fork-only");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tracking fork/fork-only");
    expect(git(join(c, "fork-only"), "rev-parse", "--abbrev-ref", "@{u}")).toBe("fork/fork-only");
  });

  test("a branch on several remotes needs --remote, which then picks it", () => {
    const r = wt(c, "add", "feature/x");
    expect(r.code).toBe(1);
    expect(r.err).toContain("exists on fork, origin; pick one with --remote");
    expect(existsSync(join(c, "feature-x"))).toBe(false);
    expect(wt(c, "add", "feature/x", "--remote", "fork").code).toBe(0);
    expect(git(join(c, "feature-x"), "rev-parse", "--abbrev-ref", "@{u}")).toBe("fork/feature/x");
  });

  test("--remote errors say where the branch actually is", () => {
    expect(wt(c, "add", "fork-only2", "--remote", "origin").err).toContain("origin/fork-only2 does not exist (git fetch first?)");
    expect(wt(c, "add", "nope", "--remote", "ghost").err).toContain("no remote named ghost");
    expect(wt(c, "add", "x", "--remote", "fork", "--from", "master").err).toContain("pass only one");
  });
});

describe("[copy] entries", () => {
  let c: string;
  const trees = ["master", "feature-x"];
  const shared = (text: string) => writeFileSync(join(c, ".shared"), text);

  beforeAll(() => {
    c = join(root, "copyproj");
    expect(wt(root, "clone", makeRemote("copyrem"), "--dir", c).code).toBe(0);
    expect(wt(c, "add", "feature/x").code).toBe(0);
    writeFileSync(join(c, "app.yaml"), "port: 1\n");
    writeFileSync(join(c, ".env"), "S=1\n");
  });

  test("copies once per worktree, excluded from git, next to [link] entries", () => {
    shared("[link]\n.env\n[copy]\napp.yaml\n");
    const r = wt(c, "sync");
    expect(r.code).toBe(0);
    for (const w of trees) {
      const st = lstatSync(join(c, w, "app.yaml"));
      expect(st.isFile() && !st.isSymbolicLink()).toBe(true);
      expect(readFileSync(join(c, w, "app.yaml"), "utf8")).toBe("port: 1\n");
      expect(lstatSync(join(c, w, ".env")).isSymbolicLink()).toBe(true);
      expect(git(join(c, w), "status", "--porcelain")).toBe("");
    }
    expect(r.out).toContain("copied");
  });

  test("a new worktree gets its copy on add", () => {
    expect(wt(c, "add", "third").code).toBe(0);
    expect(readFileSync(join(c, "third", "app.yaml"), "utf8")).toBe("port: 1\n");
    trees.push("third");
  });

  test("existing copies are never overwritten, until --reset", () => {
    writeFileSync(join(c, "master", "app.yaml"), "port: 2\n"); // worktree's own edit
    writeFileSync(join(c, "app.yaml"), "port: 3\n"); // new root default
    expect(wt(c, "sync").out).toContain("already up to date");
    expect(readFileSync(join(c, "master", "app.yaml"), "utf8")).toBe("port: 2\n");

    writeFileSync(join(c, "feature-x", "app.yaml"), "port: 3\n"); // already equal to root
    const r = wt(c, "sync", "--reset", "app.yaml");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`reset    ${join(c, "master", "app.yaml")}`);
    expect(r.out).not.toContain(join(c, "feature-x", "app.yaml")); // identical: skipped
    for (const w of trees) expect(readFileSync(join(c, w, "app.yaml"), "utf8")).toBe("port: 3\n");
  });

  test("--reset only accepts [copy] entries", () => {
    const r = wt(c, "sync", "--reset", ".env");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not listed under [copy]");
  });

  test("moving an entry from [link] to [copy] swaps each link for a real copy", () => {
    shared("[copy]\napp.yaml\n.env\n");
    expect(wt(c, "sync").code).toBe(0);
    for (const w of trees) {
      expect(lstatSync(join(c, w, ".env")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(c, w, ".env"), "utf8")).toBe("S=1\n");
      expect(git(join(c, w), "status", "--porcelain")).toBe("");
    }
  });

  test("moving an entry from [copy] to [link] stops on the real copies", () => {
    shared(".env\n[copy]\napp.yaml\n");
    const r = wt(c, "sync");
    expect(r.code).toBe(1);
    expect(r.err).toContain("a real file sits where the shared link belongs");
    shared("[copy]\napp.yaml\n.env\n");
  });

  test("removed copies stay on disk and stay excluded until they are gone everywhere", () => {
    shared("[copy]\n.env\n");
    expect(wt(c, "sync").code).toBe(0);
    const exclude = () => readFileSync(join(c, ".bare", "info", "exclude"), "utf8");
    for (const w of trees) {
      expect(readFileSync(join(c, w, "app.yaml"), "utf8")).toBe("port: 3\n");
      expect(git(join(c, w), "status", "--porcelain")).toBe("");
    }
    expect(exclude()).toContain("/app.yaml");
    for (const w of trees) rmSync(join(c, w, "app.yaml"));
    expect(wt(c, "sync").code).toBe(0);
    expect(exclude()).not.toContain("/app.yaml");
  });

  test("a symlinked root default is copied as the file it points at", () => {
    writeFileSync(join(c, "real.json"), "{}\n");
    symlinkSync("real.json", join(c, "alias.json"));
    shared("[copy]\n.env\nalias.json\n");
    expect(wt(c, "sync").code).toBe(0);
    for (const w of trees) {
      expect(lstatSync(join(c, w, "alias.json")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(c, w, "alias.json"), "utf8")).toBe("{}\n");
    }
    expect(wt(c, "sync").out).toContain("already up to date");
    shared("[copy]\n.env\n");
    for (const w of trees) rmSync(join(c, w, "alias.json"));
    expect(wt(c, "sync").code).toBe(0);
  });

  test("a linked dir replaced by a nested [copy] entry is copied in the same run", () => {
    mkdirSync(join(c, "cfg"));
    writeFileSync(join(c, "cfg", "local.json"), "{\"a\":1}\n");
    shared("[copy]\n.env\n[link]\ncfg\n");
    expect(wt(c, "sync").code).toBe(0);
    shared("[copy]\n.env\ncfg/local.json\n");
    const r = wt(c, "sync");
    expect(r.code).toBe(0);
    for (const w of trees) {
      expect(lstatSync(join(c, w, "cfg")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(c, w, "cfg", "local.json"), "utf8")).toBe("{\"a\":1}\n");
    }
    shared("[copy]\n.env\n");
  });

  test("a dangling symlink as a [copy] default is reported as missing, not a crash", () => {
    symlinkSync("does-not-exist", join(c, "ghost.json"));
    shared("[copy]\n.env\nghost.json\n");
    const r = wt(c, "sync");
    expect(r.code).toBe(0);
    expect(r.out).toContain("ghost.json: not present");
    shared("[copy]\n.env\n");
    rmSync(join(c, "ghost.json"));
  });

  test(".shared rejects unknown sections and entries listed twice", () => {
    shared("[copies]\napp.yaml\n");
    expect(wt(c, "sync").err).toContain("unknown section [copies]");
    shared(".env\n[copy]\n.env\n");
    expect(wt(c, "sync").err).toContain("under both [link] and [copy]");
    shared("[copy]\n.env\n");
  });
});

describe("convert", () => {
  function checkout(name: string) {
    const dir = join(root, name);
    git(root, "clone", "-q", makeRemote(`${name}-r`), dir);
    return dir;
  }

  test("refuses uncommitted tracked changes", () => {
    const d = checkout("dirty");
    writeFileSync(join(d, "a.txt"), "changed\n");
    const r = wt(d, "convert");
    expect(r.code).toBe(1);
    expect(r.err).toContain("uncommitted");
    expect(existsSync(join(d, ".git"))).toBe(true);
  });

  test("converts in place keeping untracked, ignored, empty dirs, symlinks, stashes and reflog", () => {
    const d = checkout("conv");
    git(d, "checkout", "-q", "feature/x");
    writeFileSync(join(d, "a.txt"), "stash me\n");
    git(d, "stash", "-q");
    writeFileSync(join(d, "x.txt"), "stash two\n");
    git(d, "stash", "-q");
    writeFileSync(join(d, ".env"), "S=1\n");
    mkdirSync(join(d, "build", "empty"), { recursive: true });
    writeFileSync(join(d, "notes.md"), "untracked\n");
    symlinkSync("a.txt", join(d, "link"));
    const stashes = git(d, "stash", "list", "--format=%H");
    const reflogLen = git(d, "reflog").split("\n").length;

    const r = wt(root, "convert", d);
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 stash(es) intact");
    const w = join(d, "feature-x");
    expect(existsSync(`${d}.pre-wt`)).toBe(false);
    expect(readFileSync(join(d, ".git"), "utf8")).toBe("gitdir: ./.bare\n");
    expect(readFileSync(join(w, ".env"), "utf8")).toBe("S=1\n");
    expect(existsSync(join(w, "build", "empty"))).toBe(true);
    expect(readlinkSync(join(w, "link"))).toBe("a.txt");
    expect(git(w, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(git(w, "stash", "list", "--format=%H")).toBe(stashes);
    expect(git(w, "reflog").split("\n").length).toBeGreaterThanOrEqual(reflogLen);
    expect(existsSync(join(d, ".bare", "logs", "HEAD"))).toBe(false);
    expect(existsSync(join(d, ".bare", "index"))).toBe(false);
    expect(wt(d, "add", "master").code).toBe(0);
    expect(git(join(d, "master"), "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/master");
  });

  test("keeps skip-worktree and assume-unchanged bits", () => {
    const d = checkout("bits");
    git(d, "update-index", "--skip-worktree", "a.txt");
    git(d, "update-index", "--assume-unchanged", ".gitignore");
    expect(wt(root, "convert", d).code).toBe(0);
    const flags = git(join(d, "master"), "ls-files", "-v");
    expect(flags).toContain("S a.txt");
    expect(flags).toContain("h .gitignore");
  });

  test("a failure rolls everything back to the original checkout", () => {
    const d2 = checkout("rb");
    const config = readFileSync(join(d2, ".git", "config"), "utf8");
    writeFileSync(join(d2, "notes.md"), "untracked\n");
    const headBefore = git(d2, "rev-parse", "HEAD");
    const f = convertWith("fail:late", d2);
    expect(f.code).toBe(1);
    expect(f.err).toContain("Rolled back");
    expect(lstatSync(join(d2, ".git")).isDirectory()).toBe(true);
    expect(existsSync(`${d2}.pre-wt`)).toBe(false);
    expect(existsSync(join(d2, ".bare"))).toBe(false);
    expect(readFileSync(join(d2, "notes.md"), "utf8")).toBe("untracked\n");
    expect(git(d2, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(d2, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(git(d2, "worktree", "list").split("\n").length).toBe(1);
    expect(git(d2, "config", "core.bare")).toBe("false");
    // No relative-worktrees extension or format bump left behind.
    expect(readFileSync(join(d2, ".git", "config"), "utf8")).toBe(config);
  });

  test("cloned and converted containers survive being moved", () => {
    const cl = join(root, "mv-clone");
    expect(wt(root, "clone", join(root, "proj.git"), "--dir", cl).code).toBe(0);
    const cv = checkout("mv-conv");
    expect(wt(root, "convert", cv).code).toBe(0);
    for (const [from, branch] of [[cl, "master"], [cv, "master"]] as const) {
      const to = `${from}-moved`;
      spawnSync("mv", [from, to]);
      expect(git(join(to, branch), "status", "--porcelain")).toBe("");
      expect(git(to, "worktree", "list")).not.toContain("prunable");
      expect(wt(to, "add", "after-move").code).toBe(0);
    }
  });

  test("after converting a feature branch, new branches start from the default branch", () => {
    const d = checkout("def");
    git(d, "checkout", "-q", "feature/x");
    git(d, "branch", "-q", "-D", "master"); // only origin/master remains
    expect(wt(root, "convert", d).code).toBe(0);
    const r = wt(d, "add", "newbranch");
    expect(r.code).toBe(0);
    expect(r.out).toContain("from origin/master");
    expect(existsSync(join(d, "newbranch", "x.txt"))).toBe(false);
    expect(git(join(d, "newbranch"), "rev-parse", "HEAD")).toBe(git(d, "rev-parse", "origin/master"));
  });

  test("convert prunes a stale linked worktree instead of carrying it over", () => {
    const d = checkout("stale");
    git(d, "worktree", "add", "-q", join(root, "stale-side"), "-b", "side");
    rmSync(join(root, "stale-side"), { recursive: true });
    expect(wt(root, "convert", d).code).toBe(0);
    expect(wt(d, "add", "side").code).toBe(0);
  });

  test("drops a redundant core.worktree, and restores it on rollback", () => {
    const d = checkout("cw");
    git(d, "config", "core.worktree", "..");
    const r = wt(root, "convert", d);
    expect(r.code).toBe(0);
    expect(r.out).toContain("removed core.worktree=..");
    expect(sh("git", ["config", "--get", "core.worktree"], d).code).toBe(1);
    expect(sh("git", ["worktree", "list"], d).err).toBe(""); // no core.bare/core.worktree warning

    const d2 = checkout("cw-rb");
    git(d2, "config", "core.worktree", "..");
    const f = convertWith("fail:late", d2);
    expect(f.err).toContain("Rolled back");
    expect(git(d2, "config", "core.worktree")).toBe("..");
  });

  function sparseCheckout(name: string) {
    const dir = join(root, name);
    git(root, "clone", "-q", "--sparse", `file://${makeRemote(`${name}-r`)}`, dir);
    // makeRemote has only top-level files; add a directory so a cone pattern means something.
    mkdirSync(join(dir, "only"));
    writeFileSync(join(dir, "only", "in.txt"), "in\n");
    git(dir, "sparse-checkout", "disable");
    git(dir, "add", "only"); git(dir, "commit", "-qm", "dir");
    git(dir, "sparse-checkout", "set", "only");
    return dir;
  }

  test("converts a sparse checkout and keeps it sparse", () => {
    const d = sparseCheckout("sparse");
    expect(existsSync(join(d, "a.txt"))).toBe(true); // cone mode keeps top-level files
    const r = wt(root, "convert", d);
    expect(r.code).toBe(0);
    const w = join(d, "master");
    expect(git(w, "sparse-checkout", "list")).toBe("only");
    expect(git(w, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(git(w, "rev-parse", "--is-bare-repository")).toBe("false");
    expect(git(d, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(d, "config", "--get", "core.bare")).toBe("true"); // from .bare/config.worktree
    // A new worktree is a normal (non-sparse) checkout of its own.
    expect(wt(d, "add", "feature/x").code).toBe(0);
    expect(git(join(d, "feature-x"), "rev-parse", "--is-bare-repository")).toBe("false");
  });

  test("a failed sparse convert restores its settings exactly", () => {
    const d = sparseCheckout("sparse-rb");
    const cfg = readFileSync(join(d, ".git", "config.worktree"), "utf8");
    const pat = readFileSync(join(d, ".git", "info", "sparse-checkout"), "utf8");
    const f = convertWith("fail:late", d);
    expect(f.err).toContain("Rolled back");
    expect(readFileSync(join(d, ".git", "config.worktree"), "utf8")).toBe(cfg);
    expect(readFileSync(join(d, ".git", "info", "sparse-checkout"), "utf8")).toBe(pat);
    expect(git(d, "sparse-checkout", "list")).toBe("only");
    expect(git(d, "status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  for (const at of ["early", "late"]) {
    test(`a convert killed ${at} is rolled back by the next run, then converts cleanly`, () => {
      const d = checkout(`crash-${at}`);
      git(d, "checkout", "-q", "feature/x"); // branch folder name must not be mistaken for a real dir
      mkdirSync(join(d, "feature-x"));
      writeFileSync(join(d, "feature-x", "keep.txt"), "real dir\n");
      writeFileSync(join(d, ".env"), "S=1\n");
      const head = git(d, "rev-parse", "HEAD");
      const k = convertWith(`crash:${at}`, d);
      expect(k.code).toBe(137);
      expect(existsSync(`${d}.git-wt-convert.json`)).toBe(true);

      const r = wt(root, "convert", d);
      expect(r.code).toBe(1);
      expect(r.err).toContain("found an interrupted convert");
      expect(r.err).toContain("run convert again");
      expect(existsSync(`${d}.git-wt-convert.json`)).toBe(false);
      expect(existsSync(`${d}.pre-wt`)).toBe(false);
      expect(lstatSync(join(d, ".git")).isDirectory()).toBe(true);
      expect(git(d, "rev-parse", "HEAD")).toBe(head);
      expect(git(d, "status", "--porcelain", "--untracked-files=no")).toBe("");
      expect(readFileSync(join(d, "feature-x", "keep.txt"), "utf8")).toBe("real dir\n");
      expect(readFileSync(join(d, ".env"), "utf8")).toBe("S=1\n");

      // The tree's own feature-x/ dir ends up inside the feature-x worktree, untouched.
      expect(wt(root, "convert", d).code).toBe(0);
      expect(readFileSync(join(d, "feature-x", "feature-x", "keep.txt"), "utf8")).toBe("real dir\n");
      expect(readFileSync(join(d, "feature-x", ".env"), "utf8")).toBe("S=1\n");
    });
  }

  test("rollback of a journaled-but-not-done move keeps the original reflog", () => {
    const d = checkout("crash-mid");
    const reflog = readFileSync(join(d, ".git", "logs", "HEAD"), "utf8");
    expect(convertWith("crash:late", d).code).toBe(137);
    // Recreate the state of a kill after move() journaled logs/HEAD but before the rename:
    // the original still in .bare, and worktree add's own one-line log at the destination.
    const admin = join(d, "master", ".git"); // pointer file
    const adminDir = join(d, "master", readFileSync(admin, "utf8").replace(/^gitdir: /, "").trim());
    writeFileSync(join(d, ".bare", "logs", "HEAD"), reflog);
    writeFileSync(join(adminDir, "logs", "HEAD"), "0000 1111 worktree-add-line\n");
    expect(convertWith("", d).err).toContain("Rolled back");
    expect(readFileSync(join(d, ".git", "logs", "HEAD"), "utf8")).toBe(reflog);
  });

  test("a journal from a crash before anything moved is harmless", () => {
    const d = checkout("crash-none");
    writeFileSync(`${d}.git-wt-convert.json`, JSON.stringify({
      top: d, old: `${d}.pre-wt`, wt: join(d, "master"), bare: join(d, ".bare"), adminDir: "",
      moved: [], wroteBareWorktreeConfig: false, config: "", linked: [],
    }));
    const r = wt(root, "convert", d);
    expect(r.err).toContain("is the original checkout");
    expect(wt(root, "convert", d).code).toBe(0);
  });

  test("takes existing linked worktrees into the container, dirty state and all", () => {
    const d = checkout("lw");
    const side = join(root, "lw.2");
    git(d, "worktree", "add", "-q", side, "-b", "team/side");
    writeFileSync(join(side, "a.txt"), "side edit\n"); // uncommitted, must survive
    writeFileSync(join(side, "notes.md"), "untracked\n");
    git(d, "worktree", "add", "-q", join(d, "nested", "inner"), "-b", "inner");
    const heads = { side: git(side, "rev-parse", "HEAD"), inner: git(join(d, "nested", "inner"), "rev-parse", "HEAD") };

    const r = wt(root, "convert", d);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`moved linked worktree ${side} -> ${join(d, "team-side")}`);
    expect(existsSync(side)).toBe(false);
    const list = git(d, "worktree", "list");
    for (const name of ["master", "team-side", "inner"]) expect(list).toContain(join(d, name));
    expect(list).not.toContain("prunable");
    expect(git(join(d, "team-side"), "rev-parse", "HEAD")).toBe(heads.side);
    expect(git(join(d, "inner"), "rev-parse", "HEAD")).toBe(heads.inner);
    expect(git(join(d, "team-side"), "status", "--porcelain").split("\n")).toContain("M a.txt"); // helper trims the leading space
    expect(readFileSync(join(d, "team-side", "notes.md"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(d, "team-side", ".git"), "utf8")).toStartWith("gitdir: ../.bare/worktrees/");
    expect(existsSync(join(d, "master", "nested", "inner"))).toBe(false);
  });

  test("a failed convert puts linked worktrees back where they were, still working", () => {
    const d = checkout("lw-rb");
    const side = join(root, "lw-rb.2");
    git(d, "worktree", "add", "-q", side, "-b", "side");
    git(d, "worktree", "add", "-q", join(d, "nested", "inner"), "-b", "inner");
    const f = convertWith("fail:late", d);
    expect(f.err).toContain("Rolled back");
    expect(git(side, "rev-parse", "--abbrev-ref", "HEAD")).toBe("side");
    expect(git(join(d, "nested", "inner"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("inner");
    expect(git(d, "worktree", "list")).not.toContain("prunable");
    expect(lstatSync(join(d, ".git")).isDirectory()).toBe(true);
  });

  test("refuses locked linked worktrees and folder-name collisions", () => {
    const d = checkout("lw-bad");
    git(d, "worktree", "add", "-q", join(root, "lw-bad.2"), "-b", "x");
    git(d, "worktree", "lock", join(root, "lw-bad.2"));
    expect(wt(root, "convert", d).err).toContain("locked");
    git(d, "worktree", "unlock", join(root, "lw-bad.2"));
    git(d, "worktree", "add", "-q", join(root, "lw-bad.3"), "-b", "mas/ter"); // flattens to mas-ter
    git(d, "checkout", "-q", "-b", "mas-ter");
    const r = wt(root, "convert", d);
    expect(r.code).toBe(1);
    expect(r.err).toContain("already taken");
    expect(lstatSync(join(d, ".git")).isDirectory()).toBe(true);
  });

  test("rollback never deletes an admin dir that belongs to an existing linked worktree", () => {
    const d = checkout("adm");
    const other = join(root, "adm-wts", "master"); // admin id "master" = the main worktree's folder name
    git(d, "worktree", "add", "-q", other, "-b", "other");
    writeFileSync(join(other, "staged.txt"), "s\n");
    git(other, "add", "staged.txt");
    expect(convertWith("fail:repo", d).err).toContain("Rolled back");
    expect(git(other, "status", "--porcelain")).toBe("A  staged.txt");
    expect(existsSync(join(d, ".git", "worktrees", "master"))).toBe(true);
  });

  test("a stopped relink is finished by the next convert instead of being forgotten", () => {
    const d = checkout("relink");
    const side = join(root, "relink.2");
    git(d, "worktree", "add", "-q", side, "-b", "side");
    expect(convertWith("crash:late", d).code).toBe(137);
    const journal = readFileSync(`${d}.git-wt-convert.json`, "utf8");
    expect(wt(root, "convert", d).err).toContain("Rolled back"); // full rollback
    // Recreate "rollback stopped right before relinking": journal present, link still wrong.
    writeFileSync(`${d}.git-wt-convert.json`, journal);
    const id = readFileSync(join(side, ".git"), "utf8").trim().split("/").pop()!;
    writeFileSync(join(d, ".git", "worktrees", id, "gitdir"), "/nowhere/.git\n");
    const r = wt(root, "convert", d);
    expect(r.err).toContain("is the original checkout");
    expect(git(side, "rev-parse", "--abbrev-ref", "HEAD")).toBe("side");
    expect(git(d, "worktree", "list")).not.toContain("prunable");
  });

  test("a linked worktree nested inside another linked worktree moves with it", () => {
    const d = checkout("nest");
    const outer = join(root, "nest-a");
    git(d, "worktree", "add", "-q", outer, "-b", "a");
    git(d, "worktree", "add", "-q", join(outer, "inner"), "-b", "inner");
    const r = wt(root, "convert", d);
    expect(r.code).toBe(0);
    expect(git(join(d, "a"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("a");
    expect(git(join(d, "inner"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("inner");
    expect(git(d, "worktree", "list")).not.toContain("prunable");
  });

  test("a linked worktree on an unborn branch converts", () => {
    const d = checkout("orph");
    git(d, "worktree", "add", "-q", "--orphan", "-b", "orph", join(root, "orph.2"));
    expect(wt(root, "convert", d).code).toBe(0);
    expect(git(join(d, "orph"), "symbolic-ref", "HEAD")).toBe("refs/heads/orph");
  });

  test("rollback keeps a relative linked worktree link relative", () => {
    const d = checkout("relwt");
    const side = join(root, "relwt.2");
    git(d, "-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", side, "-b", "side");
    const link = readFileSync(join(side, ".git"), "utf8");
    expect(link).toStartWith("gitdir: ..");
    expect(convertWith("fail:late", d).err).toContain("Rolled back");
    expect(readFileSync(join(side, ".git"), "utf8")).toBe(link);
  });

  test("refuses a detached HEAD and an existing container", () => {
    const d = checkout("detached");
    git(d, "checkout", "-q", "--detach");
    expect(wt(d, "convert").err).toContain("detached");
    expect(wt(root, "convert", join(root, "conv", "feature-x")).code).toBe(1);
  });
});

describe("reuse", () => {
  let c: string;
  let bare: string;
  let g: FakeGh;
  /** A fake gh: answers `pr list --head <b>` from fixtures/<b with / -> ->.json, logs every call. */
  const wtGh = (cwd: string, ...a: string[]) => sh("bun", [TOOL, ...a], cwd, g.env);
  /** Push a commit to the remote's master, so local master is stale until a fetch. */
  function advanceRemote(): string {
    const tmp = mkdtempSync(join(root, "push-"));
    git(root, "clone", "-q", bare, tmp);
    writeFileSync(join(tmp, "later.txt"), "later\n");
    git(tmp, "add", "."); git(tmp, "commit", "-qm", "later");
    git(tmp, "push", "-q", "origin", "master");
    return git(tmp, "rev-parse", "HEAD");
  }

  beforeAll(() => {
    bare = makeRemote("reuse-r");
    c = join(root, "reuseproj");
    expect(wt(root, "clone", bare, "--dir", c).code).toBe(0);
    writeFileSync(join(c, ".env"), "S=1\n");
    writeFileSync(join(c, ".shared"), ".env\n");
    expect(wt(c, "add", "feature/x").code).toBe(0);
    g = fakeGh(join(root, "gh"));
  });

  test("renames the folder, checks out a new branch from the fetched remote default, keeps ignored files", () => {
    mkdirSync(join(c, "feature-x", "build"));
    writeFileSync(join(c, "feature-x", "build", "deps.bin"), "expensive\n");
    const fresh = advanceRemote();
    const r = wt(c, "reuse", "feature-x", "next/one");
    expect(r.code).toBe(0);
    expect(r.out).toContain("now next-one/ on next/one");
    expect(r.out).toContain("feature/x is still a local branch");
    const w = join(c, "next-one");
    expect(existsSync(join(c, "feature-x"))).toBe(false);
    expect(readFileSync(join(w, "build", "deps.bin"), "utf8")).toBe("expensive\n");
    expect(git(w, "rev-parse", "--abbrev-ref", "HEAD")).toBe("next/one");
    expect(git(w, "rev-parse", "HEAD")).toBe(fresh);
    expect(sh("git", ["rev-parse", "--abbrev-ref", "@{u}"], w).code).not.toBe(0); // new branch, no upstream
    expect(readFileSync(join(w, ".env"), "utf8")).toBe("S=1\n");
    expect(git(c, "rev-parse", "--verify", "feature/x")).toMatch(/^[0-9a-f]{40}$/);
    expect(git(c, "worktree", "list")).not.toContain("prunable");
    expect(git(w, "status", "--porcelain")).toBe("");
  });

  test("tracks a remote branch, naming the worktree by its branch", () => {
    git(bare, "branch", "remote-b", "master");
    const r = wt(c, "reuse", "next/one", "remote-b");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tracking origin/remote-b");
    expect(git(join(c, "remote-b"), "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/remote-b");
    expect(existsSync(join(c, "remote-b", "build", "deps.bin"))).toBe(true);
  });

  test("refuses tracked changes, untracked files and an occupied folder, changing nothing", () => {
    const w = join(c, "remote-b");
    writeFileSync(join(w, "a.txt"), "edited\n");
    let r = wt(c, "reuse", "remote-b", "other");
    expect(r.code).toBe(1);
    expect(r.err).toContain("M a.txt");
    git(w, "checkout", "--", "a.txt");
    writeFileSync(join(w, "notes.md"), "mine\n");
    r = wt(c, "reuse", "remote-b", "other");
    expect(r.err).toContain("?? notes.md");
    rmSync(join(w, "notes.md"));
    r = wt(c, "reuse", "remote-b", "master");
    expect(r.err).toContain("already exists");
    expect(git(w, "rev-parse", "--abbrev-ref", "HEAD")).toBe("remote-b");
    expect(existsSync(join(c, "other"))).toBe(false);
    expect(sh("git", ["rev-parse", "--verify", "--quiet", "other"], c).code).not.toBe(0);
  });

  test("a failed move puts the worktree back on its branch and drops the branch it made", () => {
    const r = sh("bun", [TOOL, "reuse", "remote-b", "doomed"], c, { GIT_WT_TEST: "fail:move" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("is back on remote-b");
    expect(git(join(c, "remote-b"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("remote-b");
    expect(sh("git", ["rev-parse", "--verify", "--quiet", "doomed"], c).code).not.toBe(0);
  });

  test("tells a shell inside the worktree where it went", () => {
    const r = wt(join(c, "remote-b", "build"), "reuse", "remote-b", "moved");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`cd "${join(c, "moved", "build")}"`);
  });

  describe("automatic, on a GitHub remote", () => {
    beforeAll(() => {
      const url = "https://github.com/t/reuse.git";
      git(c, "config", `url.${bare}.insteadOf`, url);
      git(c, "remote", "set-url", "origin", url);
      expect(git(c, "fetch", "-q", "origin")).toBe(""); // fetch still reaches the local bare
    });

    test("add reuses the worktree whose branch has a merged PR", () => {
      expect(wt(c, "add", "done/a").code).toBe(0);
      writeFileSync(join(c, "done-a", "work.txt"), "w\n");
      git(join(c, "done-a"), "add", "."); git(join(c, "done-a"), "commit", "-qm", "work");
      g.merged("done/a", git(join(c, "done-a"), "rev-parse", "HEAD"));
      const r = wtGh(c, "add", "new/b");
      expect(r.code).toBe(0);
      expect(r.out).toContain("reusing done-a/: done/a was merged in t/reuse#7");
      expect(r.out).toMatch(/deleted done\/a \(was [0-9a-f]{7,}; merged in t\/reuse#7\)/);
      expect(sh("git", ["rev-parse", "--verify", "--quiet", "refs/heads/done/a"], c).code).not.toBe(0);
      expect(existsSync(join(c, "done-a"))).toBe(false);
      expect(git(join(c, "new-b"), "rev-parse", "HEAD")).toBe(git(c, "rev-parse", "origin/master"));
      expect(g.calls()).toContain("--repo t/reuse --head done/a");
    });

    test("never the default branch, never with commits past the merged head, never with --fresh", () => {
      g.merged("master", git(c, "rev-parse", "master"));
      expect(wt(c, "add", "past/c").code).toBe(0);
      const before = git(join(c, "past-c"), "rev-parse", "HEAD");
      writeFileSync(join(c, "past-c", "more.txt"), "m\n");
      git(join(c, "past-c"), "add", "."); git(join(c, "past-c"), "commit", "-qm", "after merge");
      g.merged("past/c", before);
      g.clearCalls();
      // new/b's branch has no PR; moved and the rest likewise.
      const r = wtGh(c, "add", "fresh/d");
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("reusing");
      expect(existsSync(join(c, "fresh-d"))).toBe(true);
      expect(existsSync(join(c, "past-c"))).toBe(true);
      expect(g.calls()).not.toContain("--head master");

      g.merged("fresh/d", git(join(c, "fresh-d"), "rev-parse", "HEAD"));
      g.clearCalls();
      const f = wtGh(c, "add", "fresh/e", "--fresh");
      expect(f.out).not.toContain("reusing");
      expect(existsSync(join(c, "fresh-d"))).toBe(true);
      expect(g.calls()).toBe("");
    });

    test("a dirty merged worktree is skipped; a missing gh is announced and add goes ahead", () => {
      writeFileSync(join(c, "fresh-d", "scratch.txt"), "s\n");
      const r = wtGh(c, "add", "fresh/f");
      expect(r.out).not.toContain("reusing");
      expect(existsSync(join(c, "fresh-d", "scratch.txt"))).toBe(true);
      const g = sh("bun", [TOOL, "add", "fresh/g"], c, { GIT_WT_GH: join(root, "no-such-gh") });
      expect(g.code).toBe(0);
      expect(g.out).toContain("cannot ask GitHub for merged PRs");
      expect(existsSync(join(c, "fresh-g"))).toBe(true);
    });

    test("explicit reuse deletes the old branch only when a merged PR contains it", () => {
      expect(wtGh(c, "add", "ex/a", "--fresh").code).toBe(0);
      const w = join(c, "ex-a");
      writeFileSync(join(w, "ex.txt"), "e\n");
      git(w, "add", "."); git(w, "commit", "-qm", "ex");
      const tip = git(w, "rev-parse", "HEAD");
      let r = wtGh(c, "reuse", "ex-a", "ex/b");
      expect(r.code).toBe(0);
      expect(r.out).toContain("ex/a is still a local branch; nothing was deleted");
      expect(git(c, "rev-parse", "ex/a")).toBe(tip);

      g.merged("ex/b", git(join(c, "ex-b"), "rev-parse", "HEAD"), 8);
      r = wtGh(c, "reuse", "ex-b", "ex/c");
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/deleted ex\/b \(was [0-9a-f]{7,}; merged in t\/reuse#8\)/);
      expect(sh("git", ["rev-parse", "--verify", "--quiet", "refs/heads/ex/b"], c).code).not.toBe(0);

      // gh failing keeps the branch, and the reuse itself still goes through.
      g.merged("ex/c", git(join(c, "ex-c"), "rev-parse", "HEAD"), 9);
      r = sh("bun", [TOOL, "reuse", "ex-c", "ex/d"], c, { GIT_WT_GH: join(root, "no-such-gh") });
      expect(r.code).toBe(0);
      expect(r.out).toContain("cannot ask GitHub for merged PRs");
      expect(r.out).toContain("ex/c is still a local branch");
      expect(existsSync(join(c, "ex-d"))).toBe(true);
    });

    test("a container without a GitHub remote never calls gh", () => {
      const local = join(root, "no-gh");
      expect(wt(root, "clone", makeRemote("no-gh-r"), "--dir", local).code).toBe(0);
      expect(wt(local, "add", "feature/x").code).toBe(0);
      g.clearCalls();
      expect(wtGh(local, "add", "no-gh").code).toBe(0);
      expect(g.calls()).toBe("");
    });
  });
});

describe("reuse safety", () => {
  let c: string;
  let bare: string;
  let g: FakeGh;
  const wtGh = (cwd: string, ...a: string[]) => sh("bun", [TOOL, ...a], cwd, g.env);
  /** Run `fn` in a scratch clone of the remote, which it may commit in and push from. */
  function onRemote(fn: (dir: string) => void) {
    const tmp = mkdtempSync(join(root, "remote-work-"));
    git(root, "clone", "-q", bare, tmp);
    fn(tmp);
  }

  beforeAll(() => {
    bare = makeRemote("safe-r");
    c = join(root, "safeproj");
    expect(wt(root, "clone", bare, "--dir", c).code).toBe(0);
    writeFileSync(join(c, ".env"), "S=1\n");
    writeFileSync(join(c, ".shared"), ".env\n");
    expect(wt(c, "sync").code).toBe(0);
    const url = "https://github.com/t/safe.git";
    git(c, "config", `url.${bare}.insteadOf`, url);
    git(c, "remote", "set-url", "origin", url);
    g = fakeGh(join(root, "gh2"));
    // Branches that track a normally ignored file, and the shared .env.
    onRemote((d) => {
      git(d, "checkout", "-qb", "tracks-ignored");
      mkdirSync(join(d, "build"));
      writeFileSync(join(d, "build", "keep.txt"), "FROM BRANCH\n");
      git(d, "add", "-f", "build/keep.txt"); git(d, "commit", "-qm", "track ignored");
      git(d, "checkout", "-q", "-b", "tracks-env", "master");
      writeFileSync(join(d, ".env"), "BRANCH=1\n");
      git(d, "add", "-f", ".env"); git(d, "commit", "-qm", "track env");
      git(d, "push", "-q", "origin", "tracks-ignored", "tracks-env");
    });
    git(c, "fetch", "-q", "origin");
  });

  test("refuses to overwrite ignored files and shared links the branch tracks, changing nothing", () => {
    expect(wt(c, "add", "clob/a").code).toBe(0);
    const w = join(c, "clob-a");
    mkdirSync(join(w, "build"));
    writeFileSync(join(w, "build", "keep.txt"), "MINE\n");
    const r = wt(c, "reuse", "clob-a", "tracks-ignored");
    expect(r.code).toBe(1);
    expect(r.err).toContain("build/keep.txt");
    expect(wt(c, "reuse", "clob-a", "tracks-env").err).toMatch(/overwrite them:\n\s+\.env/);
    expect(readFileSync(join(w, "build", "keep.txt"), "utf8")).toBe("MINE\n");
    expect(lstatSync(join(w, ".env")).isSymbolicLink()).toBe(true);
    expect(git(w, "rev-parse", "--abbrev-ref", "HEAD")).toBe("clob/a");
  });

  test("add falls back to a fresh worktree when the merged candidate refuses", () => {
    g.merged("clob/a", git(join(c, "clob-a"), "rev-parse", "HEAD"));
    const r = wtGh(c, "add", "tracks-ignored");
    expect(r.code).toBe(0);
    expect(r.out).toContain("not reusing clob-a/ after all, nothing changed");
    expect(readFileSync(join(c, "clob-a", "build", "keep.txt"), "utf8")).toBe("MINE\n");
    expect(readFileSync(join(c, "tracks-ignored", "build", "keep.txt"), "utf8")).toBe("FROM BRANCH\n");
    g.unmerge("clob/a");
  });

  test("refuses worktrees outside the container and ones with populated submodules", () => {
    git(c, "worktree", "add", "-q", join(root, "safe-outside"), "-b", "outside");
    expect(wt(c, "reuse", join(root, "safe-outside"), "x1").err).toContain("outside the container");
    expect(wt(c, "add", "sub/a").code).toBe(0);
    const w = join(c, "sub-a");
    git(w, "-c", "protocol.file.allow=always", "submodule", "add", "-q", makeRemote("safe-sub"), "mod");
    git(w, "commit", "-qm", "submodule");
    const r = wt(c, "reuse", "sub-a", "x2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("submodules");
    expect(git(w, "rev-parse", "--abbrev-ref", "HEAD")).toBe("sub/a");
  });

  test("a PR head that only exists on GitHub is fetched from refs/pull/<n>/head", () => {
    expect(wt(c, "add", "done/m").code).toBe(0);
    const w = join(c, "done-m");
    writeFileSync(join(w, "m.txt"), "m\n");
    git(w, "add", "."); git(w, "commit", "-qm", "m");
    git(w, "push", "-q", "origin", "done/m");
    let head = "";
    onRemote((d) => { // the suggestion applied in the GitHub UI, then the branch deleted
      git(d, "checkout", "-q", "done/m");
      writeFileSync(join(d, "m.txt"), "suggested\n");
      git(d, "commit", "-qam", "apply suggestion");
      head = git(d, "rev-parse", "HEAD");
      git(d, "push", "-q", "origin", "HEAD:refs/pull/9/head");
    });
    expect(sh("git", ["cat-file", "-e", head], c).code).not.toBe(0);
    g.merged("done/m", head, 9);
    const r = wtGh(c, "add", "next/m");
    expect(r.code).toBe(0);
    expect(r.out).toContain("reusing done-m/: done/m was merged in t/safe#9");
    expect(existsSync(join(c, "next-m"))).toBe(true);
  });

  test("unreadable gh output is a warning, not a crash", () => {
    writeFileSync(g.fixture("tracks-ignored"), "not json");
    const r = wtGh(c, "add", "after-junk");
    expect(r.code).toBe(0);
    expect(r.out).toContain("unreadable output");
    expect(r.err).not.toContain("    at ");
    g.unmerge("tracks-ignored");
  });

  test("githubRepo matches github.com only", async () => {
    const { githubRepo } = await import("./GitWt.ts");
    expect(githubRepo("git@github.com:o/r.git")).toBe("o/r");
    expect(githubRepo("ssh://git@github.com/o/r")).toBe("o/r");
    expect(githubRepo("https://github.com/o/r/")).toBe("o/r");
    expect(githubRepo("https://notgithub.com/o/r.git")).toBeUndefined();
    expect(githubRepo("https://mygithub.com/o/r")).toBeUndefined();
    expect(githubRepo("git@github.company.com:o/r.git")).toBeUndefined();
  });
});

describe("prune", () => {
  let c: string;
  let bare: string;
  let g: FakeGh;
  const wtGh = (...a: string[]) => sh("bun", [TOOL, ...a], c, g.env);
  /** The section, short SHA and reason prune printed for each branch. */
  const rows = (out: string) => {
    const m = new Map<string, { section: string; sha: string; why: string }>();
    let section = "";
    for (const line of out.split("\n")) {
      const h = /^(\S.*) \(\d+\):$/.exec(line);
      if (h) section = h[1];
      const r = /^  (\S+) +([0-9a-f]{7,})  (.*)$/.exec(line);
      if (r && section) m.set(r[1], { section, sha: r[2], why: r[3] });
    }
    return m;
  };
  const has = (b: string) => sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], c).code === 0;
  const tips: Record<string, string> = {};
  /** A branch with one commit of its own, made in a scratch worktree outside the container.
   *  push: "u" pushes with an upstream, "plain" without one; `gone` then deletes it on the remote. */
  function branch(name: string, push?: "u" | "plain", gone = false) {
    const tmp = join(root, `prune-${name.replace(/\//g, "-")}`);
    git(c, "worktree", "add", "-q", "--no-track", "-b", name, tmp, "origin/master");
    writeFileSync(join(tmp, `${name.replace(/\//g, "-")}.txt`), "w\n");
    git(tmp, "add", "."); git(tmp, "commit", "-qm", name);
    if (push) git(tmp, "push", "-q", ...(push === "u" ? ["-u"] : []), "origin", name);
    if (gone) git(tmp, "push", "-q", "origin", "--delete", name);
    tips[name] = git(tmp, "rev-parse", "HEAD");
    git(c, "worktree", "remove", tmp);
  }

  beforeAll(() => {
    bare = makeRemote("prune-r");
    c = join(root, "pruneproj");
    expect(wt(root, "clone", bare, "--dir", c).code).toBe(0);
    const url = "https://github.com/t/prune.git";
    git(c, "config", `url.${bare}.insteadOf`, url);
    git(c, "remote", "set-url", "origin", url);
    git(c, "remote", "set-head", "origin", "master");
    g = fakeGh(join(root, "gh3"));

    branch("p/merged", "u", true); g.merged("p/merged", tips["p/merged"], 1);
    branch("p/merged-live", "u"); g.merged("p/merged-live", tips["p/merged-live"], 2); // remote branch never deleted
    branch("p/no-u", "plain", true); g.merged("p/no-u", tips["p/no-u"], 3); // pushed without -u
    branch("p/desc", "u");
    const remote = mkdtempSync(join(root, "prune-remote-"));
    git(root, "clone", "-q", bare, remote);
    git(remote, "checkout", "-q", "p/desc"); // a suggestion applied on GitHub, then the branch deleted
    writeFileSync(join(remote, "desc.txt"), "suggested\n");
    git(remote, "add", "."); git(remote, "commit", "-qm", "suggestion");
    git(remote, "push", "-q", "origin", "HEAD:refs/pull/11/head");
    git(remote, "push", "-q", "origin", "--delete", "p/desc");
    g.merged("p/desc", git(remote, "rev-parse", "HEAD"), 11);
    branch("p/gone", "u", true); // upstream gone, no PR
    branch("p/local"); // never pushed
    branch("p/open", "u"); // tracking, no PR
    branch("p/open2", "u");
    branch("p/past", "u"); g.merged("p/past", tips["p/past"], 4);
    const past = join(root, "prune-past-more");
    git(c, "worktree", "add", "-q", past, "p/past");
    writeFileSync(join(past, "more.txt"), "after merge\n");
    git(past, "add", "."); git(past, "commit", "-qm", "after merge");
    git(c, "worktree", "remove", past);

    expect(wtGh("add", "p/inwt", "--fresh").code).toBe(0);
    g.merged("p/inwt", git(join(c, "p-inwt"), "rev-parse", "HEAD"), 5);
    g.merged("master", git(c, "rev-parse", "master"), 6);
    // A worktree whose folder is gone for now, say on an unmounted volume.
    const vanished = join(root, "prune-vanished");
    git(c, "worktree", "add", "-q", "--no-track", "-b", "p/vanished", vanished, "origin/master");
    g.merged("p/vanished", git(vanished, "rev-parse", "HEAD"), 8);
    rmSync(vanished, { recursive: true });
    // A worktree stopped mid-rebase, which git lists as a detached HEAD.
    const rb = join(root, "prune-rb");
    git(c, "worktree", "add", "-q", "--detach", rb, "origin/master");
    writeFileSync(join(rb, "a.txt"), "theirs\n");
    git(rb, "commit", "-qam", "theirs");
    const onto = git(rb, "rev-parse", "HEAD");
    git(rb, "checkout", "-q", "--no-track", "-b", "p/rb", "origin/master");
    writeFileSync(join(rb, "a.txt"), "ours\n");
    git(rb, "commit", "-qam", "ours");
    g.merged("p/rb", git(rb, "rev-parse", "HEAD"), 9);
    expect(sh("git", ["rebase", onto], rb).code).not.toBe(0);
    expect(git(rb, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");

    mkdirSync(join(c, "stray-empty", "a", "b"), { recursive: true });
    mkdirSync(join(c, "stray-full", "tools"), { recursive: true });
    writeFileSync(join(c, "stray-full", "tools", "outbox.jsonl"), "{}\n");
    mkdirSync(join(c, "stray-link"));
    symlinkSync("/nonexistent", join(c, "stray-link", "l"));
    mkdirSync(join(c, "config"));
    writeFileSync(join(c, "config", "local.yaml"), "k: v\n");
    writeFileSync(join(c, ".shared"), "config/local.yaml\n");
    mkdirSync(join(c, ".cache"));
  });

  test("without --yes it lists every branch with its reason and changes nothing", () => {
    g.clearCalls();
    const r = wtGh("prune");
    expect(r.code).toBe(0);
    const m = rows(r.out);
    const all = [...Object.keys(tips), "p/inwt", "p/vanished", "p/rb", "master"];
    expect([...m.keys()].sort()).toEqual(all.sort());
    expect(m.get("p/merged")).toEqual({ section: "deleted by --yes", sha: tips["p/merged"].slice(0, 7), why: "merged in t/prune#1" });
    for (const b of ["p/merged-live", "p/no-u", "p/desc"]) expect(m.get(b)?.section).toBe("deleted by --yes");
    expect(m.get("p/gone")).toMatchObject({ section: "deleted by --yes --gone", why: "upstream gone, no merged PR" });
    const kept = (b: string) => (expect(m.get(b)?.section).toBe("kept"), m.get(b)!.why);
    expect(kept("p/local")).toBe("no upstream, no merged PR");
    expect(kept("p/open")).toBe("tracking origin/p/open, no merged PR");
    expect(kept("p/past")).toBe("tracking origin/p/past, t/prune#4 merged, but 1 commit came after it");
    expect(kept("p/inwt")).toBe("merged in t/prune#5, p-inwt/ stays for add to reuse");
    expect(kept("p/vanished")).toMatch(/^checked out in \/.*prune-vanished\/ \(folder missing\)$/);
    expect(kept("p/rb")).toMatch(/^rebasing in \/.*prune-rb\/$/);
    expect(kept("master")).toBe("default branch");
    expect(r.out).toContain("not a worktree, removed by --yes: stray-empty/ (empty)");
    expect(r.out).toContain("not a worktree, left alone: stray-full/ holds 1 file");
    expect(r.out).toContain("not a worktree, left alone: stray-link/ holds 1 file");
    expect(r.out).not.toContain("config/");
    expect(r.out).not.toContain(".cache");
    expect(r.out).toContain("nothing changed; the lists above say what --yes and --yes --gone delete");
    for (const b of all) expect(has(b)).toBe(true);
    expect(existsSync(join(c, "stray-empty"))).toBe(true);
    expect(git(c, "worktree", "list")).toContain("prune-vanished");
    for (const b of ["master", "p/vanished", "p/rb"]) expect(g.calls()).not.toContain(`--head ${b} `);
  });

  test("--yes deletes the merged branches and empty folders only, printing each SHA", () => {
    const r = wtGh("prune", "--yes");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`deleted p/merged (was ${tips["p/merged"].slice(0, 7)}`);
    expect(r.out).toContain("merged in t/prune#1)");
    for (const b of ["p/merged", "p/merged-live", "p/no-u", "p/desc"]) expect(has(b)).toBe(false);
    for (const b of ["p/gone", "p/local", "p/open", "p/open2", "p/past", "p/inwt", "p/vanished", "p/rb", "master"]) expect(has(b)).toBe(true);
    expect(r.out).toContain("kept without --gone");
    expect(existsSync(join(c, "stray-empty"))).toBe(false);
    expect(readFileSync(join(c, "stray-full", "tools", "outbox.jsonl"), "utf8")).toBe("{}\n");
    expect(lstatSync(join(c, "stray-link", "l")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(c, "config", "local.yaml"))).toBe(true);
    expect(git(c, "worktree", "list")).toContain("prune-vanished");
    // The printed SHA is enough to bring a branch back.
    git(c, "branch", "p/merged", tips["p/merged"]);
    expect(wtGh("prune", "--yes").out).toContain("deleted p/merged");
  });

  test("--gone also deletes upstream-gone branches, never local or checked-out ones", () => {
    const r = wtGh("prune", "--yes", "--gone");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`deleted p/gone (was ${tips["p/gone"].slice(0, 7)}; upstream gone, no merged PR)`);
    expect(has("p/gone")).toBe(false);
    for (const b of ["p/local", "p/open", "p/past", "p/inwt", "p/vanished", "p/rb", "master"]) expect(has(b)).toBe(true);
  });

  test("a stale .bare/HEAD doesn't expose the remote's default branch", () => {
    git(c, "symbolic-ref", "HEAD", "refs/heads/p/open");
    try {
      const r = wtGh("prune");
      expect(r.code).toBe(0);
      const m = rows(r.out);
      expect(m.get("master")).toMatchObject({ section: "kept", why: "default branch of origin" });
      expect(m.get("p/open")).toMatchObject({ section: "kept", why: "default branch" });
    } finally {
      git(c, "symbolic-ref", "HEAD", "refs/heads/master");
    }
  });

  test("when gh fails it warns and deletes nothing", () => {
    branch("p/later", "u", true); g.merged("p/later", tips["p/later"], 7);
    const r = sh("bun", [TOOL, "prune", "--yes"], c, { GIT_WT_GH: join(root, "no-such-gh") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("cannot ask GitHub for merged PRs");
    expect(r.out).toContain("those branches count as not merged");
    expect(r.err).not.toContain("    at ");
    expect(has("p/later")).toBe(true);
  });

  test("rejects positional arguments", () => {
    expect(wtGh("prune", "x").err).toContain("usage: git-wt prune");
  });

  test("reusing the default branch's worktree never deletes the default branch", () => {
    const r = wtGh("reuse", "master", "p/newmain");
    expect(r.code).toBe(0);
    expect(r.out).toContain("master is still a local branch; nothing was deleted");
    expect(has("master")).toBe(true);
  });
});

describe("prune removes merged worktrees", () => {
  let c: string;
  let g: FakeGh;
  const wtGh = (...a: string[]) => sh("bun", [TOOL, ...a], c, g.env);
  const folder = (b: string) => join(c, b.replace(/\//g, "-"));
  const has = (b: string) => sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], c).code === 0;
  let pr = 100;
  /** A worktree on its own branch with one commit, merged on GitHub at `day` unless that is left out. */
  function tree(b: string, day?: string) {
    expect(wtGh("add", b, "--fresh").code).toBe(0);
    writeFileSync(join(folder(b), `${b.replace(/\//g, "-")}.txt`), "w\n");
    git(folder(b), "add", "."); git(folder(b), "commit", "-qm", b);
    if (day) g.merged(b, git(folder(b), "rev-parse", "HEAD"), pr++, `2026-10-${day}T00:00:00Z`);
  }
  const row = (out: string, b: string) => out.split("\n").find((l) => l.startsWith(`  ${b} `)) ?? "";

  beforeAll(() => {
    const bare = makeRemote("prune-wt-r");
    c = join(root, "prunewt");
    expect(wt(root, "clone", bare, "--dir", c).code).toBe(0);
    const url = "https://github.com/t/prunewt.git";
    git(c, "config", `url.${bare}.insteadOf`, url);
    git(c, "remote", "set-url", "origin", url);
    git(c, "remote", "set-head", "origin", "master");
    g = fakeGh(join(root, "gh-wt"));
    writeFileSync(join(c, "shared.env"), "s=1\n");
    writeFileSync(join(c, ".shared"), "shared.env\n");
    expect(wt(c, "sync").code).toBe(0);

    tree("w/old", "01");
    tree("w/older", "02");
    tree("w/spare", "10");
    tree("w/dirty", "20"); // the newest merge, but dirty, so it can't be the spare
    writeFileSync(join(folder("w/dirty"), "a.txt"), "uncommitted\n");
    tree("w/untracked", "21");
    writeFileSync(join(folder("w/untracked"), "notes.txt"), "mine\n");
    tree("w/open"); // no PR
    tree("w/after", "03");
    writeFileSync(join(folder("w/after"), "more.txt"), "after merge\n");
    git(folder("w/after"), "add", "."); git(folder("w/after"), "commit", "-qm", "after merge");
    tree("w/locked", "22");
    git(c, "worktree", "lock", folder("w/locked"));
    mkdirSync(join(folder("w/old"), "build"));
    writeFileSync(join(folder("w/old"), "build", "out.bin"), "ignored\n");
    g.merged("master", git(c, "rev-parse", "master"), 99, "2026-10-30T00:00:00Z");
  });

  test("the preview names what goes and why the rest stays, and changes nothing", () => {
    const r = wtGh("prune");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/deleted by --yes \(2\):/);
    expect(row(r.out, "w/old")).toContain("worktree w-old/ goes too");
    expect(row(r.out, "w/older")).toContain("worktree w-older/ goes too");
    expect(row(r.out, "w/spare")).toContain("w-spare/ stays for add to reuse");
    expect(row(r.out, "w/dirty")).toContain("but w-dirty/ has uncommitted changes or untracked files");
    expect(row(r.out, "w/untracked")).toContain("but w-untracked/ has uncommitted changes or untracked files");
    expect(row(r.out, "w/locked")).toContain("but w-locked/ is locked");
    expect(row(r.out, "w/open")).toContain("checked out in w-open/");
    expect(row(r.out, "w/after")).toContain("checked out in w-after/");
    expect(row(r.out, "master")).toContain("default branch");
    expect(existsSync(folder("w/old"))).toBe(true);
    expect(has("w/old")).toBe(true);
  });

  test("a running process keeps its worktree, and the spare is picked from the others", () => {
    const proc = spawn("sleep", ["60"], { cwd: folder("w/spare"), stdio: "ignore" });
    try {
      const r = wtGh("prune");
      expect(row(r.out, "w/spare")).toContain("but w-spare/ has a process running in it");
      expect(row(r.out, "w/older")).toContain("w-older/ stays for add to reuse");
      expect(row(r.out, "w/old")).toContain("worktree w-old/ goes too");
    } finally {
      proc.kill();
    }
    // The kill is asynchronous; lsof must stop seeing it before the next test counts on that.
    while (sh("sh", ["-c", `lsof -nP -d cwd -Fn | grep -qxF "n${realpathSync(folder("w/spare"))}"`], c).code === 0) Bun.sleepSync(20);
  });

  test("its own version of a shared path keeps a worktree", () => {
    tree("w/copy", "04");
    tree("w/reallink", "05");
    const shared = readFileSync(join(c, ".shared"), "utf8");
    writeFileSync(join(c, "app.yaml"), "default\n");
    writeFileSync(join(folder("w/copy"), "app.yaml"), "edited\n");
    rmSync(join(folder("w/reallink"), "shared.env"));
    writeFileSync(join(folder("w/reallink"), "shared.env"), "mine\n");
    writeFileSync(join(c, ".shared"), `${shared}[copy]\napp.yaml\n`);
    try {
      const r = wtGh("prune");
      expect(row(r.out, "w/copy")).toContain("but w-copy/ has its own version of app.yaml");
      expect(row(r.out, "w/reallink")).toContain("but w-reallink/ has its own shared.env where a shared link belongs");
    } finally {
      writeFileSync(join(c, ".shared"), shared);
      rmSync(join(c, "app.yaml"));
      for (const [wtName, b] of [["w-copy", "w/copy"], ["w-reallink", "w/reallink"]]) {
        git(c, "worktree", "remove", "--force", join(c, wtName));
        git(c, "branch", "-D", b);
      }
    }
  });

  test("when gh fails no worktree goes", () => {
    const r = sh("bun", [TOOL, "prune", "--yes"], c, { GIT_WT_GH: join(root, "no-such-gh") });
    expect(r.code).toBe(0);
    expect(existsSync(folder("w/old"))).toBe(true);
    expect(has("w/old")).toBe(true);
  });

  test("--gone never removes a worktree", () => {
    tree("w/gone");
    git(folder("w/gone"), "push", "-q", "-u", "origin", "w/gone");
    git(folder("w/gone"), "push", "-q", "origin", "--delete", "w/gone");
    expect(wtGh("prune", "--yes", "--gone").code).toBe(0);
    expect(existsSync(folder("w/gone"))).toBe(true);
    expect(has("w/gone")).toBe(true);
    // That run was also a plain --yes: the next test sees what it left.
  });

  test("--yes removes the worktree and its branch, ignored files included; shared files survive", () => {
    expect(existsSync(folder("w/old"))).toBe(false);
    expect(has("w/old")).toBe(false);
    expect(existsSync(folder("w/older"))).toBe(false);
    expect(has("w/older")).toBe(false);
    expect(readFileSync(join(c, "shared.env"), "utf8")).toBe("s=1\n");
    for (const b of ["w/spare", "w/dirty", "w/untracked", "w/locked", "w/open", "w/after"]) {
      expect(existsSync(folder(b))).toBe(true);
      expect(has(b)).toBe(true);
    }
    expect(readFileSync(join(folder("w/dirty"), "a.txt"), "utf8")).toBe("uncommitted\n");
    expect(readFileSync(join(folder("w/untracked"), "notes.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(c, "master"))).toBe(true);
    expect(has("master")).toBe(true);
  });

  test("a second run leaves the spare, and add then reuses it", () => {
    const again = wtGh("prune", "--yes");
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("removed worktree");
    expect(existsSync(folder("w/spare"))).toBe(true);
    const r = wtGh("add", "w/next");
    expect(r.code).toBe(0);
    expect(r.out).toContain("reusing w-spare/");
    expect(existsSync(folder("w/next"))).toBe(true);
    expect(existsSync(folder("w/spare"))).toBe(false);
  });
});

describe("open + wtc", () => {
  let c: string;
  let bare: string;
  const bin = () => join(root, "open-bin");
  const yarnLog = () => join(root, "open-yarn.log");
  const env = (extra: Record<string, string> = {}) => ({ PATH: `${bin()}:${process.env.PATH}`, YARN_LOG: yarnLog(), ...extra });
  const open = (branch: string, extra: Record<string, string> = {}) => sh("bun", [TOOL, "open", branch], c, env(extra));
  const yarnRuns = () => (existsSync(yarnLog()) ? readFileSync(yarnLog(), "utf8").split("\n").filter(Boolean) : []);
  const head = (dir: string) => git(dir, "rev-parse", "HEAD");
  const settings = (w: string) => join(c, w, ".claude", "settings.local.json");
  function advanceRemote(): string {
    const tmp = mkdtempSync(join(root, "open-push-"));
    git(root, "clone", "-q", bare, tmp);
    writeFileSync(join(tmp, "later.txt"), `${tmp}\n`);
    git(tmp, "add", "."); git(tmp, "commit", "-qm", "later");
    git(tmp, "push", "-q", "origin", "master");
    return git(tmp, "rev-parse", "HEAD");
  }

  beforeAll(() => {
    bare = makeRemote("open-r");
    const tmp = mkdtempSync(join(root, "open-init-"));
    git(root, "clone", "-q", bare, tmp);
    writeFileSync(join(tmp, "yarn.lock"), "# lock\n");
    writeFileSync(join(tmp, ".gitignore"), ".env\nbuild/\nnode_modules/\n.claude/\n");
    git(tmp, "add", "."); git(tmp, "commit", "-qm", "yarn");
    git(tmp, "push", "-q", "origin", "master");
    c = join(root, "openproj");
    expect(wt(root, "clone", bare, "--dir", c).code).toBe(0);
    c = realpathSync(c);
    mkdirSync(bin());
    // A failing install still leaves node_modules behind, as a real one cut short does.
    writeFileSync(join(bin(), "yarn"), '#!/bin/sh\necho "$PWD" >> "$YARN_LOG"\nmkdir -p node_modules\n[ -n "$YARN_FAIL" ] && exit 3\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin(), "git-wt"), `#!/bin/sh\nexec bun "${TOOL}" "$@"\n`, { mode: 0o755 });
    mkdirSync(join(c, "master", ".claude"));
    writeFileSync(settings("master"), JSON.stringify({ enabledMcpjsonServers: ["tracer"], permissions: { allow: ["x"] } }));
  });

  test("a new branch pulls the clean default worktree, installs, inherits MCP approvals, prints only the path", () => {
    const fresh = advanceRemote();
    const r = open("feat/a");
    expect(r.code).toBe(0);
    expect(r.out).toBe(join(c, "feat-a"));
    expect(r.err).toContain("worktree feat-a/ on feat/a");
    expect(head(join(c, "master"))).toBe(fresh);
    expect(head(join(c, "feat-a"))).toBe(fresh);
    expect(yarnRuns()).toEqual([join(c, "feat-a")]);
    expect(JSON.parse(readFileSync(settings("feat-a"), "utf8"))).toEqual({ enabledMcpjsonServers: ["tracer"] });
  });

  test("an existing worktree is used as it is, installing only without node_modules", () => {
    const before = head(join(c, "master"));
    advanceRemote();
    let r = open("feat/a");
    expect(r.code).toBe(0);
    expect(r.out).toBe(join(c, "feat-a"));
    expect(head(join(c, "master"))).toBe(before);
    expect(yarnRuns().length).toBe(1);
    rmSync(join(c, "feat-a", "node_modules"), { recursive: true });
    r = open("feat/a");
    expect(yarnRuns().length).toBe(2);
  });

  test("MCP approvals the worktree already has are kept", () => {
    const own = JSON.stringify({ disabledMcpjsonServers: ["tracer"] });
    writeFileSync(settings("feat-a"), own);
    expect(open("feat/a").code).toBe(0);
    expect(readFileSync(settings("feat-a"), "utf8")).toBe(own);
  });

  test("a dirty default worktree is left alone; the new branch starts from the fetched remote", () => {
    writeFileSync(join(c, "master", "scratch.txt"), "mine\n");
    const before = head(join(c, "master"));
    const fresh = advanceRemote();
    const r = open("feat/b");
    expect(r.code).toBe(0);
    expect(head(join(c, "feat-b"))).toBe(fresh);
    expect(head(join(c, "master"))).toBe(before);
    expect(readFileSync(join(c, "master", "scratch.txt"), "utf8")).toBe("mine\n");
    rmSync(join(c, "master", "scratch.txt"));
  });

  test("a failing install fails loudly, and the next open installs again", () => {
    const r = open("feat/c", { YARN_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("yarn install failed");
    expect(r.out).toBe("");
    expect(existsSync(join(c, "feat-c", "node_modules"))).toBe(true);
    const runs = yarnRuns().length;
    expect(open("feat/c").code).toBe(0);
    expect(yarnRuns().length).toBe(runs + 1);
    expect(open("feat/c").code).toBe(0); // installed now, so no third run
    expect(yarnRuns().length).toBe(runs + 1);
  });

  test("a worktree from plain git-wt add installs on its first open, even with a node_modules", () => {
    expect(sh("bun", [TOOL, "add", "feat/d"], c, env()).code).toBe(0);
    mkdirSync(join(c, "feat-d", "node_modules")); // as a reused worktree would carry over
    const runs = yarnRuns().length;
    expect(open("feat/d").code).toBe(0);
    expect(yarnRuns().length).toBe(runs + 1);
  });

  test("a default worktree without an upstream isn't fast-forwarded; the new branch starts from the remote", () => {
    git(join(c, "master"), "branch", "--unset-upstream");
    try {
      const before = head(join(c, "master"));
      const fresh = advanceRemote();
      const r = open("feat/e");
      expect(r.code).toBe(0);
      expect(head(join(c, "feat-e"))).toBe(fresh);
      expect(head(join(c, "master"))).toBe(before);
    } finally {
      git(join(c, "master"), "branch", "--set-upstream-to", "origin/master");
    }
  });

  test("open --help goes to stderr, keeping stdout for the path", () => {
    const r = sh("bun", [TOOL, "open", "--help"], c, env());
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("git-wt open <branch>");
  });

  for (const shell of ["bash", "zsh"]) {
    test(`wtc in ${shell} lands in the worktree and runs WTC_COMMAND there`, () => {
      if (sh("sh", ["-c", `command -v ${shell}`], root).code !== 0) return; // not installed here
      const script = `. "${join(import.meta.dir, "wtc.sh")}"; WTC_COMMAND='echo "ran in $PWD"'; wtc feat/a; echo "now in $PWD"`;
      const flag = shell === "zsh" ? "-fc" : "-c"; // -f: no rc files
      const r = sh(shell, [flag, script], c, env());
      expect(r.code).toBe(0);
      expect(r.out.split("\n").slice(-2)).toEqual([`ran in ${join(c, "feat-a")}`, `now in ${join(c, "feat-a")}`]);
      const bare = sh(shell, [flag, `. "${join(import.meta.dir, "wtc.sh")}"; wtc; echo "still in $PWD"`], c, env());
      expect(bare.err).toContain("usage: git-wt open");
      expect(bare.out).toBe(`still in ${c}`);
    });
  }
});
