import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const git = (cwd: string, ...a: string[]) => {
  const r = sh("git", a, cwd);
  if (r.code !== 0) throw new Error(`git ${a.join(" ")}: ${r.err}`);
  return r.out;
};
const wt = (cwd: string, ...a: string[]) => sh("bun", [TOOL, ...a], cwd);

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

  test("refuses a detached HEAD and an existing container", () => {
    const d = checkout("detached");
    git(d, "checkout", "-q", "--detach");
    expect(wt(d, "convert").err).toContain("detached");
    expect(wt(root, "convert", join(root, "conv", "feature-x")).code).toBe(1);
  });
});
