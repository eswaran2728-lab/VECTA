# Incident-photos bucket lockdown (migration 20261114000001)

## Defect
`supabase/migrations/icms/20260101000002_rls.sql` created two policies for role `public`:
`incident photos: authenticated upload` (insert) and `incident photos: authenticated read` (select), both `bucket_id = 'incident-photos' and auth.role() = 'authenticated'`.
Any signed-in account (Driver, Vendor, an officer at any station, any AOC) could therefore upload any object into the private bucket and read and list every object in it.

## Inventory
| Question | Finding |
|---|---|
| Producers in application code | none. `uploadDataUrl("incident-photos", …)` is never called; the type union only allowed it. |
| Consumers in application code | none (`signedUrl` accepts the bucket name, but no caller passes it). |
| Database writers of a photo reference | `caterlink_incidents.photo_url` was written only by `raise_caterlink_incident_secure(…, p_photo_url)`, which is a closed fail-closed stub since 20261108000001. Incidents are created by checkpoint escalation, which carries no photo. |
| Legacy `incident_photos` table | absent on staging (and on every environment this chain builds). |
| Staging (read-only, `scripts/staging/inspect-incident-photos.mjs`) | bucket private, **0 objects**, `caterlink_incidents.photo_url` empty (0 rows). |
| Roles with access today | role `public` policies gated by `auth.role() = 'authenticated'`: every signed-in user, read and write. |

There is no legitimate workflow to preserve and no historical object to strand.

## Replacement (least privilege, fail closed)
* Both historical policies are removed.
* **No client INSERT/UPDATE/DELETE policy.** An incident-photo upload workflow does not exist and is not invented here; when the process owner defines
  one it needs its own bound path format, reporter/state rules and tests. The signature rules do not carry over automatically (the parent is an
  incident, the actor is its reporter or an assigned handler, and the allowed states differ). The trusted service role is unaffected.
* **Scoped read** (`incident photos: scoped read`, role `authenticated`): an object is readable only if the caller uploaded it, or a
  `caterlink_incidents` row that references it as `photo_url` is visible to the caller. The helper `caterlink_incident_photo_visible` is
  SECURITY INVOKER so the existing `caterlink_incidents_read` row-level security decides: CaterLink Management / Operation Manager / Main
  Enforcement of the incident's AOC, the reporter, the assignee.
* The bucket stays private. Nothing is deleted.

## Matrix
| Actor | Upload | Read a photo referenced by an incident | Read an unreferenced object |
|---|---|---|---|
| Incident reporter | denied | yes (their incident) | only their own upload |
| Assignee | denied | yes | no |
| CaterLink Management / Operation Manager / Main Enforcement (same AOC) | denied | yes | no |
| Same-station officer who is not involved | denied | no | no |
| Officer at another station | denied | no | no |
| Management of another AOC | denied | no | no |
| Driver, Vendor | denied | no | no |
| Anonymous | denied | no | no |
| `service_role` | allowed (trusted server workflows) | allowed | allowed |

## Related bucket
The `completed-forms` bucket carried the same historical pattern; it is locked down fail-closed by migration 20261116000001 (see `completed-forms-lockdown.md`).
