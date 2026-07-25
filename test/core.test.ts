import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isIgnoredWatchPath } from "../src/controller.js";
import { composeFeedback } from "../src/prompt.js";
import { createCheckpoint, decodeStored, parsePorcelainPaths, scanAgainstCheckpoint } from "../src/git.js";
import { WorkspaceModel } from "../src/workspace.js";

const execFileAsync = promisify(execFile);

function fakePi(): ExtensionAPI {
  return {
    async exec(command: string, args: string[], options?: { cwd?: string }) {
      try {
        const result = await execFileAsync(command, args, { cwd: options?.cwd, encoding: "utf8" });
        return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, killed: false };
      }
    },
  } as ExtensionAPI;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

test("ignores generated dependency and git trees at any depth", () => {
  assert.equal(isIgnoredWatchPath("/repo", "/repo/packages/app/node_modules/pkg/file.js"), true);
  assert.equal(isIgnoredWatchPath("/repo", "/repo/packages/app/.git/index"), true);
  assert.equal(isIgnoredWatchPath("/repo", "/repo/src/file.ts"), false);
});

test("parses porcelain paths including renames", () => {
  const output = " M src/a.ts\0R  src/new.ts\0src/old.ts\0?? new file.ts\0";
  assert.deepEqual(parsePorcelainPaths(output), ["src/a.ts", "src/new.ts", "src/old.ts", "new file.ts"]);
});

test("formats compact actionable feedback", () => {
  assert.equal(composeFeedback([
    { path: "src/a.ts", side: "modified", line: 12, body: "Handle the empty case." },
    { path: "README.md", side: "file", line: null, body: "Clarify setup.\nAdd an example." },
  ]), [
    "Please address the following review feedback:",
    "",
    "1. src/a.ts:12 (current)",
    "   Handle the empty case.",
    "",
    "2. README.md",
    "   Clarify setup.",
    "   Add an example.",
  ].join("\n"));
});

test("bundled webview is self-contained and syntactically valid", async () => {
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const html = await readFile(join(projectRoot, "web/dist/index.html"), "utf8");
  assert.doesNotMatch(html, /__[A-Z_]+__/);

  const appMatch = html.match(/\(0, eval\)\(atob\("([A-Za-z0-9+/=]+)"\)\)/);
  const workerMatch = html.match(/__reviewWorkerSource = atob\("([A-Za-z0-9+/=]+)"\)/);
  assert.ok(appMatch, "embedded app bundle is present");
  assert.ok(workerMatch, "embedded worker bundle is present");
  assert.doesNotThrow(() => new Function(Buffer.from(appMatch[1]!, "base64").toString("utf8")));
  assert.doesNotThrow(() => new Function(Buffer.from(workerMatch[1]!, "base64").toString("utf8")));
});

test("checkpoint stores dirty state and produces only the next delta", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-loop-"));
  try {
    await git(cwd, "init", "-b", "main");
    await git(cwd, "config", "user.email", "test@example.com");
    await git(cwd, "config", "user.name", "Test");
    await writeFile(join(cwd, "app.ts"), "export const value = 1;\n");
    await writeFile(join(cwd, "clean.ts"), "export const clean = true;\n");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-m", "initial");

    await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
    await writeFile(join(cwd, "untracked.ts"), "first\n");
    const checkpoint = await createCheckpoint(fakePi(), cwd, ["app.ts", "untracked.ts"], "feedback");

    assert.equal(decodeStored(checkpoint.overrides["app.ts"]!), "export const value = 2;\n");
    assert.equal(decodeStored(checkpoint.overrides["untracked.ts"]!), "first\n");
    assert.deepEqual(await scanAgainstCheckpoint(fakePi(), cwd, checkpoint), []);

    const reviewedModel = await WorkspaceModel.create(fakePi(), cwd, checkpoint);
    await reviewedModel.refresh();
    reviewedModel.setMode("head");
    const reviewedHeadState = reviewedModel.state();
    assert.deepEqual(reviewedHeadState.pendingFiles, []);
    assert.deepEqual(reviewedHeadState.recentPaths.sort(), ["app.ts", "untracked.ts"]);
    assert.ok(reviewedHeadState.files.every((file) => typeof file.recentAt === "number"));

    await writeFile(join(cwd, "app.ts"), "export const value = 3;\n");
    await writeFile(join(cwd, "clean.ts"), "export const clean = false;\n");
    await writeFile(join(cwd, "untracked.ts"), "second\n");
    const delta = await scanAgainstCheckpoint(fakePi(), cwd, checkpoint);

    assert.deepEqual(delta.map((file) => file.path), ["app.ts", "clean.ts", "untracked.ts"]);
    assert.equal(delta.find((file) => file.path === "app.ts")?.originalContent, "export const value = 2;\n");
    assert.equal(delta.find((file) => file.path === "clean.ts")?.originalContent, "export const clean = true;\n");
    assert.equal(delta.find((file) => file.path === "untracked.ts")?.originalContent, "first\n");
    assert.equal(await readFile(join(cwd, "app.ts"), "utf8"), "export const value = 3;\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
