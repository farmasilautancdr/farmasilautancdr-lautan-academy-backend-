create table if not exists staff_roster (
  id bigserial primary key,
  division text not null,        -- 'retail' | 'warehouse'
  outlet text not null,
  name text not null,
  pin_hash text not null,
  id_note text,                  -- matches GAS's IDNote column, disambiguates duplicate names
  added_by text,
  created_at timestamptz not null default now(),
  unique (division, outlet, name)
);

create table if not exists manager_pins (
  role text primary key,         -- 'area_manager' | 'outlet_manager' | 'supervisor' | 'resources'
  pin_hash text not null
);

create table if not exists manager_credentials (
  id bigserial primary key,
  role text not null,            -- 'outlet_manager' | 'warehouse_manager' | 'area_manager'
  scope_key text not null,       -- outlet code (uppercase), or area id for area_manager
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (role, scope_key)
);

create table if not exists content (
  id bigserial primary key,
  topic text not null,
  category text,
  title text not null,
  body text not null,
  link text,
  created_at timestamptz not null default now()
);

-- score/percentage kept as text ("8/10", "80%") — matches GAS's own stored
-- format exactly (Sheets column is free text, not a parsed number).
-- attempt_id mirrors ai_results' column (added later — see migration below
-- for existing databases) so a retaken topic's wrong answers can be scoped
-- to the specific attempt instead of matched by topic alone, which mixed
-- every retake's wrong answers together in Quiz History.
create table if not exists results (
  id bigserial primary key,
  attempt_id text,
  outlet text not null,
  name text not null,
  topic text,
  score text,
  percentage text,
  created_at timestamptz not null default now()
);

create table if not exists wrong_answers (
  id bigserial primary key,
  attempt_id text,
  outlet text not null,
  staff_name text not null,
  topic text,
  question text,
  chosen text,
  correct text,
  created_at timestamptz not null default now()
);

-- Matches the live GAS report form's active fields only — the sheet has
-- 15 columns total, but 5 (Competency Comments, Housebrand Focus, the old
-- numeric Product Knowledge, Communication and Customer Service) haven't
-- been written to since v1.29/v1.34; not carried over since this table
-- starts empty either way (see SCOPE_TRACKER.md — Reports data was never
-- migrated). One report per outlet+staff_name+topic, matches GAS exactly.
create table if not exists reports (
  id bigserial primary key,
  outlet text not null,
  staff_name text not null,
  manager text not null,
  topic text not null,
  quiz_score text,
  skill_level text,
  performance_gaps text,
  recommendations text,
  competency int,
  product_knowledge_comments text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet, staff_name, topic)
);

create table if not exists ai_results (
  id bigserial primary key,
  attempt_id text,
  outlet text not null,
  name text not null,
  topic text,
  score text,
  percentage text,
  passcode text,
  created_at timestamptz not null default now()
);

create table if not exists ai_wrong_answers (
  id bigserial primary key,
  attempt_id text,
  outlet text not null,
  staff_name text not null,
  topic text,
  question text,
  chosen text,
  correct text,
  created_at timestamptz not null default now()
);

create table if not exists ai_quizzes (
  id bigserial primary key,
  outlet text not null unique,   -- one active quiz per outlet, mirrors GAS overwrite behavior
  passcode text not null,
  topic text not null,
  count int not null,
  questions_json jsonb not null,
  created_by text,
  created_at timestamptz not null default now()
);

-- Standard Quiz question bank — matches GAS's Questions sheet exactly
-- (topic, bilingual question/options, 0-indexed correct answer, status).
-- Public read (GET /questions), no auth — matches GAS's doGet() serving
-- this before login. Retail staff only, same as GAS: warehouse never had
-- Standard Quiz, only AI Practice.
--
-- Named standard_questions, not questions — this Supabase project already
-- has an unrelated, unused `questions` table (different shape: topic_id FK,
-- jsonb options, correct_index) left over from an earlier abandoned
-- attempt. Not touched; this table is intentionally separate.
create table if not exists standard_questions (
  id bigserial primary key,
  topic text not null,
  question_en text not null,
  question_ms text not null,
  opt1_en text, opt2_en text, opt3_en text, opt4_en text,
  opt1_ms text, opt2_ms text, opt3_ms text, opt4_ms text,
  correct int not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- Backs middleware/rateLimit.js — login lockout (5 fails/5 min) and the
-- check-endpoint throttle (80 calls/10 min) share this one table, distinct
-- key prefixes ("staff_...", "mgr_...", "check_std_...", "check_ai_...")
-- keep them from colliding. Postgres-backed instead of an in-memory Map so
-- it survives restarts/redeploys and would stay correct if this backend
-- ever ran as more than one instance.
create table if not exists rate_limits (
  key text primary key,
  count int not null default 1,
  expires_at timestamptz not null
);

-- Audit trail for all privileged/admin actions (Master Subsystem E) —
-- superseded master_delete_log (Subsystem C's interim version, migrated
-- and dropped). One row per logged action, written best-effort (fails
-- open for standalone routes, part of the transaction for purge routes).
create table if not exists audit_log (
  id bigserial primary key,
  actor_type text not null,        -- 'master' | 'outlet_manager' | 'warehouse_manager' | 'area_manager' | 'supervisor'
  actor_key text not null,         -- master username | outlet code | area id | 'ALL'
  action text not null,            -- e.g. 'staff.add', 'content.delete', 'purge.staff', 'master.login'
  summary text not null,
  affected_count integer,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_at_idx on audit_log (created_at desc);

-- Generic key-value settings table. First user: Master Subsystem D's
-- maintenance kill-switch (key='maintenance', value={enabled,message}).
-- Reusable by future subsystems without another migration.
create table if not exists system_settings (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- Master Subsystem G: one row per staff/manager login (never Master's own
-- tokens — those stay untracked/stateless by design). Note: this Supabase
-- project's `auth` schema already has its own unrelated `sessions` table
-- (Supabase Auth internals) — always qualify with table_schema='public' if
-- ever inspecting via information_schema, or the two will double-match.
create table if not exists sessions (
  id bigserial primary key,
  scope_type text not null,
  scope_key text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  impersonated_by text,
  ip text,
  user_agent text
);
create index if not exists sessions_active_idx on sessions (revoked_at, expires_at);
create index if not exists sessions_scope_idx on sessions (scope_type, scope_key);

create index if not exists idx_results_outlet_name on results (outlet, name);
create index if not exists idx_ai_results_outlet_name on ai_results (outlet, name);
create index if not exists idx_ai_quizzes_passcode on ai_quizzes (passcode);
create index if not exists idx_standard_questions_topic on standard_questions (topic);
create index if not exists idx_rate_limits_expires_at on rate_limits (expires_at);

-- Outlet/Area Management. Replaces the hardcoded AREAS/OUTLET_LIST/
-- WAREHOUSE_LOCATIONS arrays previously duplicated across this backend's
-- config/areas.js and 10+ frontend files — Master edits these from the
-- Control Panel now instead of a code change + redeploy. Soft-delete only
-- (active boolean); store_outlets.code has no rename endpoint since staff_roster/
-- results/reports/etc. all reference it by free text. Named store_outlets,
-- not outlets — this Supabase project already has an unrelated `outlets`
-- table (dependent staff/quizzes/attempts/manager_reviews tables belonging
-- to a different app, none matching this file's own schema) sharing the
-- same DB. Not touched, same reasoning as standard_questions above. See
-- docs/superpowers/specs/2026-08-11-outlet-management-design.md.
create table if not exists areas (
  id text primary key,
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists store_outlets (
  code text primary key,
  division text not null,        -- 'retail' | 'warehouse'
  area_id text references areas(id),  -- null for warehouse
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists store_outlets_area_idx on store_outlets (area_id);

-- Video Training. Separate from standard_questions/Module Quiz by design —
-- same choice as store_outlets vs the unrelated pre-existing `outlets`
-- table: two topic-grouped question banks that must never accidentally
-- mix. video_trainings.topic is matched by plain text against
-- video_questions.topic, same loose-coupling convention standard_questions
-- already uses with Module Quiz — no foreign key. See
-- docs/superpowers/specs/2026-08-12-video-training-design.md.
create table if not exists video_trainings (
  id bigserial primary key,
  title text not null,
  topic text not null,
  youtube_url text not null,
  created_at timestamptz not null default now()
);

create table if not exists video_questions (
  id bigserial primary key,
  topic text not null,
  question_en text not null,
  question_ms text not null,
  opt1_en text, opt2_en text, opt3_en text, opt4_en text,
  opt1_ms text, opt2_ms text, opt3_ms text, opt4_ms text,
  correct int not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);
create index if not exists idx_video_questions_topic on video_questions (topic);

-- CPD Hours Tracking (120hr/year target). Supervisor sets this manually
-- per video when adding it (not derived from the real YouTube duration —
-- see docs/superpowers/specs/2026-08-12-cpd-hours-design.md). Hours-this-
-- year is always computed on read (join results -> video_trainings by
-- topic, filtered to the current calendar year) — no separate ledger
-- table. Module Quiz and AI Practice also count toward the target at a
-- flat rate — see docs/superpowers/specs/2026-08-13-cpd-hours-revision-design.md.
alter table video_trainings add column if not exists hours numeric not null default 1;
