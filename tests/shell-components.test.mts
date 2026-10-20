import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildNavModel } from "../lib/dashboard/nav-capabilities.ts";
import { deriveShellNav } from "../lib/dashboard/shell-nav.ts";
import { MobileBottomNavigation } from "../components/layout/shell/MobileBottomNavigation.tsx";
import { DesktopNavigationRail } from "../components/layout/shell/DesktopNavigationRail.tsx";
import { AppChrome } from "../components/layout/shell/AppChrome.tsx";

const h = React.createElement;
const read = (p: string) => fs.readFileSync(p, "utf8");
const shell = (role: string, extra: { canScan?: boolean; canReceive?: boolean } = {}) => deriveShellNav(buildNavModel({ roleCodes: [role], ...extra }));
const bottom = (role: string, extra = {}) => renderToStaticMarkup(h(MobileBottomNavigation, { shell: shell(role, extra), userId: "u1" }));
const rail = (role: string, extra = {}) => {
  const m = buildNavModel({ roleCodes: [role], ...extra });
  return renderToStaticMarkup(h(DesktopNavigationRail, { userId: "u1", name: "Test User", roleLabel: m.roleLabel, role: m.roleCode, groups: m.groups, station: "PEN", team: "A" }));
};
const labels = (html: string) => [...html.matchAll(/<(?:span|a|button)[^>]*>(?:<[^>]+>)*(Home|Reports|Actions|Alerts|More)(?:<\/[^>]+>)*/g)].map((m) => m[1]);

test("mobile bottom navigation: a station ASO sees Home, Reports, Actions, Alerts, More in that order", () => {
  const html = bottom("aso", { canScan: true });
  const order = ["Home", "Reports", "Actions", "Alerts", "More"].map((l) => html.indexOf(`>${l}<`));
  assert.ok(order.every((i) => i >= 0), `all five present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in the approved order");
  assert.match(html, /aria-label="Primary"/);
});

test("mobile bottom navigation is for phones only and every tab is at least 44px", () => {
  const html = bottom("aso");
  assert.match(html, /<nav[^>]*md:hidden/);
  assert.match(html, /min-h-\[56px\]/);
  assert.ok(!/min-h-\[(?:[0-3]\d|4[0-3])px\]/.test(html), "no tab under 44px");
});

test("a role with no report destination and no operational shortcuts shows only Home, Alerts and More", () => {
  const html = bottom("definitely_not_a_role");
  assert.ok(!html.includes(">Reports<"));
  assert.ok(!html.includes(">Actions<"));
  assert.ok(html.includes(">Alerts<") && html.includes(">More<"));
});

test("non-rostered leadership never gets Duty in the bottom bar or the rail", () => {
  for (const role of ["maa_boss", "maa_admin", "aax_boss", "aax_admin", "airasia_management", "ghod", "operation_manager"]) {
    assert.ok(!/href="\/avsec\/duty"/.test(bottom(role)), `${role} bottom`);
    assert.ok(!/href="\/avsec\/duty"/.test(rail(role)), `${role} rail`);
  }
  assert.match(rail("aso"), /href="\/avsec\/duty"/);
});

test("the rail is for tablet and desktop only, is labelled, and renders the role's own links", () => {
  const html = rail("aso", { canScan: true });
  assert.match(html, /<aside[^>]*aria-label="Primary navigation"[^>]*md:flex/);
  assert.match(html, /hidden/);
  assert.match(html, /vecta-rail/);
  assert.match(html, /href="\/avsec\/scan"/);
  assert.doesNotMatch(rail("aso", { canScan: false }), /href="\/avsec\/scan"/);
});

test("collapsed rail keeps every link accessible: labels stay in the DOM as screen-reader text and each link has a title", () => {
  const html = rail("aso");
  assert.match(html, /class="[^"]*vecta-rail-label[^"]*"/);
  assert.match(html, /title="Bay Board"/);
  assert.match(read("app/globals.css"), /\.vecta-rail-label \{[^}]*clip: rect\(0, 0, 0, 0\)/);
});

test("rail controls: collapse toggle is a pressed-state button visible only from lg, theme and alerts live in the rail", () => {
  const html = rail("aso");
  assert.match(html, /aria-pressed="false"[^>]*aria-label="Collapse navigation"|aria-label="Collapse navigation"[^>]*aria-pressed="false"/);
  assert.match(html, /hidden h-11 w-11[^"]*lg:inline-flex/);
  assert.match(html, /Appearance: /);
  assert.match(html, /aria-label="Notifications"/);
});

test("the chrome shows the slim navy top bar on phones only and offsets content for the rail on larger screens", () => {
  const model = buildNavModel({ roleCodes: ["aso"] });
  const html = renderToStaticMarkup(h(AppChrome, { userId: "u1", name: "T", roleLabel: "ASO", model, station: "PEN", team: null }, h("p", null, "page body")));
  assert.match(html, /<header[^>]*md:hidden/);
  assert.match(html, /vecta-shell-offset/);
  assert.match(html, /page body/);
  assert.match(html, /pb-24 md:pb-8/);
});

test("breakpoint geometry: phones bottom nav, tablet 72px rail, desktop 256px sidebar that can collapse to the rail", () => {
  const css = read("app/globals.css").replace(/\r\n/g, "\n");
  assert.match(css, /\.vecta-rail \{ width: 4\.5rem; \}/);
  assert.match(css, /@media \(min-width: 768px\)[\s\S]*padding-left: 4\.5rem/);
  assert.match(css, /@media \(min-width: 1024px\)[\s\S]*\.vecta-rail \{ width: 16rem; \}/);
  assert.match(css, /html\[data-nav="collapsed"\] \.vecta-rail \{ width: 4\.5rem; \}/);
});

test("bottom sheet and confirmation dialog are real modal dialogs with focus trap, Escape and focus return", () => {
  for (const f of ["components/layout/shell/BottomSheet.tsx", "components/ds/ConfirmationDialog.tsx"]) {
    const src = read(f);
    assert.match(src, /role="dialog"/, f);
    assert.match(src, /aria-modal="true"/, f);
    assert.match(src, /aria-labelledby/, f);
    assert.match(src, /e\.key === "Escape"/, f);
    assert.match(src, /e\.key !== "Tab"/, f);
    assert.match(src, /\.focus\?\.\(\)/, `${f} returns focus to the opener`);
  }
});

test("the shell is used by every signed-in layout and routes no authorization of its own", () => {
  for (const f of ["app/(avsec)/avsec/layout.tsx", "app/(icms)/icms/layout.tsx", "app/page.tsx"]) assert.match(read(f), /<AppChrome/, f);
  for (const f of ["lib/dashboard/shell-nav.ts", "components/layout/shell/AppChrome.tsx", "components/layout/shell/MobileBottomNavigation.tsx", "components/layout/shell/DesktopNavigationRail.tsx"]) {
    assert.doesNotMatch(read(f), /requireRole|requireProfile|has_active_role|supabase\.rpc|\.from\(/, `${f} must not authorize or query`);
  }
});

test("keyboard: all shell controls have visible focus styles", () => {
  for (const f of ["components/layout/shell/MobileBottomNavigation.tsx", "components/layout/shell/DesktopNavigationRail.tsx", "components/layout/NavGroupsList.tsx"]) {
    assert.match(read(f), /focus-visible:ring/, f);
  }
  assert.ok(labels(bottom("aso")).length >= 3);
});

test("CaterLink-only identities never get the VECTA shell: the portal shell returns first, before AppChrome is reached", () => {
  const layout = read("app/(icms)/icms/layout.tsx");
  const portal = layout.indexOf("if (isCaterLinkOnly(portalKind))");
  const caterShell = layout.indexOf("<CaterLinkShell");
  const chrome = layout.indexOf("<AppChrome");
  assert.ok(portal > 0 && caterShell > portal && chrome > caterShell, "CaterLink-only returns before the VECTA chrome");
  const home = read("app/page.tsx");
  assert.ok(home.indexOf('redirect("/caterlink/dashboard")') > 0 && home.indexOf('redirect("/caterlink/dashboard")') < home.indexOf("<AppChrome"), "the home page sends CaterLink-only identities away before rendering the shell");
});

test("the AVSEC shell is drawn only for approved profiles with an assignment (negative states fail closed)", () => {
  const layout = read("app/(avsec)/avsec/layout.tsx").replace(/\r\n/g, "\n");
  assert.match(layout, /const showChrome = Boolean\(profile && profile\.status === "approved" && profile\.name && access\?\.hasAssignment && !access\.isSuperAdmin\)/);
  assert.match(layout, /showChrome && profile && navModel \? \(\s*<AppChrome/);
});

test("ICMS transactions render readable cards on phones and the table from tablet width", () => {
  const page = read("app/(icms)/icms/transactions/page.tsx");
  assert.match(page, /<ul className="space-y-2 p-3 md:hidden" aria-label="Transactions">/);
  assert.match(page, /<div className="hidden md:block">\s*<Table>/);
});

test("profile page uses the shared Appearance control and the primitive for profile status", () => {
  const page = read("app/(avsec)/avsec/profile/page.tsx");
  assert.match(page, /<ThemeOptions \/>/);
  assert.match(page, /<AssignmentStatusCard title="Profile status"/);
  assert.doesNotMatch(page, /Nocturne/);
});
