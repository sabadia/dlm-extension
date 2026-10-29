// Compares the pinned OpenAPI document with a newer release and fails when the newer one would break the client:
// an operation the client uses is gone or moved, a request body gained a required field, or a response field the client
// reads vanished. Usage: node tools/check-contract.mjs <pinned.json> <latest.json>
import { readFileSync } from 'node:fs';

const [pinnedPath, latestPath] = process.argv.slice(2);
if (!pinnedPath || !latestPath) {
  console.error('usage: check-contract <pinned openapi> <latest openapi>');
  process.exit(2);
}
const used = JSON.parse(
  readFileSync(new URL('../spec/used-operations.json', import.meta.url), 'utf8'),
);
const pinned = JSON.parse(readFileSync(pinnedPath, 'utf8'));
const latest = JSON.parse(readFileSync(latestPath, 'utf8'));

function operations(doc) {
  const out = new Map();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (op && typeof op === 'object' && op.operationId)
        out.set(op.operationId, { method, path, op });
    }
  }
  return out;
}

function resolve(doc, schema) {
  let s = schema;
  for (let i = 0; i < 8 && s && s.$ref; i++) {
    s = s.$ref
      .replace('#/', '')
      .split('/')
      .reduce((node, key) => node?.[key], doc);
  }
  return s ?? {};
}

const jsonSchema = (doc, content) => resolve(doc, content?.['application/json']?.schema);

function requestSchema(doc, op) {
  return jsonSchema(doc, op.requestBody?.content);
}

function responseSchema(doc, op) {
  const ok = Object.entries(op.responses ?? {}).find(([code]) => /^2/.test(code));
  return ok ? jsonSchema(doc, ok[1].content) : {};
}

const before = operations(pinned);
const after = operations(latest);
const problems = [];

for (const [id, { reads }] of Object.entries(used)) {
  const was = before.get(id);
  const now = after.get(id);
  if (!was) {
    problems.push(`${id}: not in the pinned document (fix spec/used-operations.json)`);
    continue;
  }
  if (!now) {
    problems.push(`${id}: removed`);
    continue;
  }
  if (was.method !== now.method || was.path !== now.path) {
    problems.push(
      `${id}: moved from ${was.method.toUpperCase()} ${was.path} to ${now.method.toUpperCase()} ${now.path}`,
    );
    continue;
  }
  const oldRequired = new Set(requestSchema(pinned, was.op).required ?? []);
  for (const field of requestSchema(latest, now.op).required ?? []) {
    if (!oldRequired.has(field)) problems.push(`${id}: request field "${field}" is now required`);
  }
  const props = responseSchema(latest, now.op).properties ?? {};
  for (const field of reads) {
    if (!(field in props)) problems.push(`${id}: response field "${field}" is gone`);
  }
}

if (problems.length > 0) {
  console.error(`The newer daemon API breaks the extension:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`contract: ok (${Object.keys(used).length} operations)`);
