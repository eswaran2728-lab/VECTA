-- submitted_at had no default, so every report insert left it null. This silently broke
-- the admin notification email (buildReportEmailHtml tries to format submittedAt and
-- throws on null) and would also break any future display/export of submission time.
alter table report_sec016 alter column submitted_at set default now();
alter table report_sec014 alter column submitted_at set default now();
alter table report_sec029 alter column submitted_at set default now();
alter table report_sec018 alter column submitted_at set default now();

alter table report_sec016 disable trigger report_sec016_immutable;
update report_sec016 set submitted_at = created_at where submitted_at is null;
alter table report_sec016 enable trigger report_sec016_immutable;

alter table report_sec014 disable trigger report_sec014_immutable;
update report_sec014 set submitted_at = created_at where submitted_at is null;
alter table report_sec014 enable trigger report_sec014_immutable;

alter table report_sec029 disable trigger report_sec029_immutable;
update report_sec029 set submitted_at = created_at where submitted_at is null;
alter table report_sec029 enable trigger report_sec029_immutable;

alter table report_sec018 disable trigger report_sec018_immutable;
update report_sec018 set submitted_at = created_at where submitted_at is null;
alter table report_sec018 enable trigger report_sec018_immutable;
