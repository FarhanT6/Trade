-- Meme-Coin Trading Intelligence Platform: core data model (spec §15).
-- PostgreSQL 15+. Optional: TimescaleDB for trades/signals, pgvector for embeddings.

create extension if not exists pgcrypto;

create table if not exists tokens (
  mint            text primary key,
  chain           text not null,
  symbol          text not null,
  name            text not null,
  decimals        int  not null default 6,
  total_supply    numeric not null,
  created_at      timestamptz not null,
  launch_type     text not null default 'unknown',
  migrated        boolean not null default false,
  migrated_at     timestamptz,
  deployer        text not null,
  metadata_uri    text,
  inserted_at     timestamptz not null default now()
);
create index if not exists tokens_symbol_idx on tokens (symbol);
create index if not exists tokens_deployer_idx on tokens (deployer);

create table if not exists pools (
  id                 text primary key,
  chain              text not null,
  token_mint         text not null references tokens(mint),
  quote_mint         text not null,
  dex                text not null,
  token_reserve      numeric not null,
  quote_reserve_usd  numeric not null,
  liquidity_usd      numeric not null,
  lp_owner           text,
  lp_locked_pct      numeric not null default 0,
  created_at         timestamptz not null,
  observed_at        timestamptz not null,
  source             text not null,
  confidence         numeric not null default 1
);
create index if not exists pools_token_idx on pools (token_mint);

create table if not exists trades (
  id            text primary key,
  chain         text not null,
  token_mint    text not null,
  pool_id       text not null,
  wallet        text not null,
  side          text not null check (side in ('buy','sell')),
  amount_token  numeric not null,
  amount_usd    numeric not null,
  price_usd     numeric not null,
  fee_usd       numeric not null default 0,
  ts            timestamptz not null,
  tx_signature  text not null,
  program       text
);
create index if not exists trades_token_ts_idx on trades (token_mint, ts desc);
create index if not exists trades_wallet_ts_idx on trades (wallet, ts desc);

create table if not exists transfers (
  id          text primary key,
  chain       text not null,
  from_wallet text not null,
  to_wallet   text not null,
  mint        text not null,
  amount      numeric not null,
  amount_usd  numeric,
  ts          timestamptz not null
);
create index if not exists transfers_to_idx on transfers (to_wallet, ts);
create index if not exists transfers_from_idx on transfers (from_wallet, ts);

create table if not exists wallets (
  address     text primary key,
  chain       text not null,
  labels      text[] not null default '{}',
  first_seen  timestamptz not null,
  reputation  numeric not null default 0.5
);

create table if not exists wallet_clusters (
  id                    text primary key,
  wallets               text[] not null,
  funding_ancestor      text,
  funding_overlap       numeric not null default 0,
  synchronized_entries  int not null default 0,
  synchronized_exits    int not null default 0,
  size_similarity       numeric not null default 0,
  co_occurrence         int not null default 0,
  same_entity_score     numeric not null default 0,
  computed_at           timestamptz not null default now()
);

create table if not exists positions (
  id                 uuid primary key default gen_random_uuid(),
  wallet             text not null,
  token_mint         text not null,
  opened_at          timestamptz not null,
  closed_at          timestamptz,
  entry_price_usd    numeric not null,
  exit_price_usd     numeric,
  size_usd           numeric not null,
  quantity           numeric not null,
  realized_pnl_usd   numeric not null default 0,
  fees_usd           numeric not null default 0,
  hold_ms            bigint,
  size_to_liquidity  numeric,
  entry_latency_ms   bigint,
  token_rugged       boolean not null default false,
  exit_quality       numeric,
  regime             text
);
create index if not exists positions_wallet_idx on positions (wallet, opened_at desc);
create index if not exists positions_token_idx on positions (token_mint, opened_at desc);

create table if not exists trader_profiles (
  wallet                  text not null,
  "window"                text not null,
  computed_at             timestamptz not null,
  realized_pnl_usd        numeric not null,
  unrealized_pnl_usd      numeric not null default 0,
  win_rate                numeric not null,
  profit_factor           numeric not null,
  average_r               numeric not null,
  median_hold_ms          bigint,
  median_entry_latency_ms bigint,
  position_sizing         jsonb not null,
  max_drawdown_pct        numeric not null,
  recovery_time_ms        bigint,
  regime_consistency      jsonb not null,
  category_performance    jsonb not null,
  rug_exposure            numeric not null,
  exit_quality            numeric not null,
  survivability           numeric not null,
  sample_size             int not null,
  risk_adjusted_skill     numeric not null,
  archetype               text not null,
  archetype_confidence    numeric not null,
  primary key (wallet, "window", computed_at)
);
create index if not exists trader_profiles_skill_idx on trader_profiles ("window", computed_at desc, risk_adjusted_skill desc);

create table if not exists leaderboard_snapshots (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,
  "window"     text not null,
  captured_at  timestamptz not null,
  entries      jsonb not null
);
create index if not exists leaderboard_snapshots_idx on leaderboard_snapshots (source, "window", captured_at desc);

create table if not exists social_posts (
  id                  text primary key,
  platform            text not null,
  author_id           text not null,
  author_followers    int not null default 0,
  author_created_at   timestamptz,
  author_high_signal  boolean not null default false,
  text                text not null,
  ts                  timestamptz not null,
  engagement          jsonb not null,
  is_quote            boolean not null default false,
  tickers             text[] not null default '{}',
  contracts           text[] not null default '{}',
  urls                text[] not null default '{}',
  community           text
);
create index if not exists social_posts_ts_idx on social_posts (ts desc);
create index if not exists social_posts_tickers_idx on social_posts using gin (tickers);
create index if not exists social_posts_contracts_idx on social_posts using gin (contracts);

create table if not exists entities (
  id       text primary key,
  kind     text not null check (kind in ('person','project','token','wallet','url','narrative')),
  label    text not null,
  aliases  text[] not null default '{}'
);

create table if not exists narratives (
  id                        text primary key,
  label                     text not null,
  keywords                  text[] not null,
  first_seen                timestamptz not null,
  last_seen                 timestamptz not null,
  token_mints               text[] not null default '{}',
  sentiment                 jsonb not null,
  momentum                  text not null,
  momentum_score            numeric not null,
  authenticity              numeric not null,
  influencer_concentration  numeric not null,
  catalyst                  text,
  computed_at               timestamptz not null default now()
);

create table if not exists narrative_mentions (
  narrative_id  text not null references narratives(id) on delete cascade,
  post_id       text not null,
  entity_id     text,
  ts            timestamptz not null,
  primary key (narrative_id, post_id)
);

create table if not exists risk_events (
  id          uuid primary key default gen_random_uuid(),
  token_mint  text not null,
  ts          timestamptz not null,
  family      text not null,
  severity    text not null,
  code        text not null,
  message     text not null,
  hard_block  boolean not null default false
);
create index if not exists risk_events_token_idx on risk_events (token_mint, ts desc);

create table if not exists signals (
  id             text primary key,
  token_mint     text not null,
  ts             timestamptz not null,
  features       jsonb not null,
  scores         jsonb not null,
  decision       text not null,
  model_version  text not null
);
create index if not exists signals_token_ts_idx on signals (token_mint, ts desc);
create index if not exists signals_ts_idx on signals (ts desc);

create table if not exists alerts (
  id           text primary key,
  kind         text not null,
  token_mint   text not null,
  ts           timestamptz not null,
  rank         numeric not null,
  severity     text not null,
  title        text not null,
  explanation  text not null,
  evidence     jsonb not null
);
create index if not exists alerts_ts_idx on alerts (ts desc);

create table if not exists orders (
  id                text primary key,
  token_mint        text not null,
  side              text not null,
  size_usd          numeric not null,
  status            text not null,
  mode              text not null check (mode in ('paper','live')),
  quote             jsonb,
  filled_price_usd  numeric,
  filled_usd        numeric,
  slippage_pct      numeric,
  reject_reason     text,
  created_at        timestamptz not null
);

create table if not exists execution_events (
  id        text primary key,
  order_id  text not null,
  kind      text not null,
  ts        timestamptz not null,
  detail    jsonb not null
);
create index if not exists execution_events_order_idx on execution_events (order_id, ts);

create table if not exists outcomes (
  signal_id           text primary key references signals(id) on delete cascade,
  token_mint          text not null,
  decision_at         timestamptz not null,
  forward_returns     jsonb not null,
  max_forward_return  numeric not null,
  max_drawdown        numeric not null,
  reached_2x          boolean not null,
  reached_5x          boolean not null,
  rugged              boolean not null,
  time_to_target_ms   bigint,
  realized_pnl_pct    numeric
);

-- Optional TimescaleDB hypertables (no-op when the extension is absent).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'timescaledb') then
    perform create_hypertable('trades', 'ts', if_not_exists => true, migrate_data => true);
    perform create_hypertable('signals', 'ts', if_not_exists => true, migrate_data => true);
  end if;
end $$;
