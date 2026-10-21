-- Narrow the client roles to the privileges the application actually uses (forward migration; no policy, function body or data change).
-- Supabase default privileges gave `authenticated` every table privilege on every new public table. TRUNCATE is not subject to row level security,
-- and TRIGGER / REFERENCES are never needed by a client role. EXECUTE on trigger functions is only checked when a trigger is created, never when it
-- fires, so the client roles do not need it either. SELECT / INSERT / UPDATE / DELETE as designed for each table are left exactly as they are, except
-- the one DELETE that was never granted by design (shift_handovers: select, insert, update only) and write privileges on read-only reporting views.
set local lock_timeout = '5s';

revoke truncate, trigger, references on table public.absence_notices from authenticated;
revoke truncate, trigger, references on table public.aircraft_types from authenticated;
revoke truncate, trigger, references on table public.announcement_acknowledgements from authenticated;
revoke truncate, trigger, references on table public.announcements from authenticated;
revoke truncate, trigger, references on table public.bay_board from authenticated;
revoke truncate, trigger, references on table public.duty_audit_log from authenticated;
revoke truncate, trigger, references on table public.duty_records from authenticated;
revoke truncate, trigger, references on table public.duty_zones from authenticated;
revoke truncate, trigger, references on table public.enforcement_search_log from authenticated;
revoke truncate, trigger, references on table public.offload_items from authenticated;
revoke truncate, trigger, references on table public.offload_records from authenticated;
revoke truncate, trigger, references on table public.overtime_requests from authenticated;
revoke truncate, trigger, references on table public.phase13_readiness_access_log from authenticated;
revoke truncate, trigger, references on table public.profiles from authenticated;
revoke truncate, trigger, references on table public.report_acknowledgements from authenticated;
revoke truncate, trigger, references on table public.report_attachments from authenticated;
revoke truncate, trigger, references on table public.report_counters from authenticated;
revoke truncate, trigger, references on table public.report_drafts from authenticated;
revoke truncate, trigger, references on table public.report_sec013 from authenticated;
revoke truncate, trigger, references on table public.report_sec013_profiling_duties from authenticated;
revoke truncate, trigger, references on table public.report_sec014 from authenticated;
revoke truncate, trigger, references on table public.report_sec014_patrols from authenticated;
revoke truncate, trigger, references on table public.report_sec016 from authenticated;
revoke truncate, trigger, references on table public.report_sec018 from authenticated;
revoke truncate, trigger, references on table public.report_sec018_patrols from authenticated;
revoke truncate, trigger, references on table public.report_sec029 from authenticated;
revoke truncate, trigger, references on table public.report_sec029_items from authenticated;
revoke truncate, trigger, references on table public.report_sec033 from authenticated;
revoke truncate, trigger, references on table public.report_sec033_hold_checks from authenticated;
revoke truncate, trigger, references on table public.role_definitions from authenticated;
revoke truncate, trigger, references on table public.sheet_sync_config from authenticated;
revoke truncate, trigger, references on table public.sheet_sync_queue from authenticated;
revoke truncate, trigger, references on table public.shift_handovers from authenticated;
revoke truncate, trigger, references on table public.shifts from authenticated;
revoke truncate, trigger, references on table public.station_teams from authenticated;
revoke truncate, trigger, references on table public.stations from authenticated;
revoke truncate, trigger, references on table public.team_rosters from authenticated;
revoke truncate, trigger, references on table public.teams from authenticated;
revoke truncate, trigger, references on table public.user_notifications from authenticated;
revoke truncate, trigger, references on table public.user_registration_requests from authenticated;
revoke truncate, trigger, references on table public.v_phase2_backfill_coverage from authenticated;
revoke truncate, trigger, references on table public.v_phase2_unclassified_stations from authenticated;
revoke truncate, trigger, references on table public.v_report_index_classification_gaps from authenticated;
revoke truncate, trigger, references on table public.v_report_index_current_version_mismatch from authenticated;
revoke truncate, trigger, references on table public.v_report_index_queue_health from authenticated;
revoke truncate, trigger, references on table public.wois_audit_log from authenticated;
revoke truncate, trigger, references on table public.wois_conversations from authenticated;
revoke truncate, trigger, references on table public.wois_messages from authenticated;

revoke insert, update, delete on table public.v_phase2_backfill_coverage from authenticated;
revoke insert, update, delete on table public.v_phase2_unclassified_stations from authenticated;
revoke insert, update, delete on table public.v_report_index_classification_gaps from authenticated;
revoke insert, update, delete on table public.v_report_index_current_version_mismatch from authenticated;
revoke insert, update, delete on table public.v_report_index_queue_health from authenticated;

revoke delete on table public.shift_handovers from authenticated;

revoke execute on function public.block_duty_remark_rewrite() from authenticated;
revoke execute on function public.block_settled_overtime_mutation() from authenticated;
revoke execute on function public.block_submitted_child_mutation_offload() from authenticated;
revoke execute on function public.block_submitted_child_mutation_sec013() from authenticated;
revoke execute on function public.block_submitted_child_mutation_sec014() from authenticated;
revoke execute on function public.block_submitted_child_mutation_sec018() from authenticated;
revoke execute on function public.block_submitted_child_mutation_sec029() from authenticated;
revoke execute on function public.block_submitted_child_mutation_sec033() from authenticated;
revoke execute on function public.block_submitted_report_mutation() from authenticated;
revoke execute on function public.enforce_announcement_delete_guard() from authenticated;
revoke execute on function public.enforce_announcement_immutability() from authenticated;
revoke execute on function public.enforce_overtime_transition() from authenticated;
revoke execute on function public.enforce_profile_self_update() from authenticated;
revoke execute on function public.enforce_registration_request_self_write() from authenticated;
revoke execute on function public.enforce_seal_color() from authenticated;
revoke execute on function public.enqueue_sheet_sync() from authenticated;
revoke execute on function public.guard_incident_update() from authenticated;
revoke execute on function public.guard_part_update() from authenticated;
revoke execute on function public.log_audit_admin() from authenticated;
revoke execute on function public.notify_supervisors_on_incident() from authenticated;
revoke execute on function public.set_report_no_offload() from authenticated;
revoke execute on function public.set_report_no_sec013() from authenticated;
revoke execute on function public.set_report_no_sec014() from authenticated;
revoke execute on function public.set_report_no_sec016() from authenticated;
revoke execute on function public.set_report_no_sec018() from authenticated;
revoke execute on function public.set_report_no_sec029() from authenticated;
revoke execute on function public.set_report_no_sec033() from authenticated;
revoke execute on function public.set_updated_at() from authenticated;
revoke execute on function public.set_updated_at_user_registration_requests() from authenticated;
revoke execute on function public.set_vendor_transaction_number() from authenticated;
