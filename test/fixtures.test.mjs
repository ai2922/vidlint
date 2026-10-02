/**
 * Fixture generation must be safe under concurrency.
 *
 * Node's test runner executes test files in parallel, so e2e/mcp/schema all
 * call `ensureFixtures()` on the same directory at once. An earlier
 * implementation shared a scratch directory and wrote the output in place,
 * which produced a truncated `bad.mp4` on CI - and because the truncated file
 * was still a *valid* two-second video, the suite reported zero defects
 * instead of failing loudly. That is the worst possible failure mode for a
 * linter, so it gets its own regression test.
 *
 * This deliberately spawns several real processes against a fresh directory.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { lint } from "../src/lint.mjs";

const GENERATOR = join(process.cwd(), "test", "helpers", "fixtures.mjs");
const CONCURRENCY = 3;

let scratch;

after(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

/** Run the fixture generator once against `dir`. */
function generate(dir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [GENERATOR, dir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(undefined);
      else rejectPromise(new Error(`fixture generator exited ${code}\n${stderr}`));
    });
  });
}

test(
  "concurrent fixture generation never produces a truncated video",
  { timeout: 300_000 },
  async () => {
    scratch = mkdtempSync(join(tmpdir(), "vidlint-race-"));
    const dir = join(scratch, "fixtures");

    // Several processes race to build the same fixtures at the same time.
    await Promise.all(Array.from({ length: CONCURRENCY }, () => generate(dir)));

    for (const name of ["good.mp4", "bad.mp4", "clean-bg.mp4"]) {
      const path = join(dir, name);
      assert.ok(existsSync(path), `${name} was not produced`);
      assert.ok(statSync(path).size > 10_000, `${name} looks truncated (${statSync(path).size} bytes)`);
    }

    // The real assertion: the planted defects must all still be present. A
    // truncated bad.mp4 would be a valid but short video that reports nothing.
    const report = await lint(join(dir, "bad.mp4"));
    const ids = report.defects.map((d) => d.id);

    assert.ok(ids.includes("frozen-with-audio"), `missing frozen-with-audio; got ${ids.join(", ")}`);
    assert.ok(ids.includes("blank-frames"), `missing blank-frames; got ${ids.join(", ")}`);

    // The fixture is ten seconds long; a truncated one would be far shorter.
    assert.ok(
      report.media.durationSeconds > 9.5 && report.media.durationSeconds < 10.5,
      `bad.mp4 duration was ${report.media.durationSeconds}s, expected about 10s`,
    );
  },
);
