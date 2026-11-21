-- =====================================================================
--  🐾 ANIMAL CARDS — Schéma Supabase complet
--  À coller dans Supabase > SQL Editor, puis exécuter (Run).
--  Ensuite, exécuter supabase/seed.sql (catalogue des cartes).
--
--  Principe : le client n'écrit JAMAIS directement dans les tables.
--  Toutes les actions passent par des fonctions SECURITY DEFINER
--  transactionnelles (verrous FOR UPDATE). Le client lit seulement
--  ce que la RLS lui permet de lire.
--  Le script est ré-exécutable (idempotent) pour les mises à jour.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CONFIGURATION DU JEU (équilibrage modifiable ici, voir ECONOMIE.md)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id      smallint primary key default 1 check (id = 1),
  shop_refresh_seconds  integer not null default 300,   -- 5 minutes
  shop_slots            smallint not null default 6,
  cards_per_pack        smallint not null default 5,
  start_balance  bigint  not null default 1500,
  starter_cards  smallint not null default 3,
  offline_cap_hours     integer not null default 8,     -- plafond de cumul des revenus passifs
  market_fee_pct        integer not null default 5,     -- taxe prélevée sur chaque vente (puits monétaire)
  min_bid_increment_pct integer not null default 5,
  anti_snipe_seconds    integer not null default 30,
  max_active_listings   integer not null default 20,
  max_open_trades       integer not null default 20,
  max_cards      integer not null default 5000,
  max_price      bigint  not null default 100000000
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.rarities (
  id  smallint primary key check (id between 0 and 6),
  code       text not null unique,
  name       text not null,
  color      text not null,
  card_value        integer not null check (card_value > 0),       -- valeur de référence d'une carte
  income_per_hour   integer not null check (income_per_hour >= 0), -- revenu passif par carte possédée
  discovery_reward  integer not null check (discovery_reward >= 0),-- pièces à la 1re obtention
  luck_bonus numeric(8,4) not null check (luck_bonus >= 0), -- % de chance permanent à la découverte
  booster_price     integer not null check (booster_price > 0),    -- prix de base du booster
  shop_weight       numeric(8,3) not null check (shop_weight >= 0),-- poids d'apparition en boutique
  pack_weights      numeric[] not null check (array_length(pack_weights, 1) = 7)
);

insert into public.rarities values
 (0,'common',   'Commun',     '#9fb3a8',    10,   4,    5, 0.001,   120, 50.0, '{70,22,6,1.6,0.35,0.045,0.005}'),
 (1,'uncommon', 'Peu commun', '#4fd18b',    30,   8,   15, 0.005,   300, 25.0, '{40,40,15,4,0.85,0.13,0.02}'),
 (2,'rare',     'Rare',       '#4aa8ff',   100,  20,   50, 0.025,   800, 13.0, '{20,32,35,10,2.5,0.45,0.05}'),
 (3,'epic',     'Épique',     '#a77bff',   400,  50,  150, 0.120,  2400,  7.0, '{8,20,32,30,8,1.8,0.2}'),
 (4,'legendary','Légendaire', '#ffc247',  1500, 120,  500, 0.600,  7500,  3.5, '{3,10,22,35,24,5.5,0.5}'),
 (5,'mythic',   'Mythique',   '#ff5fa2',  6000, 300, 2000, 1.800, 22000,  1.2, '{0,4,14,30,32,18,2}'),
 (6,'secret',   'Secret',     '#5ff5e0', 25000, 800, 8000, 5.000, 70000,  0.3, '{0,0,6,16,32,34,12}')
on conflict (id) do update set
  code = excluded.code, name = excluded.name, color = excluded.color,
  card_value = excluded.card_value, income_per_hour = excluded.income_per_hour,
  discovery_reward = excluded.discovery_reward, luck_bonus = excluded.luck_bonus,
  booster_price = excluded.booster_price, shop_weight = excluded.shop_weight,
  pack_weights = excluded.pack_weights;

create table if not exists public.cards (
  id       text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  number          integer not null unique,
  name            text not null,
  scientific_name text not null,
  category        text not null check (category in ('mammal','bird','reptile','amphibian','fish','marine','insect','extinct')),
  habitat  text not null,
  emoji           text not null,
  rarity          smallint not null references public.rarities(id),
  value    integer not null check (value > 0)
);
create index if not exists cards_rarity_idx on public.cards(rarity);

-- ---------------------------------------------------------------------
-- 2. DONNÉES DES JOUEURS
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id     uuid primary key references auth.users(id) on delete cascade,
  username      text not null check (username ~ '^[A-Za-z0-9_-]{3,20}$'),
  balance       bigint not null default 0 check (balance >= 0 and balance <= 1000000000000),
  luck          numeric(10,4) not null default 0 check (luck >= 0),
  income_pending       numeric(20,4) not null default 0 check (income_pending >= 0),
  income_updated_at    timestamptz not null default now(),
  shop_next_refresh_at timestamptz not null default now(),
  shop_generation      integer not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on public.profiles (lower(username));

-- Chaque carte possédée est une instance unique avec un seul propriétaire.
create table if not exists public.card_instances (
  id          uuid primary key default gen_random_uuid(),
  card_id     text not null references public.cards(id),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  lock_kind   text check (lock_kind in ('listing','trade')),
  lock_id     uuid,
  origin      text not null check (origin in ('starter','booster','market','auction','trade')),
  acquired_at timestamptz not null default now(),
  check ((lock_kind is null) = (lock_id is null))
);
create index if not exists card_instances_owner_idx on public.card_instances(owner_id, card_id);
create unique index if not exists card_instances_lock_uidx on public.card_instances(lock_id) where lock_id is not null;

create table if not exists public.discoveries (
  player_id     uuid not null references public.profiles(id) on delete cascade,
  card_id       text not null references public.cards(id),
  luck_gained   numeric(8,4) not null,
  reward        integer not null,
  discovered_at timestamptz not null default now(),
  primary key (player_id, card_id)
);

create table if not exists public.shop_offers (
  player_id  uuid not null references public.profiles(id) on delete cascade,
  slot       smallint not null check (slot between 0 and 11),
  generation integer not null,
  tier       smallint not null references public.rarities(id),
  price      integer not null check (price > 0),
  stock      integer check (stock is null or stock >= 0),      -- null = stock illimité
  primary key (player_id, slot)
);

create table if not exists public.pack_openings (
  id  uuid primary key default gen_random_uuid(),
  player_id  uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null,
  tier       smallint not null references public.rarities(id),
  price      integer not null,
  result     jsonb not null,
  created_at timestamptz not null default now(),
  unique (player_id, request_id)
);

create table if not exists public.listings (
  id   uuid primary key default gen_random_uuid(),
  seller_id   uuid not null references public.profiles(id) on delete cascade,
  seller_name text not null,
  instance_id uuid not null references public.card_instances(id) on delete cascade,
  card_id     text not null references public.cards(id),
  kind        text not null check (kind in ('fixed','auction')),
  price       bigint not null check (price > 0),-- prix fixe ou mise de départ
  current_bid bigint check (current_bid > 0),   -- montant en séquestre
  bidder_id   uuid references public.profiles(id) on delete set null,
  bidder_name text,
  bid_count   integer not null default 0,
  status      text not null default 'active' check (status in ('active','sold','cancelled','expired')),
  buyer_id    uuid references public.profiles(id) on delete set null,
  buyer_name  text,
  final_price bigint,
  ends_at     timestamptz not null,
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create unique index if not exists listings_active_instance_uidx on public.listings(instance_id) where status = 'active';
create index if not exists listings_status_ends_idx on public.listings(status, ends_at);
create index if not exists listings_status_closed_idx on public.listings(status, closed_at desc);

create table if not exists public.trades (
  id     uuid primary key default gen_random_uuid(),
  creator_id           uuid not null references public.profiles(id) on delete cascade,
  creator_name  text not null,
  offered_instance_id  uuid not null references public.card_instances(id) on delete cascade,
  offered_card_id      text not null references public.cards(id),
  wanted_card_id       text not null references public.cards(id),
  status        text not null default 'open' check (status in ('open','accepted','cancelled')),
  acceptor_id   uuid references public.profiles(id) on delete set null,
  acceptor_name        text,
  received_instance_id uuid references public.card_instances(id) on delete set null,
  created_at    timestamptz not null default now(),
  closed_at            timestamptz
);
create unique index if not exists trades_open_instance_uidx on public.trades(offered_instance_id) where status = 'open';
create index if not exists trades_status_idx on public.trades(status, created_at desc);

create table if not exists public.rate_limits (
  player_id    uuid not null references public.profiles(id) on delete cascade,
  bucket       text not null,
  window_start timestamptz not null,
  hits  integer not null,
  primary key (player_id, bucket)
);

-- ---------------------------------------------------------------------
-- 3. SÉCURITÉ : RLS + droits (lecture seule et limitée pour les clients)
-- ---------------------------------------------------------------------
alter table public.settings       enable row level security;
alter table public.rarities       enable row level security;
alter table public.cards   enable row level security;
alter table public.profiles enable row level security;
alter table public.card_instances enable row level security;
alter table public.discoveries    enable row level security;
alter table public.shop_offers    enable row level security;
alter table public.pack_openings  enable row level security;
alter table public.listings       enable row level security;
alter table public.trades  enable row level security;
alter table public.rate_limits    enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.settings, public.rarities, public.cards to anon, authenticated;
grant select on public.card_instances, public.discoveries, public.shop_offers,
         public.pack_openings, public.listings, public.trades to authenticated;
-- Profils : seules les colonnes publiques sont lisibles (le solde passe par get_state()).
grant select (id, username, luck, created_at) on public.profiles to authenticated;

drop policy if exists "lecture publique" on public.settings;
create policy "lecture publique" on public.settings for select using (true);
drop policy if exists "lecture publique" on public.rarities;
create policy "lecture publique" on public.rarities for select using (true);
drop policy if exists "lecture publique" on public.cards;
create policy "lecture publique" on public.cards for select using (true);
drop policy if exists "pseudos visibles" on public.profiles;
create policy "pseudos visibles" on public.profiles for select to authenticated using (true);
drop policy if exists "mes cartes" on public.card_instances;
create policy "mes cartes" on public.card_instances for select to authenticated using (owner_id = auth.uid());
drop policy if exists "mes découvertes" on public.discoveries;
create policy "mes découvertes" on public.discoveries for select to authenticated using (player_id = auth.uid());
drop policy if exists "ma boutique" on public.shop_offers;
create policy "ma boutique" on public.shop_offers for select to authenticated using (player_id = auth.uid());
drop policy if exists "mes ouvertures" on public.pack_openings;
create policy "mes ouvertures" on public.pack_openings for select to authenticated using (player_id = auth.uid());
drop policy if exists "marché public" on public.listings;
create policy "marché public" on public.listings for select to authenticated using (true);
drop policy if exists "échanges publics" on public.trades;
create policy "échanges publics" on public.trades for select to authenticated using (true);
-- rate_limits : aucune politique => aucun accès client.
-- Aucune politique INSERT/UPDATE/DELETE n'existe : toute écriture directe est refusée.

-- ---------------------------------------------------------------------
-- 4. FONCTIONS INTERNES (non exécutables par les clients)
-- ---------------------------------------------------------------------
create or replace function public._uid() returns uuid
language plpgsql stable set search_path = public as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'Connexion requise.'; end if;
  return v;
end $$;

create or replace function public._cfg() returns public.settings
language sql stable set search_path = public as $$ select * from public.settings where id = 1 $$;

create or replace function public._rate_limit(p_uid uuid, p_bucket text, p_max int, p_seconds int)
returns void language plpgsql security definer set search_path = public as $$
declare v_hits int;
begin
  insert into rate_limits as r (player_id, bucket, window_start, hits)
  values (p_uid, p_bucket, now(), 1)
  on conflict (player_id, bucket) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_seconds) then now() else r.window_start end
  returning hits into v_hits;
  if v_hits > p_max then
    raise exception 'Trop d''actions rapprochées. Patiente quelques secondes.';
  end if;
end $$;

-- Verrouille le profil de l'appelant (sérialise toutes ses actions).
create or replace function public._lock_profile(p_uid uuid) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  select * into p from profiles where id = p_uid for update;
  if not found then raise exception 'Crée d''abord ton profil de collectionneur.'; end if;
  return p;
end $$;

-- Verrouille deux profils toujours dans le même ordre (évite les interblocages).
create or replace function public._lock_two(p_a uuid, p_b uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from profiles where id in (p_a, p_b) order by id for update;
end $$;

create or replace function public._income_rate(p_uid uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(r.income_per_hour), 0)::bigint
  from card_instances i join cards c on c.id = i.card_id join rarities r on r.id = c.rarity
  where i.owner_id = p_uid
$$;

-- Accumule les revenus passifs depuis la dernière mise à jour (profil verrouillé).
-- Le temps compté est plafonné à offline_cap_hours, et le total en attente
-- ne dépasse pas offline_cap_hours heures de revenu.
create or replace function public._settle_income(p_uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p public.profiles; v_rate bigint; v_cap numeric; v_elapsed numeric;
begin
  select * into p from profiles where id = p_uid;
  v_rate := _income_rate(p_uid);
  v_cap := (_cfg()).offline_cap_hours;
  v_elapsed := least(greatest(extract(epoch from now() - p.income_updated_at), 0), v_cap * 3600);
  update profiles set
    income_pending = least(p.income_pending + v_rate * v_elapsed / 3600.0,
      greatest(p.income_pending, v_rate * v_cap)),
    income_updated_at = now()
  where id = p_uid;
end $$;

create or replace function public._add_money(p_uid uuid, p_amount bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  update profiles set balance = least(balance + p_amount, 1000000000000) where id = p_uid;
end $$;

-- Enregistre une découverte (1re obtention) : bonus de chance + récompense.
create or replace function public._discover(p_uid uuid, p_card text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rarities; v_new boolean;
begin
  select rr.* into r from cards c join rarities rr on rr.id = c.rarity where c.id = p_card;
  insert into discoveries (player_id, card_id, luck_gained, reward)
  values (p_uid, p_card, r.luck_bonus, r.discovery_reward)
  on conflict do nothing;
  get diagnostics v_new = row_count;
  if v_new then
    update profiles set luck = luck + r.luck_bonus,
   balance = least(balance + r.discovery_reward, 1000000000000)
    where id = p_uid;
    return jsonb_build_object('is_new', true, 'luck_gained', r.luck_bonus, 'reward', r.discovery_reward);
  end if;
  return jsonb_build_object('is_new', false, 'luck_gained', 0, 'reward', 0);
end $$;

create or replace function public._grant_card(p_uid uuid, p_card text, p_origin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into card_instances (card_id, owner_id, origin) values (p_card, p_uid, p_origin) returning id into v_id;
  return jsonb_build_object('instance_id', v_id, 'card_id', p_card) || _discover(p_uid, p_card);
end $$;

-- Tirage pondéré : renvoie l'indice (0..n-1) choisi.
create or replace function public._pick(p_weights numeric[]) returns int
language plpgsql volatile set search_path = public as $$
declare v_total numeric := 0; v_roll numeric; i int;
begin
  for i in 1..array_length(p_weights, 1) loop v_total := v_total + greatest(p_weights[i], 0); end loop;
  if v_total <= 0 then raise exception 'Table de probabilités invalide.'; end if;
  v_roll := random() * v_total;
  for i in 1..array_length(p_weights, 1) loop
    v_roll := v_roll - greatest(p_weights[i], 0);
    if v_roll < 0 then return i - 1; end if;
  end loop;
  return array_length(p_weights, 1) - 1;
end $$;

-- Formule de chance (documentée dans ECONOMIE.md) :
--   poids_ajusté(rareté r) = poids_base(r) × (1 + chance/100) ^ (r / diviseur)
--   diviseur = 2 pour la boutique, 3 pour le contenu des boosters.
create or replace function public._luck_weights(p_base numeric[], p_luck numeric, p_divisor numeric)
returns numeric[] language sql immutable set search_path = public as $$
  select array_agg(w * power(1 + least(p_luck, 100) / 100.0, (ord - 1) / p_divisor) order by ord)
  from unnest(p_base) with ordinality as t(w, ord)
$$;

create or replace function public._shop_probabilities(p_luck numeric) returns numeric[]
language sql stable set search_path = public as $$
  with w as (select _luck_weights((select array_agg(shop_weight order by id) from rarities), p_luck, 2) as a)
  select array_agg(x / (select sum(y) from unnest(w.a) y) order by ord)
  from w, unnest(w.a) with ordinality as t(x, ord)
$$;

-- Régénère la boutique si l'échéance est passée (profil verrouillé).
-- Fonctionne même après une longue absence : régénération à la demande.
create or replace function public._refresh_shop_if_due(p_uid uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  p public.profiles; cfg public.settings := _cfg(); v_weights numeric[];
  v_slot int; v_tier int; r public.rarities; v_stock int;
begin
  select * into p from profiles where id = p_uid;
  if now() < p.shop_next_refresh_at then return false; end if;
  v_weights := _luck_weights((select array_agg(shop_weight order by id) from rarities), p.luck, 2);
  delete from shop_offers where player_id = p_uid;
  for v_slot in 0..cfg.shop_slots - 1 loop
    v_tier := case when v_slot = 0 then 0 else _pick(v_weights) end;  -- 1er emplacement toujours abordable
    select * into r from rarities where id = v_tier;
    v_stock := case v_tier
      when 0 then case when random() < 0.6 then null else 8 + floor(random() * 8)::int end
      when 1 then case when random() < 0.3 then null else 3 + floor(random() * 6)::int end
      when 2 then 2 + floor(random() * 4)::int
      when 3 then 1 + floor(random() * 3)::int
      when 4 then 1 + floor(random() * 2)::int
      else 1 end;
    insert into shop_offers (player_id, slot, generation, tier, price, stock)
    values (p_uid, v_slot, p.shop_generation + 1, v_tier,
     greatest(1, round(r.booster_price * (0.85 + random() * 0.35))::int), v_stock);
  end loop;
  update profiles set shop_generation = shop_generation + 1,
        shop_next_refresh_at = now() + make_interval(secs => cfg.shop_refresh_seconds)
  where id = p_uid;
  return true;
end $$;

-- Clôture une annonce expirée (enchère ou prix fixe). Annonce verrouillée par l'appelant.
create or replace function public._close_listing(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l public.listings; v_fee bigint;
begin
  select * into l from listings where id = p_id;
  if l.status <> 'active' or l.ends_at > now() then return; end if;
  if l.kind = 'auction' and l.bidder_id is not null then
    perform _lock_two(l.seller_id, l.bidder_id);
    perform _settle_income(l.seller_id);
    perform _settle_income(l.bidder_id);
    v_fee := floor(l.current_bid * (_cfg()).market_fee_pct / 100.0);
    perform _add_money(l.seller_id, l.current_bid - v_fee);   -- l'argent était déjà en séquestre
    update card_instances set owner_id = l.bidder_id, lock_kind = null, lock_id = null,
         origin = 'auction', acquired_at = now()
    where id = l.instance_id;
    perform _discover(l.bidder_id, l.card_id);
    update listings set status = 'sold', buyer_id = l.bidder_id, buyer_name = l.bidder_name,
          final_price = l.current_bid, closed_at = now()
    where id = p_id;
  else
    update card_instances set lock_kind = null, lock_id = null where id = l.instance_id and lock_id = p_id;
    update listings set status = 'expired', closed_at = now() where id = p_id;
  end if;
end $$;

-- Résout toutes les annonces arrivées à échéance (appelée par pg_cron chaque
-- minute ET à la demande par get_state / refresh_market).
create or replace function public.settle_due_listings(p_limit int default 200) returns int
language plpgsql security definer set search_path = public as $$
declare v_id uuid; n int := 0;
begin
  for v_id in
    select id from listings where status = 'active' and ends_at <= now()
    order by ends_at limit p_limit for update skip locked
  loop
    perform _close_listing(v_id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 5. FONCTIONS RPC APPELÉES PAR LE CLIENT
-- ---------------------------------------------------------------------

-- Création du profil (pseudo unique) + cartes de départ.
create or replace function public.create_profile(p_username text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _uid(); cfg public.settings := _cfg(); v_card text; i int;
begin
  if exists (select 1 from profiles where id = v_uid) then
    return jsonb_build_object('created', false);
  end if;
  p_username := trim(coalesce(p_username, ''));
  if p_username !~ '^[A-Za-z0-9_-]{3,20}$' then
    raise exception 'Le pseudo doit faire 3 à 20 caractères : lettres sans accent, chiffres, - ou _.';
  end if;
  if exists (select 1 from profiles where lower(username) = lower(p_username)) then
    raise exception 'Ce pseudo est déjà pris.';
  end if;
  begin
    insert into profiles (id, username, balance) values (v_uid, p_username, cfg.start_balance);
  exception when unique_violation then
    raise exception 'Ce pseudo est déjà pris.';
  end;
  for i in 1..cfg.starter_cards loop
    select id into v_card from cards where rarity = 0 order by random() limit 1;
    perform _grant_card(v_uid, v_card, 'starter');
  end loop;
  perform _refresh_shop_if_due(v_uid);
  return jsonb_build_object('created', true);
end $$;

-- État complet du joueur : solde, revenus, chance, boutique (régénérée si besoin).
create or replace function public.get_state() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _uid(); p public.profiles; v_rate bigint;
begin
  if not exists (select 1 from profiles where id = v_uid) then
    return jsonb_build_object('profile', null, 'server_now', now());
  end if;
  perform settle_due_listings(50);
  perform _lock_profile(v_uid);
  perform _settle_income(v_uid);
  perform _refresh_shop_if_due(v_uid);
  select * into p from profiles where id = v_uid;
  v_rate := _income_rate(v_uid);
  return jsonb_build_object(
    'server_now', now(),
    'profile', jsonb_build_object(
      'id', p.id, 'username', p.username, 'balance', p.balance, 'luck', p.luck,
      'income_pending', floor(p.income_pending), 'income_per_hour', v_rate,
      'income_cap', v_rate * (_cfg()).offline_cap_hours,
      'shop_next_refresh_at', p.shop_next_refresh_at,
      'card_count', (select count(*) from card_instances where owner_id = v_uid),
      'discovered', (select count(*) from discoveries where player_id = v_uid)),
    'shop_probabilities', to_jsonb(_shop_probabilities(p.luck)),
    'shop', coalesce((select jsonb_agg(jsonb_build_object('slot', slot, 'tier', tier, 'price', price, 'stock', stock) order by slot)
 from shop_offers where player_id = v_uid), '[]'::jsonb));
end $$;

create or replace function public.claim_income() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _uid(); v_amount bigint;
begin
  perform _rate_limit(v_uid, 'claim', 10, 60);
  perform _lock_profile(v_uid);
  perform _settle_income(v_uid);
  select floor(income_pending) into v_amount from profiles where id = v_uid;
  update profiles set income_pending = income_pending - v_amount,
        balance = least(balance + v_amount, 1000000000000)
  where id = v_uid;
  return jsonb_build_object('claimed', v_amount);
end $$;

-- Achat + ouverture d'un booster, en une seule transaction atomique.
-- p_request_id rend l'appel idempotent : un double envoi renvoie le même résultat.
create or replace function public.buy_booster(p_slot int, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _uid(); cfg public.settings := _cfg(); p public.profiles; o public.shop_offers;
  r public.rarities; v_weights numeric[]; v_rarity int; v_card text; v_cards jsonb := '[]'::jsonb;
  v_res jsonb; v_prev jsonb; i int;
begin
  if p_request_id is null then raise exception 'Identifiant de requête manquant.'; end if;
  p := _lock_profile(v_uid);   -- sérialise les achats du joueur (doubles clics compris)
  select result into v_prev from pack_openings where player_id = v_uid and request_id = p_request_id;
  if found then return v_prev || jsonb_build_object('already_applied', true); end if;
  perform _rate_limit(v_uid, 'booster', 12, 10);
  if now() >= p.shop_next_refresh_at then
    raise exception 'La boutique vient de se renouveler. Regarde les nouvelles offres !';
  end if;
  select * into o from shop_offers where player_id = v_uid and slot = p_slot for update;
  if not found then raise exception 'Cette offre n''existe pas.'; end if;
  if o.stock is not null and o.stock <= 0 then raise exception 'Ce booster est épuisé.'; end if;
  if p.balance < o.price then raise exception 'Tu n''as pas assez de pièces.'; end if;
  if (select count(*) from card_instances where owner_id = v_uid) + cfg.cards_per_pack > cfg.max_cards then
    raise exception 'Ta collection est pleine (% cartes maximum).', cfg.max_cards;
  end if;

  perform _settle_income(v_uid);   -- solde les revenus AVANT que le taux change
  update profiles set balance = balance - o.price where id = v_uid;
  update shop_offers set stock = stock - 1 where player_id = v_uid and slot = p_slot and stock is not null;

  select * into r from rarities where id = o.tier;
  v_weights := _luck_weights(r.pack_weights, p.luck, 3);
  for i in 1..cfg.cards_per_pack loop
    v_rarity := _pick(v_weights);
    if i = cfg.cards_per_pack then v_rarity := greatest(v_rarity, o.tier); end if;  -- dernière carte garantie
    select id into v_card from cards where rarity = v_rarity order by random() limit 1;
    v_cards := v_cards || jsonb_build_array(_grant_card(v_uid, v_card, 'booster'));
  end loop;

  select jsonb_build_object('tier', o.tier, 'price', o.price, 'cards', v_cards,
       'balance', pr.balance, 'luck', pr.luck, 'already_applied', false)
    into v_res from profiles pr where pr.id = v_uid;
  insert into pack_openings (player_id, request_id, tier, price, result)
  values (v_uid, p_request_id, o.tier, o.price, v_res);
  return v_res;
end $$;

-- Mise en vente (prix fixe) ou aux enchères. La carte est verrouillée.
create or replace function public.create_listing(p_instance uuid, p_kind text, p_price bigint, p_minutes int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _uid(); cfg public.settings := _cfg(); p public.profiles; c public.card_instances; v_id uuid;
begin
  perform _rate_limit(v_uid, 'market', 20, 60);
  p := _lock_profile(v_uid);
  if p_kind not in ('fixed','auction') then raise exception 'Type de vente invalide.'; end if;
  if p_price is null or p_price < 1 or p_price > cfg.max_price then
    raise exception 'Le prix doit être compris entre 1 et % pièces.', cfg.max_price;
  end if;
  if p_minutes is null
     or (p_kind = 'fixed' and (p_minutes < 10 or p_minutes > 10080))
     or (p_kind = 'auction' and (p_minutes < 5 or p_minutes > 1440)) then
    raise exception 'Durée invalide (enchère : 5 min à 24 h, prix fixe : 10 min à 7 jours).';
  end if;
  select * into c from card_instances where id = p_instance for update;
  if not found or c.owner_id <> v_uid then raise exception 'Cette carte ne t''appartient pas.'; end if;
  if c.lock_id is not null then raise exception 'Cette carte est déjà en vente ou dans un échange.'; end if;
  if (select count(*) from listings where seller_id = v_uid and status = 'active') >= cfg.max_active_listings then
    raise exception 'Tu as déjà % annonces actives.', cfg.max_active_listings;
  end if;
  insert into listings (seller_id, seller_name, instance_id, card_id, kind, price, ends_at)
  values (v_uid, p.username, c.id, c.card_id, p_kind, p_price, now() + make_interval(mins => p_minutes))
  returning id into v_id;
  update card_instances set lock_kind = 'listing', lock_id = v_id where id = c.id;
  return v_id;
end $$;

create or replace function public.cancel_listing(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _uid(); l public.listings;
begin
  perform _rate_limit(v_uid, 'market', 20, 60);
  select * into l from listings where id = p_id for update;
  if not found or l.seller_id <> v_uid then raise exception 'Annonce introuvable.'; end if;
  if l.status <> 'active' then raise exception 'Cette annonce est déjà terminée.'; end if;
  if l.kind = 'auction' and l.bidder_id is not null then
    raise exception 'Impossible d''annuler une enchère qui a déjà reçu une offre.';
  end if;
  update listings set status = 'cancelled', closed_at = now() where id = p_id;
  update card_instances set lock_kind = null, lock_id = null where id = l.instance_id and lock_id = p_id;
end $$;

create or replace function public.buy_listing(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _uid(); l public.listings; v_fee bigint; v_buyer public.profiles; v_disc jsonb;
begin
  perform _rate_limit(v_uid, 'buy', 20, 30);
  select * into l from listings where id = p_id for update;   -- 2 acheteurs simultanés : le 2e attend puis échoue
  if not found then raise exception 'Annonce introuvable.'; end if;
  if l.status <> 'active' then raise exception 'Trop tard : cette carte n''est plus en vente.'; end if;
  if l.kind <> 'fixed' then raise exception 'Cette annonce est une enchère.'; end if;
  if l.ends_at <= now() then raise exception 'Cette annonce a expiré.'; end if;
  if l.seller_id = v_uid then raise exception 'Tu ne peux pas acheter ta propre annonce.'; end if;
  perform _lock_two(v_uid, l.seller_id);
  select * into v_buyer from profiles where id = v_uid;
  if not found then raise exception 'Crée d''abord ton profil de collectionneur.'; end if;
  if v_buyer.balance < l.price then raise exception 'Tu n''as pas assez de pièces.'; end if;
  if (select count(*) from card_instances where owner_id = v_uid) >= (_cfg()).max_cards then
    raise exception 'Ta collection est pleine.';
  end if;
  perform _settle_income(v_uid);
  perform _settle_income(l.seller_id);
  v_fee := floor(l.price * (_cfg()).market_fee_pct / 100.0);
  update profiles set balance = balance - l.price where id = v_uid;
  perform _add_money(l.seller_id, l.price - v_fee);
  update card_instances set owner_id = v_uid, lock_kind = null, lock_id = null, origin = 'market', acquired_at = now()
  where id = l.instance_id and owner_id = l.seller_id and lock_id = p_id;
  if not found then raise exception 'Incohérence détectée : achat annulé.'; end if;
  v_disc := _discover(v_uid, l.card_id);
  update listings set status = 'sold', buyer_id = v_uid, buyer_name = v_buyer.username,
        final_price = l.price, closed_at = now()
  where id = p_id;
  return jsonb_build_object('card_id', l.card_id, 'price', l.price) || v_disc;
end $$;

-- Enchère : l'argent est bloqué (séquestre). L'enchérisseur précédent est remboursé.
create or replace function public.place_bid(p_id uuid, p_amount bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _uid(); cfg public.settings := _cfg(); l public.listings; v_min bigint; v_me public.profiles;
begin
  perform _rate_limit(v_uid, 'bid', 20, 30);
  select * into l from listings where id = p_id for update;
  if not found then raise exception 'Enchère introuvable.'; end if;
  if l.status <> 'active' or l.kind <> 'auction' or l.ends_at <= now() then
    raise exception 'Cette enchère est terminée.';
  end if;
  if l.seller_id = v_uid then raise exception 'Tu ne peux pas enchérir sur ta propre carte.'; end if;
  if l.bidder_id = v_uid then raise exception 'Tu es déjà le meilleur enchérisseur.'; end if;
  v_min := case when l.current_bid is null then l.price
  else l.current_bid + greatest(1, ceil(l.current_bid * cfg.min_bid_increment_pct / 100.0)) end;
  if p_amount is null or p_amount < v_min then raise exception 'L''enchère minimale est de % pièces.', v_min; end if;
  if p_amount > cfg.max_price then raise exception 'Montant trop élevé.'; end if;
  if l.bidder_id is not null then perform _lock_two(v_uid, l.bidder_id); else perform _lock_profile(v_uid); end if;
  select * into v_me from profiles where id = v_uid;
  if not found then raise exception 'Crée d''abord ton profil de collectionneur.'; end if;
  if v_me.balance < p_amount then raise exception 'Tu n''as pas assez de pièces.'; end if;
  update profiles set balance = balance - p_amount where id = v_uid;         -- séquestre
  if l.bidder_id is not null then perform _add_money(l.bidder_id, l.current_bid); end if;  -- remboursement
  update listings set current_bid = p_amount, bidder_id = v_uid, bidder_name = v_me.username,
        bid_count = bid_count + 1,
 ends_at = greatest(ends_at, now() + make_interval(secs => cfg.anti_snipe_seconds))
  where id = p_id;
  return jsonb_build_object('amount', p_amount);
end $$;

create or replace function public.refresh_market() returns int
language plpgsql security definer set search_path = public as $$
begin
  perform _uid();
  return settle_due_listings(100);
end $$;

-- Échanges : carte offerte contre carte demandée.
create or replace function public.create_trade(p_instance uuid, p_wanted text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _uid(); cfg public.settings := _cfg(); p public.profiles; c public.card_instances; v_id uuid;
begin
  perform _rate_limit(v_uid, 'market', 20, 60);
  p := _lock_profile(v_uid);
  if not exists (select 1 from cards where id = p_wanted) then raise exception 'Carte demandée inconnue.'; end if;
  select * into c from card_instances where id = p_instance for update;
  if not found or c.owner_id <> v_uid then raise exception 'Cette carte ne t''appartient pas.'; end if;
  if c.lock_id is not null then raise exception 'Cette carte est déjà en vente ou dans un échange.'; end if;
  if (select count(*) from trades where creator_id = v_uid and status = 'open') >= cfg.max_open_trades then
    raise exception 'Tu as déjà % offres d''échange ouvertes.', cfg.max_open_trades;
  end if;
  insert into trades (creator_id, creator_name, offered_instance_id, offered_card_id, wanted_card_id)
  values (v_uid, p.username, c.id, c.card_id, p_wanted) returning id into v_id;
  update card_instances set lock_kind = 'trade', lock_id = v_id where id = c.id;
  return v_id;
end $$;

create or replace function public.cancel_trade(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _uid(); t public.trades;
begin
  perform _rate_limit(v_uid, 'market', 20, 60);
  select * into t from trades where id = p_id for update;
  if not found or t.creator_id <> v_uid then raise exception 'Offre introuvable.'; end if;
  if t.status <> 'open' then raise exception 'Cette offre est déjà terminée.'; end if;
  update trades set status = 'cancelled', closed_at = now() where id = p_id;
  update card_instances set lock_kind = null, lock_id = null where id = t.offered_instance_id and lock_id = p_id;
end $$;

create or replace function public.accept_trade(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _uid(); t public.trades; v_me public.profiles; v_mine uuid; v_disc jsonb;
begin
  perform _rate_limit(v_uid, 'buy', 20, 30);
  select * into t from trades where id = p_id for update;
  if not found then raise exception 'Offre introuvable.'; end if;
  if t.status <> 'open' then raise exception 'Trop tard : cette offre n''est plus disponible.'; end if;
  if t.creator_id = v_uid then raise exception 'Tu ne peux pas accepter ta propre offre.'; end if;
  perform _lock_two(v_uid, t.creator_id);
  select * into v_me from profiles where id = v_uid;
  if not found then raise exception 'Crée d''abord ton profil de collectionneur.'; end if;
  select id into v_mine from card_instances
  where owner_id = v_uid and card_id = t.wanted_card_id and lock_id is null
  order by acquired_at limit 1 for update;
  if v_mine is null then raise exception 'Tu ne possèdes pas d''exemplaire libre de la carte demandée.'; end if;
  perform 1 from card_instances where id = t.offered_instance_id and owner_id = t.creator_id and lock_id = p_id for update;
  if not found then raise exception 'Incohérence détectée : échange annulé.'; end if;
  perform _settle_income(v_uid);
  perform _settle_income(t.creator_id);
  update card_instances set owner_id = v_uid, lock_kind = null, lock_id = null, origin = 'trade', acquired_at = now()
  where id = t.offered_instance_id;
  update card_instances set owner_id = t.creator_id, origin = 'trade', acquired_at = now() where id = v_mine;
  v_disc := _discover(v_uid, t.offered_card_id);
  perform _discover(t.creator_id, t.wanted_card_id);
  update trades set status = 'accepted', acceptor_id = v_uid, acceptor_name = v_me.username,
      received_instance_id = v_mine, closed_at = now()
  where id = p_id;
  return jsonb_build_object('card_id', t.offered_card_id) || v_disc;
end $$;

-- ---------------------------------------------------------------------
-- 6. DROITS D'EXÉCUTION : seules les RPC publiques sont appelables
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.create_profile(text), public.get_state(), public.claim_income(),
  public.buy_booster(int, uuid), public.create_listing(uuid, text, bigint, int),
  public.cancel_listing(uuid), public.buy_listing(uuid), public.place_bid(uuid, bigint),
  public.refresh_market(), public.create_trade(uuid, text), public.cancel_trade(uuid),
  public.accept_trade(uuid)
to authenticated;

-- ---------------------------------------------------------------------
-- 7. TEMPS RÉEL + TÂCHE PLANIFIÉE (facultatifs mais recommandés)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'listings') then
      alter publication supabase_realtime add table public.listings;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'trades') then
      alter publication supabase_realtime add table public.trades;
    end if;
  end if;
end $$;

-- Résolution des enchères chaque minute, même si personne n'est connecté.
-- Si pg_cron n'est pas disponible, la résolution se fait quand même à la
-- demande (get_state / refresh_market), mais seulement quand un joueur se connecte.
do $$
begin
  create extension if not exists pg_cron;
  if exists (select 1 from cron.job where jobname = 'animal-cards-settle') then
    perform cron.unschedule('animal-cards-settle');
  end if;
  perform cron.schedule('animal-cards-settle', '* * * * *', 'select public.settle_due_listings(500)');
exception when others then
  raise notice 'pg_cron indisponible (%). Résolution à la demande uniquement.', sqlerrm;
end $$;
