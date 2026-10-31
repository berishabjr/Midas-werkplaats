-- =====================================================================
-- Midas Werkplaats — STAP 2: aanvragen (verlof + materiaal) en live meldingen
-- Uitvoeren in Supabase: SQL Editor > New query > plakken > Run.
-- Veilig om 1x uit te voeren na 01_fundament.sql.
-- =====================================================================

-- Verlof indienen (medewerker met geldige sessie)
create or replace function public.verlof_indienen(
  p_sessie text, p_type text, p_van date, p_tot date, p_opmerking text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_med uuid := public._sessie(p_sessie); v_c uuid; v_id uuid;
begin
  if v_med is null then raise exception 'sessie_ongeldig'; end if;
  if p_van is null or p_tot is null or p_tot < p_van then raise exception 'datums_ongeldig'; end if;
  select m.centre_id into v_c from public.medewerkers m where m.id = v_med;
  insert into public.verlof (centre_id, medewerker_id, type, van, tot, opmerking)
  values (v_c, v_med, btrim(p_type), p_van, p_tot, nullif(btrim(coalesce(p_opmerking,'')), ''))
  returning id into v_id;
  return v_id;
end $$;

-- Materiaal aanvragen
create or replace function public.materiaal_indienen(
  p_sessie text, p_categorie text, p_omschrijving text, p_maat text, p_aantal int,
  p_urgentie text default 'Normaal', p_motivatie text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_med uuid := public._sessie(p_sessie); v_c uuid; v_id uuid;
begin
  if v_med is null then raise exception 'sessie_ongeldig'; end if;
  if coalesce(p_aantal, 0) < 1 then raise exception 'aantal_ongeldig'; end if;
  select m.centre_id into v_c from public.medewerkers m where m.id = v_med;
  insert into public.materiaal (centre_id, medewerker_id, categorie, omschrijving, maat, aantal, urgentie, motivatie)
  values (v_c, v_med, btrim(p_categorie), btrim(p_omschrijving), nullif(btrim(coalesce(p_maat,'')), ''),
          p_aantal, coalesce(p_urgentie,'Normaal'), nullif(btrim(coalesce(p_motivatie,'')), ''))
  returning id into v_id;
  return v_id;
end $$;

-- Mijn aanvragen (incl. beslissing en weigerreden)
create or replace function public.mijn_aanvragen(p_sessie text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_med uuid := public._sessie(p_sessie);
begin
  if v_med is null then raise exception 'sessie_ongeldig'; end if;
  return jsonb_build_object(
    'verlof', coalesce((
      select jsonb_agg(jsonb_build_object('id', v.id, 'type', v.type, 'van', v.van, 'tot', v.tot,
               'opmerking', v.opmerking, 'status', v.status, 'weiger_reden', v.weiger_reden,
               'gezien', v.gezien_door_werknemer, 'ts', v.created_at) order by v.created_at desc)
      from public.verlof v where v.medewerker_id = v_med), '[]'::jsonb),
    'materiaal', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'categorie', x.categorie, 'omschrijving', x.omschrijving,
               'maat', x.maat, 'aantal', x.aantal, 'urgentie', x.urgentie, 'status', x.status,
               'weiger_reden', x.weiger_reden, 'gezien', x.gezien_door_werknemer, 'ts', x.created_at)
               order by x.created_at desc)
      from public.materiaal x where x.medewerker_id = v_med), '[]'::jsonb));
end $$;

-- Melding "beslissing gezien" door de medewerker
create or replace function public.aanvraag_gelezen(p_sessie text, p_soort text, p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_med uuid := public._sessie(p_sessie);
begin
  if v_med is null then raise exception 'sessie_ongeldig'; end if;
  if p_soort = 'verlof' then
    update public.verlof set gezien_door_werknemer = true where id = p_id and medewerker_id = v_med;
  elsif p_soort = 'materiaal' then
    update public.materiaal set gezien_door_werknemer = true where id = p_id and medewerker_id = v_med;
  end if;
end $$;

revoke execute on function
  public.verlof_indienen(text, text, date, date, text),
  public.materiaal_indienen(text, text, text, text, int, text, text),
  public.mijn_aanvragen(text), public.aanvraag_gelezen(text, text, uuid)
  from public, anon, authenticated;
grant execute on function
  public.verlof_indienen(text, text, date, date, text),
  public.materiaal_indienen(text, text, text, text, int, text, text),
  public.mijn_aanvragen(text), public.aanvraag_gelezen(text, text, uuid)
  to anon, authenticated;

-- Live meldingen voor beheerders (Realtime; RLS blijft van toepassing)
alter publication supabase_realtime add table public.verlof, public.materiaal, public.pointages;
