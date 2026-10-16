-- =====================================================================================
-- Lançamento de diesel: banco de dados (Supabase / PostgreSQL 15+)
--
-- Como aplicar: Supabase > SQL Editor > cole este arquivo inteiro > Run.
-- Pode ser rodado de novo (atualiza funções e regras sem apagar dados).
--
-- Segurança:
--  * Toda tabela tem RLS. Só contas Google cadastradas em "acessos" enxergam alguma coisa.
--  * O celular (papel "posto") não grava direto em tabela nenhuma: só pelas funções registrar_*,
--    que conferem tudo aqui dentro. O resultado da conferência que vale é o do banco.
--  * Abastecimento nunca é apagado; auditoria não pode ser alterada nem apagada.
-- =====================================================================================

-- ---------- Acesso ----------
create table if not exists acessos (
  email      text primary key check (email = lower(email) and email like '%@%'),
  nome       text not null,
  papel      text not null check (papel in ('posto', 'supervisor')),
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);

create or replace function meu_email() returns text
language sql stable set search_path = public as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- Só vale login feito pelo Google (o provedor de e-mail/senha do Supabase deve ficar desligado).
create or replace function meu_papel() returns text
language sql stable security definer set search_path = public as $$
  select a.papel from acessos a
   where a.email = meu_email() and a.ativo
     and coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') = 'google'
$$;

create or replace function exigir(p_papeis text[]) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_papel text := meu_papel();
begin
  if v_papel is null or not (v_papel = any (p_papeis)) then
    raise exception 'Acesso negado para %', coalesce(nullif(meu_email(), ''), 'usuário sem login')
      using errcode = '42501';
  end if;
  return v_papel;
end $$;

-- ---------- Utilidades ----------
create or replace function agora_local() returns timestamp
language sql stable as $$ select date_trunc('second', now() at time zone 'America/Sao_Paulo') $$;

create or replace function hoje() returns date
language sql stable as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;

create or replace function normaliza_placa(t text) returns text
language sql immutable as $$ select upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g')) $$;

create or replace function normaliza_nome(t text) returns text
language sql immutable as $$
  select regexp_replace(trim(translate(upper(coalesce(t, '')),
         'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN')), '\s+', ' ', 'g')
$$;

create or replace function placa_valida(t text) returns boolean
language sql immutable as $$ select normaliza_placa(t) ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$' $$;

create or replace function cpf_valido(t text) returns boolean
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(t, ''), '\D', '', 'g'); s int; i int; dv int;
begin
  if length(d) <> 11 or d = repeat(substr(d, 1, 1), 11) then return false; end if;
  for n in 9..10 loop
    s := 0;
    for i in 1..n loop s := s + substr(d, i, 1)::int * (n + 2 - i); end loop;
    dv := (s * 10 % 11) % 10;
    if dv <> substr(d, n + 1, 1)::int then return false; end if;
  end loop;
  return true;
end $$;

-- 7071686 -> '7.071.686'; 640.5 -> '640,5'
create or replace function fmt(x numeric) returns text
language sql immutable as $$
  select rtrim(rtrim(replace(replace(replace(to_char(x, 'FM999,999,999,990.999'), ',', '#'), '.', ','), '#', '.'), '0'), ',')
$$;

-- ---------- Cadastros ----------
create table if not exists frentistas (
  id     bigint generated always as identity primary key,
  nome   text not null unique,
  ativo  boolean not null default true
);

create table if not exists veiculos (
  placa         text primary key check (placa ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'),
  capacidade_l  numeric(8, 1) not null check (capacidade_l > 0 and capacidade_l < 5000),
  km_inicial    integer check (km_inicial >= 0),
  ativo         boolean not null default true
);

create table if not exists motoristas (
  id     bigint generated always as identity primary key,
  nome   text not null unique,
  cpf    text not null check (cpf ~ '^\d{11}$' and cpf_valido(cpf)),
  ativo  boolean not null default true
);

create table if not exists tanques (
  codigo         text primary key check (codigo ~ '^[A-Z0-9 _-]{1,20}$'),
  capacidade_l   numeric(10, 1) not null check (capacidade_l > 0),
  saldo_inicial  numeric(10, 1) not null check (saldo_inicial >= 0)
);

create table if not exists bombas (
  numero              integer primary key check (numero between 1 and 99),
  tanque              text not null references tanques (codigo),
  encerrante_inicial  numeric(14, 3) not null check (encerrante_inicial >= 0),
  ativa               boolean not null default true
);

-- Normaliza placa, nome e CPF antes de gravar (o painel pode digitar "abc-1d23" ou "529.982.247-25")
create or replace function normalizar_cadastro() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'veiculos' then new.placa := normaliza_placa(new.placa);
  elsif tg_table_name = 'motoristas' then
    new.nome := normaliza_nome(new.nome);
    new.cpf := regexp_replace(new.cpf, '\D', '', 'g');
  elsif tg_table_name = 'frentistas' then new.nome := regexp_replace(trim(new.nome), '\s+', ' ', 'g');
  elsif tg_table_name = 'tanques' then new.codigo := upper(trim(new.codigo));
  elsif tg_table_name = 'bombas' then new.tanque := upper(trim(new.tanque));
  elsif tg_table_name = 'acessos' then new.email := lower(trim(new.email));
  end if;
  return new;
end $$;

-- ---------- Movimento ----------
create table if not exists lotes (
  id          bigint generated always as identity primary key,
  criado_em   timestamptz not null default now(),
  criado_por  text not null,
  quantidade  integer not null,
  litros      numeric(12, 3) not null,
  situacao    text not null check (situacao in ('Gerado', 'Confirmado', 'Desfeito')),
  fechado_em  timestamptz,
  fechado_por text
);

-- id = Nº requisição no KMM
create table if not exists abastecimentos (
  id                   bigint generated always as identity primary key,
  uuid                 uuid not null unique,
  data_hora            timestamp(0) not null,
  placa                text not null,
  motorista            text not null,
  cpf                  text,
  km                   integer not null check (km > 0),
  litros               numeric(10, 3) not null check (litros > 0),
  encerrante           numeric(14, 3) not null check (encerrante > 0),
  encerrante_anterior  numeric(14, 3),
  bomba                integer not null,
  tanque               text,
  status               text not null check (status in ('Pronto', 'Exceção', 'Em lote', 'Lançado', 'Erro', 'Cancelado')),
  problemas            jsonb not null default '[]',
  obs_frentista        text check (length(obs_frentista) <= 500),
  obs_supervisor       text check (length(obs_supervisor) <= 500),
  frentista_id         bigint not null references frentistas (id),
  conta                text not null,
  recebido_em          timestamptz not null default now(),
  atualizado_em        timestamptz,
  lote_id              bigint references lotes (id),
  erro_kmm             text
);
create index if not exists ix_abast_placa on abastecimentos (placa, data_hora);
create index if not exists ix_abast_bomba on abastecimentos (bomba, data_hora);
create index if not exists ix_abast_status on abastecimentos (status);
create index if not exists ix_abast_data on abastecimentos (data_hora);

create table if not exists chegadas (
  id              bigint generated always as identity primary key,
  uuid            uuid not null unique,
  tanque          text not null references tanques (codigo),
  data_hora       timestamp(0) not null,
  nf              text not null check (length(nf) between 1 and 20),
  litros          numeric(10, 1) not null check (litros > 0),
  valor_total     numeric(12, 2) check (valor_total >= 0),
  regua_antes     numeric(10, 1),
  regua_depois    numeric(10, 1),
  placa_caminhao  text,
  placa_carreta   text,
  motorista       text,
  cpf             text,
  alerta          text,
  frentista_id    bigint not null references frentistas (id),
  conta           text not null,
  recebido_em     timestamptz not null default now(),
  cancelada       boolean not null default false
);

create table if not exists fechamentos (
  id               bigint generated always as identity primary key,
  tanque           text not null references tanques (codigo),
  data             date not null,
  saldo_inicial    numeric(10, 1) not null,
  chegadas         numeric(10, 1) not null,
  saidas           numeric(12, 3) not null,
  saldo_calculado  numeric(12, 3) not null,
  saldo_medido     numeric(10, 1) not null,
  diferenca        numeric(12, 3) not null,
  frentista_id     bigint references frentistas (id),
  conta            text not null,
  criado_em        timestamptz not null default now(),
  unique (tanque, data)
);

create table if not exists auditoria (
  id           bigint generated always as identity primary key,
  quando       timestamptz not null default now(),
  conta        text,
  acao         text not null,
  entidade     text,
  entidade_id  text,
  detalhes     jsonb
);

create or replace function auditar(p_acao text, p_entidade text, p_id text, p_detalhes jsonb) returns void
language sql security definer set search_path = public as $$
  insert into auditoria (conta, acao, entidade, entidade_id, detalhes) values (nullif(meu_email(), ''), p_acao, p_entidade, p_id, p_detalhes)
$$;

create or replace function bloquear_alteracao() returns trigger
language plpgsql as $$
begin
  raise exception '%', tg_argv[0] using errcode = '42501';
end $$;

-- Registra no histórico toda mudança de cadastro feita pelo painel (CPF mascarado)
create or replace function auditar_cadastro() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_novo jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
        v_velho jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
        v_chave text;
begin
  if v_novo ? 'cpf' then v_novo := v_novo || jsonb_build_object('cpf', '***' || right(v_novo ->> 'cpf', 2)); end if;
  if v_velho ? 'cpf' then v_velho := v_velho || jsonb_build_object('cpf', '***' || right(v_velho ->> 'cpf', 2)); end if;
  v_chave := coalesce(v_novo, v_velho) ->> (case tg_table_name when 'veiculos' then 'placa' when 'tanques' then 'codigo'
                                             when 'bombas' then 'numero' when 'acessos' then 'email' else 'id' end);
  perform auditar('cadastro.' || tg_table_name || '.' || lower(tg_op), tg_table_name, v_chave,
                  jsonb_build_object('antes', v_velho, 'depois', v_novo));
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['veiculos', 'motoristas', 'frentistas', 'tanques', 'bombas', 'acessos'] loop
    execute format('drop trigger if exists normalizar on %I', t);
    execute format('create trigger normalizar before insert or update on %I for each row execute function normalizar_cadastro()', t);
    execute format('drop trigger if exists auditar on %I', t);
    execute format('create trigger auditar after insert or update or delete on %I for each row execute function auditar_cadastro()', t);
  end loop;
end $$;

drop trigger if exists auditoria_imutavel on auditoria;
create trigger auditoria_imutavel before update or delete on auditoria
  for each row execute function bloquear_alteracao('Auditoria é somente inclusão.');
drop trigger if exists abastecimento_sem_delete on abastecimentos;
create trigger abastecimento_sem_delete before delete on abastecimentos
  for each row execute function bloquear_alteracao('Abastecimento não pode ser apagado; use o status Cancelado.');

-- ---------- Conferência (as mesmas regras que substituem o analista) ----------
create or replace function conferir_abastecimento(
  p_data_hora timestamp, p_placa text, p_motorista text, p_km integer, p_litros numeric,
  p_encerrante numeric, p_bomba integer, p_excluir bigint default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_placa text := normaliza_placa(p_placa);
  v_veic veiculos;
  v_mot motoristas;
  v_bomba bombas;
  v_km_ant integer;
  v_enc_ant numeric;
  v_agora timestamp := agora_local();
  p text[] := '{}';
begin
  select * into v_veic from veiculos where placa = v_placa and ativo;
  select * into v_mot from motoristas where nome = normaliza_nome(p_motorista) and ativo;
  select * into v_bomba from bombas where numero = p_bomba and ativa;

  if v_placa = '' or normaliza_nome(p_motorista) = '' then p := p || 'Placa e motorista são obrigatórios.'::text; end if;
  if not placa_valida(p_placa) and placa_valida(p_motorista) then p := p || 'Placa e nome do motorista parecem trocados de campo.'::text; end if;
  if v_veic.placa is null then p := p || format('Placa %s não cadastrada.', coalesce(nullif(v_placa, ''), '(vazia)')); end if;
  if v_mot.id is null then p := p || format('Motorista ''%s'' não cadastrado.', p_motorista);
  elsif length(v_mot.cpf) <> 11 then p := p || format('Motorista ''%s'' sem CPF válido no cadastro (o KMM exige CPF).', v_mot.nome);
  end if;

  -- KM crescente e salto razoável (só contam abastecimentos aceitos, anteriores a este)
  if v_veic.placa is not null then
    select max(km) into v_km_ant from abastecimentos
     where placa = v_placa and data_hora < p_data_hora and id is distinct from p_excluir
       and status in ('Pronto', 'Em lote', 'Lançado');
    v_km_ant := greatest(v_km_ant, v_veic.km_inicial);
    if v_km_ant is not null then
      if p_km <= v_km_ant then
        p := p || format('KM %s não é maior que o último KM da placa (%s).', fmt(p_km), fmt(v_km_ant));
      elsif p_km - v_km_ant > 3000 then
        p := p || format('Salto de KM suspeito: %s km desde o último abastecimento.', fmt(p_km - v_km_ant));
      end if;
    end if;
    if p_litros > v_veic.capacidade_l * 1.05 then
      p := p || format('%s L acima da capacidade do tanque (%s L).', fmt(p_litros), fmt(v_veic.capacidade_l));
    end if;
  end if;

  -- Encerrante da bomba crescente e igual aos litros (tolerância 1 L)
  if v_bomba.numero is null then
    p := p || format('Bomba %s não existe.', p_bomba);
  else
    select max(encerrante) into v_enc_ant from abastecimentos
     where bomba = p_bomba and data_hora < p_data_hora and id is distinct from p_excluir and status <> 'Cancelado';
    v_enc_ant := greatest(v_enc_ant, v_bomba.encerrante_inicial);
    if p_encerrante <= v_enc_ant then
      p := p || format('Encerrante %s não é maior que o anterior da bomba %s (%s).', fmt(p_encerrante), p_bomba, fmt(v_enc_ant));
    elsif abs(p_encerrante - v_enc_ant - p_litros) > 1 then
      p := p || format('Encerrante indica %s L (de %s para %s), mas foram informados %s L.',
                       fmt(p_encerrante - v_enc_ant), fmt(v_enc_ant), fmt(p_encerrante), fmt(p_litros));
    end if;
  end if;

  if exists (select 1 from abastecimentos
              where placa = v_placa and date_trunc('minute', data_hora) = date_trunc('minute', p_data_hora)
                and abs(litros - p_litros) < 0.005 and status <> 'Cancelado' and id is distinct from p_excluir) then
    p := p || 'Registro duplicado (mesma placa, hora e litros).'::text;
  end if;

  if p_data_hora > v_agora + interval '10 minutes' then
    p := p || format('Hora %s está no futuro. Confira o relógio do celular.', to_char(p_data_hora, 'DD/MM HH24:MI'));
  elsif p_data_hora < v_agora - interval '7 days' then
    p := p || format('Abastecimento de %s, mais de 7 dias atrás.', to_char(p_data_hora, 'DD/MM/YYYY'));
  end if;

  return jsonb_build_object(
    'placa', v_placa,
    'motorista', coalesce(v_mot.nome, normaliza_nome(p_motorista)),
    'cpf', v_mot.cpf,
    'tanque', v_bomba.tanque,
    'encerrante_anterior', v_enc_ant,
    'problemas', to_jsonb(p),
    'status', case when cardinality(p) > 0 then 'Exceção' else 'Pronto' end);
end $$;

-- ---------- Funções chamadas pelo celular ----------
create or replace function calcular_fechamento(p_dia date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb := '[]'; t tanques; v_ini numeric; v_ent numeric; v_sai numeric; v_fech fechamentos;
begin
  perform exigir(array['posto', 'supervisor']);
  for t in select * from tanques order by codigo loop
    select saldo_medido into v_ini from fechamentos where tanque = t.codigo and data < p_dia order by data desc limit 1;
    v_ini := coalesce(v_ini, t.saldo_inicial);
    select coalesce(sum(litros), 0) into v_ent from chegadas
     where tanque = t.codigo and data_hora::date = p_dia and not cancelada;
    select coalesce(sum(encerrante - encerrante_anterior), 0) into v_sai from abastecimentos
     where tanque = t.codigo and data_hora::date = p_dia and status <> 'Cancelado' and encerrante > encerrante_anterior;
    select * into v_fech from fechamentos where tanque = t.codigo and data = p_dia;
    v := v || jsonb_build_object('tanque', t.codigo, 'capacidade_l', t.capacidade_l, 'saldo_inicial', v_ini,
              'chegadas', v_ent, 'saidas', v_sai, 'saldo_calculado', v_ini + v_ent - v_sai,
              'fechado', case when v_fech.id is null then null else to_jsonb(v_fech) end);
  end loop;
  return v;
end $$;

create or replace function estado_posto() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_papel text := exigir(array['posto', 'supervisor']); v_hoje date := hoje();
begin
  return jsonb_build_object(
    'gerado_em', agora_local(),
    'dia', v_hoje,
    'papel', v_papel,
    'conta', meu_email(),
    'frentistas', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nome', nome) order by nome) from frentistas where ativo), '[]'),
    'veiculos', coalesce((select jsonb_agg(jsonb_build_object(
        'placa', v.placa, 'capacidade_l', v.capacidade_l,
        'km_anterior', greatest(v.km_inicial, (select max(km) from abastecimentos a where a.placa = v.placa and a.status in ('Pronto', 'Em lote', 'Lançado'))),
        'motorista_sugerido', (select a.motorista from abastecimentos a where a.placa = v.placa order by a.id desc limit 1)
      ) order by v.placa) from veiculos v where v.ativo), '[]'),
    -- O celular não recebe CPF
    'motoristas', coalesce((select jsonb_agg(nome order by nome) from motoristas where ativo), '[]'),
    'bombas', coalesce((select jsonb_agg(jsonb_build_object(
        'numero', b.numero, 'tanque', b.tanque,
        'encerrante_anterior', greatest(b.encerrante_inicial, (select max(encerrante) from abastecimentos a where a.bomba = b.numero and a.status <> 'Cancelado'))
      ) order by b.numero) from bombas b where b.ativa), '[]'),
    'tanques', calcular_fechamento(v_hoje),
    'hoje', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'uuid', a.uuid, 'data_hora', a.data_hora, 'placa', a.placa, 'motorista', a.motorista, 'km', a.km,
        'litros', a.litros, 'encerrante', a.encerrante, 'bomba', a.bomba, 'status', a.status, 'problemas', a.problemas,
        'frentista', f.nome) order by a.data_hora desc)
      from abastecimentos a join frentistas f on f.id = a.frentista_id where a.data_hora::date = v_hoje), '[]'));
end $$;

create or replace function registrar_abastecimentos(p_registros jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_ex abastecimentos; c jsonb; v_id bigint; v_res jsonb := '[]';
  v_dh timestamp; v_km integer; v_lt numeric; v_enc numeric; v_bomba integer; v_frent bigint;
begin
  perform exigir(array['posto', 'supervisor']);
  if jsonb_typeof(p_registros) <> 'array' or jsonb_array_length(p_registros) > 200 then
    raise exception 'Envie de 1 a 200 registros por vez.' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_registros) order by value ->> 'data_hora' loop
    select * into v_ex from abastecimentos where uuid = (r ->> 'uuid')::uuid;
    if v_ex.id is not null then   -- reenvio do celular: devolve o que já foi gravado
      v_res := v_res || jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'status', v_ex.status, 'problemas', v_ex.problemas);
      continue;
    end if;
    v_dh := date_trunc('second', (r ->> 'data_hora')::timestamp);
    v_km := (r ->> 'km')::integer; v_lt := (r ->> 'litros')::numeric; v_enc := (r ->> 'encerrante')::numeric;
    v_bomba := (r ->> 'bomba')::integer; v_frent := (r ->> 'frentista_id')::bigint;
    if v_km is null or v_km <= 0 or v_km >= 10000000 or v_lt is null or v_lt <= 0 or v_lt >= 5000
       or v_enc is null or v_enc <= 0 or v_bomba is null or v_bomba not between 1 and 99 then
      raise exception 'Valores fora do permitido no registro %.', r ->> 'uuid' using errcode = '22023';
    end if;
    if not exists (select 1 from frentistas where id = v_frent and ativo) then
      raise exception 'Frentista não cadastrado ou desativado.' using errcode = '22023';
    end if;
    c := conferir_abastecimento(v_dh, r ->> 'placa', r ->> 'motorista', v_km, v_lt, v_enc, v_bomba);
    insert into abastecimentos (uuid, data_hora, placa, motorista, cpf, km, litros, encerrante, encerrante_anterior,
                                bomba, tanque, status, problemas, obs_frentista, frentista_id, conta)
    values ((r ->> 'uuid')::uuid, v_dh, c ->> 'placa', c ->> 'motorista', c ->> 'cpf', v_km, v_lt, v_enc,
            (c ->> 'encerrante_anterior')::numeric, v_bomba, c ->> 'tanque', c ->> 'status', c -> 'problemas',
            left(nullif(trim(r ->> 'obs'), ''), 500), v_frent, meu_email())
    returning id into v_id;
    perform auditar('abastecimento.recebido', 'abastecimento', v_id::text,
                    jsonb_build_object('placa', c ->> 'placa', 'litros', v_lt, 'status', c ->> 'status', 'frentista_id', v_frent));
    v_res := v_res || jsonb_build_object('uuid', r ->> 'uuid', 'id', v_id, 'status', c ->> 'status', 'problemas', c -> 'problemas');
  end loop;
  return v_res;
end $$;

create or replace function registrar_chegadas(p_registros jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; v_ex chegadas; v_id bigint; v_res jsonb := '[]'; v_alerta text; v_sub numeric; v_lt numeric;
begin
  perform exigir(array['posto', 'supervisor']);
  if jsonb_typeof(p_registros) <> 'array' or jsonb_array_length(p_registros) > 50 then
    raise exception 'Envie de 1 a 50 chegadas por vez.' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_registros) loop
    select * into v_ex from chegadas where uuid = (r ->> 'uuid')::uuid;
    if v_ex.id is not null then
      v_res := v_res || jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'alerta', v_ex.alerta);
      continue;
    end if;
    if not exists (select 1 from frentistas where id = (r ->> 'frentista_id')::bigint and ativo) then
      raise exception 'Frentista não cadastrado ou desativado.' using errcode = '22023';
    end if;
    v_lt := (r ->> 'litros')::numeric;
    v_alerta := null;
    if r ->> 'regua_antes' is not null and r ->> 'regua_depois' is not null then
      v_sub := (r ->> 'regua_depois')::numeric - (r ->> 'regua_antes')::numeric;
      if abs(v_sub - v_lt) > 20 then
        v_alerta := format('NF diz %s L, mas a régua subiu %s L.', fmt(v_lt), fmt(v_sub));
      end if;
    end if;
    insert into chegadas (uuid, tanque, data_hora, nf, litros, valor_total, regua_antes, regua_depois, placa_caminhao,
                          placa_carreta, motorista, cpf, alerta, frentista_id, conta)
    values ((r ->> 'uuid')::uuid, upper(r ->> 'tanque'), date_trunc('second', (r ->> 'data_hora')::timestamp), trim(r ->> 'nf'),
            v_lt, (r ->> 'valor_total')::numeric, (r ->> 'regua_antes')::numeric, (r ->> 'regua_depois')::numeric,
            nullif(normaliza_placa(r ->> 'placa_caminhao'), ''), nullif(normaliza_placa(r ->> 'placa_carreta'), ''),
            left(r ->> 'motorista', 120), nullif(regexp_replace(coalesce(r ->> 'cpf', ''), '\D', '', 'g'), ''),
            v_alerta, (r ->> 'frentista_id')::bigint, meu_email())
    returning id into v_id;
    perform auditar('chegada.recebida', 'chegada', v_id::text, jsonb_build_object('nf', r ->> 'nf', 'litros', v_lt));
    v_res := v_res || jsonb_build_object('uuid', r ->> 'uuid', 'id', v_id, 'alerta', v_alerta);
  end loop;
  return v_res;
end $$;

create or replace function registrar_fechamento(p_medidos jsonb, p_frentista_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dia date := hoje(); t jsonb; v_med numeric; v_dif numeric; v_res jsonb := '[]';
begin
  perform exigir(array['posto', 'supervisor']);
  if not exists (select 1 from frentistas where id = p_frentista_id and ativo) then
    raise exception 'Frentista não cadastrado ou desativado.' using errcode = '22023';
  end if;
  if exists (select 1 from fechamentos where data = v_dia) then
    raise exception 'O dia já foi fechado.' using errcode = '22023';
  end if;
  for t in select value from jsonb_array_elements(calcular_fechamento(v_dia)) loop
    v_med := (p_medidos ->> (t ->> 'tanque'))::numeric;
    if v_med is null or v_med < 0 then
      raise exception 'Informe a medição do tanque %.', t ->> 'tanque' using errcode = '22023';
    end if;
    v_dif := v_med - (t ->> 'saldo_calculado')::numeric;
    insert into fechamentos (tanque, data, saldo_inicial, chegadas, saidas, saldo_calculado, saldo_medido, diferenca, frentista_id, conta)
    values (t ->> 'tanque', v_dia, (t ->> 'saldo_inicial')::numeric, (t ->> 'chegadas')::numeric, (t ->> 'saidas')::numeric,
            (t ->> 'saldo_calculado')::numeric, v_med, v_dif, p_frentista_id, meu_email());
    v_res := v_res || jsonb_build_object('tanque', t ->> 'tanque', 'saldo_calculado', (t ->> 'saldo_calculado')::numeric,
                                         'saldo_medido', v_med, 'diferenca', v_dif, 'alerta', abs(v_dif) > 20);
  end loop;
  perform auditar('fechamento.registrado', 'fechamento', v_dia::text, jsonb_build_object('medidos', p_medidos, 'frentista_id', p_frentista_id));
  return v_res;
end $$;

-- ---------- Funções do painel do supervisor ----------
create or replace function decidir_abastecimento(p_id bigint, p_acao text, p_motivo text, p_alteracoes jsonb default '{}')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_antes abastecimentos; v_depois abastecimentos; c jsonb; v_status text; v_dh timestamp;
        v_placa text; v_mot text; v_km integer; v_lt numeric; v_enc numeric; v_bomba integer;
begin
  perform exigir(array['supervisor']);
  if p_acao not in ('revalidar', 'aprovar', 'cancelar') then raise exception 'Ação inválida.' using errcode = '22023'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Escreva o motivo da decisão.' using errcode = '22023'; end if;
  select * into v_antes from abastecimentos where id = p_id for update;
  if v_antes.id is null then raise exception 'Abastecimento não encontrado.' using errcode = 'P0002'; end if;
  if v_antes.status not in ('Pronto', 'Exceção', 'Erro') then
    raise exception 'Registro com status % não pode ser alterado aqui. Corrija no KMM.', v_antes.status using errcode = '22023';
  end if;
  if p_acao = 'cancelar' then
    update abastecimentos set status = 'Cancelado', obs_supervisor = left(p_motivo, 500), atualizado_em = now() where id = p_id;
  else
    v_dh := coalesce(date_trunc('second', (p_alteracoes ->> 'data_hora')::timestamp), v_antes.data_hora);
    v_placa := coalesce(p_alteracoes ->> 'placa', v_antes.placa);
    v_mot := coalesce(p_alteracoes ->> 'motorista', v_antes.motorista);
    v_km := coalesce((p_alteracoes ->> 'km')::integer, v_antes.km);
    v_lt := coalesce((p_alteracoes ->> 'litros')::numeric, v_antes.litros);
    v_enc := coalesce((p_alteracoes ->> 'encerrante')::numeric, v_antes.encerrante);
    v_bomba := coalesce((p_alteracoes ->> 'bomba')::integer, v_antes.bomba);
    if v_km <= 0 or v_lt <= 0 or v_lt >= 5000 or v_enc <= 0 then raise exception 'Valores fora do permitido.' using errcode = '22023'; end if;
    c := conferir_abastecimento(v_dh, v_placa, v_mot, v_km, v_lt, v_enc, v_bomba, p_id);
    v_status := c ->> 'status';
    if p_acao = 'aprovar' then
      if c ->> 'cpf' is null then raise exception 'Não dá para aprovar: motorista sem cadastro ou sem CPF.' using errcode = '22023'; end if;
      if c ->> 'tanque' is null then raise exception 'Não dá para aprovar: bomba inexistente.' using errcode = '22023'; end if;
      v_status := 'Pronto';
    end if;
    update abastecimentos set data_hora = v_dh, placa = c ->> 'placa', motorista = c ->> 'motorista', cpf = c ->> 'cpf',
           km = v_km, litros = v_lt, encerrante = v_enc, encerrante_anterior = (c ->> 'encerrante_anterior')::numeric,
           bomba = v_bomba, tanque = c ->> 'tanque', status = v_status, problemas = c -> 'problemas',
           obs_supervisor = left(p_motivo, 500), erro_kmm = null, lote_id = null, atualizado_em = now()
     where id = p_id;
  end if;
  select * into v_depois from abastecimentos where id = p_id;
  perform auditar('abastecimento.' || p_acao, 'abastecimento', p_id::text, jsonb_build_object(
    'motivo', p_motivo,
    'alterado', (select coalesce(jsonb_object_agg(a.key, jsonb_build_array(a.value, d.value)), '{}')
                   from jsonb_each(to_jsonb(v_antes) - 'atualizado_em' - 'cpf') a
                   join jsonb_each(to_jsonb(v_depois) - 'atualizado_em' - 'cpf') d using (key)
                  where a.value is distinct from d.value)));
  return to_jsonb(v_depois) - 'cpf';
end $$;

create or replace function marcar_erro_kmm(p_id bigint, p_mensagem text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exigir(array['supervisor']);
  if length(trim(coalesce(p_mensagem, ''))) < 3 then raise exception 'Escreva a mensagem do KMM.' using errcode = '22023'; end if;
  update abastecimentos set status = 'Erro', erro_kmm = left(p_mensagem, 1000), atualizado_em = now()
   where id = p_id and status = 'Em lote';
  if not found then raise exception 'Só registros "Em lote" podem ser marcados com erro do KMM.' using errcode = '22023'; end if;
  perform auditar('abastecimento.erro_kmm', 'abastecimento', p_id::text, jsonb_build_object('mensagem', p_mensagem));
end $$;

-- Linhas no layout do importador "Abastecimento interno" do KMM (a planilha é montada no painel)
create or replace function linhas_lote(p_lote bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform exigir(array['supervisor']);
  return coalesce((select jsonb_agg(jsonb_build_object('requisicao', id, 'data_hora', data_hora, 'placa', placa, 'cpf', cpf,
                   'km', km, 'litros', litros, 'bomba', bomba) order by data_hora, id)
                   from abastecimentos where lote_id = p_lote), '[]');
end $$;

create or replace function gerar_lote() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_qtd integer; v_lt numeric; v_sem_cpf text;
begin
  perform exigir(array['supervisor']);
  perform 1 from abastecimentos where status = 'Pronto' for update;
  select count(*), coalesce(sum(litros), 0) into v_qtd, v_lt from abastecimentos where status = 'Pronto';
  if v_qtd = 0 then raise exception 'Não há abastecimentos prontos para o KMM.' using errcode = '22023'; end if;
  select string_agg(id::text, ', ') into v_sem_cpf from abastecimentos where status = 'Pronto' and (cpf is null or length(cpf) <> 11);
  if v_sem_cpf is not null then
    raise exception 'Registros sem CPF de motorista: %. Corrija o cadastro e revise.', v_sem_cpf using errcode = '22023';
  end if;
  insert into lotes (criado_por, quantidade, litros, situacao) values (meu_email(), v_qtd, v_lt, 'Gerado') returning id into v_id;
  update abastecimentos set status = 'Em lote', lote_id = v_id, atualizado_em = now() where status = 'Pronto';
  perform auditar('lote.gerado', 'lote', v_id::text, jsonb_build_object('quantidade', v_qtd, 'litros', v_lt));
  return jsonb_build_object('id', v_id, 'quantidade', v_qtd, 'litros', v_lt, 'linhas', linhas_lote(v_id));
end $$;

create or replace function fechar_lote(p_lote bigint, p_acao text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_lote lotes; v_n integer;
begin
  perform exigir(array['supervisor']);
  select * into v_lote from lotes where id = p_lote for update;
  if v_lote.id is null then raise exception 'Lote não encontrado.' using errcode = 'P0002'; end if;
  if v_lote.situacao <> 'Gerado' then raise exception 'Lote já está %.', lower(v_lote.situacao) using errcode = '22023'; end if;
  if p_acao = 'confirmar' then
    update abastecimentos set status = 'Lançado', atualizado_em = now() where lote_id = p_lote and status = 'Em lote';
    get diagnostics v_n = row_count;
    update lotes set situacao = 'Confirmado', fechado_em = now(), fechado_por = meu_email() where id = p_lote;
  elsif p_acao = 'desfazer' then
    update abastecimentos set status = 'Pronto', lote_id = null, atualizado_em = now() where lote_id = p_lote and status = 'Em lote';
    get diagnostics v_n = row_count;
    update lotes set situacao = 'Desfeito', fechado_em = now(), fechado_por = meu_email() where id = p_lote;
  else
    raise exception 'Ação inválida.' using errcode = '22023';
  end if;
  perform auditar('lote.' || p_acao, 'lote', p_lote::text, jsonb_build_object('registros', v_n));
  return jsonb_build_object('id', p_lote, 'situacao', case p_acao when 'confirmar' then 'Confirmado' else 'Desfeito' end, 'registros', v_n);
end $$;

-- ---------- RLS: ninguém vê nada sem estar em "acessos" ----------
do $$
declare t text;
begin
  foreach t in array array['acessos', 'frentistas', 'veiculos', 'motoristas', 'tanques', 'bombas',
                           'lotes', 'abastecimentos', 'chegadas', 'fechamentos', 'auditoria'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon', t);
    execute format('drop policy if exists supervisor_le on %I', t);
    execute format('create policy supervisor_le on %I for select to authenticated using (meu_papel() = ''supervisor'')', t);
  end loop;
  -- Cadastros: o supervisor edita direto (com histórico automático pelos gatilhos)
  foreach t in array array['acessos', 'frentistas', 'veiculos', 'motoristas', 'tanques', 'bombas'] loop
    execute format('drop policy if exists supervisor_edita on %I', t);
    execute format('create policy supervisor_edita on %I for all to authenticated using (meu_papel() = ''supervisor'') with check (meu_papel() = ''supervisor'')', t);
  end loop;
  -- Movimento (abastecimentos, chegadas, fechamentos, lotes) e auditoria: só pelas funções acima
end $$;

-- ---------- Quem pode chamar cada função ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as assinatura from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.assinatura);
  end loop;
end $$;

grant execute on function meu_email(), meu_papel(), estado_posto(), registrar_abastecimentos(jsonb), registrar_chegadas(jsonb),
  registrar_fechamento(jsonb, bigint), decidir_abastecimento(bigint, text, text, jsonb), marcar_erro_kmm(bigint, text),
  gerar_lote(), linhas_lote(bigint), fechar_lote(bigint, text), calcular_fechamento(date)
  to authenticated;
-- As políticas RLS e os gatilhos chamam estas; precisam estar liberadas para quem está logado
grant execute on function exigir(text[]), agora_local(), hoje(), normaliza_placa(text), normaliza_nome(text), placa_valida(text),
  cpf_valido(text), fmt(numeric), normalizar_cadastro(), auditar_cadastro(), bloquear_alteracao()
  to authenticated;
