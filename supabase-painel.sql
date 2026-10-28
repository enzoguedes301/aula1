-- ============================================================================
-- Tabelas do PAINEL /admin
--
-- Rode isto UMA VEZ no SQL Editor do Supabase:
--   Dashboard -> SQL Editor -> New query -> cole tudo -> Run
--
-- Tudo é IF NOT EXISTS / ADD COLUMN IF NOT EXISTS: rodar de novo não quebra
-- nada e não apaga dado nenhum. A tabela `transactions` já existe e só
-- ganha colunas novas.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. transactions — colunas que o painel precisa e ainda não existiam
-- ---------------------------------------------------------------------------
alter table public.transactions add column if not exists gateway        text;
alter table public.transactions add column if not exists funil          text;
alter table public.transactions add column if not exists attrib         jsonb;
alter table public.transactions add column if not exists net_amount     numeric;
alter table public.transactions add column if not exists acquirer       text;
alter table public.transactions add column if not exists paid_manually  boolean default false;
alter table public.transactions add column if not exists paid_reason    text;
alter table public.transactions add column if not exists checked_at     timestamptz;

create index if not exists transactions_created_at_idx on public.transactions (created_at desc);
create index if not exists transactions_status_idx     on public.transactions (status);

-- ---------------------------------------------------------------------------
-- 2. leads — TUDO que o funil souber da pessoa
--
-- A chave é o CPF: é o identificador que o funil pede primeiro e o único que
-- não muda. Telefone e e-mail a pessoa troca; CPF não. Quem chegar sem CPF
-- ainda assim é gravado (o `lead_key` cai para o telefone).
--
-- `raw` guarda o payload inteiro como veio, incluindo campos que este schema
-- ainda não previu. É a rede de segurança: se amanhã o funil passar a perguntar
-- mais uma coisa, o dado não se perde enquanto a coluna não existe.
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  lead_key     text primary key,           -- CPF (só dígitos) ou, sem CPF, o telefone
  cpf          text,
  name         text,
  email        text,
  phone        text,                       -- só dígitos
  birth_date   text,                       -- como o funil mandou (dd/mm/aaaa)
  mother_name  text,
  age_range    text,
  gender       text,
  -- onde a pessoa está
  cep          text,
  address      text,
  city         text,
  state        text,
  -- de onde ela veio
  origin       text,                       -- nome do funil
  attrib       jsonb,                      -- utm_*, fbclid, gclid, ttclid, fbp, fbc
  first_step   text,                       -- primeira etapa em que apareceu
  last_step    text,                       -- última etapa alcançada
  session      text,                       -- sessão que a identificou
  -- rastro técnico
  ip           text,
  user_agent   text,
  referrer     text,
  landing_url  text,
  -- o payload cru, para nada se perder
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_phone_idx      on public.leads (phone);
create index if not exists leads_cpf_idx        on public.leads (cpf);
create index if not exists leads_email_idx      on public.leads (email);

-- Se a tabela já existia numa versão anterior (só com phone), ganha o resto:
alter table public.leads add column if not exists lead_key    text;
alter table public.leads add column if not exists cpf         text;
alter table public.leads add column if not exists phone       text;
alter table public.leads add column if not exists birth_date  text;
alter table public.leads add column if not exists mother_name text;
alter table public.leads add column if not exists gender      text;
alter table public.leads add column if not exists cep         text;
alter table public.leads add column if not exists address     text;
alter table public.leads add column if not exists city        text;
alter table public.leads add column if not exists state       text;
alter table public.leads add column if not exists first_step  text;
alter table public.leads add column if not exists last_step   text;
alter table public.leads add column if not exists session     text;
alter table public.leads add column if not exists ip          text;
alter table public.leads add column if not exists user_agent  text;
alter table public.leads add column if not exists referrer    text;
alter table public.leads add column if not exists landing_url text;
alter table public.leads add column if not exists raw         jsonb;

-- ---------------------------------------------------------------------------
-- 3. funnel_events — uma linha por (sessão, etapa, dia)
--
-- No Redis original isto era um SET por dia+etapa e a métrica era SCARD
-- (quantas sessões únicas). Aqui a PK composta garante o mesmo: a mesma
-- sessão batendo duas vezes na mesma etapa no mesmo dia não conta duas.
-- ---------------------------------------------------------------------------
create table if not exists public.funnel_events (
  day        date   not null,
  step       text   not null,              -- chegou, quiz, checkout, pix...
  funnel     text   not null default '',   -- nome do funil ('' = padrão)
  session    text   not null,
  ad_id      text,                         -- utm_content (o criativo)
  created_at timestamptz not null default now(),
  primary key (day, step, funnel, session)
);

create index if not exists funnel_events_day_idx    on public.funnel_events (day desc);
create index if not exists funnel_events_ad_idx     on public.funnel_events (ad_id);

-- ---------------------------------------------------------------------------
-- 4. painel_config — chave/valor para as configurações do painel
--
-- Substitui as chaves `config:*` do Redis (taxas, impostos, despesas,
-- notificações, pixels do TikTok). Uma linha por chave, valor em JSON.
-- ---------------------------------------------------------------------------
create table if not exists public.painel_config (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. RLS — estas tabelas só são lidas pelo backend com a service_role key,
--    que ignora RLS. Ligar RLS sem policy = ninguém mais entra pelo anon key.
-- ---------------------------------------------------------------------------
alter table public.leads         enable row level security;
alter table public.funnel_events enable row level security;
alter table public.painel_config enable row level security;
