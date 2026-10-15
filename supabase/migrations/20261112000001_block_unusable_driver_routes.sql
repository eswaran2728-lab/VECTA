-- A CaterLink Driver cannot create a movement whose route cannot complete (additive).
--
-- Only the HUB route has a complete workflow today (Part B, then the destination receipt). AIRCRAFT, REDQ, MAINTENANCE and INBOUND
-- movements need Part C / Part D / REDQ, which have no recording workflow until the process owner answers
-- docs/dashboard-review/part-c-owner-questions.md. The creation form and server action already refuse them; this trigger makes the
-- database refuse them too, so a direct call to create_caterlink_driver_transaction_secure() (or any insert made as a Driver) cannot
-- produce a movement that can never finish. It applies only to an active external Driver (caterlink_external_role() = 'warehouse_pic');
-- station officers, CaterLink Management and service-role fixtures are unaffected.
create or replace function public.enforce_completable_driver_route()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if public.caterlink_external_role() = 'warehouse_pic'
     and not (
       new.direction = 'OUTBOUND'
       and new.route = 'HUB'
       -- a HUB movement can only finish at a named receiving hub (the table check restricts it to the known hubs; NILAI, for
       -- example, has no station row of its own): the hub destination must be present, and a destination station id, when
       -- given, must be that same ACTIVE station (the rule the destination receipt enforces through caterlink_expected_receiving_station)
       and nullif(btrim(coalesce(new.hub_destination, '')), '') is not null
       and (new.destination_station_id is null
            or exists (select 1 from public.org_stations s where s.id = new.destination_station_id and s.code = new.hub_destination and s.is_active))
     ) then
    raise exception 'This movement type is not available yet.';
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_completable_driver_route() from public, anon, authenticated;

drop trigger if exists trg_enforce_completable_driver_route on public.transactions;
create trigger trg_enforce_completable_driver_route
  before insert on public.transactions
  for each row execute function public.enforce_completable_driver_route();
