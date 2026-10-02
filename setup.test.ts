import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETUP = join(import.meta.dir, "setup");
const REAL_SKILLS = join(import.meta.dir, "skills");

let t: string; // per-test sandbox: repo/, claude/, bin/, state/, fake/
const claude = () => join(t, "claude");
const skill = (name: string) => join(claude(), "skills", name);

/** A repo with the real setup and the given skills: real ones copied, fakes from `{ name: install.conf }`. */
function repo(real: string[], fakes: Record<string, string> = {}) {
  const r = join(t, "repo");
  mkdirSync(join(r, "skills"), { recursive: true });
  cpSync(SETUP, join(r, "setup"));
  for (const s of real) cpSync(join(REAL_SKILLS, s), join(r, "skills", s), { recursive: true });
  for (const [s, conf] of Object.entries(fakes)) {
    mkdirSync(join(r, "skills", s, "Tools"), { recursive: true });
    writeFileSync(join(r, "skills", s, "SKILL.md"), `---\nname: {{SKILL_NAME}}\n---\nrun bun {{SKILL_DIR}}/Tools/x.ts, source {{SOURCE_DIR}}\n`);
    writeFileSync(join(r, "skills", s, "Tools", "x.ts"), 'console.log("x ran")\n');
    writeFileSync(join(r, "skills", s, "install.conf"), conf);
  }
  return r;
}

/** Executables that log their arguments to fake/log, put first on PATH. */
function fakes(...names: string[]) {
  for (const n of names) {
    writeFileSync(join(t, "fake", n), `#!/bin/sh\necho "${n} $*" >> "${join(t, "fake", "log")}"\n`);
    chmodSync(join(t, "fake", n), 0o755);
  }
}
const fakeLog = () => (existsSync(join(t, "fake", "log")) ? readFileSync(join(t, "fake", "log"), "utf8") : "");

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", a, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

function os(id: string, like = "", pretty = id) {
  writeFileSync(join(t, "os-release"), `ID=${id}\nID_LIKE=${like}\nPRETTY_NAME="${pretty}"\n`);
}

function setup(args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [join(t, "repo", "setup"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], // no terminal: setup must never prompt
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claude(), XDG_BIN_HOME: join(t, "bin"), XDG_STATE_HOME: join(t, "state"),
      SETUP_OS_RELEASE: join(t, "os-release"), SETUP_UNAME: "Linux",
      PATH: `${join(t, "fake")}:${join(t, "bin")}:${process.env.PATH}`,
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

beforeEach(() => {
  t = mkdtempSync(join(tmpdir(), "skills-setup-"));
  mkdirSync(join(t, "fake"));
  mkdirSync(claude());
  os("arch", "", "Arch Linux");
});

describe("installing", () => {
  test("copies every skill with the _ prefix on a LifeOS install, fills placeholders, writes a working shim", () => {
    mkdirSync(join(claude(), "LIFEOS"));
    repo(["GitWorktree", "review-loop"]);
    const r = setup();
    expect(r.code).toBe(0);
    expect(r.out).toContain("done: 2 skill(s)");
    const md = readFileSync(join(skill("_GitWorktree"), "SKILL.md"), "utf8");
    expect(md).toContain("name: _GitWorktree");
    expect(md).toContain(`bun ${join(skill("_GitWorktree"), "Tools", "GitWt.ts")}`);
    expect(md).not.toContain("{{");
    expect(readFileSync(join(skill("_review-loop"), "SKILL.md"), "utf8")).toContain("name: review-loop"); // literal name kept
    expect(existsSync(join(skill("_GitWorktree"), "install.conf"))).toBe(false);
    expect(readFileSync(join(skill("_GitWorktree"), ".skill-install"), "utf8")).toMatch(/^source=.*\ncommit=none\nhash=[0-9a-f]{64}\n$/);
    const shim = spawnSync(join(t, "bin", "git-wt"), ["--help"], { encoding: "utf8" });
    expect(shim.status).toBe(0);
    expect(shim.stdout).toContain("git-wt — bare-repo worktree containers");
  });

  test("no prefix without LifeOS; --prefix forces it; a rerun changes nothing", () => {
    repo([], { fake: "" });
    expect(setup().code).toBe(0);
    expect(readFileSync(join(skill("fake"), "SKILL.md"), "utf8")).toContain("name: fake");
    expect(setup().out).toContain("unchanged");
    expect(setup(["--prefix"]).code).toBe(0);
    expect(existsSync(skill("_fake"))).toBe(true);
  });

  test("only the named skills are installed; an unknown one is an error", () => {
    repo([], { a: "", b: "" });
    expect(setup(["b"]).code).toBe(0);
    expect(readdirSync(join(claude(), "skills"))).toEqual(["b"]);
    expect(setup(["nope"]).err).toContain("no skill named nope");
  });

  test("a tab-completed trailing slash is dropped; a path is rejected", () => {
    repo([], { fake: "" });
    expect(setup(["fake/"]).code).toBe(0);
    expect(readFileSync(join(skill("fake"), "SKILL.md"), "utf8")).toContain("name: fake\n");
    expect(setup(["skills/fake"]).err).toContain("not a skill name");
  });

  test("an unchanged rerun records the new commit in the marker", () => {
    const r = repo([], { fake: "" });
    git(r, "init", "-q"); git(r, "add", "."); git(r, "commit", "-qm", "one");
    writeFileSync(join(r, "skills", "fake", "Tools", "y.ts"), "");
    expect(setup().code).toBe(0);
    expect(readFileSync(join(skill("fake"), ".skill-install"), "utf8")).toContain("+uncommitted");
    git(r, "add", "."); git(r, "commit", "-qm", "two");
    expect(setup().out).toContain("unchanged");
    const marker = readFileSync(join(skill("fake"), ".skill-install"), "utf8");
    expect(marker).not.toContain("+uncommitted");
    expect(marker).toContain(`commit=${git(r, "rev-parse", "--short", "HEAD")}`);
  });
});

describe("never losing anything", () => {
  test("an installed copy edited in place is refused, and --force backs it up", () => {
    repo([], { fake: "" });
    setup();
    writeFileSync(join(skill("fake"), "SKILL.md"), "my edit\n");
    writeFileSync(join(t, "repo", "skills", "fake", "SKILL.md"), "new version\n");
    const r = setup();
    expect(r.code).toBe(1);
    expect(r.err).toContain("was edited after setup installed it");
    expect(readFileSync(join(skill("fake"), "SKILL.md"), "utf8")).toBe("my edit\n");
    const f = setup(["--force"]);
    expect(f.code).toBe(0);
    expect(readFileSync(join(skill("fake"), "SKILL.md"), "utf8")).toBe("new version\n");
    const [backup] = readdirSync(join(t, "state", "claude-skills", "backup"));
    expect(readFileSync(join(t, "state", "claude-skills", "backup", backup, "fake", "SKILL.md"), "utf8")).toBe("my edit\n");
  });

  test("two backups in the same second never land on each other", () => {
    repo([], { foo: "bin foo Tools/x.ts\n" });
    mkdirSync(skill("foo"), { recursive: true });
    writeFileSync(join(skill("foo"), "foo"), "my notes\n"); // same basename as the shim
    mkdirSync(join(t, "bin"));
    writeFileSync(join(t, "bin", "foo"), "#!/bin/sh\necho mine\n");
    expect(setup(["--force"]).code).toBe(0);
    const root = join(t, "state", "claude-skills", "backup");
    // One backup holds the old shim file `foo`, the other the skill folder `foo/` with its own `foo`.
    const found = readdirSync(root).map((d) => {
      const p = join(root, d, "foo");
      return readFileSync(lstatSync(p).isDirectory() ? join(p, "foo") : p, "utf8");
    }).sort();
    expect(found).toEqual(["#!/bin/sh\necho mine\n", "my notes\n"]);
  });

  test("a failed placeholder fill stops setup and leaves the installed copy alone", () => {
    repo([], { fake: "" });
    expect(setup().code).toBe(0);
    const before = readFileSync(join(skill("fake"), "SKILL.md"), "utf8");
    writeFileSync(join(t, "repo", "skills", "fake", "SKILL.md"), "new {{SKILL_NAME}}\n");
    mkdirSync(join(t, "repo", "skills", "fake", "locked"));
    writeFileSync(join(t, "repo", "skills", "fake", "locked", "doc.md"), "{{SKILL_DIR}}\n");
    chmodSync(join(t, "repo", "skills", "fake", "locked"), 0o555); // copied as read-only: no room for doc.md.setup
    const r = setup();
    chmodSync(join(t, "repo", "skills", "fake", "locked"), 0o755);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot fill placeholders in locked/doc.md");
    expect(readFileSync(join(skill("fake"), "SKILL.md"), "utf8")).toBe(before);
    expect(readdirSync(claude()).filter((d) => d.startsWith(".skill-setup"))).toEqual([]); // tmp cleaned
  });

  test("a symlink where a shim goes is never written through", () => {
    repo([], { fake: "bin fake-cli Tools/x.ts\n" });
    mkdirSync(join(t, "bin"));
    symlinkSync(join(t, "elsewhere", "fake-cli"), join(t, "bin", "fake-cli")); // dangling
    expect(setup().err).toContain("fake-cli exists and was not written by this setup");
    expect(existsSync(join(t, "elsewhere"))).toBe(false);
  });

  test("a committed chmod +x or a retargeted symlink is a change; a symlink added to the copy is an edit", () => {
    repo([], { fake: "" });
    expect(setup().code).toBe(0);
    chmodSync(join(t, "repo", "skills", "fake", "Tools", "x.ts"), 0o755);
    expect(setup().out).toContain("installed");
    expect(lstatSync(join(skill("fake"), "Tools", "x.ts")).mode & 0o100).toBeTruthy();
    symlinkSync("x.ts", join(skill("fake"), "Tools", "link.ts"));
    expect(setup().err).toContain("was edited after setup installed it");
  });

  test("a symlink in the source is copied as a link, and retargeting it is a change", () => {
    const src = join(repo([], { fake: "" }), "skills", "fake", "Tools");
    symlinkSync("x.ts", join(src, "link.ts"));
    expect(setup().code).toBe(0);
    expect(readlinkSync(join(skill("fake"), "Tools", "link.ts"))).toBe("x.ts");
    expect(setup().out).toContain("unchanged");
    unlinkSync(join(src, "link.ts"));
    symlinkSync("../SKILL.md", join(src, "link.ts"));
    expect(setup().out).toContain("installed");
    expect(readlinkSync(join(skill("fake"), "Tools", "link.ts"))).toBe("../SKILL.md");
  });

  test("read-only folders in a skill do not break reruns or reinstalls", () => {
    repo([], { fake: "" });
    mkdirSync(join(t, "repo", "skills", "fake", "ro"));
    writeFileSync(join(t, "repo", "skills", "fake", "ro", "f"), "f\n");
    chmodSync(join(t, "repo", "skills", "fake", "ro"), 0o555);
    try {
      expect(setup().code).toBe(0);
      expect(setup().out).toContain("unchanged");
      writeFileSync(join(t, "repo", "skills", "fake", "Tools", "x.ts"), "changed\n");
      const r = setup();
      expect(r.code).toBe(0);
      expect(readFileSync(join(skill("fake"), "SKILL.md"), "utf8")).toContain("name: fake");
    } finally {
      chmodSync(join(t, "repo", "skills", "fake", "ro"), 0o755);
    }
  });

  test("a dangling symlink where the skill goes is refused, and --force backs it up", () => {
    repo([], { fake: "" });
    mkdirSync(join(claude(), "skills"));
    symlinkSync(join(t, "moved-away"), skill("fake"));
    expect(setup().err).toContain("was not installed by this setup");
    expect(setup(["--force"]).code).toBe(0);
    expect(lstatSync(skill("fake")).isDirectory()).toBe(true);
  });

  test("macOS Finder metadata does not count as an edit", () => {
    repo([], { fake: "" });
    writeFileSync(join(t, "repo", "skills", "fake", ".DS_Store"), "x");
    expect(setup().code).toBe(0);
    expect(existsSync(join(skill("fake"), ".DS_Store"))).toBe(false);
    writeFileSync(join(skill("fake"), ".DS_Store"), "finder");
    expect(setup().out).toContain("unchanged");
  });

  test("a folder or shim setup did not write is refused, and --force backs it up", () => {
    repo([], { fake: "bin fake-cli Tools/x.ts\n" });
    mkdirSync(join(claude(), "skills", "fake"), { recursive: true });
    writeFileSync(join(claude(), "skills", "fake", "SKILL.md"), "hand-made\n");
    expect(setup().err).toContain("was not installed by this setup");
    expect(readFileSync(join(skill("fake"), "SKILL.md"), "utf8")).toBe("hand-made\n");
    expect(setup(["--force"]).code).toBe(0);

    writeFileSync(join(t, "bin", "fake-cli"), "#!/bin/sh\necho mine\n");
    const r = setup();
    expect(r.err).toContain("fake-cli exists and was not written by this setup");
    expect(readFileSync(join(t, "bin", "fake-cli"), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(setup(["--force"]).code).toBe(0);
    expect(spawnSync(join(t, "bin", "fake-cli"), { encoding: "utf8" }).stdout).toBe("x ran\n");
  });

  test("switching prefix removes setup's own copy, never a foreign one", () => {
    repo([], { fake: "", stray: "" });
    expect(setup(["--prefix", "fake"]).code).toBe(0);
    const r = setup(["--no-prefix", "fake"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("now installed as fake");
    expect(existsSync(skill("_fake"))).toBe(false);
    mkdirSync(skill("_stray"));
    writeFileSync(join(skill("_stray"), "SKILL.md"), "someone else's\n");
    const w = setup(["--no-prefix", "stray"]);
    expect(w.code).toBe(0);
    expect(w.err).toContain("_stray also exists and was not installed from here");
    expect(readFileSync(join(skill("_stray"), "SKILL.md"), "utf8")).toBe("someone else's\n");
  });
});

describe("dependencies", () => {
  const conf = "require zzz-nope 1.0 arch=zzz-pkg brew=zzz-brew\nrequire git 2.0 arch=git brew=git\n";

  test("on Arch without a terminal: prints the pacman command, installs the skills anyway, exits 2", () => {
    repo([], { fake: conf });
    const r = setup();
    expect(r.code).toBe(2);
    expect(r.out).toContain("sudo pacman -S --needed zzz-pkg");
    expect(r.out).not.toContain("--needed zzz-pkg git"); // present deps are left out
    expect(fakeLog()).toBe("");
    expect(existsSync(skill("fake"))).toBe(true);
    expect(r.out).toContain("Paste this into Claude Code");
  });

  test("on Arch with --yes: runs pacman through sudo, then rechecks", () => {
    fakes("sudo");
    repo([], { fake: conf });
    const r = setup(["--yes"]);
    expect(fakeLog()).toBe("sudo pacman -S --needed zzz-pkg\n");
    expect(r.code).toBe(2); // the fake installed nothing
    expect(r.out).toContain("package manager ran and they are still missing");
  });

  test("an ID_LIKE=arch distro counts as Arch", () => {
    os("cachyos", "arch", "CachyOS");
    repo([], { fake: conf });
    expect(setup().out).toContain("sudo pacman -S --needed zzz-pkg");
  });

  test("on macOS with Homebrew: brew install with the brew names", () => {
    fakes("brew");
    repo([], { fake: conf });
    const r = setup(["--yes"], { SETUP_UNAME: "Darwin" });
    expect(fakeLog()).toBe("brew install zzz-brew\n");
    expect(r.code).toBe(2);
  });

  test("on macOS without Homebrew, or an unknown Linux: a prompt naming everything Claude needs", () => {
    repo([], { fake: conf + "optional zzz-opt - brew=zzz-o -- doing extra things\n" });
    const mac = setup([], { SETUP_UNAME: "Darwin" });
    expect(mac.code).toBe(2);
    expect(mac.out).toContain("Package manager setup found: none it knows");
    os("gentoo", "", "Gentoo Linux");
    const r = setup();
    expect(r.code).toBe(2);
    expect(r.out).toContain("Machine: Gentoo Linux (Linux ");
    expect(r.out).toContain("- zzz-nope >= 1.0 (required; found: none) [package: arch=zzz-pkg brew=zzz-brew]");
    expect(r.out).toContain("- zzz-opt (optional, for doing extra things; found: none) [package: brew=zzz-o]");
    expect(r.out).toContain(`${join(t, "repo")}/setup again`);
  });

  test("a command that is present but too old counts as missing, with the version found", () => {
    os("gentoo");
    repo([], { fake: "require git 99.0 arch=git\n" });
    const r = setup();
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/- git >= 99\.0 \(required; found: \d+\.\d+\.\d+ at \//);
  });

  test("only optional commands missing: a note, exit 0", () => {
    repo([], { fake: "optional zzz-opt - -- extras\n" });
    const r = setup();
    expect(r.code).toBe(0);
    expect(r.out).toContain("optional, not installed: zzz-opt (optional, for extras; found: none)");
    expect(r.out).not.toContain("Paste this");
  });

  test("the same command from two skills is asked for once, at the higher minimum", () => {
    os("gentoo");
    repo([], { a: "require zzz-nope 1.2 arch=p\n", b: "optional zzz-nope 2.0 -- b things\n" });
    const r = setup();
    expect(r.out.match(/- zzz-nope/g)?.length).toBe(1);
    expect(r.out).toContain("- zzz-nope >= 2.0 (required;");
  });

  test("a shim that reads stdin cannot swallow the remaining bin entries", () => {
    const r = repo([], { fake: "bin fa Tools/a.ts\nbin fb Tools/x.ts\n" });
    writeFileSync(join(r, "skills", "fake", "Tools", "a.ts"), "await Bun.stdin.text()\n");
    expect(setup().code).toBe(0);
    expect(existsSync(join(t, "bin", "fa"))).toBe(true);
    expect(existsSync(join(t, "bin", "fb"))).toBe(true);
  });

  test("an exported CDPATH does not change which repo is used", () => {
    repo([], { fake: "" });
    const r = spawnSync("bash", ["repo/setup"], {
      cwd: t, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CDPATH: ".:/nonexistent", CLAUDE_CONFIG_DIR: claude(), XDG_BIN_HOME: join(t, "bin"), SETUP_OS_RELEASE: join(t, "os-release") },
    });
    expect(r.status).toBe(0);
    expect(existsSync(skill("fake"))).toBe(true);
  });

  test("the last install.conf line counts without a trailing newline", () => {
    repo([], { fake: "require git 2.0\nbin fake-cli Tools/x.ts" });
    const r = setup();
    expect(r.code).toBe(0);
    expect(r.out).toContain("shim");
    expect(existsSync(join(t, "bin", "fake-cli"))).toBe(true);
  });

  test("* and ? in install.conf stay literal", () => {
    writeFileSync(join(t, "notes.md"), "");
    repo([], { fake: "optional zzz-opt - -- making * faster?\n" });
    const r = spawnSync("bash", [join(t, "repo", "setup")], {
      cwd: t, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude(), XDG_BIN_HOME: join(t, "bin"), SETUP_OS_RELEASE: join(t, "os-release") },
    });
    expect(r.stdout).toContain("optional, for making * faster?;");
  });

  test("a malformed install.conf fails loudly", () => {
    repo([], { fake: "require git\n" });
    expect(setup().err).toContain("needs <command> <min version|->");
    writeFileSync(join(t, "repo", "skills", "fake", "install.conf"), "needs git\n");
    expect(setup().err).toContain("unknown entry 'needs'");
  });
});
