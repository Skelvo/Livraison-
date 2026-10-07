-- Sécurité (appliqué le 2026-10-07) : lecture publique, écritures uniquement via fonctions contrôlées.
-- Le mot de passe admin est stocké haché dans admin_config (jamais lisible depuis l'app).
-- Pour le changer, dans l'éditeur SQL de Supabase :
--   update public.admin_config set value = extensions.crypt('NOUVEAU_MOT_DE_PASSE', extensions.gen_salt('bf'))
--   where name = 'password_hash';

alter table public.garages enable row level security;
alter table public.stats   enable row level security;
alter table public.meta    enable row level security;
create policy "lecture publique" on public.garages for select to anon, authenticated using (true);
create policy "lecture publique" on public.stats   for select to anon, authenticated using (true);
create policy "lecture publique" on public.meta    for select to anon, authenticated using (true);

create table if not exists public.admin_config (name text primary key, value text not null);
alter table public.admin_config enable row level security;

-- admin_check(p_password), admin_save_garage(p_password, p_name, p_carriers),
-- admin_delete_garage(p_password, p_name), increment_stat(garage_name), increment_total() :
-- fonctions SECURITY DEFINER, voir l'historique des migrations Supabase.

-- 2026-10-07 : transporteurs modifiables (carriers), retards/annulations (departure_events),
-- journal des recherches (search_log) et fonctions admin_save_carrier, admin_set_event,
-- log_search, admin_stats — voir l'historique des migrations Supabase.
