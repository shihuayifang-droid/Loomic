import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * 45K guard (OP-08): deploy/backup.sh, restore.sh and verify-backup.sh are run
 * under bash with a fake `COMPOSE` command that records its calls and prints
 * fixed bytes, so no Docker daemon is needed. The real backup / restore drill
 * on .37 is QA-13. HAHART_BACKUP_NOW is a test-only override of "now".
 */
const BASH_CANDIDATES =
  process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe"] : ["/usr/bin/bash", "/bin/bash"];
const BASH = BASH_CANDIDATES.find((p) => existsSync(p));

const DEPLOY_SRC = fileURLToPath(new URL("../../../../deploy/", import.meta.url));

function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
}

const FAKE_COMPOSE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
args="$*"
case "$args" in
  *pg_dump*)
    if [ "\${FAKE_FAIL_DUMP:-0}" = "1" ]; then echo "boom" >&2; exit 1; fi
    printf 'PGDUMP-FIXED-BYTES'
    ;;
  *"pg_restore --list"*)
    cat > /dev/null
    echo "; archive listing"
    ;;
  *pg_restore*)
    cat > /dev/null
    ;;
  "run "*)
    case "$args" in
      *" xzf "*) cat > /dev/null ;;
      *) printf 'OBJECTS-FIXED-BYTES' ;;
    esac
    ;;
esac
exit 0
`;

const SUNDAY = "20260104-033000"; // 2026-01-04 is a Sunday
const MONDAY = "20260105-033000";

describe.skipIf(!BASH)("backup / restore scripts (OP-08)", () => {
  const work = mkdtempSync(join(tmpdir(), "hahart-bk-"));
  let caseDir = "";
  let n = 0;

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  function run(script: string, args: string[], env: Record<string, string>) {
    const r = spawnSync(BASH as string, [toPosix(join(DEPLOY_SRC, script)), ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function setup() {
    caseDir = join(work, `case${++n}`);
    const deploy = join(caseDir, "current", "deploy");
    mkdirSync(deploy, { recursive: true });
    mkdirSync(join(caseDir, "bk", "daily"), { recursive: true });
    writeFileSync(join(deploy, "docker-compose.yml"), "name: hahart\n");
    writeFileSync(join(deploy, "nginx.conf"), "events {}\n");
    writeFileSync(join(caseDir, "current", "REVISION"), "abc1234\n");
    writeFileSync(join(caseDir, "env.production"), "SECRET=not-a-real-secret\n");
    writeFileSync(join(caseDir, "fake-compose.sh"), FAKE_COMPOSE, { encoding: "utf8" });
    writeFileSync(join(caseDir, "calls.log"), "");
    const daily = join(caseDir, "bk", "daily");
    const weekly = join(caseDir, "bk", "weekly");
    const env = (extra: Record<string, string> = {}) => ({
      HAHART_BACKUP_ROOT: toPosix(daily),
      HAHART_DEPLOY_DIR: toPosix(deploy),
      HAHART_ENV_FILE: toPosix(join(caseDir, "env.production")),
      COMPOSE: `bash ${toPosix(join(caseDir, "fake-compose.sh"))}`,
      FAKE_LOG: toPosix(join(caseDir, "calls.log")),
      HAHART_BACKUP_NOW: MONDAY,
      ...extra,
    });
    return { daily, weekly, env, log: () => readFileSync(join(caseDir, "calls.log"), "utf8") };
  }

  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("produces the three artifacts, SHA256SUMS and MANIFEST with no .partial left", () => {
    const r = run("backup.sh", [], ctx.env());
    expect(r.code, r.stderr).toBe(0);
    const dir = join(ctx.daily, MONDAY);
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["MANIFEST", "SHA256SUMS", "config.tar.gz", "db.dump", "objects.tar.gz"]);
    expect(readdirSync(ctx.daily).some((x) => x.endsWith(".partial"))).toBe(false);
    expect(readFileSync(join(dir, "db.dump"), "utf8")).toBe("PGDUMP-FIXED-BYTES");
    const manifest = readFileSync(join(dir, "MANIFEST"), "utf8");
    expect(manifest).toContain("git_sha=abc1234");
    expect(manifest).toContain("bytes.db.dump=18");
    const sums = spawnSync(BASH as string, ["-c", "sha256sum -c SHA256SUMS"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(sums.status, sums.stdout + sums.stderr).toBe(0);
  });

  it("fails cleanly when pg_dump fails: non-zero, no final dir, .partial removed", () => {
    const r = run("backup.sh", [], ctx.env({ FAKE_FAIL_DUMP: "1" }));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("pg_dump");
    expect(r.stderr).not.toContain("not-a-real-secret");
    expect(readdirSync(ctx.daily)).toEqual([]);
  });

  it("keeps only the newest 7 daily backups", () => {
    for (let d = 1; d <= 9; d++) {
      mkdirSync(join(ctx.daily, `2025120${d}-033000`), { recursive: true });
    }
    const r = run("backup.sh", [], ctx.env());
    expect(r.code, r.stderr).toBe(0);
    const left = readdirSync(ctx.daily).sort();
    expect(left).toHaveLength(7);
    expect(left).toContain(MONDAY);
    expect(left).not.toContain("20251201-033000");
    expect(left).toContain("20251209-033000");
  });

  it("copies the Sunday backup to weekly and keeps only 4 weekly", () => {
    mkdirSync(ctx.weekly, { recursive: true });
    for (const d of ["20251123", "20251130", "20251207", "20251214", "20251221", "20251228"]) {
      mkdirSync(join(ctx.weekly, `${d}-033000`), { recursive: true });
    }
    const r = run("backup.sh", [], ctx.env({ HAHART_BACKUP_NOW: SUNDAY }));
    expect(r.code, r.stderr).toBe(0);
    const left = readdirSync(ctx.weekly).sort();
    expect(left).toEqual(["20251214-033000", "20251221-033000", "20251228-033000", SUNDAY]);
    expect(existsSync(join(ctx.weekly, SUNDAY, "db.dump"))).toBe(true);
  });

  it("does not touch weekly on a non-Sunday", () => {
    const r = run("backup.sh", [], ctx.env());
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(ctx.weekly)).toBe(false);
  });

  it("restore.sh exits 3 on a tampered backup and runs nothing", () => {
    expect(run("backup.sh", [], ctx.env()).code).toBe(0);
    const dir = join(ctx.daily, MONDAY);
    writeFileSync(join(dir, "db.dump"), "PGDUMP-FIXED-BYTEX");
    const before = ctx.log();
    const r = run("restore.sh", [toPosix(dir), "--yes"], ctx.env());
    expect(r.code).toBe(3);
    expect(ctx.log()).toBe(before);
  });

  it("restore.sh without --yes runs no restore command", () => {
    expect(run("backup.sh", [], ctx.env()).code).toBe(0);
    const dir = join(ctx.daily, MONDAY);
    const before = ctx.log();
    const r = run("restore.sh", [toPosix(dir)], ctx.env());
    expect(r.code).not.toBe(0);
    expect(ctx.log()).toBe(before);
    expect(ctx.log()).not.toContain("pg_restore");
  });

  it("restore.sh --yes issues pg_restore on a good backup", () => {
    expect(run("backup.sh", [], ctx.env()).code).toBe(0);
    const dir = join(ctx.daily, MONDAY);
    const r = run("restore.sh", [toPosix(dir), "--yes"], ctx.env());
    expect(r.code, r.stderr).toBe(0);
    expect(ctx.log()).toContain("pg_restore --clean --if-exists -U hahart -d hahart");
  });

  it("verify-backup.sh passes on a good backup and fails when a file is missing", () => {
    expect(run("backup.sh", [], ctx.env()).code).toBe(0);
    const dir = join(ctx.daily, MONDAY);
    const ok = run("verify-backup.sh", [toPosix(dir)], ctx.env());
    expect(ok.code, ok.stderr).toBe(0);
    expect(ctx.log()).toContain("pg_restore --list");
    rmSync(join(dir, "objects.tar.gz"));
    const bad = run("verify-backup.sh", [toPosix(dir)], ctx.env());
    expect(bad.code).not.toBe(0);
  });
});
