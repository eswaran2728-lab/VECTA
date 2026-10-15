# Part C (Airport Post) and dependent steps: questions for the CaterLink process owner

Status: **known functional blocker** (`KNOWN_BLOCKERS[0]` in `lib/icms/route-readiness.ts`, guarded by `tests/route-readiness.test.mts`).
No code or migration writes `AIRPORT_POST_APPROVED`, `REDQ_RESEALED` or `POST6_APPROVED`; Part C, Part D and Part REDQ have no
recording workflow. Consequence on the current build:

| Route | Steps (workflow.ts) | Can it complete? | Why |
|---|---|---|---|
| Outbound HUB | A → B → Hub | **Yes** (when created with a hub destination) | Part B is certified; the destination receipt serves the Hub step |
| Outbound AIRCRAFT | A → B → C → D | No | no Part C / Part D write path |
| Outbound REDQ | A → B → REDQ → C → D | No | no REDQ / Part C / Part D write path |
| Outbound MAINTENANCE | A → B → C | No | no Part C write path; also no trusted destination for the receipt |
| Inbound | A → C → B | No | the first step (Part C) has no write path |

These movements stay blocked on purpose. Nothing below may be assumed; each answer must come from the process owner.

## Part C (Airport Security Post, "Post 6")
1. **Actor.** Which roles may record it (ASO, SO, SSO, DSE, others)? Is Staff Profiling excluded as for Part B? Must the officer be on duty today?
2. **Station.** At which station is it performed: the origin station, the destination station, or a separate airport post? Does it require
   the station *scan* capability (only PEN and JHB have it) or a new capability?
3. **Fields.** Which fields are recorded: vehicle verified, driver verified, seal verified (number and colour entered), observed vehicle and
   driver against the whitelist (as in Part B), remarks, anything else?
4. **Signature.** Is a signature required, and does the same signature-ownership rule as Part B apply?
5. **Failure and escalation.** What happens on a seal mismatch, wrong colour or whitelist violation: freeze the movement behind an incident
   as in Part B? Who is notified (CaterLink Management, Operation Manager, others)? May the officer escalate manually with a reason?
6. **Transitions.** Exactly which statuses does it require and produce for each route (including the inbound order C → B, REDQ → C, and
   MAINTENANCE where Part C is terminal)? Is `POST6_APPROVED` an alias of `AIRPORT_POST_APPROVED` or a separate state?
7. **Notifications.** Which events notify whom (success as well as failure)? Does completion notify the sender?
8. **Correction.** After an incident is resolved, does the movement resume at its earlier status with the recorded Part C standing, or is
   Part C redone as a new versioned record? Who chooses the resume status?

## Part D (Delivery) and Skip Part D
9. Is the destination receipt the replacement for Part D on non-HUB routes (as it is for Hub)? If yes, Part D and Skip Part D are retired.
   If no: who is the "receiver", at which station, with which fields and signature?

## REDQ (re-seal)
10. Who re-seals, at which station, and how are the old and new seals recorded (new seal row, colour rule, whitelist)? Is REDQ offered to
    Drivers in the trial at all?

## Destination and receipt
11. For routes other than HUB, where is the movement received and how is that destination stored at creation (the receipt now requires a
    trusted destination equal to the receiving station)? Must the receipt additionally require every earlier checkpoint?

## Creation
12. Should AIRCRAFT, REDQ, INBOUND and MAINTENANCE movements remain hidden from the creation form until the above is decided (current behaviour)?
