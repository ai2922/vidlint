/**
 * vidlint — objective QA for generated video.
 *
 * Public API. Everything else in `src/` is an implementation detail.
 */

export { lint, SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from "./lint.mjs";
export { renderText, renderMarkdown, renderHtml } from "./report.mjs";
export { buildContactSheet, extractFramePng, selectSampleTimes } from "./visuals.mjs";
export { resolveConfig, DEFAULT_CONFIG, PLATFORM_PRESETS } from "./config.mjs";
export { VidlintError } from "./errors.mjs";
export { probeMedia } from "./probe.mjs";
