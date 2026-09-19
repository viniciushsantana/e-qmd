/**
 * End-to-end trust gate for project-local collection paths and model URIs (#889).
 *
 * Spawns real `qmd update` processes against a fixture that plays the part of a
 * freshly cloned repository shipping its own `.qmd/index.yml`.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const runnerArgs = isBunRuntime ? [qmdScript] : [tsxCli, qmdScript];

let projectDir: string;
let configDir: string;
let outsideDir: string;

function runQmd(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [...runnerArgs, ...args], {
      cwd: projectDir,
      env: {
        ...process.env,
        QMD_CONFIG_DIR: configDir,
        PWD: projectDir,
        QMD_DOCTOR_DEVICE_PROBE: "0",
        QMD_TRUST_LOCAL_CONFIG: "0",
        QMD_TRUST_UPDATE_HOOKS: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

function writeLocalConfig(body: string): void {
  writeFileSync(join(projectDir, ".qmd", "index.yml"), body, "utf-8");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "qmd-path-trust-proj-"));
  configDir = mkdtempSync(join(tmpdir(), "qmd-path-trust-cfg-"));
  outsideDir = mkdtempSync(join(tmpdir(), "qmd-path-trust-out-"));
  mkdirSync(join(projectDir, ".qmd"), { recursive: true });
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "readme.md"), "# Readme\n\nSome indexable content.\n", "utf-8");
  writeFileSync(join(outsideDir, "secret.md"), "# Secret\n\nShould not be indexed unattended.\n", "utf-8");
});

afterEach(() => {
  for (const dir of [projectDir, configDir, outsideDir]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("qmd update with a checked-in collection path outside the project", () => {
  function outsideConfig(): string {
    return [
      "collections:",
      "  secrets:",
      `    path: ${JSON.stringify(outsideDir)}`,
      '    pattern: "**/*.md"',
      "",
    ].join("\n");
  }

  test("does not index the outside path unattended", async () => {
    writeLocalConfig(outsideConfig());
    const result = await runQmd(["update"]);

    expect(result.stdout).toContain("Collection paths outside this project");
    expect(result.stdout).toContain("qmd trust");
    expect(result.stdout).toContain(`Skipping collection 'secrets'`);
    expect(result.stdout).not.toContain("Indexed: 1 new");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test("indexes it after `qmd trust`", async () => {
    writeLocalConfig(outsideConfig());
    const trust = await runQmd(["trust"]);
    expect(trust.stdout).toContain("Trusted");
    expect(trust.stdout).toContain(outsideDir);

    const result = await runQmd(["update"]);
    expect(result.stdout).toContain("Indexed: 1 new");
    expect(result.stdout).not.toContain("Skipping collection 'secrets'");
  }, 120_000);

  test("re-arms the gate when the path is rewritten after approval", async () => {
    writeLocalConfig(outsideConfig());
    await runQmd(["trust"]);
    const other = mkdtempSync(join(tmpdir(), "qmd-path-trust-other-"));
    writeFileSync(join(other, "other.md"), "# Other\n\nAlso outside.\n", "utf-8");
    writeLocalConfig([
      "collections:",
      "  secrets:",
      `    path: ${JSON.stringify(other)}`,
      '    pattern: "**/*.md"',
      "",
    ].join("\n"));

    const result = await runQmd(["update"]);
    expect(result.stdout).toContain("Skipping collection 'secrets'");
    expect(result.stdout).not.toContain("Indexed: 1 new");
    try { rmSync(other, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 120_000);

  test("QMD_TRUST_LOCAL_CONFIG=1 opts unattended runs back in", async () => {
    writeLocalConfig(outsideConfig());
    const result = await runQmd(["update"], { QMD_TRUST_LOCAL_CONFIG: "1" });
    expect(result.stdout).toContain("Indexed: 1 new");
    expect(result.stdout).not.toContain("Skipping collection 'secrets'");
  }, 120_000);
});

describe("qmd update with a checked-in custom model URI", () => {
  test("does not treat the custom model as trusted, but still indexes the project", async () => {
    writeLocalConfig([
      "collections:",
      "  docs:",
      "    path: ./docs",
      '    pattern: "**/*.md"',
      "models:",
      "  embed: hf:evil/embed/x.gguf",
      "",
    ].join("\n"));

    const result = await runQmd(["update"]);
    expect(result.stdout).toContain("Custom models");
    expect(result.stdout).toContain("hf:evil/embed/x.gguf");
    expect(result.stdout).toContain("Indexed: 1 new");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test("`qmd trust` records the custom model", async () => {
    writeLocalConfig([
      "collections:",
      "  docs:",
      "    path: ./docs",
      '    pattern: "**/*.md"',
      "models:",
      "  embed: hf:evil/embed/x.gguf",
      "",
    ].join("\n"));

    const trust = await runQmd(["trust"]);
    expect(trust.stdout).toContain("hf:evil/embed/x.gguf");
    expect(trust.stdout).toContain("Trusted");

    const result = await runQmd(["update"]);
    expect(result.stdout).not.toContain("Custom models");
    expect(result.stdout).toContain("Indexed: 1 new");
  }, 120_000);
});

describe("qmd update with only in-project paths", () => {
  test("indexes without a trust prompt", async () => {
    writeLocalConfig([
      "collections:",
      "  docs:",
      "    path: ./docs",
      '    pattern: "**/*.md"',
      "",
    ].join("\n"));

    const result = await runQmd(["update"]);
    expect(result.stdout).toContain("Indexed: 1 new");
    expect(result.stdout).not.toContain("qmd trust");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});

describe("project-local remote inference trust", () => {
  function remoteConfig(fields: string, provider = "openai"): string {
    return `collections:\n  docs:\n    path: ./docs\n    pattern: '*.md'\nembedding:\n  provider: ${provider}\n  openai:\n    model: fixture-embed\n    expansion_model: fixture-chat\n${fields}\n`;
  }

  test.each(["http://127.0.0.1:1/v1", "not-a-url"])("untrusted remote pull never falls through to local downloads (%s)", async url => {
    writeLocalConfig(remoteConfig(`    base_url: ${url}`));
    const result = await runQmd(["pull"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Remote inference is not trusted; no models downloaded");
    expect(result.stdout).not.toContain("Pulling models");
  }, 120_000);

  test("trusted remote pull remains a no-op", async () => {
    writeLocalConfig(remoteConfig("    base_url: http://127.0.0.1:1/v1"));
    expect((await runQmd(["trust"])).exitCode).toBe(0);
    const result = await runQmd(["pull"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no GGUF models to download");
    expect(result.stdout).not.toContain("Pulling models");
  }, 120_000);

  test("invalid untrusted remote config permits local indexing/search but cannot be approved", async () => {
    writeLocalConfig(remoteConfig("    base_url: https://user:private-fixture@example.com/v1"));
    const update = await runQmd(["update"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("Indexed: 1 new");
    expect(update.stderr).toContain("Remote inference configuration is invalid");
    expect(update.stdout + update.stderr).not.toContain("private-fixture");
    const search = await runQmd(["search", "indexable", "--json"]);
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("readme.md");
    const trust = await runQmd(["trust"]);
    expect(trust.exitCode).toBe(1);
    expect(trust.stderr).toContain("before granting trust");
    expect(trust.stdout + trust.stderr).not.toContain("private-fixture");
    expect(trust.stderr).not.toContain(" at ");
    expect(existsSync(join(configDir, "trusted.json"))).toBe(false);
  }, 120_000);

  test("invalid remote tuning is rejected before granting trust", async () => {
    writeLocalConfig(remoteConfig("    base_url: http://127.0.0.1:1/v1\n    timeout_ms: -1"));
    const trust = await runQmd(["trust"]);
    expect(trust.exitCode).toBe(1);
    expect(existsSync(join(configDir, "trusted.json"))).toBe(false);
    expect((await runQmd(["update"])).exitCode).toBe(0);
  }, 120_000);

  test("key rotation retains trust, but a changed remote destination re-arms it", async () => {
    const fields = "    base_url: http://127.0.0.1:1/v1";
    writeLocalConfig(remoteConfig(fields));
    expect((await runQmd(["trust"])).exitCode).toBe(0);
    writeLocalConfig(remoteConfig(`${fields}\n    api_key: rotated-fixture\n    chat_api_key: rotated-chat-fixture\n    timeout_ms: 1234`));
    const update = await runQmd(["update"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).not.toContain("not trusted by default");
    writeLocalConfig(remoteConfig("    base_url: http://127.0.0.1:2/v1"));
    const changed = await runQmd(["update"]);
    expect(changed.exitCode).toBe(0);
    expect(changed.stdout).toContain("not trusted by default");
  }, 120_000);

  test("trusted remote configuration with invalid tuning fails instead of silently using local inference", async () => {
    const fields = "    base_url: http://127.0.0.1:1/v1";
    writeLocalConfig(remoteConfig(fields));
    expect((await runQmd(["trust"])).exitCode).toBe(0);
    writeLocalConfig(remoteConfig(`${fields}\n    timeout_ms: -1`));
    const update = await runQmd(["update"]);
    expect(update.exitCode).not.toBe(0);
    expect(update.stderr).toContain("Invalid remote inference config: timeout_ms");
    expect(update.stdout).not.toContain("Indexed:");
  }, 120_000);

  test("explicit local mode ignores malformed remote fields", async () => {
    writeLocalConfig(remoteConfig("    base_url: not-a-url\n    timeout_ms: -1", "local"));
    const update = await runQmd(["update"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("Indexed: 1 new");
    expect(update.stdout + update.stderr).not.toContain("Remote inference configuration is invalid");
    expect(update.stdout).not.toContain("qmd trust");
  }, 120_000);
});
