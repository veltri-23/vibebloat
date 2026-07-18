create table onboarding_events (
  id bigint generated always as identity primary key,
  schema_version text not null check (schema_version = 'v1'),
  gate text not null check (gate ~ '^([A-O]|F1b)$'),
  choice text not null check (choice in ('a', 'b', 'c', 'd', 'e')),
  received_at timestamptz not null
);

create table return_sessions (
  id bigint generated always as identity primary key,
  schema_version text not null check (schema_version = 'v1'),
  action text not null check (action in ('review', 'tune', 'reject', 'other')),
  received_at timestamptz not null
);

create table incidents (
  id bigint generated always as identity primary key,
  schema_version text not null check (schema_version = 'v1'),
  class text not null check (class in ('A', 'B', 'C', 'D')),
  guard_id text not null check (guard_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(guard_id) <= 80),
  pattern text not null check (length(pattern) between 1 and 256),
  received_at timestamptz not null
);

create table telemetry (
  id bigint generated always as identity primary key,
  schema_version text not null check (schema_version = 'v1'),
  metric text not null check (metric in ('guard-fired', 'doctor-health')),
  guard_id text check (guard_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(guard_id) <= 80),
  agent text check (agent in ('claude-code', 'codex', 'hermes', 'openclaw', 'shell')),
  status text check (status in ('healthy', 'degraded')),
  received_at timestamptz not null,
  check (
    (metric = 'guard-fired' and guard_id is not null and agent is not null and status is null)
    or (metric = 'doctor-health' and guard_id is null and agent is null and status is not null)
  )
);

alter table onboarding_events enable row level security;
alter table return_sessions enable row level security;
alter table incidents enable row level security;
alter table telemetry enable row level security;

revoke all on onboarding_events, return_sessions, incidents, telemetry from anon, authenticated;
grant insert on onboarding_events, return_sessions, incidents, telemetry to service_role;
grant usage on sequence onboarding_events_id_seq, return_sessions_id_seq, incidents_id_seq, telemetry_id_seq to service_role;
