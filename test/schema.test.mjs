/**
 * Schema conformance.
 *
 * `schema/report.schema.json` is a published contract, so it needs to be
 * enforced rather than trusted. This file contains a small validator covering
 * exactly the JSON Schema keywords the schema uses, then runs real reports
 * through it.
 *
 * It also pins the rule id enum in the schema to the rule catalogue in
 * `src/rules.mjs`, so the two cannot drift apart.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";

import { lint } from "../src/lint.mjs";
import { RULES } from "../src/rules.mjs";
import { ensureFixtures } from "./helpers/fixtures.mjs";

const SCHEMA_PATH = join(process.cwd(), "schema", "report.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

let fixtures;

before(() => {
  fixtures = ensureFixtures(join(process.cwd(), ".fixtures"));
}, { timeout: 180_000 });

/**
 * Resolve a local `$ref` like `#/$defs/defect` against the schema root.
 */
function resolve(schemaRoot, ref) {
  return ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((node, part) => node[part], schemaRoot);
}

/**
 * Minimal JSON Schema validator for the keyword subset used by this schema.
 *
 * `$ref` is resolved during validation rather than pre-expanded: expanding it
 * up front via a JSON.stringify replacer silently produced nodes with no `type`,
 * which made the validator accept anything.
 *
 * @param {any} value
 * @param {any} node
 * @param {string} path
 * @param {any} root
 * @returns {string[]} list of violations, empty when valid
 */
function validate(value, node, path = "$", root = schema) {
  const errors = [];

  if (node.$ref) {
    return validate(value, resolve(root, node.$ref), path, root);
  }

  if (node.const !== undefined && value !== node.const) {
    errors.push(`${path}: expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);
  }

  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node.enum)}`);
  }

  if (node.type) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const numeric = actual === "number" && Number.isInteger(value) ? "integer" : actual;
    const ok = types.some(
      (t) => t === actual || t === numeric || (t === "number" && actual === "number"),
    );
    if (!ok) {
      errors.push(`${path}: expected ${types.join("|")}, got ${actual}`);
      return errors;
    }
  }

  if (node.minimum !== undefined && typeof value === "number" && value < node.minimum) {
    errors.push(`${path}: ${value} is below minimum ${node.minimum}`);
  }

  if (node.oneOf) {
    const matches = node.oneOf.filter((sub) => validate(value, sub, path, root).length === 0);
    if (matches.length !== 1) {
      errors.push(`${path}: matched ${matches.length} of oneOf, expected exactly 1`);
    }
  }

  if (node.type === "object" || (node.properties && typeof value === "object" && value !== null)) {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (node.additionalProperties === false && node.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in node.properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(node.properties ?? {})) {
      if (key in value) errors.push(...validate(value[key], sub, `${path}.${key}`, root));
    }
  }

  if (node.type === "array" && node.items && Array.isArray(value)) {
    value.forEach((item, i) => errors.push(...validate(item, node.items, `${path}[${i}]`, root)));
  }

  return errors;
}

/** Validate a report against the published schema. */
function validateReport(report) {
  return validate(report, schema, "$", schema);
}

test("the schema file is valid JSON and declares the expected top level", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(Array.isArray(schema.required));
  assert.ok(schema.required.includes("defects"));
  assert.ok(schema.required.includes("summary"));
});

test("the schema's rule enum matches the rule catalogue exactly", () => {
  const fromSchema = [...schema.$defs.defect.properties.id.enum].sort();
  const fromCatalogue = RULES.map((r) => r.id).sort();
  assert.deepEqual(
    fromSchema,
    fromCatalogue,
    "schema/report.schema.json and src/rules.mjs have drifted apart",
  );
});

test("every catalogued rule id is unique", () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id in the catalogue");
});

test("a report with defects conforms to the published schema", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.bad);
  const errors = validateReport(report);

  assert.deepEqual(errors, [], `schema violations:\n${errors.join("\n")}`);
  assert.ok(report.defects.length > 0, "fixture should produce defects to validate");
});

test("a clean report conforms to the published schema", { timeout: 120_000 }, async () => {
  const report = await lint(fixtures.good);
  const errors = validateReport(report);
  assert.deepEqual(errors, [], `schema violations:\n${errors.join("\n")}`);
});

test("a report from the heuristic layout pass also conforms", { timeout: 180_000 }, async () => {
  const report = await lint(fixtures.clean, { platform: "reels", checkEdgeClipping: true });
  const errors = validateReport(report);
  assert.deepEqual(errors, [], `schema violations:\n${errors.join("\n")}`);
});

test("the validator actually rejects a malformed report", async () => {
  // Guard against the validator silently passing everything.
  const report = await lint(fixtures.good);
  const broken = { ...report, severity: undefined };
  delete broken.summary;

  const errors = validateReport(broken);
  assert.ok(errors.length > 0, "validator should reject a report missing `summary`");
});

test("the validator rejects an unknown rule id and a bad severity", async () => {
  const report = await lint(fixtures.good);
  const tampered = {
    ...report,
    defects: [{ ...blankDefect(), id: "not-a-real-rule" }],
  };
  assert.ok(validateReport(tampered).some((e) => e.includes("is not one of")));

  const badSeverity = {
    ...report,
    defects: [{ ...blankDefect(), severity: "catastrophe" }],
  };
  assert.ok(validateReport(badSeverity).some((e) => e.includes("severity")));
});

/** A defect-shaped object with valid values, for tampering in tests. */
function blankDefect() {
  return {
    id: "dead-air",
    fingerprint: "dead-air@1.0",
    severity: "warn",
    title: "t",
    message: "m",
    from: 1,
    to: 2,
    evidence: {},
    hint: null,
  };
}
