import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { toAppNotification } from "../components/layout/NotificationsBell.tsx";

const read = (p: string) => fs.readFileSync(p, "utf8");
const BELL = read("components/layout/NotificationsBell.tsx");
const MIG = read("supabase/migrations/20260928000003_phase4_registration_approval_admin.sql");

test("the bell uses only the caller-scoped notification RPCs: no table read, no table realtime, no identity from the browser", () => {
  assert.match(BELL, /rpc\("get_my_notifications", \{ p_limit: 30 \}\)/);
  assert.match(BELL, /rpc\("mark_notification_read", \{ p_notification_id: id \}\)/);
  assert.doesNotMatch(BELL, /\.from\(/, "no direct table access");
  assert.doesNotMatch(BELL, /postgres_changes|\.channel\(|removeChannel/, "no realtime subscription to a table");
  assert.doesNotMatch(BELL, /["']notifications["']|user_notifications/, "neither the legacy nor the canonical table is addressed");
  assert.doesNotMatch(BELL, /recipient_profile_id|user_id\s*[:=]/, "no identity is sent");
  assert.ok(!fs.existsSync("lib/notifications/actions.ts"), "the legacy mark-all server action (public.notifications) is gone");
});

test("no application code reads or writes the legacy public.notifications table from the bell path", () => {
  for (const f of ["components/layout/shell/DesktopNavigationRail.tsx", "components/layout/shell/MobileBottomNavigation.tsx", "app/page.tsx", "app/(avsec)/avsec/layout.tsx", "app/(icms)/icms/layout.tsx"]) {
    assert.doesNotMatch(read(f), /from\("notifications"\)/, f);
  }
});

test("SQL authorization: list and mark-read are derived from auth.uid(), executable by authenticated only", () => {
  const list = MIG.slice(MIG.indexOf("create or replace function public.get_my_notifications"));
  assert.match(list.slice(0, 700), /where n\.recipient_profile_id = auth\.uid\(\)/);
  assert.match(list, /security definer\s+set search_path to 'public'/);
  assert.match(MIG, /revoke execute on function public\.get_my_notifications\(integer\) from public, anon;/);
  assert.match(MIG, /grant execute on function public\.get_my_notifications\(integer\) to authenticated, service_role;/);
  const mark = MIG.slice(MIG.indexOf("create or replace function public.mark_notification_read"));
  assert.match(mark.slice(0, 500), /where id = p_notification_id and recipient_profile_id = auth\.uid\(\)/);
  assert.match(MIG, /revoke execute on function public\.mark_notification_read\(uuid\) from public, anon;/);
  // the table itself: no anon, authenticated limited to own rows for select / update
  assert.match(MIG, /revoke all on public\.user_notifications from public, anon;/);
  assert.match(MIG, /for select using \(recipient_profile_id = auth\.uid\(\)\)/);
});

test("TypeScript signatures exist for both RPCs", () => {
  const t = read("lib/supabase/database.types.ts");
  assert.match(t, /get_my_notifications: \{\s+Args: \{ p_limit\?: number \}/);
  assert.match(t, /mark_notification_read: \{ Args: \{ p_notification_id: string \}; Returns: undefined \}/);
});

test("row mapping: entity reports link through the secure route; read state follows read_at; unknown events are humanised", () => {
  const entity = toAppNotification({ id: "1", event_type: "entity_report_submitted", payload: { source_table: "report_sec016", source_id: "abc" }, created_at: "2026-10-12T00:00:00Z", read_at: null });
  assert.equal(entity.title, "New entity report");
  assert.equal(entity.isRead, false);
  assert.match(entity.href ?? "", /abc/);
  const read1 = toAppNotification({ id: "2", event_type: "request_approved", payload: null, created_at: "2026-10-12T00:00:00Z", read_at: "2026-10-12T01:00:00Z" });
  assert.equal(read1.title, "Registration approved");
  assert.equal(read1.isRead, true);
  assert.equal(read1.href, null);
  assert.equal(toAppNotification({ id: "3", event_type: "some_new_event", payload: null, created_at: "2026-10-12T00:00:00Z", read_at: null }).title, "Some new event");
});

test("header touch targets are at least 44x44 on mobile and keep their desktop size", () => {
  const header = read("components/layout/UnifiedHeader.tsx");
  assert.match(header, /min-h-\[44px\] min-w-\[44px\][^"]*sm:min-h-\[28px\] sm:min-w-0/);
  assert.match(header, /Link href=\{homeHref\} className="flex min-h-\[44px\][^"]*sm:min-h-0/);
  assert.match(read("components/theme/AppearanceControl.tsx"), /h-11 w-11/); // the quick theme toggle keeps a 44px mobile target
  assert.match(BELL, /h-11 w-11[^"]*sm:h-9 sm:w-9/);
  assert.match(BELL, /aria-label=/);
});

test("layout icon metadata points at files that exist under public/ (no favicon 404 console errors)", () => {
  const layout = read("app/layout.tsx");
  const urls = [...layout.matchAll(/(?:url|apple): "(\/[^"]+\.png)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 3);
  for (const u of urls) assert.ok(fs.existsSync(`public${u}`), `public${u} exists`);
});

test("the profile page has a page heading (h1) for assistive technology", () => {
  assert.match(read("app/(avsec)/avsec/profile/page.tsx"), /<h1 className="font-display[^>]*>\s*\{profile\.name\}\s*<\/h1>/);
});

test("pages found without a heading by the hosted UAT now have an h1; the moderation link is not offered to a role the page refuses", () => {
  assert.match(read("app/(avsec)/avsec/admin/absences/page.tsx"), /<h1[^>]*>\s*LEAVE & ABSENCE AUDIT DASHBOARD/);
  assert.match(read("app/(avsec)/avsec/duty/overtime/page.tsx"), /<h1[^>]*>\s*OVERTIME \(OT\)/);
  assert.match(read("app/(avsec)/avsec/operation/duty-draw/page.tsx"), /<h1[^>]*>Duty-Zone Draw<\/h1>\s*<div className="card p-6/);
  assert.doesNotMatch(read("lib/dashboard/nav-capabilities.ts"), /L\("\/avsec\/discussions\/moderation"/);
});

test("the legacy Anonymous Feedback module is retired: no reference to the missing notifications / feedback tables remains in application code", () => {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "database.types.ts") return [];
      const p = `${d}/${e.name}`;
      return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
  const offenders = ["app", "lib", "components"].flatMap(walk).filter((f) => /from\(\s*["'](notifications|feedback_threads|feedback_messages)["']\s*\)|table:\s*["']notifications["']/.test(read(f)));
  assert.deepEqual(offenders, []);
  for (const gone of ["lib/avsec/feedback/actions.ts", "lib/avsec/feedback/queries.ts", "components/avsec/feedback/ManagementFeedbackInbox.tsx", "app/api/avsec/feedback/[id]/messages/route.ts"]) assert.ok(!fs.existsSync(gone), gone);
  for (const stub of ["app/(avsec)/avsec/feedback/page.tsx", "app/(avsec)/avsec/management/feedback/page.tsx"]) {
    const src = read(stub);
    assert.match(src, /requireProfile\(\)/);
    assert.match(src, /redirect\("\/avsec\/discussions"\)/);
    assert.doesNotMatch(src, /\.from\(|\.rpc\(/);
  }
  assert.doesNotMatch(read("lib/dashboard/nav-capabilities.ts"), /\/avsec\/feedback|management\/feedback/);
  for (const f of ["components/layout/shell/DesktopNavigationRail.tsx", "components/layout/shell/MobileBottomNavigation.tsx", "lib/dashboard/shell-nav.ts"]) assert.doesNotMatch(read(f), /\/avsec\/feedback|management\/feedback|discussions\/moderation/);
});

test("every AVSEC page the hosted UAT reached has a page heading (h1 or h2) in its source or its header component", () => {
  for (const f of ["duty/page.tsx", "duty/zones/page.tsx", "duty/timesheet/page.tsx", "scan/page.tsx", "bay-board/page.tsx", "profile/page.tsx"]) {
    assert.match(read(`app/(avsec)/avsec/${f}`), /<h1[\s>]/, f);
  }
});

test("accessibility fixes found by axe-core and the target-size audit", () => {
  assert.match(read("components/layout/TransactionStageBar.tsx"), /role="img" aria-label=\{`Stage: \$\{status\}`\}/);
  const side = read("components/layout/shell/DesktopNavigationRail.tsx");
  assert.match(side, /min-h-\[44px\] w-full items-center gap-2\.5/, "rail actions are 44px targets");
  assert.doesNotMatch(side, /min-h-\[28px\]|text-\[9px\]|text-\[10px\]/, "no sub-44px targets or tiny text in the rail");
  assert.match(read("components/dashboard/EntityDashboard.tsx"), /inline-flex min-h-\[24px\] items-center font-mono text-xs text-primary/);
});

test("contrast, keyboard-scroll and mobile target fixes from the hosted accessibility audit", () => {
  assert.match(read("components/layout/shell/MobileBottomNavigation.tsx"), /active \? "text-shell-active" : "text-shell-muted/);
  assert.match(read("components/avsec/duty/CheckInScreen.tsx"), /bg-brand\/10 px-5 py-4 text-sm font-medium text-foreground/);
  assert.match(read("app/(avsec)/avsec/duty/page.tsx"), /text-\[11px\] font-bold uppercase tracking-\[0\.06em\] text-foreground/);
  assert.match(read("app/page.tsx"), /overflow-x-auto" tabIndex=\{0\} role="region" aria-label="My recent activity/);
  assert.match(read("app/page.tsx"), /overflow-x-auto" tabIndex=\{0\} role="region" aria-label="Station activity/);
  assert.match(read("components/icms/language-toggle.tsx"), /min-h-\[44px\] min-w-\[44px\][^"]*lg:min-h-\[28px\]/);
  assert.match(read("components/caterlink/CaterLinkShell.tsx"), /aria-label="Sign out" className="inline-flex min-h-\[44px\]/);
});
