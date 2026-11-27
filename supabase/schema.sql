-- Cartera Mayorista · Tomás Oberti Supplies
-- Estructura de la base en Supabase. Se corre una sola vez en: Supabase → SQL Editor → New query.

-- Quiénes pueden entrar a la app (además de tener usuario en Authentication).
create table if not exists public.permitidos (
  email text primary key
);

-- Clientes: el documento completo de cada cliente (datos, compras, contactos, perfil) en `data`.
create table if not exists public.clientes (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Movimientos de cuenta corriente: Deuda suma al saldo, Entrega resta, Ajuste va con su signo.
create table if not exists public.movimientos (
  id text primary key,
  f date not null,
  cid text not null,
  tipo text not null,
  monto numeric(16, 2) not null default 0,
  comp text not null default '',
  medio text not null default '',
  obs text not null default '',
  creado text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists movimientos_cid_idx on public.movimientos (cid);
create index if not exists movimientos_f_idx on public.movimientos (f);

-- Ingresos de mercadería y ajustes de la app.
create table if not exists public.ingresos (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.config (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Saldo de cada cliente, para consultas y reportes.
create or replace view public.saldos with (security_invoker = true) as
  select cid,
         sum(monto) as saldo,
         max(f) filter (where tipo = 'Entrega') as ultimo_pago,
         count(*) as movimientos
  from public.movimientos
  group by cid;

-- ---------- seguridad: solo los usuarios de `permitidos` leen y escriben ----------
create or replace function public.es_permitido() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.permitidos p where lower(p.email) = lower(auth.jwt() ->> 'email'));
$$;

alter table public.permitidos enable row level security;
alter table public.clientes enable row level security;
alter table public.movimientos enable row level security;
alter table public.ingresos enable row level security;
alter table public.config enable row level security;

drop policy if exists equipo on public.clientes;
create policy equipo on public.clientes for all to authenticated using (public.es_permitido()) with check (public.es_permitido());
drop policy if exists equipo on public.ingresos;
create policy equipo on public.ingresos for all to authenticated using (public.es_permitido()) with check (public.es_permitido());
drop policy if exists equipo on public.config;
create policy equipo on public.config for all to authenticated using (public.es_permitido()) with check (public.es_permitido());
-- `permitidos` no tiene políticas: solo se edita desde el panel de Supabase.

-- ---------- permisos de la API: solo usuarios con sesión (y después filtra es_permitido) ----------
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.clientes, public.movimientos, public.ingresos, public.config to authenticated;
grant select on public.saldos to authenticated;
revoke all on public.clientes, public.movimientos, public.ingresos, public.config, public.saldos, public.permitidos from anon;
grant execute on function public.es_permitido() to authenticated;

-- ---------- movimientos: todos los leen, solo quien tenga permitidos.movimientos = true los carga o modifica ----------
alter table public.permitidos add column if not exists movimientos boolean not null default false;
create or replace function public.puede_movimientos() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.permitidos p
                 where lower(p.email) = lower(auth.jwt() ->> 'email') and p.movimientos);
$$;
grant execute on function public.puede_movimientos() to authenticated;
drop policy if exists equipo on public.movimientos;
drop policy if exists leer on public.movimientos;
drop policy if exists cargar on public.movimientos;
drop policy if exists modificar on public.movimientos;
drop policy if exists borrar on public.movimientos;
create policy leer on public.movimientos for select to authenticated using (public.es_permitido());
create policy cargar on public.movimientos for insert to authenticated with check (public.puede_movimientos());
create policy modificar on public.movimientos for update to authenticated using (public.puede_movimientos()) with check (public.puede_movimientos());
create policy borrar on public.movimientos for delete to authenticated using (public.puede_movimientos());
-- Para habilitar a alguien: update public.permitidos set movimientos = true where lower(email) = lower('email@...');

-- ---------- tiempo real: los cambios de uno se ven al instante en las otras pantallas ----------
do $$
declare t text;
begin
  foreach t in array array['clientes', 'movimientos', 'ingresos', 'config'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- comprobantes (PDF y fotos) en Storage, privados ----------
insert into storage.buckets (id, name, public) values ('comprobantes', 'comprobantes', false)
  on conflict (id) do nothing;

drop policy if exists "equipo lee comprobantes" on storage.objects;
create policy "equipo lee comprobantes" on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes' and public.es_permitido());
drop policy if exists "equipo sube comprobantes" on storage.objects;
create policy "equipo sube comprobantes" on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes' and public.es_permitido());
drop policy if exists "equipo borra comprobantes" on storage.objects;
create policy "equipo borra comprobantes" on storage.objects for delete to authenticated
  using (bucket_id = 'comprobantes' and public.es_permitido());
