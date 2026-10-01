import test from "node:test";
import assert from "node:assert/strict";
import { executeWoisQuery, isGreeting, type ConversationTurn } from "../lib/wois/engine.ts";
import { matchWoisToolIntent, isKnownWoisTool } from "../lib/wois/tools.ts";
import { getWoisSuggestedActions } from "../lib/wois/suggestions.ts";

// --- B. Multi-turn conversation behavior ---------------------------------

test("Phase 12 multi-turn: a short follow-up reuses the prior user turn's topic", async () => {
  const history: ConversationTurn[] = [
    { role: "user", content: "what is the aircraft search timing for an A330?" },
    { role: "assistant", content: "A330 requires at least 45 minutes." },
  ];
  // "what about dangerous goods" alone matches nothing specific; combined
  // with the prior A330 search-timing turn it should still resolve to a
  // real knowledge-base hit rather than falling through to "I'm not sure".
  const res = await executeWoisQuery("and the A321?", {}, history);
  assert.notEqual(res.confidence_tag, "UNCERTAIN");
});

test("Phase 12 multi-turn: a self-contained query is answered on its own terms, never reinterpreted via history", async () => {
  const history: ConversationTurn[] = [
    { role: "user", content: "what is the aircraft search timing for an A330?" },
    { role: "assistant", content: "A330 requires at least 45 minutes." },
  ];
  const res = await executeWoisQuery("can a 20,000mAh power bank board in carry-on baggage?", {}, history);
  assert.equal(res.confidence_tag, "GENERAL_KNOWLEDGE");
  assert.ok(res.body.includes("Wh") || res.body.includes("power bank"));
});

test("Phase 12 multi-turn: no history still behaves exactly like a single-turn query (backward compatible)", async () => {
  const res = await executeWoisQuery("what is the aircraft search timing for an A330?");
  assert.equal(res.confidence_tag, "VERIFIED");
});

test("Phase 12: greeting detection is unaffected by the new history parameter", () => {
  assert.equal(isGreeting("hi"), true);
  assert.equal(isGreeting("hi what is the search timing"), false);
});

// --- C. Tool authorization boundary (allowlist, not model-driven) -------

test("Phase 12 tools: only the five allowlisted tool names are known", () => {
  const allowed = [
    "list_my_submissions",
    "get_my_notifications",
    "get_my_active_role_assignments",
    "get_visible_announcements",
    "get_my_registration_request",
  ];
  for (const name of allowed) {
    assert.equal(isKnownWoisTool(name), true, `${name} should be allowlisted`);
  }
});

test("Phase 12 tools: unknown/arbitrary tool names are rejected by the allowlist check", () => {
  const rejected = [
    "approve_leave_request",
    "publish_announcement",
    "delete_report",
    "execute_sql",
    "select_from_table",
    "drop_table_profiles",
    "reveal_anonymous_identity",
    "",
    "LIST_MY_SUBMISSIONS", // case-sensitive -- no implicit normalization that could be exploited
  ];
  for (const name of rejected) {
    assert.equal(isKnownWoisTool(name), false, `${name} must NOT be allowlisted`);
  }
});

test("Phase 12 tool-intent matcher: deterministic phrase matching, no write-intent phrase ever matches", () => {
  assert.equal(matchWoisToolIntent("Show my pending reports"), "list_my_submissions");
  assert.equal(matchWoisToolIntent("What announcements apply to me?"), "get_visible_announcements");
  assert.equal(matchWoisToolIntent("What reports can my role access?"), "get_my_active_role_assignments");
  assert.equal(matchWoisToolIntent("What is the minimum aircraft search timing for an A330?"), null);
  // Write-style phrasing never resolves to a tool -- there is no tool that
  // could execute it even if it did, but the matcher itself should not
  // treat these as actions in the first place.
  assert.equal(matchWoisToolIntent("Approve my leave request"), null);
  assert.equal(matchWoisToolIntent("Publish an announcement for my station"), null);
  assert.equal(matchWoisToolIntent("Delete my last report"), null);
});

// --- Role-adapted suggested actions --------------------------------------

test("Phase 12 suggestions: report-submitter roles see the pending-reports suggestion, others do not", () => {
  const asoSuggestions = getWoisSuggestedActions("ASO");
  assert.ok(asoSuggestions.some((s) => s.query.toLowerCase().includes("pending reports")));

  const mgmtSuggestions = getWoisSuggestedActions("MANAGEMENT");
  assert.ok(!mgmtSuggestions.some((s) => s.query.toLowerCase().includes("pending reports")));
});

test("Phase 12 suggestions: a null/unknown role still gets the baseline suggestions, never an empty list", () => {
  const suggestions = getWoisSuggestedActions(null);
  assert.ok(suggestions.length > 0);
});
