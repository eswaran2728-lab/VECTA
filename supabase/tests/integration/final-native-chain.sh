cd "C:/Users/eswaranp/Desktop/vecta antigravituy/VECTA/supabase/tests/integration"
timeout -s KILL 900 node run_harness.mjs --native > "$TEMP/out_native_harness.txt" 2>&1
echo "native_harness exit=$? $(grep -E 'scenario blocks' "$TEMP/out_native_harness.txt")"
for f in verify_canonical_compat verify_export_isolation verify_phase7_dashboard_aggregates verify_phase7_entity_and_admin_aggregates verify_phase8_operational_workflows verify_phase8_multi_aoc verify_phase9_caterlink verify_phase10_discussion_board verify_phase11_announcements verify_phase12_wois_ai verify_phase13_integration verify_phase13_storage_and_admin verify_storage_policies verify_profile_state_visibility verify_caterlink_external_accounts verify_caterlink_external_workflows verify_caterlink_receipt_authorization verify_caterlink_scan_authorization verify_caterlink_part_b verify_caterlink_containment verify_entity_report_separation verify_assignment_time_validity verify_role_workspace_support verify_role_workspace_completion print_report_form_matrix verify_concurrency_native verify_phase10_discussion_concurrency_native verify_phase11_announcements_concurrency_native verify_phase8_leave_concurrency_native verify_phase8_duty_draw_concurrency_native verify_phase8_concurrency_round2_native verify_phase9_whitelist_concurrency_native verify_phase9_transaction_creation_concurrency_native verify_report_index_worker_security verify_caterlink_pdf_jobs_concurrency_native verify_caterlink_part_b_concurrency_native verify_caterlink_containment_concurrency_native verify_phase9_legacy_collision_non_regression_native; do
  timeout -s KILL 1200 node $f.mjs > "$TEMP/out_$f.txt" 2>&1
  echo "$f exit=$? pass=$(grep -c '^PASS' $TEMP/out_$f.txt) fail=$(grep -c '^FAIL' $TEMP/out_$f.txt) fatal=$(grep -c 'FATAL' $TEMP/out_$f.txt)"
done
for spec in "verify_leave_atomicity.mjs --native" "verify_registration_throttle.mjs --native" "verify_vendor_signature_authorization.mjs --native" "verify_driver_route_guard.mjs --native" "verify_leave_atomicity_concurrency_native.mjs" "verify_registration_throttle_concurrency_native.mjs" "verify_vendor_signature_concurrency_native.mjs"; do
  timeout -s KILL 1200 node $spec > "$TEMP/out_extra.txt" 2>&1
  echo "$spec exit=$? pass=$(grep -c '^PASS' $TEMP/out_extra.txt) fail=$(grep -c '^FAIL' $TEMP/out_extra.txt) fatal=$(grep -c 'FATAL' $TEMP/out_extra.txt)"
done
echo ALLDONE
