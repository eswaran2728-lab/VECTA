import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBadge, ScopeBadge, statusToneLabel } from "../components/ds/status.tsx";
import { EmptyState, ErrorState, OfflineState, AccessRestrictedState, LoadingSkeleton } from "../components/ds/states.tsx";
import { PageHeader, RoleScopeHeader, OperationalSummaryCard, ActionCard, ReportCard, AssignmentStatusCard, AnnouncementCard, NotificationCard } from "../components/ds/cards.tsx";

const h = React.createElement;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

test("status badges never rely on colour alone: every tone renders an icon and its label text", () => {
  for (const tone of ["success", "warning", "danger", "info", "neutral", "brand"] as const) {
    const out = html(h(StatusBadge, { tone }, `label-${tone}`));
    assert.match(out, /<svg[^>]*aria-hidden="true"/, `${tone}: icon present and hidden from AT`);
    assert.match(out, new RegExp(`label-${tone}`), `${tone}: text present`);
    assert.match(out, new RegExp(`data-tone="${tone}"`));
    assert.ok(statusToneLabel(tone).length > 0);
  }
});

test("status colours come from semantic tokens only (no raw hex, rgb or hard-coded palette classes)", async () => {
  const fs = await import("node:fs");
  for (const f of ["status", "states", "cards"]) {
    const src = fs.readFileSync(`components/ds/${f}.tsx`, "utf8");
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgb\(|(?:bg|text|border)-(?:red|green|amber|blue|slate|gray|sky|cyan)-\d{2,3}/, f);
  }
});

test("scope badge shows both the label and the value", () => {
  const out = html(h(ScopeBadge, { label: "Station", value: "PEN" }));
  assert.match(out, /Station/);
  assert.match(out, /PEN/);
});

test("empty / error / offline / restricted states use the right live-region roles and plain language", () => {
  assert.match(html(h(EmptyState, { title: "No reports yet" })), /role="status"/);
  const err = html(h(ErrorState, {}));
  assert.match(err, /role="alert"/);
  assert.match(err, /Try again shortly/);
  assert.match(html(h(OfflineState, {})), /You&#x27;re offline|You're offline/);
  const restricted = html(h(AccessRestrictedState, {}));
  assert.match(restricted, /role="status"/);
  assert.doesNotMatch(restricted, /exist|not found|404/i, "never reveals whether a hidden record exists");
});

test("empty state action is a real link with a 44px target", () => {
  const out = html(h(EmptyState, { title: "Nothing", action: { href: "/avsec/duty", label: "Open duty" } }));
  assert.match(out, /href="\/avsec\/duty"/);
  assert.match(out, /min-h-\[44px\]/);
});

test("loading skeleton is announced as busy, has an accessible name and respects reduced motion", () => {
  const out = html(h(LoadingSkeleton, { label: "Loading reports" }));
  assert.match(out, /aria-busy="true"/);
  assert.match(out, /Loading reports/);
  assert.match(out, /motion-reduce:animate-none/);
});

test("page header has exactly one h1 and puts actions in the header", () => {
  const out = html(h(PageHeader, { title: "Bay Board", description: "Aircraft on ground", actions: h("button", null, "Add") }));
  assert.equal((out.match(/<h1/g) ?? []).length, 1);
  assert.match(out, /Bay Board/);
  assert.match(out, /<button>Add<\/button>/);
});

test("role scope header renders the real role label and every scope as text", () => {
  const out = html(h(RoleScopeHeader, { roleLabel: "ASO", scopes: [{ label: "Station", value: "PEN" }, { label: "Team", value: "A" }] }));
  assert.match(out, /ASO/);
  assert.match(out, /PEN/);
  assert.match(out, /Team/);
});

test("summary, action, report, assignment, announcement and notification cards keep their text and links", () => {
  assert.match(html(h(OperationalSummaryCard, { label: "Reports today", value: 4, tone: "warning", href: "/avsec/history" })), /href="\/avsec\/history"[\s\S]*Reports today[\s\S]*4[\s\S]*Pending/);
  assert.match(html(h(ActionCard, { title: "Open duty", href: "/avsec/duty", description: "Check in" })), /href="\/avsec\/duty"/);
  assert.match(html(h(ReportCard, { title: "SEC016", status: "Submitted for Review", tone: "info", href: "/avsec/reports/view/sec016/1" })), /Submitted for Review/);
  assert.match(html(h(AssignmentStatusCard, { title: "Active assignment", status: "Active", tone: "success", detail: "PEN · ASO" })), /aria-label="Active assignment"[\s\S]*PEN · ASO/);
  assert.match(html(h(AnnouncementCard, { title: "Malaysia AOC notice", body: "Body" })), /<article/);
  const unread = html(h(NotificationCard, { title: "Registration approved", time: "12 Oct", unread: true }));
  assert.match(unread, /New/);
  assert.doesNotMatch(html(h(NotificationCard, { title: "x", time: "t", unread: false })), />New</);
});

test("interactive cards are at least 44px tall", () => {
  for (const out of [html(h(ActionCard, { title: "a", href: "/x" })), html(h(OperationalSummaryCard, { label: "l", value: 1, href: "/x" })), html(h(ReportCard, { title: "t", status: "s", href: "/x" }))]) {
    assert.match(out, /min-h-\[(?:44|56)px\]/);
  }
});
