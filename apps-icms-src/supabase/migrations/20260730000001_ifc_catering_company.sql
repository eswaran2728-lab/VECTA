-- Seed the airline's own in-house catering company so Part A defaults to it
-- instead of "Not specified".
insert into public.catering_companies (name, code)
values ('Inflight Catering (IFC)', 'IFC')
on conflict (code) do nothing;
