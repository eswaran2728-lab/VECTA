-- Report Number system: AASEC16-YYYYMMDD-NNN style human-readable keys, one per
-- submitted report, assigned server-side so two officers submitting offline on the same
-- shift can never collide. Additive only — no existing column is renamed or removed.

-- ============ Counter table + atomic generator ============

create table if not exists report_counters (
  form_code   text not null,
  report_date date not null,
  last_seq    integer not null default 0,
  primary key (form_code, report_date)
);

alter table report_counters enable row level security;
-- No policies: this table is only ever touched via the SECURITY DEFINER function below,
-- never queried directly by the app.

create or replace function next_report_no(p_form_code text, p_report_date date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
  v_prefix text;
begin
  v_prefix := case upper(p_form_code)
    when 'SEC016' then 'AASEC16'
    when 'SEC014' then 'AASEC14'
    when 'SEC029' then 'AASEC29'
    when 'SEC018' then 'AASEC18'
    when 'SEC033' then 'AASEC33'
    when 'SEC013' then 'AASEC13'
    when 'OFFLOAD' then 'AASECOFL'
    else null
  end;
  if v_prefix is null then
    raise exception 'Unknown form code: %', p_form_code;
  end if;

  -- INSERT ... ON CONFLICT DO UPDATE ... RETURNING row-locks the counter row, so two
  -- concurrent submissions can never receive the same sequence number.
  insert into report_counters (form_code, report_date, last_seq)
  values (upper(p_form_code), p_report_date, 1)
  on conflict (form_code, report_date)
  do update set last_seq = report_counters.last_seq + 1
  returning last_seq into v_seq;

  return v_prefix || '-' || to_char(p_report_date, 'YYYYMMDD') || '-' || lpad(v_seq::text, 3, '0');
end;
$$;

revoke all on function next_report_no(text, date) from public;
grant execute on function next_report_no(text, date) to authenticated;

-- ============ submitted_at defaults were missing on sec033/sec013 ============
-- Same gap migration 0006 fixed for the other four tables — matters here because every
-- report list/export is about to show report_no next to the submission time.

alter table report_sec033 alter column submitted_at set default now();
alter table report_sec013 alter column submitted_at set default now();

alter table report_sec033 disable trigger report_sec033_immutable;
update report_sec033 set submitted_at = created_at where submitted_at is null;
alter table report_sec033 enable trigger report_sec033_immutable;

alter table report_sec013 disable trigger report_sec013_immutable;
update report_sec013 set submitted_at = created_at where submitted_at is null;
alter table report_sec013 enable trigger report_sec013_immutable;

-- ============ report_no column + BEFORE INSERT trigger, one block per table ============
-- Date source differs per table since only sec016 (duty_date) and sec033 (report_date)
-- have an explicit date column; the rest derive it from their own timestamp in MY time,
-- and sec029 (no date/timestamp field of its own) falls back to submitted_at.

alter table report_sec016 add column if not exists report_no text unique;
create or replace function set_report_no_sec016() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.report_no is null or new.report_no = '' then
    new.report_no := next_report_no('SEC016', coalesce(new.duty_date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_set_report_no_sec016 on report_sec016;
create trigger trg_set_report_no_sec016 before insert on report_sec016
  for each row execute function set_report_no_sec016();
create index if not exists idx_sec016_report_no on report_sec016 (report_no);

alter table report_sec014 add column if not exists report_no text unique;
create or replace function set_report_no_sec014() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.report_no is null or new.report_no = '' then
    new.report_no := next_report_no('SEC014', coalesce((new.date_time_in at time zone 'Asia/Kuala_Lumpur')::date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_set_report_no_sec014 on report_sec014;
create trigger trg_set_report_no_sec014 before insert on report_sec014
  for each row execute function set_report_no_sec014();
create index if not exists idx_sec014_report_no on report_sec014 (report_no);

alter table report_sec029 add column if not exists report_no text unique;
create or replace function set_report_no_sec029() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.report_no is null or new.report_no = '' then
    new.report_no := next_report_no('SEC029', coalesce((new.submitted_at at time zone 'Asia/Kuala_Lumpur')::date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_set_report_no_sec029 on report_sec029;
create trigger trg_set_report_no_sec029 before insert on report_sec029
  for each row execute function set_report_no_sec029();
create index if not exists idx_sec029_report_no on report_sec029 (report_no);

alter table report_sec018 add column if not exists report_no text unique;
create or replace function set_report_no_sec018() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.report_no is null or new.report_no = '' then
    new.report_no := next_report_no('SEC018', coalesce((new.date_time at time zone 'Asia/Kuala_Lumpur')::date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_set_report_no_sec018 on report_sec018;
create trigger trg_set_report_no_sec018 before insert on report_sec018
  for each row execute function set_report_no_sec018();
create index if not exists idx_sec018_report_no on report_sec018 (report_no);

alter table report_sec033 add column if not exists report_no text unique;
create or replace function set_report_no_sec033() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.report_no is null or new.report_no = '' then
    new.report_no := next_report_no('SEC033', coalesce(new.report_date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_set_report_no_sec033 on report_sec033;
create trigger trg_set_report_no_sec033 before insert on report_sec033
  for each row execute function set_report_no_sec033();
create index if not exists idx_sec033_report_no on report_sec033 (report_no);

alter table report_sec013 add column if not exists report_no text unique;
create or replace function set_report_no_sec013() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.report_no is null or new.report_no = '' then
    new.report_no := next_report_no('SEC013', coalesce((new.date_time_in at time zone 'Asia/Kuala_Lumpur')::date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_set_report_no_sec013 on report_sec013;
create trigger trg_set_report_no_sec013 before insert on report_sec013
  for each row execute function set_report_no_sec013();
create index if not exists idx_sec013_report_no on report_sec013 (report_no);

-- ============ Backfill existing rows, oldest-first per calendar day ============
-- Immutability triggers must be dropped for the duration of the backfill UPDATE, same
-- pattern migration 0006 already used for submitted_at.

alter table report_sec016 disable trigger report_sec016_immutable;
with numbered as (
  select id, coalesce(duty_date, created_at::date) as d,
         row_number() over (partition by coalesce(duty_date, created_at::date) order by created_at, id) as seq
  from report_sec016 where report_no is null
)
update report_sec016 r set report_no = 'AASEC16-' || to_char(n.d, 'YYYYMMDD') || '-' || lpad(n.seq::text, 3, '0')
from numbered n where r.id = n.id;
alter table report_sec016 enable trigger report_sec016_immutable;

alter table report_sec014 disable trigger report_sec014_immutable;
with numbered as (
  select id, coalesce((date_time_in at time zone 'Asia/Kuala_Lumpur')::date, created_at::date) as d,
         row_number() over (partition by coalesce((date_time_in at time zone 'Asia/Kuala_Lumpur')::date, created_at::date) order by created_at, id) as seq
  from report_sec014 where report_no is null
)
update report_sec014 r set report_no = 'AASEC14-' || to_char(n.d, 'YYYYMMDD') || '-' || lpad(n.seq::text, 3, '0')
from numbered n where r.id = n.id;
alter table report_sec014 enable trigger report_sec014_immutable;

alter table report_sec029 disable trigger report_sec029_immutable;
with numbered as (
  select id, coalesce((submitted_at at time zone 'Asia/Kuala_Lumpur')::date, created_at::date) as d,
         row_number() over (partition by coalesce((submitted_at at time zone 'Asia/Kuala_Lumpur')::date, created_at::date) order by created_at, id) as seq
  from report_sec029 where report_no is null
)
update report_sec029 r set report_no = 'AASEC29-' || to_char(n.d, 'YYYYMMDD') || '-' || lpad(n.seq::text, 3, '0')
from numbered n where r.id = n.id;
alter table report_sec029 enable trigger report_sec029_immutable;

alter table report_sec018 disable trigger report_sec018_immutable;
with numbered as (
  select id, coalesce((date_time at time zone 'Asia/Kuala_Lumpur')::date, created_at::date) as d,
         row_number() over (partition by coalesce((date_time at time zone 'Asia/Kuala_Lumpur')::date, created_at::date) order by created_at, id) as seq
  from report_sec018 where report_no is null
)
update report_sec018 r set report_no = 'AASEC18-' || to_char(n.d, 'YYYYMMDD') || '-' || lpad(n.seq::text, 3, '0')
from numbered n where r.id = n.id;
alter table report_sec018 enable trigger report_sec018_immutable;

alter table report_sec033 disable trigger report_sec033_immutable;
with numbered as (
  select id, coalesce(report_date, created_at::date) as d,
         row_number() over (partition by coalesce(report_date, created_at::date) order by created_at, id) as seq
  from report_sec033 where report_no is null
)
update report_sec033 r set report_no = 'AASEC33-' || to_char(n.d, 'YYYYMMDD') || '-' || lpad(n.seq::text, 3, '0')
from numbered n where r.id = n.id;
alter table report_sec033 enable trigger report_sec033_immutable;

alter table report_sec013 disable trigger report_sec013_immutable;
with numbered as (
  select id, coalesce((date_time_in at time zone 'Asia/Kuala_Lumpur')::date, created_at::date) as d,
         row_number() over (partition by coalesce((date_time_in at time zone 'Asia/Kuala_Lumpur')::date, created_at::date) order by created_at, id) as seq
  from report_sec013 where report_no is null
)
update report_sec013 r set report_no = 'AASEC13-' || to_char(n.d, 'YYYYMMDD') || '-' || lpad(n.seq::text, 3, '0')
from numbered n where r.id = n.id;
alter table report_sec013 enable trigger report_sec013_immutable;

-- ============ Reseed counters so new reports continue from the right number ============

insert into report_counters (form_code, report_date, last_seq)
select 'SEC016', coalesce(duty_date, created_at::date), count(*) from report_sec016 group by 1, 2
on conflict (form_code, report_date) do update set last_seq = greatest(report_counters.last_seq, excluded.last_seq);

insert into report_counters (form_code, report_date, last_seq)
select 'SEC014', coalesce((date_time_in at time zone 'Asia/Kuala_Lumpur')::date, created_at::date), count(*) from report_sec014 group by 1, 2
on conflict (form_code, report_date) do update set last_seq = greatest(report_counters.last_seq, excluded.last_seq);

insert into report_counters (form_code, report_date, last_seq)
select 'SEC029', coalesce((submitted_at at time zone 'Asia/Kuala_Lumpur')::date, created_at::date), count(*) from report_sec029 group by 1, 2
on conflict (form_code, report_date) do update set last_seq = greatest(report_counters.last_seq, excluded.last_seq);

insert into report_counters (form_code, report_date, last_seq)
select 'SEC018', coalesce((date_time at time zone 'Asia/Kuala_Lumpur')::date, created_at::date), count(*) from report_sec018 group by 1, 2
on conflict (form_code, report_date) do update set last_seq = greatest(report_counters.last_seq, excluded.last_seq);

insert into report_counters (form_code, report_date, last_seq)
select 'SEC033', coalesce(report_date, created_at::date), count(*) from report_sec033 group by 1, 2
on conflict (form_code, report_date) do update set last_seq = greatest(report_counters.last_seq, excluded.last_seq);

insert into report_counters (form_code, report_date, last_seq)
select 'SEC013', coalesce((date_time_in at time zone 'Asia/Kuala_Lumpur')::date, created_at::date), count(*) from report_sec013 group by 1, 2
on conflict (form_code, report_date) do update set last_seq = greatest(report_counters.last_seq, excluded.last_seq);
