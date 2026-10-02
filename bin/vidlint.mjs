#!/usr/bin/env node
/**
 * vidlint CLI.
 *
 * Exit codes (stable, for CI):
 *   0  no defects at or above the failure threshold
 *   1  defects found at or above the failure threshold
 *   2  usage error, or the analysis itself failed
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { PLATFORM_PRESETS } from "../src/config.mjs";
import { VidlintError } from "../src/errors.mjs";
import { lint, TOOL_VERSION } from "../src/lint.mjs";
import { renderHtml, renderMarkdown, renderText } from "../src/report.mjs";
import { RULES } from "../src/rules.mjs";
import { buildContactSheet, extractFramePng, selectSampleTimes } from "../src/visuals.mjs";

const HELP = `vidlint ${TOOL_VERSION} — objective QA for generated video

USAGE
  vidlint <video> [video...] [options]

WHAT IT CHECKS
  Always on (deterministic, no heuristics):
    blank-frames        flat/uniform frames where nothing rendered
    frozen-with-audio   picture froze while audio kept playing  (a stalled render)
    dead-air            static stretches, classified by what the audio was doing
    flash-risk          WCAG 2.3.1 / ITU-R BT.1702 photosensitivity thresholds
    audio-*             silent track, gaps, loudness (EBU R128), clipping
    meta                frame rate, rotation metadata, over-compression

  Opt-in (PIXEL HEURISTICS — these guess from the rendered image and can
  produce false positives on busy full-bleed footage):
    --platform <name>   safe-area: content under platform UI chrome
    --layout            edge-clipping: content running into the frame edge

OPTIONS
  --json                 print the full report as JSON
  --markdown             print the report as Markdown
  --html <path>          write a self-contained HTML report (with sampled frames)
  --sheet <path>         write a contact sheet PNG of the whole timeline
  --out <path>           write the chosen report to a file instead of stdout
  --layout               enable the edge-clipping heuristic
  --platform <name>      safe-area preset, which also enables the layout pass
  --safe-area t,r,b,l    explicit safe-area insets as fractions, e.g. 0.05,0.05,0.1,0.05
  --strict               also fail on warnings
  --verbose              include info-level findings in terminal output
  --no-color             disable ANSI colour
  --temporal-fps <n>     temporal sampling rate (default 30)
  --spatial-fps <n>      layout sampling rate (default 2)
  --quiet                suppress progress output
  --list-rules           list every rule vidlint can report and exit
  --list-platforms       list the safe-area presets and exit
  -h, --help             show this help
  -v, --version          show the version

ENVIRONMENT
  VIDLINT_FFMPEG, VIDLINT_FFPROBE   override the binaries vidlint shells out to

EXAMPLES
  vidlint out.mp4
  vidlint out.mp4 --platform reels --strict
  vidlint out.mp4 --layout --verbose
  vidlint out.mp4 --html report.html --sheet contact-sheet.png
  vidlint out.mp4 --json > report.json

EXIT CODES
  0 clean   1 defects found   2 usage/analysis error
`;

function parseArgs(argv) {
  const options = {
    inputs: [],
    format: "text",
    out: null,
    html: null,
    sheet: null,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
    verbose: false,
    strict: false,
    quiet: false,
    lint: {},
  };

  const needsValue = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new VidlintError(`${flag} requires a value.`, "USAGE");
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "--json":
        options.format = "json";
        break;
      case "--markdown":
        options.format = "markdown";
        break;
      case "--html":
        options.html = needsValue(arg, i);
        i++;
        break;
      case "--sheet":
        options.sheet = needsValue(arg, i);
        i++;
        break;
      case "--out":
        options.out = needsValue(arg, i);
        i++;
        break;
      case "--platform": {
        const name = needsValue(arg, i);
        i++;
        if (!(name in PLATFORM_PRESETS)) {
          throw new VidlintError(
            `Unknown platform preset \`${name}\`. Known: ${Object.keys(PLATFORM_PRESETS).join(", ")}.`,
            "USAGE",
          );
        }
        options.lint.platform = name;
        break;
      }
      case "--safe-area": {
        const raw = needsValue(arg, i);
        i++;
        const parts = raw.split(",").map((p) => Number(p.trim()));
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
          throw new VidlintError(
            `--safe-area expects four comma-separated fractions: top,right,bottom,left (got \`${raw}\`).`,
            "USAGE",
          );
        }
        const [top, right, bottom, left] = parts;
        options.lint.safeArea = { top, right, bottom, left };
        break;
      }
      case "--layout":
        options.lint.checkEdgeClipping = true;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--verbose":
        options.verbose = true;
        options.lint.verbose = true;
        break;
      case "--no-color":
        options.color = false;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--temporal-fps": {
        const value = Number(needsValue(arg, i));
        i++;
        options.lint.temporalFps = value;
        break;
      }
      case "--spatial-fps": {
        const value = Number(needsValue(arg, i));
        i++;
        options.lint.spatialFps = value;
        break;
      }
      case "--list-rules":
        options.listRules = true;
        break;
      case "--list-platforms":
        options.listPlatforms = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new VidlintError(`Unknown option \`${arg}\`. Try --help.`, "USAGE");
        }
        options.inputs.push(arg);
    }
  }

  return options;
}

function failThreshold(options) {
  return options.strict ? "warn" : "error";
}

/**
 * @param {any} report
 * @param {string} threshold
 */
function reportFails(report, threshold) {
  if (threshold === "none") return false;
  if (threshold === "error") return report.summary.errors > 0;
  return report.summary.errors > 0 || report.summary.warnings > 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return;
  }
  if (options.listRules) {
    process.stdout.write("Rules vidlint can report:\n\n");
    for (const rule of RULES) {
      const tags = [rule.severity, rule.optIn ? "opt-in" : null].filter(Boolean).join(", ");
      process.stdout.write(
        `  ${rule.id.padEnd(22)} [${tags}]\n` +
          `      ${rule.title}\n` +
          `      ${rule.summary}\n`,
      );
      if (rule.reference) process.stdout.write(`      reference: ${rule.reference}\n`);
      process.stdout.write("\n");
    }
    return;
  }
  if (options.listPlatforms) {
    process.stdout.write("Safe-area presets (fractions of frame width/height):\n\n");
    for (const [name, area] of Object.entries(PLATFORM_PRESETS)) {
      process.stdout.write(
        `  ${name.padEnd(12)} top ${area.top}  right ${area.right}  bottom ${area.bottom}  left ${area.left}\n`,
      );
    }
    process.stdout.write(
      "\nOnly `remotion` derives from a first-party source; the per-platform presets are\n" +
        "community-reported and unverified. Calibrate on a real device and pass --safe-area.\n",
    );
    return;
  }

  if (options.inputs.length === 0) {
    process.stderr.write("No input file given. Try --help.\n");
    process.exit(2);
    return;
  }

  if (options.inputs.length > 1 && (options.html || options.sheet || options.out)) {
    process.stderr.write("--html, --sheet and --out are only supported with a single input.\n");
    process.exit(2);
    return;
  }

  const threshold = failThreshold(options);
  let worstExit = 0;

  for (const input of options.inputs) {
    const path = resolve(input);
    if (!existsSync(path)) {
      process.stderr.write(`Input file not found: ${path}\n`);
      process.exit(2);
      return;
    }

    const progress = options.quiet
      ? () => {}
      : (stage) => {
          if (options.format !== "json") process.stderr.write(`\r  analysing: ${stage.padEnd(12)}`);
        };

    let report;
    try {
      report = await lint(path, { ...options.lint, onProgress: progress });
    } catch (err) {
      if (!options.quiet) process.stderr.write("\r");
      if (err instanceof VidlintError) {
        process.stderr.write(`vidlint: ${err.message}\n`);
        if (err.hint) process.stderr.write(`\n${err.hint}\n`);
        process.exit(2);
        return;
      }
      throw err;
    }

    if (!options.quiet && options.format !== "json") process.stderr.write("\r\u001b[K");

    // ---- side artefacts ---------------------------------------------------
    if (options.sheet) {
      const target = resolve(options.sheet);
      mkdirSync(dirname(target), { recursive: true });
      await buildContactSheet({
        input: path,
        outputPath: target,
        duration: report.media.durationSeconds ?? 1,
      });
      process.stderr.write(`Contact sheet written to ${target}\n`);
    }

    if (options.html) {
      const target = resolve(options.html);
      mkdirSync(dirname(target), { recursive: true });

      const times = selectSampleTimes(
        report.media.durationSeconds ?? 1,
        report.defects,
        12,
      );
      const frames = [];
      for (const time of times) {
        const png = await extractFramePng(path, time, 480);
        if (png) {
          frames.push({ time, dataUri: `data:image/png;base64,${png.toString("base64")}` });
        }
      }

      writeFileSync(target, renderHtml(report, { frames }), "utf8");
      process.stderr.write(`HTML report written to ${target}\n`);
    }

    // ---- main output ------------------------------------------------------
    let output;
    if (options.format === "json") output = JSON.stringify(report, null, 2);
    else if (options.format === "markdown") output = renderMarkdown(report);
    else output = renderText(report, { color: options.color, verbose: options.verbose });

    if (options.out) {
      const target = resolve(options.out);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, output, "utf8");
      process.stderr.write(`Report written to ${target}\n`);
    } else {
      process.stdout.write(`${output}\n`);
    }

    if (reportFails(report, threshold)) {
      worstExit = Math.max(worstExit, 1);
    }
  }

  process.exit(worstExit);
}

main().catch((err) => {
  process.stderr.write(`vidlint: unexpected failure\n${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
