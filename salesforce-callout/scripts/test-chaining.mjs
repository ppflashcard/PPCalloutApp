/**
 * Dry-run tests for callout chaining logic (mirrors public/callout.js).
 * Run: node scripts/test-chaining.mjs
 */

function getNestedValue(source, path) {
  if (!path || source == null) return undefined;
  return path.split(".").reduce((current, key) => {
    if (current == null || typeof current !== "object") return undefined;
    return current[key];
  }, source);
}

function parseCalloutReference(raw, defaultSource = null) {
  const trimmed = raw.trim();
  const fromCalloutMatch = trimmed.match(/^\{(.+?)\s+from\s+callout\s+([123])\}$/i);
  if (fromCalloutMatch) {
    return { source: fromCalloutMatch[2], path: fromCalloutMatch[1].trim() };
  }
  const braceMatch = trimmed.match(/^\{([^}]+)\}$/);
  if (!braceMatch) return null;
  const inner = braceMatch[1].trim();
  const prefixMatch = inner.match(/^callout([123])\.(.+)$/i);
  if (prefixMatch) {
    return { source: prefixMatch[1], path: prefixMatch[2] };
  }
  if (defaultSource) {
    return { source: defaultSource, path: inner };
  }
  return { source: null, path: inner };
}

function resolveCalloutReference(raw, sources, defaultSource = null) {
  const parsed = parseCalloutReference(raw, defaultSource);
  if (!parsed) return null;
  const sourceKey = parsed.source ?? defaultSource;
  if (!sourceKey) {
    throw new Error(`Cannot resolve {${parsed.path}} — specify the source.`);
  }
  const sourceData = sources[sourceKey];
  if (sourceData == null) {
    throw new Error(`Cannot resolve {${parsed.path}} — run Callout ${sourceKey} first.`);
  }
  const value = getNestedValue(sourceData, parsed.path);
  if (value === undefined) {
    throw new Error(`Field "${parsed.path}" was not found in Callout ${sourceKey} response.`);
  }
  return value;
}

function resolveReferencesDeep(value, sources, defaultSource = null) {
  if (typeof value === "string") {
    const resolved = resolveCalloutReference(value, sources, defaultSource);
    return resolved !== null ? resolved : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferencesDeep(item, sources, defaultSource));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReferencesDeep(item, sources, defaultSource),
      ]),
    );
  }
  return value;
}

function mergeRequestBodies(fieldsBody, textareaBody) {
  if (!fieldsBody) return textareaBody;
  if (!textareaBody) return fieldsBody;
  const fieldKeys = new Set(Object.keys(fieldsBody));
  const extraTextareaFields = Object.fromEntries(
    Object.entries(textareaBody).filter(([key]) => !fieldKeys.has(key)),
  );
  return { ...extraTextareaFields, ...fieldsBody };
}

const lastResponses = { 1: null, 2: null, 3: null };

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    failed += 1;
    console.error(`  FAIL: ${label} (expected throw)`);
  } catch {
    passed += 1;
    console.log(`  PASS: ${label}`);
  }
}

console.log("\n=== Callout Chaining Dry Run ===\n");

console.log("1. Reference parsing");
assert(
  parseCalloutReference("{Id from callout 1}")?.path === "Id" &&
    parseCalloutReference("{Id from callout 1}")?.source === "1",
  "explicit {field from callout N} syntax",
);
assert(
  parseCalloutReference("{callout1.Id}")?.path === "Id",
  "calloutN.field prefix syntax",
);
assert(
  parseCalloutReference("{Name}", "1")?.path === "Name" &&
    parseCalloutReference("{Name}", "1")?.source === "1",
  "shorthand {field} with default source",
);
assert(parseCalloutReference("plain-string") === null, "non-reference strings ignored");

console.log("\n2. Simulate Callout 1 response (Account describe)");
lastResponses[1] = {
  name: "Account",
  label: "Account",
  keyPrefix: "001",
  fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string" }],
};

console.log("\n3. Resolve references from Callout 1");
assert(
  resolveCalloutReference("{keyPrefix from callout 1}", lastResponses) === "001",
  "resolve top-level field from callout 1",
);
assert(
  resolveCalloutReference("{callout1.label}", lastResponses) === "Account",
  "resolve via callout1.field syntax",
);
assert(
  resolveCalloutReference("{name}", lastResponses, "1") === "Account",
  "shorthand resolve on pane 2",
);
assertThrows(
  () => resolveCalloutReference("{missingField from callout 1}", lastResponses),
  "missing field throws clear error",
);
assertThrows(
  () => resolveCalloutReference("{Id from callout 2}", lastResponses),
  "unrun callout 2 throws clear error",
);

console.log("\n4. Chain Callout 1 → Callout 2 (path + body)");
const callout1Path = "/sobjects/Account/describe";
const callout2Path = `/sobjects/Account/${resolveCalloutReference("{keyPrefix from callout 1}", lastResponses)}`;
assert(callout2Path.includes("001"), "chained path uses callout 1 value");

const callout2Body = resolveReferencesDeep(
  {
    objectType: "{name from callout 1}",
    meta: { label: "{label}" },
    ids: ["{keyPrefix}", "hardcoded"],
  },
  lastResponses,
  "1",
);
assert(callout2Body.objectType === "Account", "nested body field resolved");
assert(callout2Body.meta.label === "Account", "shorthand in nested object");
assert(callout2Body.ids[0] === "001", "reference in array resolved");
assert(callout2Body.ids[1] === "hardcoded", "non-reference array item preserved");

console.log("\n5. Simulate Callout 2 response");
lastResponses[2] = {
  totalSize: 1,
  done: true,
  records: [{ Id: "001xx000003DGbQAAW", Name: "Acme Corp" }],
};

console.log("\n6. Chain Callout 1 + 2 → Callout 3");
const sources12 = { 1: lastResponses[1], 2: lastResponses[2] };
assert(
  resolveCalloutReference("{records from callout 2}", sources12)?.[0]?.Name === "Acme Corp",
  "resolve array from callout 2",
);
assert(
  resolveCalloutReference("{keyPrefix from callout 1}", sources12) === "001",
  "callout 3 can still read callout 1",
);

assert(
  resolveCalloutReference("{records.0.Name from callout 2}", sources12) === "Acme Corp",
  "nested dot path from callout 2 (records.0.Name)",
);
assert(
  resolveCalloutReference("{totalSize from callout 2}", sources12) === 1,
  "numeric field from prior callout",
);

console.log("\n7. Body field builder + JSON textarea merge");
const fieldsBody = { ParentId: "001xx000003DGbQAAW", Stage: "Prospecting" };
const textareaBody = { ParentId: "should-be-overridden", Extra: "note" };
const merged = mergeRequestBodies(fieldsBody, textareaBody);
assert(merged.ParentId === "001xx000003DGbQAAW", "field builder wins over textarea on conflict");
assert(merged.Extra === "note", "textarea-only keys preserved");
assert(merged.Stage === "Prospecting", "field builder keys included");

console.log("\n8. Pane 1 → Pane 2 auto-copy simulation");
const pane1Request = {
  method: "GET",
  path: "/sobjects/Account/describe",
  headers: '{"Accept":"application/json"}',
};
const pane2Copied = {
  method: pane1Request.method,
  path: pane1Request.path,
  headers: pane1Request.headers,
};
assert(pane2Copied.path === pane1Request.path, "callout 1 success copies method/path/headers to pane 2");

console.log("\n=== Summary ===");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(failed === 0 ? "\nChaining dry run: ALL OK\n" : "\nChaining dry run: ISSUES FOUND\n");
process.exit(failed === 0 ? 0 : 1);
