import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync("supabase/migrations/20261203000001_handover_recipient_qr_verification.sql", "utf8");
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} defined`);
  const end = sql.indexOf("$function$;", sql.indexOf("$function$", start) + 10);
  return sql.slice(start, end + 11);
};

test("clients can no longer insert handovers or update them freely", () => {
  assert.match(sql, /drop policy "shift_handovers own insert"/);
  assert.match(sql, /revoke insert on public\.shift_handovers from authenticated/);
  assert.match(sql, /revoke update on public\.shift_handovers from authenticated/);
  assert.match(sql, /grant update \(acknowledged_by, acknowledged_at, acknowledgment_notes\)/);
  assert.match(sql, /handover_status = 'historical' and acknowledged_at is null/);
});

test("every client-callable function is security definer with a fixed search_path and no anon access", () => {
  for (const n of ["resolve_handover_recipient_secure", "file_handover_secure", "issue_handover_challenge_secure", "submit_handover_sender_location_secure", "complete_handover_secure"]) {
    const f = fn(n);
    assert.match(f, /security definer/i);
    assert.match(f, /set search_path to 'public'/i);
    assert.ok(new RegExp("revoke execute on function public\\." + n + "\\([^)]*\\) from public, anon").test(sql), n + " revoked from anon");
  }
});

test("sender identity is derived from the session, never a parameter", () => {
  const f = fn("file_handover_secure");
  assert.doesNotMatch(f, /p_staff_name|p_team|p_station|p_outgoing/);
  assert.match(f, /auth\.uid\(\)/);
});

test("recipient resolution rejects self, ambiguity and other stations with one generic answer", () => {
  const f = fn("resolve_handover_recipient_secure");
  assert.match(f, /v_matches = 1/);
  assert.match(f, /cannot hand over to yourself/);
  assert.match(f, /No unique active officer with that staff ID at your station/);
});

test("completion is recipient-only, row-locked, single-use and enforces every approved threshold", () => {
  const f = fn("complete_handover_secure");
  assert.match(f, /for update/);
  assert.match(f, /recipient_profile_id is distinct from v_caller/);
  assert.match(f, /challenge_consumed_at is not null/);
  assert.match(f, /interval '30 seconds'/);
  assert.match(f, /> 50/);
  assert.match(f, /v_dist <= 50/);
  assert.match(f, /handover_point_zone/);
  assert.match(f, /handover_open_duty\(h\.outgoing_profile_id/);
  assert.match(f, /handover_open_duty\(v_caller/);
  assert.match(f, /challenge_expires_at/);
  const issue = fn("issue_handover_challenge_secure");
  assert.match(issue, /interval '60 seconds'/);
  assert.match(issue, /sha256/);
  assert.doesNotMatch(sql, /challenge_token\b/, "only a hash is stored");
});

test("sender checkout or day rollover makes a pending handover uncompleted without transferring", () => {
  const f = fn("handover_effective_status");
  assert.match(f, /check_out_at is not null then 'uncompleted'/);
  assert.match(f, /> 1 then 'uncompleted'/);
});

test("historical rows are preserved and defaulted historical", () => {
  assert.match(sql, /handover_status text not null default 'historical'/);
  assert.doesNotMatch(sql, /delete from public\.shift_handovers|update public\.shift_handovers set handover_status = 'completed'/);
});
