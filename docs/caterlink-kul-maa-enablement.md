# KUL–MAA CaterLink scanning

The owner requested that the KUL–MAA ASO CaterLink scanner work for operational UAT. The previous reviewed policy deliberately allowed PEN and JHB only. This forward migration adds exactly `KUL - MAA`; it does not treat the rejection as a camera defect or bypass the scan gate.

Migration `20261130000005_enable_kul_maa_caterlink_scan.sql` changes one existing MY AOC capability row and adds KUL–MAA to the existing `can_user_scan_caterlink` allowlist. Its identity, approved-profile, active-role, active-assignment, exact-station, MY AOC and profiling-exclusion checks remain unchanged. Function ownership, execution grants and security properties remain unchanged. KUL–AAX, KUL without an entity, BKI, KCH, BTU and unknown stations remain unable to scan. Receipt capabilities and workflow Parts C/D/REDQ are unchanged.

The CLI created the migration file. Its version was placed immediately after the existing hosted/repository future-dated version `20261130000004`, rather than before that history at the current calendar timestamp. Historical migrations were not edited.

The runner requires the exact clean Git head on `fix/caterlink-kul-maa-scanning`, the expected origin, a frozen SQL SHA-256, verified staging TLS and a fresh authenticated encrypted logical backup outside the repository. It refuses a changed pre-state or a re-run after the 107→108 history transition. It tests caller/station/AOC combinations, asserts unchanged policies, triggers, table grants, other functions, profiles and assignments, then proves rollback before a separate explicit live pass.

Application scan and checkpoint handlers already call the database decision on each request. A database-only policy change needs no frontend code deployment. Browser verification must still confirm manual reference lookup, Part B, off-duty refusal, cross-station refusal and destination receipt on the final staging state. A capability RPC result alone is not complete workflow evidence.

The isolated copy preserves the original checkout's unfinished registration edits. No production deployment or main-branch merge is part of this work.
