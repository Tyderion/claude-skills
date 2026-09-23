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
      expect(r.err).toContain("Run convert again");
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
      top: d, old: `${d}.pre-wt`, wt: join(d, "master"), bare: join(d, ".bare"), adminDir: join(d, ".bare", "worktrees", "master"),
      worktreeConfig: false, moved: [], wroteBareWorktreeConfig: false,
    }));
    const r = wt(root, "convert", d);
    expect(r.err).toContain("was never touched");
    expect(wt(root, "convert", d).code).toBe(0);
  });

  test("refuses a detached HEAD and an existing container", () => {
    const d = checkout("detached");
    git(d, "checkout", "-q", "--detach");
    expect(wt(d, "convert").err).toContain("detached");
    expect(wt(root, "convert", join(root, "conv", "feature-x")).code).toBe(1);
  });
});
