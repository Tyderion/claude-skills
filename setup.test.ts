import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(readFileSync(join(t, "state", "claude-skills", "backup", backup, "SKILL.md"), "utf8")).toBe("my edit\n");
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

  test("a malformed install.conf fails loudly", () => {
    repo([], { fake: "require git\n" });
    expect(setup().err).toContain("needs <command> <min version|->");
    writeFileSync(join(t, "repo", "skills", "fake", "install.conf"), "needs git\n");
    expect(setup().err).toContain("unknown entry 'needs'");
  });
});
