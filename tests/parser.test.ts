import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeScript, parseWorkflowScript } from "../src/parser.js";

const VALID = `export const meta = { name: 'demo', description: 'a demo', phases: [{ title: 'Scan' }] }
phase('Scan')
const out = await agent('do a thing')
return out
`;

test("parses meta and strips the export from the body", () => {
  const { meta, body } = parseWorkflowScript(VALID);
  assert.equal(meta.name, "demo");
  assert.equal(meta.description, "a demo");
  assert.deepEqual(meta.phases, [{ title: "Scan" }]);
  assert.ok(!body.includes("export const meta"));
  assert.ok(body.includes("await agent"));
});

test("rejects a script without a leading meta export", () => {
  assert.throws(() => parseWorkflowScript("const x = 1"), /export const meta/);
});

test("rejects non-literal meta", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'x', description: 'y', extra: compute() }"),
    /pure literal/,
  );
  assert.throws(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the parser must reject interpolation in meta
    () => parseWorkflowScript("export const meta = { name: `a${'b'}`, description: 'y' }"),
    /interpolation/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { ...base, description: 'y' }"),
    /plain properties/,
  );
});

test("rejects missing name/description", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { description: 'y' }\nagent('x')"),
    /meta.name/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'x' }\nagent('x')"),
    /meta.description/,
  );
});

test("rejects nondeterministic calls anywhere in the script", () => {
  const header = "export const meta = { name: 'x', description: 'y' }\n";
  assert.throws(() => parseWorkflowScript(`${header}const t = Date.now()`), /deterministic/);
  assert.throws(() => parseWorkflowScript(`${header}const r = Math.random()`), /deterministic/);
  assert.throws(() => parseWorkflowScript(`${header}const d = new Date()`), /deterministic/);
  assert.throws(() => parseWorkflowScript(`${header}if (x) { const t = Date["now"]() }`), /deterministic/);
});

test("rejects imports and extra exports", () => {
  const header = "export const meta = { name: 'x', description: 'y' }\n";
  assert.throws(() => parseWorkflowScript(`${header}import fs from 'node:fs'`), /cannot use import/);
  assert.throws(
    () => parseWorkflowScript(`${header}export const other = 1`),
    /cannot use import or additional/,
  );
});

test("normalizeScript strips markdown fences", () => {
  assert.equal(normalizeScript("```js\nconst x = 1\n```"), "const x = 1");
  assert.equal(normalizeScript("  const x = 1  "), "const x = 1");
});
