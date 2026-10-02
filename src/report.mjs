/**
 * Report renderers: terminal, Markdown, HTML and JSON.
 *
 * All of them are pure functions of the report object, so the same analysis can
 * feed a human, a CI log, a pull-request comment, or an agent loop.
 */

import { formatDuration, formatTime } from "./defects.mjs";

const GLYPH = { error: "\u2716", warn: "\u26a0", info: "\u2139" };
const COLOR = { error: 31, warn: 33, info: 36 };

const paint = (enabled, code, text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);

function severityMark(severity, color) {
  return paint(color, COLOR[severity] ?? 0, GLYPH[severity] ?? "?");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === null) return "unknown size";
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** One-line description of the media, shared by the text and Markdown output. */
function mediaLine(report) {
  const m = report.media;
  const parts = [];
  if (m.video) parts.push(`${m.video.width}\u00d7${m.video.height}`);
  if (m.video?.fps) parts.push(`${m.video.fps.toFixed(2)} fps`);
  if (m.durationSeconds !== null) parts.push(`${m.durationSeconds.toFixed(2)}s`);
  if (m.sizeBytes) parts.push(formatBytes(m.sizeBytes));
  if (m.video?.codec) parts.push(m.video.codec);
  return parts.join(" \u00b7 ");
}

/**
 * @param {any} report
 * @param {{color?:boolean, verbose?:boolean}} [options]
 */
export function renderText(report, options = {}) {
  const color = options.color ?? false;
  const verbose = options.verbose ?? false;
  const lines = [];

  lines.push(
    paint(color, 1, `vidlint ${report.tool.version}`) + `  ${report.input}`,
  );
  lines.push(`  ${mediaLine(report)}`);
  if (report.media.audio) {
    lines.push(
      `  audio: ${report.media.audio.codec}` +
        (report.media.audio.sampleRate ? ` \u00b7 ${report.media.audio.sampleRate} Hz` : "") +
        (report.media.audio.channels ? ` \u00b7 ${report.media.audio.channels} ch` : ""),
    );
  }
  lines.push("");

  const { errors, warnings, infos, total } = report.summary;
  if (total === 0) {
    lines.push(`  ${paint(color, 32, "\u2714 No defects found.")}`);
  } else {
    lines.push(
      `  ${severityMark("error", color)} ${errors} error${errors === 1 ? "" : "s"} \u00b7 ` +
        `${severityMark("warn", color)} ${warnings} warning${warnings === 1 ? "" : "s"} \u00b7 ` +
        `${severityMark("info", color)} ${infos} info`,
    );
  }
  lines.push("");

  const shown = verbose ? report.defects : report.defects.filter((d) => d.severity !== "info");

  for (const d of shown) {
    const mark = severityMark(d.severity, color);
    const when = d.from !== null
      ? `${formatTime(d.from)}${d.to !== null ? `\u2013${formatTime(d.to)}` : ""}`
      : "\u2014";
    lines.push(`  ${mark} ${paint(color, 1, when.padEnd(17))} ${d.id}`);
    lines.push(`      ${d.title}`);
    lines.push(`      ${d.message}`);
    if (d.hint) lines.push(`      ${paint(color, 2, `\u21b3 ${d.hint}`)}`);
    lines.push("");
  }

  if (!verbose && report.defects.length > shown.length) {
    lines.push(
      paint(color, 2, `  ${report.defects.length - shown.length} info-level finding(s) hidden; use --verbose to show.`),
    );
    lines.push("");
  }

  const metrics = summarizeMetrics(report);
  if (metrics) lines.push(paint(color, 2, `  ${metrics}`));

  return lines.join("\n");
}

function summarizeMetrics(report) {
  const bits = [];
  const t = report.metrics?.temporal;
  const a = report.metrics?.audio;

  if (t) {
    if (typeof t.deadAirRatio === "number") bits.push(`dead air ${(t.deadAirRatio * 100).toFixed(0)}%`);
    if (typeof t.sceneCuts === "number") bits.push(`${t.sceneCuts} cut${t.sceneCuts === 1 ? "" : "s"}`);
    if (t.longestStaticSeconds) bits.push(`longest static ${t.longestStaticSeconds.toFixed(1)}s`);
  }
  if (a?.integratedLufs !== null && a?.integratedLufs !== undefined) {
    bits.push(`${a.integratedLufs.toFixed(1)} LUFS`);
  }
  if (a?.truePeakDbfs !== null && a?.truePeakDbfs !== undefined) {
    bits.push(`peak ${a.truePeakDbfs.toFixed(1)} dBFS`);
  }
  return bits.join(" \u00b7 ");
}

/**
 * @param {any} report
 */
export function renderMarkdown(report) {
  const lines = [];
  const { errors, warnings, infos } = report.summary;

  lines.push(`## vidlint report`);
  lines.push("");
  lines.push(`\`${report.input}\``);
  lines.push("");
  lines.push(`**${mediaLine(report)}**`);
  lines.push("");
  lines.push(`| Errors | Warnings | Info |`);
  lines.push(`| ---: | ---: | ---: |`);
  lines.push(`| ${errors} | ${warnings} | ${infos} |`);
  lines.push("");

  if (report.defects.length === 0) {
    lines.push("No defects found.");
    return lines.join("\n");
  }

  lines.push(`| | Time | Rule | Finding |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const d of report.defects) {
    const when = d.from !== null
      ? `${formatTime(d.from)}${d.to !== null ? `\u2013${formatTime(d.to)}` : ""}`
      : "\u2014";
    lines.push(
      `| ${GLYPH[d.severity]} | ${when} | \`${d.id}\` | ${escapePipes(d.message)} |`,
    );
  }
  lines.push("");

  lines.push("<details><summary>How to fix</summary>");
  lines.push("");
  for (const d of report.defects) {
    if (!d.hint) continue;
    lines.push(`- **\`${d.id}\`** (${formatTime(d.from)}): ${d.hint}`);
  }
  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

function escapePipes(text) {
  return String(text).replace(/\|/g, "\\|");
}

/**
 * A self-contained HTML report. `frames` are `{time, dataUri, label}`.
 *
 * @param {any} report
 * @param {{frames?: {time:number,dataUri:string,label?:string}[], title?:string}} [options]
 */
export function renderHtml(report, options = {}) {
  const frames = options.frames ?? [];
  const title = options.title ?? `vidlint \u2014 ${report.input}`;
  const { errors, warnings, infos } = report.summary;
  const duration = report.media.durationSeconds ?? 1;

  const defectCards = report.defects
    .map((d) => {
      const when = d.from !== null
        ? `${formatTime(d.from)}${d.to !== null ? `\u2013${formatTime(d.to)}` : ""}`
        : "\u2014";
      return `
      <article class="defect ${d.severity}">
        <header>
          <span class="glyph">${GLYPH[d.severity]}</span>
          <code class="rule">${esc(d.id)}</code>
          <span class="time">${esc(when)}</span>
        </header>
        <h3>${esc(d.title)}</h3>
        <p>${esc(d.message)}</p>
        ${d.hint ? `<p class="hint">\u21b3 ${esc(d.hint)}</p>` : ""}
      </article>`;
    })
    .join("\n");

  const markers = report.defects
    .filter((d) => d.from !== null)
    .map((d) => {
      const left = Math.max(0, Math.min(100, (d.from / duration) * 100));
      return `<span class="marker ${d.severity}" style="left:${left.toFixed(2)}%" title="${esc(d.id)} @ ${formatTime(d.from)}"></span>`;
    })
    .join("");

  const gallery = frames
    .map(
      (f) => `
      <figure>
        <img src="${f.dataUri}" alt="Frame at ${formatTime(f.time)}" loading="lazy" />
        <figcaption>${formatTime(f.time)}${f.label ? ` \u00b7 ${esc(f.label)}` : ""}</figcaption>
      </figure>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --panel:#171a21; --fg:#e8eaed; --dim:#9aa0a6;
          --error:#ff5c5c; --warn:#ffb020; --info:#4aa8ff; --line:#262a33; }
  @media (prefers-color-scheme: light) { :root { --bg:#f7f8fa; --panel:#fff; --fg:#1a1c20; --dim:#5f6368; --line:#e3e6ea; } }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  h3 { font-size:15px; margin:0 0 6px; }
  .sub { color:var(--dim); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; margin-bottom:20px; }
  .wrap { max-width:1000px; margin:0 auto; }
  .counts { display:flex; gap:12px; margin:20px 0; flex-wrap:wrap; }
  .pill { background:var(--panel); border:1px solid var(--line); border-radius:999px;
          padding:6px 14px; font-size:13px; }
  .pill.error { color:var(--error); } .pill.warn { color:var(--warn); } .pill.info { color:var(--info); }
  .timeline { position:relative; height:36px; background:var(--panel); border:1px solid var(--line);
              border-radius:8px; margin:24px 0; }
  .marker { position:absolute; top:6px; width:3px; height:24px; border-radius:2px; transform:translateX(-1px); }
  .marker.error { background:var(--error); } .marker.warn { background:var(--warn); } .marker.info { background:var(--info); }
  .defect { background:var(--panel); border:1px solid var(--line); border-left-width:4px;
            border-radius:8px; padding:14px 16px; margin-bottom:12px; }
  .defect.error { border-left-color:var(--error); }
  .defect.warn { border-left-color:var(--warn); }
  .defect.info { border-left-color:var(--info); }
  .defect header { display:flex; align-items:center; gap:10px; margin-bottom:6px; font-size:12px; color:var(--dim); }
  .defect .glyph { font-size:14px; }
  .defect.error .glyph { color:var(--error); } .defect.warn .glyph { color:var(--warn); } .defect.info .glyph { color:var(--info); }
  .rule { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .time { margin-left:auto; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .defect p { margin:0; }
  .hint { color:var(--dim); margin-top:8px !important; font-size:14px; }
  .gallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; margin-top:12px; }
  figure { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  figure img { width:100%; display:block; }
  figcaption { padding:6px 10px; font-size:12px; color:var(--dim);
               font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  h2 { font-size:15px; margin:28px 0 10px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; }
  .ok { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:20px; text-align:center; color:var(--dim); }
  footer { margin-top:32px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>vidlint report</h1>
  <div class="sub">${esc(report.input)}<br />${esc(mediaLine(report))}</div>

  <div class="counts">
    <span class="pill error">${errors} error${errors === 1 ? "" : "s"}</span>
    <span class="pill warn">${warnings} warning${warnings === 1 ? "" : "s"}</span>
    <span class="pill info">${infos} info</span>
  </div>

  <div class="timeline">${markers}</div>

  <h2>Findings</h2>
  ${defectCards || `<div class="ok">No defects found.</div>`}

  ${frames.length ? `<h2>Sampled frames</h2><div class="gallery">${gallery}</div>` : ""}

  <footer>Generated by vidlint ${esc(report.tool.version)} \u00b7 schema ${esc(report.schemaVersion)} \u00b7 analysed in ${report.timing.analysisMs} ms</footer>
</div>
</body>
</html>`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { formatBytes };
