# Mobile and Desktop Review (static, from source)

> **Method:** STATIC, read-only source review of branch `dashboard/role-workspaces-adjustment` (HEAD `139d71cc4a1e4de8554ee2b9f3a12cf439da716f`, confirmed from `.git/HEAD` and `.git/refs`). No login was performed; **no browser behaviour is verified**. Hosted staging DB state is **UNVERIFIED** (only repo migrations were read).
> **Git working-tree cleanliness is UNVERIFIED.** `git status --short` could not be run (no shell on the owner's machine). Do not treat the tree as clean.
> **Credentials:** the staging credential PDF was used only for account labels and scopes. No passwords appear in these documents.
> Labels: CODE-CONFIRMED | REQUIRES-BROWSER-VERIFICATION | OWNER-DECISION-REQUIRED | SECURITY-DEFECT.

No viewport was rendered. Everything below is derived from source and must be confirmed at 1440x900 and 390x844.

## Layout mechanics (CODE-CONFIRMED)
- `AppSidebar`: `hidden lg:flex` (visible >= 1024px).
- `TeamBottomNav`: `md:hidden` (visible < 768px).
- **Gap at 768-1023px: no navigation visible** (REQUIRES-BROWSER-VERIFICATION of impact; likely tablet/landscape-phone problem). Fix: show bottom nav or a drawer below `lg`.
- Both navs take the 'ASO' fallback role for null-compat roles, so leadership gets the wrong item set on every breakpoint.
- Dashboard components (Entity, EntityAdmin, Executive, GenericLinkHub, OperationManager, SuperAdmin) use responsive card grids; no static evidence of fixed-width overflow was gathered. Tables (directory, reports, registrations) need horizontal-scroll or card-collapse checks.
- Unique dashboard types to test (6 + CaterLink portal): Entity (Boss), EntityAdmin, Executive, OperationManager, SuperAdmin, GenericLinkHub, CaterLink portal.

## Browser checklist per unique dashboard
Sidebar/menu, overflow, cards, tables, filters, forms, dialogs, buttons, readability, 44px touch targets, keyboard focus order, back navigation, loading/empty/error/unauthorised states, console and network errors. Do not capture credentials in screenshots.

## Accessibility (not assessed)
Not verifiable statically; REQUIRES-BROWSER-VERIFICATION.

---

# Responsive implementation and browser-certification checklist

## What changed (code; browser pass still required)
- One navigation model (`lib/dashboard/nav-capabilities.ts`) feeds the desktop sidebar (>= 1024px), the drawer (< 1024px, opened from a 44px "Menu" button in the header) and the bottom tabs (< 1024px). The bottom bar changed from `md:hidden` to `lg:hidden`, which closes the former 768-1023px gap; the drawer gives the full menu at every narrow width.
- Drawer: `role="dialog"`, `aria-modal`, `aria-expanded` on the trigger, focus moves into the panel on open and back to the trigger on close, Tab is trapped, Esc and backdrop close it, a route change closes it, page scroll is locked while open, links are >= 44px, visible `focus-visible` rings.
- Entity pages use `overflow-x-auto` tables with `min-w-*` so the PAGE never scrolls horizontally; filters wrap (`sm:grid-cols-2 lg:grid-cols-3`).

## Browser certification checklist (NOT done — credentials cannot be entered in this environment)
Run at **390x844, 768, 834, 1024 and 1440x900**, for MAA Boss, MAA Admin, AAX Boss, AAX Admin, an ASO, a DSE, GHOD and one CaterLink account:
1. Navigation is usable at every width: sidebar at >= 1024, header Menu + drawer + bottom bar below it; no duplicated or overlapping navigation.
2. Keyboard only: Tab reaches the Menu button; Enter opens; focus lands in the panel; Esc closes and returns focus; visible focus ring everywhere.
3. Touch targets >= 44px (Menu, drawer links, bottom tabs, filter buttons, pagination, Open links).
4. No horizontal page overflow; wide tables scroll inside their card.
5. Entity Reports: search by registration, flight (`AK703`, `ak 703`, `D7 123`), date range, type, status; counts match the list; Open works for a completed report; PDF and attachment succeed for an authorized report and fail for the other entity's report by direct URL.
6. Directory and Reports are separate buttons; Admin sees the export button, Boss does not.
7. Registration administration: nav link visible to Admins only; selectors (no UUID/AOC input); required scope fields follow the role; approve and reject (with reason) work for the own entity; a protected role is refused with a clear error.
8. Bay Board: Hub + Station selectors; empty / loading / error states are truthful.
9. Announcements: GHOD sees Global only, entity roles Malaysia AOC only, AirAsia Management read-only.
10. Identity reveal (Boss only): button visible only to MAA/AAX Boss; reason required; result shows staff number and name only; Admin / AirAsia Management never see the control.
11. Direct URLs for non-rostered leadership: `/avsec/duty`, `/avsec/duty/absences`, `/avsec/duty/overtime`, `/avsec/duty/timesheet` redirect to the dashboard.
12. Negative-state accounts (pending, rejected, deactivated, revoked, expired, future) reach no operational page.
Do not capture credentials in screenshots.
