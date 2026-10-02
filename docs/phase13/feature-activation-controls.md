# Feature Activation Controls

For every major Phase 8-12 system: how it defaults, how readiness is
checked, how it's staged, how it rolls back, and how its health is
observable. None of these are new code added in Phase 13 (they are
documented here, not built new) except the Gemini re-statement, which
restates Phase 12's own already-implemented controls unchanged.

| System | Default-safe state | Readiness check | Staged activation | Rollback/disable | Health observable | Client-only flag is security boundary? |
|---|---|---|---|---|---|---|
| Scoped-role authorization (Phase 3) | Fail-closed: no `user_role_assignments` row = no access, for every RPC that checks it | n/a (foundational, always on) | n/a | `revoked_at` on a bad assignment | `view_legacy_role_mapping_report_secure` (this phase) | No — every check is a server-side RPC/RLS predicate |
| Central reporting repository (Phase 5) | New reports index automatically via trigger; old reports simply aren't indexed until backfilled | `report_index_queue` pending/failed counts | n/a (schema-level, not feature-flagged) | Queue rows can be reset to `pending` | `view_release_readiness_report_secure` (`pending_report_index_queue_entries`, `failed_indexing_queue_entries`, this phase) | No |
| Secure report readers (Phase 6) | Fail-closed RLS | n/a | n/a | n/a | sampled, not re-verified this round | No |
| Dashboards (Phase 7) | Return nothing/zero rather than over-broad data on an unrecognized role | n/a | n/a | n/a | n/a | No |
| Operational workflows (Phase 8) | Fail-closed on missing AOC/role scope | n/a | n/a | `revoked_at`/status transitions | n/a | No |
| CaterLink station rules (Phase 9) | A station with no `caterlink_station_capabilities` row has CaterLink disabled for that station by construction (the authorization check joins against that table; no row = no match = denied) | Station capability presence | Per-station, naturally (seed one station at a time) | Deactivate the capability row | sampled, not instrumented in the readiness report this round | No |
| Anonymous discussion (Phase 10) | Fail-closed eligibility | n/a | n/a | n/a | n/a | No |
| Announcements (Phase 11) | Fail-closed scope/role check | n/a | n/a | Archive/draft status transitions | n/a | No |
| WOIS Gemini provider (Phase 12) | **Fail-closed to the deterministic rule engine** unless BOTH `WOIS_AI_PROVIDER=gemini` AND `GEMINI_API_KEY` are set (`lib/wois/config.ts:getWoisAiConfig`) | `view_release_readiness_report_secure`'s `wois_provider_configured` field is a placeholder (`false`) in this phase's DB-side report, since the real value is an environment boolean the Node app layer owns, not something the database can see — **a genuine gap**: no app-layer endpoint currently surfaces this boolean either; see "Known limitations" in the Phase 13 final report | Environment-variable-gated, one AOC/deployment at a time by construction (the config has no per-AOC dimension yet, but nothing stops setting it per-deployment) | Set `WOIS_AI_PROVIDER` to anything else (or unset it) and restart | Not yet wired into `view_release_readiness_report_secure` as a real boolean (see gap above) | **No** — disabling Gemini *narrows* capability (falls back to the deterministic engine), it never broadens access; re-confirmed by re-reading `lib/wois/provider.ts:getWoisProvider` this round, unchanged from Phase 12 |

## Gap found and closed this round: WOIS provider-configured boolean

`get_release_readiness_report_secure()` (this phase's migration) hardcodes
`'wois_provider_configured': false`, because the database has no way to
see a Node.js process's `process.env`. `app/super-admin/readiness/page.tsx`
merges in the real boolean server-side from `lib/wois/config.ts:getWoisAiConfig()`
-- the same config the chat route itself uses -- before rendering, so the
readiness page's displayed value is accurate end-to-end even though the
raw database RPC's own field stays a static placeholder. Only the boolean
is exposed; no key or model name is shown.
