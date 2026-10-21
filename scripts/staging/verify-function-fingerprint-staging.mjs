#!/usr/bin/env node
// READ-ONLY (BEGIN READ ONLY; one catalog select). Reports the hosted get_bay_board_secure fingerprints: BOTH the raw hash and the line-ending-normalized hash,
// every security property, and the comparison against the reviewed pre-state body. A raw-only (CR) difference is reported as a deviation, never concealed;
// semantic equality is accepted only after every security property and the normalized body match. Prints hashes and property names only.
//   node --env-file=.env.local scripts/staging/verify-function-fingerprint-staging.mjs
import { environmentGates, connectVerified } from "./lib/run-gates.mjs";
import { PRE_STATE, functionFingerprint, compareFunctionFingerprints } from "./apply-bay-board-migration.mjs";

environmentGates();
const { client } = await connectVerified();
let row;
try {
  await client.query("begin read only");
  row = (await client.query("select pg_get_functiondef(p.oid) def, p.prosecdef sd, coalesce(p.proconfig::text,'') cfg, pg_get_userbyid(p.proowner) owner, coalesce(p.proacl::text,'') acl, p.provolatile vol from pg_proc p where p.oid = 'public.get_bay_board_secure(text,text)'::regprocedure")).rows[0];
  await client.query("rollback");
} finally {
  await client.end().catch(() => {});
}
const actual = functionFingerprint({ def: row.def, securityDefiner: row.sd, config: row.cfg, owner: row.owner, acl: row.acl, volatility: row.vol });
const reviewed = { ...actual, raw: PRE_STATE.functionMd5, normalized: PRE_STATE.functionMd5Normalized, acl: PRE_STATE.functionAcl, config: "{search_path=public}", owner: "postgres", securityDefiner: true, volatility: "s" };
const cmp = compareFunctionFingerprints(reviewed, actual);
console.log(`raw fingerprint        : ${actual.raw}  (reviewed raw ${PRE_STATE.functionMd5})`);
console.log(`normalized fingerprint : ${actual.normalized}  (reviewed normalized ${PRE_STATE.functionMd5Normalized})`);
console.log(`security properties    : SECURITY DEFINER=${actual.securityDefiner}, config=${actual.config}, owner=${actual.owner}, volatility=${actual.volatility}, ACL as reviewed=${actual.acl === PRE_STATE.functionAcl}`);
console.log(`comparison             : ${cmp.status}${cmp.deviation ? ` -- DEVIATION: ${cmp.deviation}` : ""}${cmp.reasons.length ? ` -- ${cmp.reasons.join("; ")}` : ""}`);
process.exit(cmp.status === "different" ? 1 : 0);
