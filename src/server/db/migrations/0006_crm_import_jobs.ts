import type { Migration } from "../migrate";

/**
 * 0006 - ügyféladat-import nyilvántartása (v1.0, CRM-014-016). Kizárólag additív: két új tábla.
 *
 * - `import_jobs`: egy import (előnézet -> véglegesítés) metaadatai. NEM tárol fájlt, fájlnevet, fejlécszöveget vagy sortartalmat:
 *   csak a fájl típusát, méretét és SHA-256 lenyomatát, a deklarált adatforrást és célt, a forrás-ellenőrzés állapotát, a nyilatkozatot,
 *   az oszlop-megfeleltetést (oszlopindexek), a soronkénti besorolási kódokat (pl. V/W/P/S/E) és az összesítő számokat.
 *   Állapot: `previewed` -> `completed` (egyszer; az ismételt véglegesítés a tárolt eredményt adja, nem importál újra).
 * - `import_results`: soronkénti feldolgozási eredmény (létrehozott ügyfél azonosítója vagy a kihagyás oka) személyes adat nélkül.
 * - Jogosultság: `jg_app` SELECT/INSERT/UPDATE (import_jobs) és SELECT/INSERT (import_results); törlés nincs. RLS (FORCE): olvasni csak
 *   import- vagy importnapló-joggal, írni csak import-joggal lehet (`app_has_permission`, 0005).
 */
const sql = `
create table import_jobs (
  id text primary key,
  created_at timestamptz not null default now(),
  created_by text not null references users(id),
  status text not null check (status in ('previewed','completed')),
  file_type text not null check (file_type in ('csv','xlsx')),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size integer not null check (file_size >= 0),
  source_name text not null check (length(btrim(source_name)) > 0),
  purpose text not null check (length(btrim(purpose)) > 0),
  source_verification text not null check (source_verification in ('verified','in_progress','not_verified')),
  compliance_declared boolean not null default false,
  options jsonb not null,
  row_states text not null default '',
  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  warning_rows integer not null default 0,
  error_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  empty_rows integer not null default 0,
  created_count integer,
  skipped_count integer,
  committed_at timestamptz,
  committed_by text references users(id),
  expires_at timestamptz not null,
  constraint import_jobs_commit_chk check ((status = 'completed') = (committed_at is not null and committed_by is not null and created_count is not null and skipped_count is not null))
);
create index import_jobs_created_idx on import_jobs(created_at desc);

create table import_results (
  job_id text not null references import_jobs(id),
  row_no integer not null check (row_no > 0),
  outcome text not null check (outcome in ('created','skipped_user','skipped_error','skipped_duplicate','skipped_changed','skipped_restricted','skipped_empty')),
  customer_id text references customers(id),
  primary key (job_id, row_no),
  constraint import_results_customer_chk check ((outcome = 'created') = (customer_id is not null))
);
create index import_results_customer_idx on import_results(customer_id) where customer_id is not null;

grant select, insert, update on import_jobs to jg_app;
grant select, insert on import_results to jg_app;

do $$
declare t text;
begin
  foreach t in array array['import_jobs','import_results'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy data_access on %I for all to jg_app using (app_has_permission(%L) or app_has_permission(%L)) with check (app_has_permission(%L))',
      t, 'crm.customer.import', 'crm.import.history.read', 'crm.customer.import');
  end loop;
end $$;
`;

export const migration0006: Migration = { id: "0006_crm_import_jobs", description: "Ügyféladat-import nyilvántartása (import_jobs, import_results) személyes adat nélkül", sql };
