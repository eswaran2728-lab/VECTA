-- New role model: ASO submits reports; SO, DSE, ENFORCEMENT, ADMIN monitor them.
-- In-place enum renames keep every existing function/policy/index bound to the same
-- type OID. Split into its own migration because Postgres won't let a newly added
-- enum value (ENFORCEMENT) be used in the same transaction it was created in.
alter type user_role rename value 'OFFICER' to 'ASO';
alter type user_role rename value 'SUPERVISOR' to 'SO';
alter type user_role rename value 'MANAGER' to 'DSE';
alter type user_role add value 'ENFORCEMENT';

alter table profiles alter column role set default 'ASO';

create type profile_status as enum ('pending', 'approved', 'rejected');
alter table profiles add column status profile_status not null default 'pending';
update profiles set status = 'approved';
