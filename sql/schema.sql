create table if not exists staff_roster (
  id bigserial primary key,
  division text not null,        -- 'retail' | 'warehouse'
  outlet text not null,
  name text not null,
  pin_hash text not null,
  added_by text,
  created_at timestamptz not null default now(),
  unique (division, outlet, name)
);

create table if not exists manager_pins (
  role text primary key,         -- 'area_manager' | 'outlet_manager' | 'supervisor' | 'resources'
  pin_hash text not null
);

create table if not exists content (
  id bigserial primary key,
  topic text not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists results (
  id bigserial primary key,
  outlet text not null,
  name text not null,
  topic text,
  score numeric,
  percentage numeric,
  created_at timestamptz not null default now()
);

create table if not exists wrong_answers (
  id bigserial primary key,
  outlet text not null,
  name text not null,
  question text,
  chosen text,
  correct text,
  created_at timestamptz not null default now()
);

create table if not exists reports (
  id bigserial primary key,
  outlet text not null,
  staff_name text not null,
  body text,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists ai_results (
  id bigserial primary key,
  outlet text not null,
  name text not null,
  topic text,
  score numeric,
  percentage numeric,
  created_at timestamptz not null default now()
);

create table if not exists ai_wrong_answers (
  id bigserial primary key,
  outlet text not null,
  staff_name text not null,
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

create index if not exists idx_results_outlet_name on results (outlet, name);
create index if not exists idx_ai_results_outlet_name on ai_results (outlet, name);
create index if not exists idx_ai_quizzes_passcode on ai_quizzes (passcode);
