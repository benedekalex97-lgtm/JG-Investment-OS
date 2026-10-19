import type { Migration } from "../migrate";

/** Additive Google identity and short-lived OAuth transaction storage. Existing customer/user IDs are preserved. */
const sql = `
alter table sessions add column auth_method text not null default 'password' check (auth_method in ('password','google'));
create table oauth_identities (
  issuer text not null,
  subject text not null,
  user_id text not null references users(id),
  created_at timestamptz not null default now(),
  primary key (issuer, subject),
  unique (issuer, user_id)
);
create table oauth_flows (
  token_hash text primary key,
  state text not null,
  nonce text not null,
  code_verifier text not null,
  client_key text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index oauth_flows_expiry_idx on oauth_flows(expires_at);
create index oauth_flows_client_idx on oauth_flows(client_key, created_at);
alter table oauth_identities enable row level security;
alter table oauth_flows enable row level security;
do $$
declare r text;
begin
  foreach r in array array['jg_runtime','jg_runtime_prod'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select, insert on oauth_identities to %I', r);
      execute format('grant select, insert, delete on oauth_flows to %I', r);
      execute format('create policy %I on oauth_identities for all to %I using (true) with check (true)', 'google_' || r, r);
      execute format('create policy %I on oauth_flows for all to %I using (true) with check (true)', 'google_' || r, r);
    end if;
  end loop;
end $$;
`;
export const migration0002: Migration = { id: "0002_google_auth", description: "Google identities, one-use OAuth flows and session authentication method", sql };
