-- =====================================================================
-- Midas Werkplaats — STAP 1: FUNDAMENT
-- Tabellen, beveiliging (RLS), auditlog, aanmelden en in/uitklokken.
-- Uitvoeren in Supabase: SQL Editor > New query > plakken > Run.
-- Veilig om 1x uit te voeren op een LEEG project.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. TABELLEN
-- ---------------------------------------------------------------------
create table public.centres (
  id         uuid primary key default gen_random_uuid(),
  naam       text not null,
  slug       text not null unique,
  created_at timestamptz not null default now()
);

-- Beheerders = mensen met e-mail + wachtwoord (Supabase Auth)
create table public.beheerders (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  centre_id uuid not null references public.centres(id),
  naam      text not null,
  rol       text not null check (rol in ('eigenaar','assistent')),
  actief    boolean not null default true
);

-- Medewerkers = personeel met stamnummer + pincode (geen e-mail nodig)
create table public.medewerkers (
  id                uuid primary key default gen_random_uuid(),
  centre_id         uuid not null references public.centres(id),
  stamnummer        text not null,
  naam              text not null,
  functie           text,
  type              text check (type in ('Arbeider','Bediende')),
  geboortedatum     date,
  adres             text,
  telefoon          text,
  email             text,
  contracttype      text,
  uren_per_week     numeric not null default 38,
  pin_hash          text not null,
  mislukte_pogingen int  not null default 0,
  geblokkeerd       boolean not null default false,
  actief            boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (centre_id, stamnummer)
);

-- Geregistreerde prikstations (tablet vestiaire, pc garage)
create table public.toestellen (
  id         uuid primary key default gen_random_uuid(),
  centre_id  uuid not null references public.centres(id),
  naam       text not null,
  token_hash text not null unique,
  actief     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Tijdelijke aanmeldsessies van medewerkers
create table public.sessies (
  token_hash    text primary key,
  medewerker_id uuid not null references public.medewerkers(id) on delete cascade,
  verloopt_op   timestamptz not null
);

-- Prikklok-registraties. Tijd = SERVERTIJD (kan niet vervalst worden).
create table public.pointages (
  id                uuid primary key default gen_random_uuid(),
  centre_id         uuid not null references public.centres(id),
  medewerker_id     uuid not null references public.medewerkers(id),
  in_ts             timestamptz not null default now(),
  uit_ts            timestamptz,
  toestel_id        uuid references public.toestellen(id),
  gecorrigeerd      boolean not null default false,
  gecorrigeerd_door uuid references public.beheerders(user_id),
  correctie_notitie text,
  created_at        timestamptz not null default now(),
  check (uit_ts is null or uit_ts > in_ts),
  check (not gecorrigeerd or correctie_notitie is not null)
);
-- Maximaal 1 openstaande prik per medewerker per dag
create unique index pointages_1_open_per_dag
  on public.pointages (medewerker_id, ((in_ts at time zone 'Europe/Brussels')::date))
  where uit_ts is null;
create index pointages_med_dag on public.pointages (medewerker_id, in_ts);

-- Verlof- en materiaalaanvragen (volledige invulling in stap 2)
create table public.verlof (
  id                   uuid primary key default gen_random_uuid(),
  centre_id            uuid not null references public.centres(id),
  medewerker_id        uuid not null references public.medewerkers(id),
  type                 text not null,
  van                  date not null,
  tot                  date not null,
  opmerking            text,
  status               text not null default 'In behandeling'
                       check (status in ('In behandeling','Goedgekeurd','Geweigerd')),
  weiger_reden         text,
  gezien_door_beheer   boolean not null default false,
  gezien_door_werknemer boolean not null default true,
  beslist_door         uuid references public.beheerders(user_id),
  beslist_op           timestamptz,
  created_at           timestamptz not null default now(),
  check (tot >= van),
  -- Weigeren zonder schriftelijke reden is onmogelijk
  check (status <> 'Geweigerd' or length(btrim(coalesce(weiger_reden,''))) > 0)
);

create table public.materiaal (
  id                   uuid primary key default gen_random_uuid(),
  centre_id            uuid not null references public.centres(id),
  medewerker_id        uuid not null references public.medewerkers(id),
  categorie            text not null,
  omschrijving         text not null,
  maat                 text,
  aantal               int  not null check (aantal > 0),
  urgentie             text not null default 'Normaal',
  motivatie            text,
  status               text not null default 'In behandeling'
                       check (status in ('In behandeling','Goedgekeurd','Geweigerd')),
  weiger_reden         text,
  gezien_door_beheer   boolean not null default false,
  gezien_door_werknemer boolean not null default true,
  beslist_door         uuid references public.beheerders(user_id),
  beslist_op           timestamptz,
  created_at           timestamptz not null default now()
);

-- Auditlog: wie deed wat, wanneer, voor/na. Niet aanpasbaar via de app.
create table public.auditlog (
  id        bigserial primary key,
  centre_id uuid,
  tabel     text not null,
  record_id uuid,
  actie     text not null,
  door      uuid default auth.uid(),
  voor      jsonb,
  na        jsonb,
  ts        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. AUDIT-TRIGGER (pincodes worden nooit gelogd)
-- ---------------------------------------------------------------------
create or replace function public._audit() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare o jsonb; n jsonb; r jsonb;
begin
  o := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) - 'pin_hash' end;
  n := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) - 'pin_hash' end;
  r := coalesce(n, o);
  insert into public.auditlog (centre_id, tabel, record_id, actie, voor, na)
  values ((r->>'centre_id')::uuid, tg_table_name, (r->>'id')::uuid, tg_op, o, n);
  return coalesce(new, old);
end $$;

create trigger audit_pointages   after insert or update or delete on public.pointages   for each row execute function public._audit();
create trigger audit_verlof      after insert or update or delete on public.verlof      for each row execute function public._audit();
create trigger audit_materiaal   after insert or update or delete on public.materiaal   for each row execute function public._audit();
create trigger audit_medewerkers after insert or update or delete on public.medewerkers for each row execute function public._audit();
create trigger audit_toestellen  after insert or update or delete on public.toestellen  for each row execute function public._audit();

-- ---------------------------------------------------------------------
-- 3. BEVEILIGING (RLS): standaard is NIETS toegankelijk
-- ---------------------------------------------------------------------
alter table public.centres     enable row level security;
alter table public.beheerders  enable row level security;
alter table public.medewerkers enable row level security;
alter table public.toestellen  enable row level security;
alter table public.sessies     enable row level security;
alter table public.pointages   enable row level security;
alter table public.verlof      enable row level security;
alter table public.materiaal   enable row level security;
alter table public.auditlog    enable row level security;

-- Centrum van de ingelogde beheerder
create or replace function public.mijn_centrum() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select b.centre_id from public.beheerders b where b.user_id = auth.uid() and b.actief
$$;

-- Rechten: anon (niet-ingelogd) krijgt GEEN tabelrechten.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.centres, public.beheerders, public.toestellen,
                public.pointages, public.verlof, public.materiaal, public.auditlog
      to authenticated;
-- Medewerkers: alles behalve pin_hash
grant select (id, centre_id, stamnummer, naam, functie, type, geboortedatum, adres,
              telefoon, email, contracttype, uren_per_week, mislukte_pogingen,
              geblokkeerd, actief, created_at)
      on public.medewerkers to authenticated;
grant insert, update on public.pointages to authenticated;   -- correcties
grant update on public.verlof, public.materiaal to authenticated; -- beslissingen
-- Medewerkers aanmaken/wijzigen gebeurt enkel via de functies hieronder.

create policy centres_lezen   on public.centres    for select to authenticated using (id = public.mijn_centrum());
create policy beheer_lezen    on public.beheerders for select to authenticated using (centre_id = public.mijn_centrum());
create policy med_lezen       on public.medewerkers for select to authenticated using (centre_id = public.mijn_centrum());
create policy toestel_lezen   on public.toestellen for select to authenticated using (centre_id = public.mijn_centrum());
create policy audit_lezen     on public.auditlog   for select to authenticated using (centre_id = public.mijn_centrum());

create policy point_lezen  on public.pointages for select to authenticated using (centre_id = public.mijn_centrum());
create policy point_corr   on public.pointages for update to authenticated
  using (centre_id = public.mijn_centrum()) with check (centre_id = public.mijn_centrum() and gecorrigeerd);
create policy point_nieuw  on public.pointages for insert to authenticated
  with check (centre_id = public.mijn_centrum() and gecorrigeerd);

create policy verlof_lezen on public.verlof for select to authenticated using (centre_id = public.mijn_centrum());
create policy verlof_upd   on public.verlof for update to authenticated
  using (centre_id = public.mijn_centrum()) with check (centre_id = public.mijn_centrum());
create policy mat_lezen    on public.materiaal for select to authenticated using (centre_id = public.mijn_centrum());
create policy mat_upd      on public.materiaal for update to authenticated
  using (centre_id = public.mijn_centrum()) with check (centre_id = public.mijn_centrum());

-- ---------------------------------------------------------------------
-- 4. HULPFUNCTIES (intern, niet oproepbaar vanuit de app)
-- ---------------------------------------------------------------------
create or replace function public._hash(p text) returns text
language sql immutable set search_path = extensions, pg_temp as $$
  select encode(digest(p, 'sha256'), 'hex')
$$;

create or replace function public._toestel(p_token text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id from public.toestellen t
  where t.actief and t.token_hash = public._hash(coalesce(p_token,''))
$$;

create or replace function public._sessie(p_token text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select s.medewerker_id from public.sessies s
  where s.verloopt_op > now() and s.token_hash = public._hash(coalesce(p_token,''))
$$;

-- Controleert pincode; telt mislukte pogingen; blokkeert na 3 fouten.
create or replace function public._pin_controle(p_med uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare m public.medewerkers%rowtype;
begin
  select * into m from public.medewerkers x where x.id = p_med and x.actief for update;
  if not found then return 'ongeldig'; end if;
  if m.geblokkeerd then return 'geblokkeerd'; end if;
  if m.pin_hash = crypt(coalesce(p_pin,''), m.pin_hash) then
    if m.mislukte_pogingen > 0 then
      update public.medewerkers set mislukte_pogingen = 0 where id = m.id;
    end if;
    return 'ok';
  end if;
  update public.medewerkers
     set mislukte_pogingen = m.mislukte_pogingen + 1,
         geblokkeerd = (m.mislukte_pogingen + 1 >= 3)
   where id = m.id;
  if m.mislukte_pogingen + 1 >= 3 then return 'geblokkeerd'; end if;
  return 'fout';
end $$;

create or replace function public._nieuwe_sessie(p_med uuid, p_minuten int) returns text
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare t text := encode(gen_random_bytes(24), 'hex');
begin
  delete from public.sessies where verloopt_op < now();
  insert into public.sessies (token_hash, medewerker_id, verloopt_op)
  values (public._hash(t), p_med, now() + make_interval(mins => p_minuten));
  return t;
end $$;

-- ---------------------------------------------------------------------
-- 5. FUNCTIES VOOR DE APP (door tablet / personeel)
-- ---------------------------------------------------------------------
-- Namenlijst voor de tablet (enkel voor een geregistreerd prikstation)
create or replace function public.kiosk_personeel(p_toestel text)
returns table (o_id uuid, o_naam text, o_stamnummer text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t uuid := public._toestel(p_toestel); v_c uuid;
begin
  if v_t is null then return; end if;
  select t.centre_id into v_c from public.toestellen t where t.id = v_t;
  return query
    select m.id, m.naam, m.stamnummer from public.medewerkers m
    where m.centre_id = v_c and m.actief order by m.naam;
end $$;

-- Aanmelden op de tablet (tegel + pincode)
create or replace function public.inloggen_kiosk(p_toestel text, p_medewerker uuid, p_pin text)
returns table (o_status text, o_sessie text, o_id uuid, o_naam text, o_over int)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t uuid := public._toestel(p_toestel); v_s text; v_m public.medewerkers%rowtype;
begin
  if v_t is null then return query select 'toestel_ongeldig'::text, null::text, null::uuid, null::text, 0; return; end if;
  select * into v_m from public.medewerkers x
   where x.id = p_medewerker and x.centre_id = (select t.centre_id from public.toestellen t where t.id = v_t);
  if not found then return query select 'ongeldig'::text, null::text, null::uuid, null::text, 0; return; end if;
  v_s := public._pin_controle(v_m.id, p_pin);
  if v_s = 'ok' then
    return query select 'ok'::text, public._nieuwe_sessie(v_m.id, 5), v_m.id, v_m.naam, 3;
  else
    select * into v_m from public.medewerkers x where x.id = p_medewerker;
    return query select v_s, null::text, null::uuid, null::text, greatest(0, 3 - v_m.mislukte_pogingen);
  end if;
end $$;

-- Aanmelden van overal (stamnummer + pincode) — voor verlof/materiaal, NIET om te prikken
create or replace function public.inloggen_stamnummer(p_centrum text, p_stamnummer text, p_pin text)
returns table (o_status text, o_sessie text, o_id uuid, o_naam text, o_over int)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_m public.medewerkers%rowtype; v_s text;
begin
  select m.* into v_m from public.medewerkers m
    join public.centres c on c.id = m.centre_id
   where c.slug = lower(coalesce(p_centrum,'')) and m.stamnummer = btrim(coalesce(p_stamnummer,'')) and m.actief;
  if not found then return query select 'fout'::text, null::text, null::uuid, null::text, 2; return; end if;
  v_s := public._pin_controle(v_m.id, p_pin);
  if v_s = 'ok' then
    return query select 'ok'::text, public._nieuwe_sessie(v_m.id, 30), v_m.id, v_m.naam, 3;
  else
    select * into v_m from public.medewerkers x where x.id = v_m.id;
    return query select v_s, null::text, null::uuid, null::text, greatest(0, 3 - v_m.mislukte_pogingen);
  end if;
end $$;

-- In- of uitklokken: enkel met geldige sessie EN geregistreerd prikstation
create or replace function public.pointeer(p_sessie text, p_toestel text)
returns table (o_actie text, o_tijd timestamptz, o_naam text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_med uuid := public._sessie(p_sessie); v_t uuid := public._toestel(p_toestel);
        v_m public.medewerkers%rowtype; v_open uuid; v_vandaag date := (now() at time zone 'Europe/Brussels')::date;
begin
  if v_med is null then raise exception 'sessie_ongeldig'; end if;
  if v_t is null then raise exception 'toestel_niet_geregistreerd'; end if;
  select * into v_m from public.medewerkers x where x.id = v_med;
  -- Alleen een prik van VANDAAG wordt afgesloten; oudere open prikken blijven
  -- als anomalie staan tot een beheerder ze valideert.
  select p.id into v_open from public.pointages p
   where p.medewerker_id = v_med and p.uit_ts is null
     and (p.in_ts at time zone 'Europe/Brussels')::date = v_vandaag
   for update;
  if found then
    update public.pointages set uit_ts = now() where id = v_open;
    return query select 'uit'::text, now(), v_m.naam;
  else
    insert into public.pointages (centre_id, medewerker_id, toestel_id)
    values (v_m.centre_id, v_med, v_t);
    return query select 'in'::text, now(), v_m.naam;
  end if;
end $$;

-- Mijn prikken van een periode (voor "Mijn uren")
create or replace function public.mijn_pointages(p_sessie text, p_van date, p_tot date)
returns table (o_id uuid, o_in timestamptz, o_uit timestamptz, o_gecorrigeerd boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_med uuid := public._sessie(p_sessie);
begin
  if v_med is null then raise exception 'sessie_ongeldig'; end if;
  return query
    select p.id, p.in_ts, p.uit_ts, p.gecorrigeerd from public.pointages p
     where p.medewerker_id = v_med
       and (p.in_ts at time zone 'Europe/Brussels')::date between p_van and p_tot
     order by p.in_ts;
end $$;

create or replace function public.uitloggen(p_sessie text) returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from public.sessies where token_hash = public._hash(coalesce(p_sessie,''))
$$;

-- ---------------------------------------------------------------------
-- 6. FUNCTIES VOOR BEHEERDERS (ingelogd met e-mail + wachtwoord)
-- ---------------------------------------------------------------------
create or replace function public.beheer_medewerker_toevoegen(
  p_stamnummer text, p_naam text, p_pin text, p_functie text default null,
  p_type text default null, p_geboortedatum date default null, p_adres text default null,
  p_telefoon text default null, p_email text default null,
  p_contracttype text default 'Voltijds', p_uren numeric default 38)
returns uuid language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_c uuid := public.mijn_centrum(); v_id uuid;
begin
  if v_c is null then raise exception 'geen_toegang'; end if;
  if p_pin !~ '^\d{4}$' then raise exception 'pin_moet_4_cijfers_zijn'; end if;
  insert into public.medewerkers (centre_id, stamnummer, naam, functie, type, geboortedatum, adres,
                                  telefoon, email, contracttype, uren_per_week, pin_hash)
  values (v_c, btrim(p_stamnummer), btrim(p_naam), p_functie, p_type, p_geboortedatum, p_adres,
          p_telefoon, p_email, p_contracttype, p_uren, crypt(p_pin, gen_salt('bf')))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.beheer_pin_wijzigen(p_medewerker uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if public.mijn_centrum() is null then raise exception 'geen_toegang'; end if;
  if p_pin !~ '^\d{4}$' then raise exception 'pin_moet_4_cijfers_zijn'; end if;
  update public.medewerkers
     set pin_hash = crypt(p_pin, gen_salt('bf')), mislukte_pogingen = 0, geblokkeerd = false
   where id = p_medewerker and centre_id = public.mijn_centrum();
end $$;

create or replace function public.beheer_deblokkeren(p_medewerker uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.mijn_centrum() is null then raise exception 'geen_toegang'; end if;
  update public.medewerkers set geblokkeerd = false, mislukte_pogingen = 0
   where id = p_medewerker and centre_id = public.mijn_centrum();
end $$;

-- Registreert een prikstation. Geeft het geheime token EENMALIG terug.
create or replace function public.beheer_toestel_registreren(p_naam text) returns text
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_c uuid := public.mijn_centrum(); t text := encode(gen_random_bytes(24), 'hex');
begin
  if v_c is null then raise exception 'geen_toegang'; end if;
  insert into public.toestellen (centre_id, naam, token_hash) values (v_c, p_naam, public._hash(t));
  return t;
end $$;

create or replace function public.beheer_toestel_intrekken(p_toestel uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.mijn_centrum() is null then raise exception 'geen_toegang'; end if;
  update public.toestellen set actief = false where id = p_toestel and centre_id = public.mijn_centrum();
end $$;

-- ---------------------------------------------------------------------
-- 7. UITVOERRECHTEN: eerst alles dichtzetten, dan gericht openen
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- Voor niet-ingelogde apparaten (tablet / personeel)
grant execute on function
  public.kiosk_personeel(text), public.inloggen_kiosk(text, uuid, text),
  public.inloggen_stamnummer(text, text, text), public.pointeer(text, text),
  public.mijn_pointages(text, date, date), public.uitloggen(text)
  to anon, authenticated;

-- Voor ingelogde beheerders
grant execute on function
  public.mijn_centrum(),
  public.beheer_medewerker_toevoegen(text, text, text, text, text, date, text, text, text, text, numeric),
  public.beheer_pin_wijzigen(uuid, text), public.beheer_deblokkeren(uuid),
  public.beheer_toestel_registreren(text), public.beheer_toestel_intrekken(uuid)
  to authenticated;

-- ---------------------------------------------------------------------
-- 8. STARTGEGEVENS
-- ---------------------------------------------------------------------
insert into public.centres (naam, slug) values ('Midas Beveren', 'beveren');
