/**
 * End-to-end tests: real ffmpeg, real video files, the real report shape.
 *
 * These run the whole pipeline against the generated fixtures, so they cover
 * the parts unit tests cannot: ffmpeg invocation, raw frame streaming, the
 * audio-visual join on actual media, and the CLI's exit codes.
 *
 * The fixtures are rebuilt on demand, so the first run is slower than the rest.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { lint } from "../src/lint.mjs";
import { renderHtml, renderMarkdown, renderText } from "../src/report.mjs";
import { ensureFixtures } from "./helpers/fixtures.mjs";

const FIXTURES = join(process.cwd(), ".fixtures");
const CLI = join(process.cwd(), "bin", "vidlint.mjs");

/** @type {{good:string, bad:string, clean:string}} */
let fixtures;
let scratch;

before(() => {
  fixtures = ensureFixtures(FIXTURES);
  scratch = mkdtempSync(join(tmpdir(), "vidlint-test-"));
}, { timeout: 180_000 });

after(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

/** Run the CLI and return status plus parsed stdout. */
function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// report shape
// ---------------------------------------------------------------------------

test("the report carries a versioned schema and a media summary", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.good);

  assert.equal(report.schemaVersion, "1.0");
  assert.equal(report.tool.name, "vidlint");
  assert.equal(typeof report.tool.version, "string");

  assert.equal(report.media.video.width, 640);
  assert.equal(report.media.video.height, 360);
  assert.ok(report.media.durationSeconds > 5 && report.media.durationSeconds < 7);
  assert.equal(report.media.audio.codec, "aac");

  assert.equal(typeof report.summary.total, "number");
  assert.equal(report.summary.passed, report.summary.errors === 0);
  assert.ok(Array.isArray(report.defects));
  assert.ok(report.timing.analysisMs >= 0);
});

test("every defect carries the fields an agent needs to act on it", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.bad);
  assert.ok(report.defects.length > 0, "the bad fixture must produce defects");

  for (const d of report.defects) {
    assert.equal(typeof d.id, "string", "defect needs a stable rule id");
    assert.equal(typeof d.fingerprint, "string", "defect needs a fingerprint");
    assert.ok(["error", "warn", "info"].includes(d.severity));
    assert.equal(typeof d.title, "string");
    assert.equal(typeof d.message, "string");
    assert.ok(d.from === null || typeof d.from === "number");
    assert.ok(d.evidence !== undefined);
  }
});

test("defects come back worst-first", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.bad);
  const ranks = { error: 0, warn: 1, info: 2 };
  for (let i = 1; i < report.defects.length; i++) {
    assert.ok(
      ranks[report.defects[i - 1].severity] <= ranks[report.defects[i].severity],
      "defects must be sorted by severity",
    );
  }
});

// ---------------------------------------------------------------------------
// clean footage stays clean
// ---------------------------------------------------------------------------

test("continuous motion with correct audio produces no defects", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.good);

  assert.equal(
    report.summary.errors,
    0,
    `expected no errors, got: ${JSON.stringify(report.defects, null, 2)}`,
  );
  assert.equal(report.summary.warnings, 0);
});

test("a realistic composed video with a clean background produces no defects", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.clean);
  assert.equal(
    report.summary.errors,
    0,
    `expected no errors, got: ${JSON.stringify(report.defects, null, 2)}`,
  );
});

// ---------------------------------------------------------------------------
// the planted defects
// ---------------------------------------------------------------------------

test("a frozen picture under continuing audio is caught as an error", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.bad);

  const freeze = report.defects.find((d) => d.id === "frozen-with-audio");
  assert.ok(freeze, `expected frozen-with-audio, got ${report.defects.map((d) => d.id).join(", ")}`);
  assert.equal(freeze.severity, "error");

  // The fixture freezes from 2s to 6s.
  assert.ok(freeze.from > 1.5 && freeze.from < 3.0, `unexpected start ${freeze.from}`);
  assert.ok(freeze.to > 5.5 && freeze.to < 6.8, `unexpected end ${freeze.to}`);

  assert.equal(freeze.evidence.audioDuringFreeze, "speech");
  assert.ok(freeze.evidence.audioOverlapFraction > 0.5);
});

test("the black second is caught as blank frames", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.bad);

  const blank = report.defects.find((d) => d.id === "blank-frames");
  assert.ok(blank, "expected blank-frames");
  assert.equal(blank.severity, "error");
  assert.ok(blank.from > 5.8 && blank.from < 6.6, `unexpected start ${blank.from}`);
});

test("a blank run is reported once and not also as dead air", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.bad);
  const overlapping = report.defects.filter(
    (d) => d.id === "dead-air" && d.from !== null && d.from >= 5.8 && d.from <= 6.6,
  );
  assert.equal(overlapping.length, 0, "the blank run should not be double-reported");
});

// ---------------------------------------------------------------------------
// the layout heuristic, where it belongs
// ---------------------------------------------------------------------------

test("layout checks are skipped unless asked for", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.clean);
  assert.equal(report.metrics.layout.skipped, true);
});

test("the safe-area check pinpoints the planted banner and reports nothing else", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.clean, { platform: "reels" });

  const findings = report.defects.filter((d) => d.id === "safe-area");
  assert.equal(
    findings.length,
    1,
    `expected exactly one safe-area finding, got ${JSON.stringify(findings, null, 2)}`,
  );

  const finding = findings[0];
  assert.equal(finding.evidence.side, "bottom");

  // The fixture draws the banner at x=180 y=318 w=280 h=28 in a 640x360 frame.
  // The check must report it in composition pixels, close to ground truth.
  const box = finding.evidence.compositionBox;
  assert.ok(box, "a safe-area finding must carry a composition-space box");
  assert.ok(Math.abs(box.x - 180) <= 25, `box.x was ${box.x}, expected about 180`);
  assert.ok(Math.abs(box.y - 318) <= 25, `box.y was ${box.y}, expected about 318`);
  assert.ok(Math.abs(box.width - 280) <= 30, `box.width was ${box.width}, expected about 280`);
});

test("the edge-clipping heuristic is off until --layout is passed", { timeout: 120_000 }, async () => {
  const without = await lint(fixtures.clean, { platform: "reels" });
  assert.equal(without.defects.filter((d) => d.id === "edge-clipping").length, 0);

  const withLayout = await lint(fixtures.clean, { platform: "reels", checkEdgeClipping: true });
  assert.equal(withLayout.metrics.layout.skipped, undefined);
});

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

test("all three renderers produce non-empty output containing the rule ids", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.bad);

  const text = renderText(report, { color: false, verbose: true });
  assert.match(text, /vidlint/);
  assert.match(text, /frozen-with-audio/);

  const markdown = renderMarkdown(report);
  assert.match(markdown, /## vidlint report/);
  assert.match(markdown, /frozen-with-audio/);

  const html = renderHtml(report, { frames: [] });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /frozen-with-audio/);
});

test("the HTML report escapes untrusted strings from the input path", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.good);
  const hostile = { ...report, input: "<script>alert(1)</script>" };
  const html = renderHtml(hostile, { frames: [] });
  assert.ok(!html.includes("<script>alert(1)</script>"), "input must be HTML-escaped");
  assert.match(html, /&lt;script&gt;/);
});

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

test("the CLI exits 1 when errors are found", { timeout: 120_000 }, () => {
  const result = runCli([fixtures.bad, "--quiet"]);
  assert.equal(result.status, 1, result.stderr);
});

test("the CLI exits 0 on clean footage", { timeout: 120_000 }, () => {
  const result = runCli([fixtures.good, "--quiet"]);
  assert.equal(result.status, 0, result.stderr);
});

test("--strict escalates warnings into a non-zero exit", { timeout: 120_000 }, () => {
  const result = runCli([fixtures.clean, "--platform", "reels", "--strict", "--quiet"]);
  // The planted banner is a warning, so --strict must fail the run.
  assert.equal(result.status, 1, result.stderr);
});

test("--json emits parseable JSON on stdout", { timeout: 120_000 }, () => {
  const result = runCli([fixtures.bad, "--json", "--quiet"]);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, "1.0");
  assert.ok(parsed.defects.length > 0);
});

test("the CLI exits 2 for a missing file", { timeout: 60_000 }, () => {
  const result = runCli([join(scratch, "does-not-exist.mp4"), "--quiet"]);
  assert.equal(result.status, 2);
});

test("the CLI exits 2 for an unknown platform preset", { timeout: 60_000 }, () => {
  const result = runCli([fixtures.good, "--platform", "myspace"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown platform preset/);
});

test("--help and --version are handled without touching the video", { timeout: 60_000 }, () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /USAGE/);

  const version = runCli(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("--list-platforms does not require an input file", { timeout: 60_000 }, () => {
  const result = runCli(["--list-platforms"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /reels/);
});

// ---------------------------------------------------------------------------
// side artefacts
// ---------------------------------------------------------------------------

test("--sheet writes a readable PNG contact sheet", { timeout: 180_000 }, () => {
  const sheet = join(scratch, "sheet.png");
  const result = runCli([fixtures.bad, "--sheet", sheet, "--quiet"]);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(existsSync(sheet), "contact sheet was not written");

  const bytes = readFileSync(sheet);
  assert.ok(bytes.length > 1000, "contact sheet looks empty");
  // PNG magic number.
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("--html writes a self-contained report with embedded frames", { timeout: 180_000 }, () => {
  const out = join(scratch, "report.html");
  const result = runCli([fixtures.bad, "--html", out, "--quiet"]);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(existsSync(out), "HTML report was not written");

  const html = readFileSync(out, "utf8");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /data:image\/png;base64,/);
});
