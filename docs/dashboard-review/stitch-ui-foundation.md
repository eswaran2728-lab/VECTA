# Stitch UI foundation (branch `ui/stitch-mobile-redesign`)

The approved Stitch direction is applied to the existing Next.js application as a mobile-first responsive web/PWA interface. It is not a
native app and no route, form, field, permission or workflow was added, removed or re-authorized. The repository is the only authority for
functions, routes, roles, scope and authorization; Stitch supplied visual direction only.

## What was built
| Area | Where | Notes |
|---|---|---|
| Design tokens (Light + Dark) | `app/globals.css`, `tailwind.config.ts` | Semantic tokens: midnight-navy shell, warm-white page, white cards, AirAsia red (`brand`, primary actions), aviation cyan (`primary`, active), `success` / `warning` / `destructive`. 12px radius. Sora is the only typeface (JetBrains Mono only for data readouts). `tests/design-tokens.test.mts` computes WCAG contrast for every text/status pair in both themes and bans the old dark-first raw palette. |
| Theme system | `lib/theme/theme.ts`, `components/theme/*` | Light, Dark, Use Device Setting. Local-only (`localStorage` `vecta-theme`), applied by an inline pre-paint script (no flash), live device following, cross-tab sync, no reload, no server or Supabase involvement. Controls: More → Appearance (phones), Profile → Appearance, quick toggle in the desktop rail. |
| Primitives | `components/ds/*` | StatusBadge, ScopeBadge, PageHeader, RoleScopeHeader, OperationalSummaryCard, ActionCard, ReportCard, AssignmentStatusCard, AnnouncementCard, NotificationCard, EmptyState, ErrorState, OfflineState, AccessRestrictedState, LoadingSkeleton, ConfirmationDialog. Status never relies on colour alone (icon + text). |
| Shell | `components/layout/shell/*`, `lib/dashboard/shell-nav.ts` | Phones: bottom bar Home / Reports / Actions / Alerts / More (Actions, Alerts, More are modal sheets). Tablet: 72px icon rail. Desktop: 256px sidebar collapsible to the rail (persisted locally). One `AppChrome` serves AVSEC, ICMS and the home page. |

## Role-aware navigation (unchanged authority)
`lib/dashboard/shell-nav.ts` only *selects* from the caller's existing `NavModel` (`lib/dashboard/nav-capabilities.ts`). It adds no
destination, so a role sees exactly what it could reach before. Slots with no authorized destination are omitted. The full menu on a
phone (More) is the whole model, so nothing is unreachable. CaterLink-only Driver/Vendor/Management keep `CaterLinkShell` (returns before
`AppChrome`). Non-rostered Boss/Admin/executive roles never receive Duty. Negative profile/assignment states still fail closed
(`showChrome` gate). MAA/AAX, hub and station separation are untouched.

## Route-to-Stitch mapping (ASO Phase 1)
| Stitch concept | Real VECTA route / component | Status |
|---|---|---|
| Secure Login | `/login` (`app/login/page.tsx`; `login-form.tsx` behaviour untouched) | restyled; invented "terminal / PIN / telemetry" content not used |
| My Workspace | `/` (`app/page.tsx`) | rebuilt on primitives; activity table → cards on phones |
| Security Reports | `/` → `#reports` section, `/avsec/reports/<form>` | shell + tokens; Reports tab → `/#reports` for station operators |
| Report Search | `/avsec/reports/lookup` | shell + tokens |
| Report Details | `/avsec/reports/view/[type]/[id]` | shell + token colours |
| Required Actions | `/avsec/dashboard` (`NeedsYourActionPanel`, management-only) | **not exposed to ASO** (no such route for the role; not added) |
| Bay Board | `/avsec/bay-board` | shell + tokens |
| Notifications | Alerts tab sheet / rail bell (`get_my_notifications`, `mark_notification_read`) | same RPCs, shared list |
| Profile and Active Scope | `/avsec/profile`, header/rail scope chips | rebuilt; Appearance added |
| My Duty | `/avsec/duty` | shell + tokens |
| Malaysia AOC Announcements | `AnnouncementBanner` on `/` | tokens |
| WOIS Assistant | rail launcher + floating trigger (`WoisChatModal`) | unchanged behaviour |
| CaterLink action | `/avsec/scan`, `/icms/transactions` | shell + cards on phones |

## Stitch content intentionally NOT implemented
CAAM-OPS/CAAM claims, tactical passcodes, six-digit PIN login, `@airasia.com` sample credentials, "Sign in to Terminal", rugged-device
IDs, tarmac-boundary authorization, Tactical Gate Hold, station supervisor desk, Flight Command sync, live telemetry/radar/aircraft
tracking, socket countdowns, automatic risk scoring, departure-clearance authority, "Request MAA Elevated Scope" and any new escalation or
permission workflow, ground-engineer badge collection, encryption/build details, single-active-assignment or narrowbody/widebody rules,
AK/D7-prefix authorization, and any invented form, approval, scanner or integration. The old decorative "System Nominal" status and clock
on the login page were removed because they implied telemetry that does not exist.

## Known gaps (see the delivery report)
Pages beyond the ASO list inherit the shell and tokens but keep their own bodies (Phase 2 role expansion). ASO routes behind the duty
check-in gate were verified for layout through the gate and through non-rostered roles; an on-duty hosted visual UAT needs fixtures that
this task was not authorized to create. `get_bay_board_secure` fails on staging for leadership roles (`42703 column b.flight does not
exist`) — a database defect outside this redesign, flagged separately.
