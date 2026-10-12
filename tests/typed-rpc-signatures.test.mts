import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * The generated Supabase types must keep describing the post-receipt PDF RPCs exactly as the migrations define them. Parses the
 * LAST `create or replace function public.<name>(...)` in the migrations and compares argument names / optionality / types and
 * returned columns with lib/supabase/database.types.ts. Fails if an RPC disappears from the types or drifts from the SQL.
 */
const MIG_DIR = "supabase/migrations";
const sql = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => fs.readFileSync(path.join(MIG_DIR, f), "utf8").replace(/--.*$/gm, "")).join("\n");
const types = fs.readFileSync("lib/supabase/database.types.ts", "utf8");

const TS: Record<string, string> = { uuid: "string", text: "string", integer: "number", boolean: "boolean", timestamptz: "string" };

function splitTop(list: string): string[] {
  const out: string[] = []; let depth = 0; let cur = "";
  for (const ch of list) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function sqlSignature(name: string) {
  const re = new RegExp(`create or replace function public\\.${name}\\s*\\(`, "gi");
  let last = -1; let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) last = m.index + m[0].length;
  assert.ok(last >= 0, `${name} is defined in a migration`);
  let depth = 1; let i = last;
  while (depth > 0) { if (sql[i] === "(") depth++; if (sql[i] === ")") depth--; i++; }
  const args = splitTop(sql.slice(last, i - 1)).filter(Boolean).map((a) => {
    const mm = /^(\w+)\s+([a-z0-9_ ]+?)(?:\s+default\s+.*)?$/i.exec(a)!;
    return { name: mm[1], type: mm[2].trim().toLowerCase(), optional: /\sdefault\s/i.test(a) };
  });
  const after = sql.slice(i);
  const ret = /returns\s+(table\s*\(([\s\S]*?)\)\s*language|(\w+)\s+language)/i.exec(after)!;
  const returnsCols = ret[2] ? splitTop(ret[2]).map((c) => { const p = c.trim().split(/\s+/); return { name: p[0], type: p.slice(1).join(" ").toLowerCase() }; }) : null;
  return { args, returnsCols, returnsScalar: ret[3]?.toLowerCase() ?? null };
}

function typesEntry(name: string): string {
  const start = types.indexOf(`      ${name}: {`);
  assert.ok(start >= 0, `${name} is present in lib/supabase/database.types.ts`);
  const end = types.indexOf("\n      }\n", start);
  return types.slice(start, end);
}

const RPCS = [
  "record_caterlink_receipt_pdf_version",
  "claim_caterlink_pdf_jobs",
  "complete_caterlink_pdf_job",
  "fail_caterlink_pdf_job",
  "retry_caterlink_pdf_job_secure",
  "list_caterlink_pdf_jobs_secure",
  "get_caterlink_pdf_state_secure",
];

for (const name of RPCS) {
  test(`typed RPC ${name}: generated types match the migration signature`, () => {
    const sig = sqlSignature(name);
    const entry = typesEntry(name);
    const argsBlock = /Args:\s*\{([\s\S]*?)\}\s*\n\s*Returns:/.exec(entry);
    assert.ok(argsBlock, "Args block");
    const tsArgs = [...argsBlock![1].matchAll(/(\w+)(\??):\s*(string|number|boolean)/g)].map((m) => ({ name: m[1], optional: m[2] === "?", type: m[3].trim() }));
    assert.deepEqual(tsArgs.map((a) => a.name), sig.args.map((a) => a.name), "argument names and order");
    sig.args.forEach((a, i) => {
      assert.equal(tsArgs[i].optional, a.optional, `${a.name} optionality`);
      assert.equal(tsArgs[i].type, TS[a.type], `${a.name}: ${a.type}`);
    });
    const returns = /Returns:\s*([\s\S]*)$/.exec(entry)![1];
    if (sig.returnsCols) {
      const cols = [...returns.matchAll(/(\w+):\s*([a-z]+)(\s*\|\s*null)?/g)].map((m) => ({ name: m[1], type: m[2] }));
      assert.deepEqual(cols.map((c) => c.name), sig.returnsCols.map((c) => c.name), "returned column names and order");
      sig.returnsCols.forEach((c, i) => assert.equal(cols[i].type, TS[c.type], `returned ${c.name}: ${c.type}`));
      assert.match(returns, /\[\]/, "returns a set");
    } else {
      assert.equal(returns.trim(), TS[sig.returnsScalar!], "scalar return type");
    }
  });
}

test("application code calls the PDF RPCs through the typed Supabase client (no untyped cast)", () => {
  for (const f of ["lib/icms/completed-form-pdf.ts", "lib/avsec/caterlink/receipt.ts", "lib/icms/actions/pdf-jobs.ts"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /rpc as unknown as/, f);
    assert.doesNotMatch(src, /\.rpc\(\s*"[a-z_]+"\s*as\s/i, f);
  }
  const worker = fs.readFileSync("lib/icms/completed-form-pdf.ts", "utf8");
  for (const n of ["claim_caterlink_pdf_jobs", "complete_caterlink_pdf_job", "fail_caterlink_pdf_job"]) assert.match(worker, new RegExp(`admin\\.rpc\\("${n}"`));
});
