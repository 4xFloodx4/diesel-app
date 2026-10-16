-- =====================================================================================
-- Lançamento de diesel: banco de dados (Supabase / PostgreSQL 15+)
--
-- Como aplicar: Supabase > SQL Editor > cole este arquivo inteiro > Run.
-- Pode ser rodado de novo: cria o que falta e atualiza funções e regras sem apagar dados.
--
-- Quem é quem:
--  * administrador: tudo no painel. Só o dono do projeto (SQL Editor) cria, altera ou remove administradores.
--  * supervisor:    painel; gerencia frentistas, cadastros e contas de celular; autoriza lançamentos;
--                   vê a auditoria, menos as ações de administradores.
--  * posto:         conta Google do celular. Nele cada frentista entra com nome + PIN.
--
-- Segurança:
--  * Toda tabela tem RLS. Só contas Google cadastradas em "acessos" enxergam alguma coisa.
--  * O celular não grava direto em tabela nenhuma: só pelas funções do app, que conferem tudo aqui dentro.
--  * Abastecimento nunca é apagado; auditoria não pode ser alterada nem apagada; fotos só o supervisor exclui.
-- =====================================================================================

-- ---------- Acesso ----------
create table if not exists acessos (
  email      text primary key check (email = lower(email) and email like '%@%'),
  nome       text not null,
  papel      text not null,
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);
alter table acessos drop constraint if exists acessos_papel_check;
alter table acessos add constraint acessos_papel_check check (papel in ('posto', 'supervisor', 'administrador'));

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

create or replace function sou_gestor() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(meu_papel() in ('supervisor', 'administrador'), false)
$$;

-- O administrador pode tudo que o supervisor pode
create or replace function exigir(p_papeis text[]) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_papel text := meu_papel();
begin
  if v_papel is null or not (v_papel = any (p_papeis)
                             or (v_papel = 'administrador' and 'supervisor' = any (p_papeis))) then
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

-- Caminho de foto no Storage: pasta/uuid.jpg (o app gera o uuid)
create or replace function foto_valida(p_caminho text, p_pasta text) returns boolean
language sql immutable as $$
  select coalesce(p_caminho ~ ('^' || p_pasta || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'), false)
$$;

-- ---------- Configurações (uma linha só) ----------
create table if not exists configuracoes (
  id             integer primary key default 1 check (id = 1),
  abertura       time not null default '05:00',
  fechamento     time not null default '23:00',
  atualizado_em  timestamptz not null default now(),
  check (abertura <> fechamento)
);
insert into configuracoes (id) values (1) on conflict (id) do nothing;

-- Fora do turno: antes da abertura ou a partir do fechamento (aceita turno que vira a meia-noite)
create or replace function fora_do_turno(p_dh timestamp) returns boolean
language sql stable security definer set search_path = public as $$
  select case when c.abertura < c.fechamento then p_dh::time < c.abertura or p_dh::time >= c.fechamento
              else p_dh::time < c.abertura and p_dh::time >= c.fechamento end
    from configuracoes c where c.id = 1
$$;

-- ---------- Cadastros ----------
create table if not exists frentistas (
  id     bigint generated always as identity primary key,
  nome   text not null unique,
  ativo  boolean not null default true
);

-- PIN dos frentistas fica numa tabela à parte, que ninguém lê: nem o painel
create table if not exists frentistas_pin (
  frentista_id   bigint primary key references frentistas (id) on delete cascade,
  hash           text not null,
  sal            text not null,
  falhas         integer not null default 0,
  bloqueado_ate  timestamptz,
  alterado_em    timestamptz not null default now()
);
alter table frentistas_pin add column if not exists falhas_dia integer not null default 0;
alter table frentistas_pin add column if not exists dia_falhas date;

create table if not exists sessoes_frentista (
  token_hash    text primary key,
  frentista_id  bigint not null references frentistas (id) on delete cascade,
  conta         text not null,
  criado_em     timestamptz not null default now(),
  expira_em     timestamptz not null
);

create table if not exists veiculos (
  placa         text primary key check (placa ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'),
  capacidade_l  numeric(8, 1) not null check (capacidade_l > 0 and capacidade_l < 5000),
  km_inicial    integer check (km_inicial >= 0),
  ativo         boolean not null default true
);
alter table veiculos add column if not exists criado_por text;
alter table veiculos add column if not exists criado_em timestamptz default now();

create table if not exists motoristas (
  id     bigint generated always as identity primary key,
  nome   text not null unique,
  cpf    text not null check (cpf ~ '^\d{11}$' and cpf_valido(cpf)),
  ativo  boolean not null default true
);
alter table motoristas add column if not exists criado_por text;
alter table motoristas add column if not exists criado_em timestamptz default now();

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
  status               text not null,
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
-- Desconto do diesel no acerto do motorista: sem desconto, o lançamento precisa de autorização
alter table abastecimentos add column if not exists desconto_confirmado boolean not null default true;
alter table abastecimentos add column if not exists justificativa_desconto text check (length(justificativa_desconto) <= 500);
alter table abastecimentos add column if not exists autorizado_por text;
alter table abastecimentos add column if not exists autorizado_em timestamptz;
alter table abastecimentos add column if not exists fora_horario boolean not null default false;
alter table abastecimentos add column if not exists justificativa_horario text check (length(justificativa_horario) <= 500);
alter table abastecimentos drop constraint if exists abastecimentos_status_check;
alter table abastecimentos add constraint abastecimentos_status_check check (status in
  ('Aguardando autorização', 'Pronto', 'Exceção', 'Em lote', 'Lançado', 'Erro', 'Cancelado'));
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

-- Fotos (os arquivos ficam no Storage, bucket "fotos"; aqui fica a qual registro cada uma pertence)
create table if not exists fotos (
  id            bigint generated always as identity primary key,
  entidade      text not null check (entidade in ('fechamento', 'chegada', 'veiculo')),
  chave         text not null,
  caminho       text not null unique,
  frentista_id  bigint references frentistas (id),
  conta         text not null,
  criado_em     timestamptz not null default now()
);
create index if not exists ix_fotos_chave on fotos (entidade, chave);

create table if not exists auditoria (
  id           bigint generated always as identity primary key,
  quando       timestamptz not null default now(),
  conta        text,
  acao         text not null,
  entidade     text,
  entidade_id  text,
  detalhes     jsonb
);
alter table auditoria add column if not exists papel text;   -- papel de quem fez (o supervisor não vê ações de administradores)

create or replace function auditar(p_acao text, p_entidade text, p_id text, p_detalhes jsonb) returns void
language sql security definer set search_path = public as $$
  insert into auditoria (conta, papel, acao, entidade, entidade_id, detalhes)
  values (nullif(meu_email(), ''), meu_papel(), p_acao, p_entidade, p_id, p_detalhes)
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

-- Contas Google:
--  * administradores só pelo dono do projeto (SQL Editor do Supabase): ninguém no painel cria, altera ou remove;
--  * supervisor gerencia só contas de celular do posto; administrador gerencia supervisores e celulares.
create or replace function proteger_acessos() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_papel text := meu_papel();
begin
  if meu_email() = '' then return coalesce(new, old); end if;   -- SQL Editor: dono do projeto
  if (tg_op <> 'INSERT' and old.papel = 'administrador') or (tg_op <> 'DELETE' and new.papel = 'administrador') then
    raise exception 'Administradores só podem ser criados, alterados ou removidos pelo dono do projeto no Supabase.'
      using errcode = '42501';
  end if;
  if v_papel is distinct from 'administrador'
     and ((tg_op <> 'INSERT' and old.papel <> 'posto') or (tg_op <> 'DELETE' and new.papel <> 'posto')) then
    raise exception 'O supervisor só gerencia contas de celular do posto.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists proteger on acessos;
create trigger proteger before insert or update or delete on acessos
  for each row execute function proteger_acessos();

do $$
declare t text;
begin
  foreach t in array array['veiculos', 'motoristas', 'frentistas', 'tanques', 'bombas', 'acessos', 'configuracoes'] loop
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
drop trigger if exists fotos_imutaveis on fotos;
create trigger fotos_imutaveis before update on fotos
  for each row execute function bloquear_alteracao('Foto registrada não pode ser alterada; exclua e envie outra.');

-- ---------- Login do frentista (nome + PIN no celular do posto) ----------
create or replace function hash_pin(p_pin text, p_sal text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p_sal || ':' || p_pin, 'UTF8')), 'hex') $$;

create or replace function definir_pin(p_frentista_id bigint, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
declare v_sal text := replace(gen_random_uuid()::text, '-', '');
begin
  perform exigir(array['supervisor']);
  if p_pin !~ '^\d{4}$' then raise exception 'O PIN deve ter 4 números.' using errcode = '22023'; end if;
  if p_pin in ('0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '9876') then
    raise exception 'PIN fácil demais. Escolha outro.' using errcode = '22023';
  end if;
  if not exists (select 1 from frentistas where id = p_frentista_id) then
    raise exception 'Frentista não encontrado.' using errcode = 'P0002';
  end if;
  insert into frentistas_pin (frentista_id, hash, sal) values (p_frentista_id, hash_pin(p_pin, v_sal), v_sal)
  on conflict (frentista_id) do update set hash = excluded.hash, sal = excluded.sal, falhas = 0, falhas_dia = 0, dia_falhas = null,
                                           bloqueado_ate = null, alterado_em = now();
  delete from sessoes_frentista where frentista_id = p_frentista_id;   -- PIN novo derruba quem estava logado
  perform auditar('frentista.pin_definido', 'frentistas', p_frentista_id::text, null);
end $$;

-- Não lança erro quando o PIN está errado: o contador de tentativas precisa ser gravado.
create or replace function entrar_frentista(p_frentista_id bigint, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_pin frentistas_pin; v_f frentistas; v_token text; v_falhas integer; v_dia integer;
begin
  perform exigir(array['posto', 'supervisor']);
  select * into v_f from frentistas where id = p_frentista_id and ativo;
  select * into v_pin from frentistas_pin where frentista_id = p_frentista_id;
  if v_f.id is null or v_pin.frentista_id is null then
    return jsonb_build_object('ok', false, 'erro', 'Frentista sem PIN cadastrado. Peça ao supervisor.');
  end if;
  if v_pin.bloqueado_ate = 'infinity' then
    return jsonb_build_object('ok', false, 'erro', 'Bloqueado por muitas tentativas erradas hoje. Peça ao supervisor um PIN novo.');
  end if;
  if v_pin.bloqueado_ate > now() then
    return jsonb_build_object('ok', false, 'erro', format('Bloqueado por tentativas erradas. Tente às %s ou peça ao supervisor um PIN novo.',
                              to_char(v_pin.bloqueado_ate at time zone 'America/Sao_Paulo', 'HH24:MI')));
  end if;
  if hash_pin(coalesce(p_pin, ''), v_pin.sal) <> v_pin.hash then
    v_falhas := v_pin.falhas + 1;
    v_dia := case when v_pin.dia_falhas = hoje() then v_pin.falhas_dia else 0 end + 1;
    update frentistas_pin set falhas = case when v_falhas >= 5 then 0 else v_falhas end, falhas_dia = v_dia, dia_falhas = hoje(),
           bloqueado_ate = case when v_dia >= 15 then 'infinity'::timestamptz
                                when v_falhas >= 5 then now() + interval '5 minutes' end
     where frentista_id = p_frentista_id;
    perform auditar('frentista.pin_errado', 'frentistas', p_frentista_id::text,
                    jsonb_build_object('tentativa', v_falhas, 'no_dia', v_dia, 'frentista', v_f.nome));
    return jsonb_build_object('ok', false, 'erro', case when v_dia >= 15 then 'Muitas tentativas erradas hoje. Peça ao supervisor um PIN novo.'
                                                        when v_falhas >= 5 then 'PIN errado 5 vezes. Bloqueado por 5 minutos.'
                                                        else format('PIN errado. Restam %s tentativa(s).', 5 - v_falhas) end);
  end if;
  update frentistas_pin set falhas = 0, bloqueado_ate = null where frentista_id = p_frentista_id;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into sessoes_frentista (token_hash, frentista_id, conta, expira_em)
  values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_frentista_id, meu_email(), now() + interval '30 days');
  delete from sessoes_frentista where expira_em < now();
  perform auditar('frentista.entrou', 'frentistas', p_frentista_id::text, jsonb_build_object('frentista', v_f.nome));
  return jsonb_build_object('ok', true, 'sessao', v_token, 'frentista', jsonb_build_object('id', v_f.id, 'nome', v_f.nome));
end $$;

create or replace function frentista_da_sessao(p_sessao text) returns bigint
language plpgsql stable security definer set search_path = public as $$
declare v_id bigint;
begin
  select s.frentista_id into v_id from sessoes_frentista s join frentistas f on f.id = s.frentista_id
   where s.token_hash = encode(sha256(convert_to(coalesce(p_sessao, ''), 'UTF8')), 'hex')
     and s.expira_em > now() and s.conta = meu_email() and f.ativo;
  if v_id is null then
    raise exception 'Login do frentista expirou. Entre de novo com seu nome e PIN.' using errcode = '28000';
  end if;
  return v_id;
end $$;

drop function if exists sair_frentista(text);
create or replace function sair_frentista(p_sessao text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exigir(array['posto', 'supervisor']);
  delete from sessoes_frentista where token_hash = encode(sha256(convert_to(coalesce(p_sessao, ''), 'UTF8')), 'hex')
     and conta = meu_email();
end $$;

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

-- Liga as fotos já enviadas ao Storage a um registro
create or replace function registrar_fotos(p_entidade text, p_chave text, p_fotos text[], p_frentista bigint) returns integer
language plpgsql security definer set search_path = public as $$
declare v_caminho text; v_n integer := 0;
begin
  if coalesce(cardinality(p_fotos), 0) > 10 then raise exception 'No máximo 10 fotos por registro.' using errcode = '22023'; end if;
  foreach v_caminho in array coalesce(p_fotos, '{}') loop
    if not foto_valida(v_caminho, p_entidade) then raise exception 'Foto inválida: %', v_caminho using errcode = '22023'; end if;
    insert into fotos (entidade, chave, caminho, frentista_id, conta) values (p_entidade, p_chave, v_caminho, p_frentista, meu_email())
    on conflict (caminho) do nothing;
    v_n := v_n + 1;
  end loop;
  return v_n;
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

drop function if exists estado_posto();
create or replace function estado_posto() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_papel text := exigir(array['posto', 'supervisor']); v_hoje date := hoje();
begin
  return jsonb_build_object(
    'gerado_em', agora_local(),
    'dia', v_hoje,
    'papel', v_papel,
    'conta', meu_email(),
    'frentistas', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome,
        'tem_pin', exists (select 1 from frentistas_pin p where p.frentista_id = f.id)) order by f.nome)
      from frentistas f where f.ativo), '[]'),
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
    'turno', (select jsonb_build_object('abertura', to_char(abertura, 'HH24:MI'), 'fechamento', to_char(fechamento, 'HH24:MI'))
                from configuracoes where id = 1),
    'fechado_hoje', exists (select 1 from fechamentos where data = v_hoje),
    'hoje', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'uuid', a.uuid, 'data_hora', a.data_hora, 'placa', a.placa, 'motorista', a.motorista, 'km', a.km,
        'litros', a.litros, 'encerrante', a.encerrante, 'bomba', a.bomba, 'status', a.status, 'problemas', a.problemas,
        'desconto_confirmado', a.desconto_confirmado, 'fora_horario', a.fora_horario, 'frentista', f.nome) order by a.data_hora desc)
      from abastecimentos a join frentistas f on f.id = a.frentista_id where a.data_hora::date = v_hoje), '[]'));
end $$;

-- Versões antigas (antes do login do frentista)
drop function if exists registrar_abastecimentos(jsonb);
drop function if exists registrar_chegadas(jsonb);
drop function if exists registrar_fechamento(jsonb, bigint);

-- Data e hora de um lançamento novo: nem no futuro, nem antiga, nem num dia já fechado
create or replace function validar_data_lancamento(p_dh timestamp) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_dh is null then raise exception 'Informe a data e a hora.' using errcode = '22023'; end if;
  if p_dh > agora_local() + interval '10 minutes' then
    raise exception 'A hora % está no futuro. Confira o relógio do celular.', to_char(p_dh, 'DD/MM HH24:MI') using errcode = '22023';
  end if;
  if p_dh < agora_local() - interval '7 days' then
    raise exception 'Lançamento de mais de 7 dias atrás não é aceito pelo app. Fale com o supervisor.' using errcode = '22023';
  end if;
  if exists (select 1 from fechamentos where data = p_dh::date) then
    raise exception 'O turno de % já foi fechado. Lançamentos desse dia não são mais aceitos.', to_char(p_dh, 'DD/MM') using errcode = '22023';
  end if;
end $$;

create or replace function registrar_abastecimento(p_sessao text, p_dados jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb := p_dados; v_ex abastecimentos; c jsonb; v_id bigint; v_status text;
  v_dh timestamp; v_km integer; v_lt numeric; v_enc numeric; v_bomba integer; v_frent bigint;
  v_desconto boolean; v_just text; v_fora boolean; v_just_h text; v_c configuracoes;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  select * into v_ex from abastecimentos where uuid = (r ->> 'uuid')::uuid;
  if v_ex.id is not null then   -- toque duplo ou reenvio: devolve o que já foi gravado
    return jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'status', v_ex.status, 'problemas', v_ex.problemas);
  end if;
  v_dh := date_trunc('second', (r ->> 'data_hora')::timestamp);
  v_km := (r ->> 'km')::integer; v_lt := (r ->> 'litros')::numeric; v_enc := (r ->> 'encerrante')::numeric;
  v_bomba := (r ->> 'bomba')::integer;
  v_desconto := coalesce((r ->> 'desconto')::boolean, false);
  v_just := nullif(trim(coalesce(r ->> 'justificativa_desconto', '')), '');
  if v_km is null or v_km <= 0 or v_km >= 10000000 or v_lt is null or v_lt <= 0 or v_lt >= 5000
     or v_enc is null or v_enc <= 0 or v_bomba is null or v_bomba not between 1 and 99 then
    raise exception 'Valores fora do permitido.' using errcode = '22023';
  end if;
  if not v_desconto and (v_just is null or length(v_just) < 5) then
    raise exception 'Sem o desconto do motorista, escreva a justificativa para o supervisor.' using errcode = '22023';
  end if;
  perform validar_data_lancamento(v_dh);
  v_fora := fora_do_turno(v_dh);
  v_just_h := nullif(trim(coalesce(r ->> 'justificativa_horario', '')), '');
  if v_fora and (v_just_h is null or length(v_just_h) < 5) then
    select * into v_c from configuracoes where id = 1;
    raise exception 'Lançamento fora do horário do turno (% às %): escreva a justificativa para o supervisor.',
      to_char(v_c.abertura, 'HH24:MI'), to_char(v_c.fechamento, 'HH24:MI') using errcode = '22023';
  end if;
  c := conferir_abastecimento(v_dh, r ->> 'placa', r ->> 'motorista', v_km, v_lt, v_enc, v_bomba);
  v_status := case when v_desconto and not v_fora then c ->> 'status' else 'Aguardando autorização' end;
  insert into abastecimentos (uuid, data_hora, placa, motorista, cpf, km, litros, encerrante, encerrante_anterior,
                              bomba, tanque, status, problemas, obs_frentista, frentista_id, conta,
                              desconto_confirmado, justificativa_desconto, fora_horario, justificativa_horario)
  values ((r ->> 'uuid')::uuid, v_dh, c ->> 'placa', c ->> 'motorista', c ->> 'cpf', v_km, v_lt, v_enc,
          (c ->> 'encerrante_anterior')::numeric, v_bomba, c ->> 'tanque', v_status, c -> 'problemas',
          left(nullif(trim(r ->> 'obs'), ''), 500), v_frent, meu_email(), v_desconto, left(v_just, 500),
          v_fora, case when v_fora then left(v_just_h, 500) end)
  returning id into v_id;
  perform auditar('abastecimento.recebido', 'abastecimento', v_id::text,
                  jsonb_build_object('placa', c ->> 'placa', 'litros', v_lt, 'bomba', v_bomba, 'status', v_status, 'frentista_id', v_frent,
                                     'frentista', (select nome from frentistas where id = v_frent), 'desconto', v_desconto, 'fora_horario', v_fora));
  return jsonb_build_object('uuid', r ->> 'uuid', 'id', v_id, 'status', v_status, 'problemas', c -> 'problemas');
end $$;

create or replace function registrar_chegada(p_sessao text, p_dados jsonb, p_fotos text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb := p_dados; v_ex chegadas; v_id bigint; v_alerta text; v_sub numeric; v_lt numeric; v_frent bigint;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  select * into v_ex from chegadas where uuid = (r ->> 'uuid')::uuid;
  if v_ex.id is not null then return jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'alerta', v_ex.alerta); end if;
  perform validar_data_lancamento(date_trunc('second', (r ->> 'data_hora')::timestamp));
  v_lt := (r ->> 'litros')::numeric;
  if v_lt is null or v_lt <= 0 or v_lt >= 100000 then raise exception 'Litros da nota fora do permitido.' using errcode = '22023'; end if;
  if r ->> 'regua_antes' is not null and r ->> 'regua_depois' is not null then
    v_sub := (r ->> 'regua_depois')::numeric - (r ->> 'regua_antes')::numeric;
    if abs(v_sub - v_lt) > 20 then v_alerta := format('NF diz %s L, mas a régua subiu %s L.', fmt(v_lt), fmt(v_sub)); end if;
  end if;
  insert into chegadas (uuid, tanque, data_hora, nf, litros, valor_total, regua_antes, regua_depois, placa_caminhao,
                        placa_carreta, motorista, cpf, alerta, frentista_id, conta)
  values ((r ->> 'uuid')::uuid, upper(r ->> 'tanque'), date_trunc('second', (r ->> 'data_hora')::timestamp), trim(r ->> 'nf'),
          v_lt, (r ->> 'valor_total')::numeric, (r ->> 'regua_antes')::numeric, (r ->> 'regua_depois')::numeric,
          nullif(normaliza_placa(r ->> 'placa_caminhao'), ''), nullif(normaliza_placa(r ->> 'placa_carreta'), ''),
          left(r ->> 'motorista', 120), nullif(regexp_replace(coalesce(r ->> 'cpf', ''), '\D', '', 'g'), ''),
          v_alerta, v_frent, meu_email())
  returning id into v_id;
  perform registrar_fotos('chegada', v_id::text, p_fotos, v_frent);
  perform auditar('chegada.recebida', 'chegada', v_id::text,
                  jsonb_build_object('nf', r ->> 'nf', 'litros', v_lt, 'tanque', upper(r ->> 'tanque'), 'fotos', coalesce(cardinality(p_fotos), 0),
                                     'frentista', (select nome from frentistas where id = v_frent)));
  return jsonb_build_object('uuid', r ->> 'uuid', 'id', v_id, 'alerta', v_alerta);
end $$;

create or replace function registrar_fechamento(p_sessao text, p_medidos jsonb, p_fotos text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dia date := hoje(); t jsonb; v_med numeric; v_dif numeric; v_res jsonb := '[]'; v_frent bigint;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  if exists (select 1 from fechamentos where data = v_dia) then
    raise exception 'O dia já foi fechado.' using errcode = '22023';
  end if;
  if not exists (select 1 from tanques) then
    raise exception 'Nenhum tanque cadastrado. Peça ao supervisor.' using errcode = '22023';
  end if;
  for t in select value from jsonb_array_elements(calcular_fechamento(v_dia)) loop
    v_med := (p_medidos ->> (t ->> 'tanque'))::numeric;
    if v_med is null or v_med < 0 then
      raise exception 'Informe a medição do tanque %.', t ->> 'tanque' using errcode = '22023';
    end if;
    v_dif := v_med - (t ->> 'saldo_calculado')::numeric;
    insert into fechamentos (tanque, data, saldo_inicial, chegadas, saidas, saldo_calculado, saldo_medido, diferenca, frentista_id, conta)
    values (t ->> 'tanque', v_dia, (t ->> 'saldo_inicial')::numeric, (t ->> 'chegadas')::numeric, (t ->> 'saidas')::numeric,
            (t ->> 'saldo_calculado')::numeric, v_med, v_dif, v_frent, meu_email());
    v_res := v_res || jsonb_build_object('tanque', t ->> 'tanque', 'saldo_calculado', (t ->> 'saldo_calculado')::numeric,
                                         'saldo_medido', v_med, 'diferenca', v_dif, 'alerta', abs(v_dif) > 20);
  end loop;
  perform registrar_fotos('fechamento', v_dia::text, p_fotos, v_frent);
  perform auditar('fechamento.registrado', 'fechamento', v_dia::text,
                  jsonb_build_object('medidos', p_medidos, 'frentista_id', v_frent, 'frentista', (select nome from frentistas where id = v_frent),
                                     'fotos', coalesce(cardinality(p_fotos), 0)));
  return v_res;
end $$;

-- O frentista cadastra veículo ou motorista que ainda não existe. Depois, só o supervisor edita.
create or replace function cadastrar_veiculo_app(p_sessao text, p_placa text, p_capacidade numeric, p_km integer, p_foto text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_frent bigint; v_placa text := normaliza_placa(p_placa); v_nome text;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  if not placa_valida(v_placa) then raise exception 'Placa inválida.' using errcode = '22023'; end if;
  if exists (select 1 from veiculos where placa = v_placa) then
    raise exception 'A placa % já está cadastrada. Para mudar algo, peça ao supervisor.', v_placa using errcode = '22023';
  end if;
  if p_capacidade is null or p_capacidade <= 0 or p_capacidade >= 5000 then raise exception 'Capacidade do tanque inválida.' using errcode = '22023'; end if;
  if not foto_valida(p_foto, 'veiculo') then raise exception 'Tire a foto do caminhão com a placa.' using errcode = '22023'; end if;
  select nome into v_nome from frentistas where id = v_frent;
  insert into veiculos (placa, capacidade_l, km_inicial, ativo, criado_por) values (v_placa, p_capacidade, p_km, true, 'Frentista: ' || v_nome);
  perform registrar_fotos('veiculo', v_placa, array[p_foto], v_frent);
  return jsonb_build_object('placa', v_placa);
end $$;

create or replace function cadastrar_motorista_app(p_sessao text, p_nome text, p_cpf text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_frent bigint; v_nome text := normaliza_nome(p_nome); v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'); v_f text;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  if length(v_nome) < 5 then raise exception 'Escreva o nome completo do motorista.' using errcode = '22023'; end if;
  if not cpf_valido(v_cpf) then raise exception 'CPF inválido.' using errcode = '22023'; end if;
  if exists (select 1 from motoristas where nome = v_nome or cpf = v_cpf) then
    raise exception 'Motorista já cadastrado (mesmo nome ou CPF). Para mudar algo, peça ao supervisor.' using errcode = '22023';
  end if;
  select nome into v_f from frentistas where id = v_frent;
  insert into motoristas (nome, cpf, ativo, criado_por) values (v_nome, v_cpf, true, 'Frentista: ' || v_f);
  return jsonb_build_object('nome', v_nome);
end $$;

-- ---------- Funções do painel ----------
create or replace function decidir_autorizacao(p_id bigint, p_aprovar boolean, p_motivo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v abastecimentos; c jsonb;
begin
  perform exigir(array['supervisor']);
  if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Escreva o motivo da decisão.' using errcode = '22023'; end if;
  select * into v from abastecimentos where id = p_id for update;
  if v.id is null or v.status <> 'Aguardando autorização' then
    raise exception 'Este lançamento não está aguardando autorização.' using errcode = '22023';
  end if;
  if p_aprovar then
    c := conferir_abastecimento(v.data_hora, v.placa, v.motorista, v.km, v.litros, v.encerrante, v.bomba, v.id);
    update abastecimentos set status = c ->> 'status', problemas = c -> 'problemas', cpf = c ->> 'cpf',
           encerrante_anterior = (c ->> 'encerrante_anterior')::numeric, tanque = c ->> 'tanque',
           autorizado_por = meu_email(), autorizado_em = now(), obs_supervisor = left(p_motivo, 500), atualizado_em = now()
     where id = p_id;
  else
    update abastecimentos set status = 'Cancelado', obs_supervisor = left('Autorização recusada: ' || p_motivo, 500),
           autorizado_por = meu_email(), autorizado_em = now(), atualizado_em = now()
     where id = p_id;
  end if;
  perform auditar(case when p_aprovar then 'autorizacao.aprovada' else 'autorizacao.recusada' end, 'abastecimento', p_id::text,
                  jsonb_build_object('motivo', p_motivo));
  return (select to_jsonb(a) - 'cpf' from abastecimentos a where id = p_id);
end $$;

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
    raise exception 'Registro com status % não pode ser alterado aqui.', v_antes.status using errcode = '22023';
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

-- Fotos de um registro, para o painel abrir (o painel gera o link temporário no Storage)
create or replace function fotos_de(p_entidade text, p_chave text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform exigir(array['supervisor']);
  return coalesce((select jsonb_agg(jsonb_build_object('caminho', caminho, 'criado_em', criado_em) order by id)
                   from fotos where entidade = p_entidade and chave = p_chave), '[]');
end $$;

create or replace function anexar_foto_veiculo(p_placa text, p_foto text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exigir(array['supervisor']);
  if not exists (select 1 from veiculos where placa = normaliza_placa(p_placa)) then
    raise exception 'Veículo não encontrado.' using errcode = 'P0002';
  end if;
  perform registrar_fotos('veiculo', normaliza_placa(p_placa), array[p_foto], null);
  perform auditar('veiculo.foto_anexada', 'veiculos', normaliza_placa(p_placa), null);
end $$;

-- Excluir foto: só supervisor e administrador. O painel apaga o arquivo no Storage e depois chama esta função.
create or replace function excluir_foto(p_caminho text) returns void
language plpgsql security definer set search_path = public as $$
declare v fotos;
begin
  perform exigir(array['supervisor']);
  delete from fotos where caminho = p_caminho returning * into v;
  if v.id is null then raise exception 'Foto não encontrada.' using errcode = 'P0002'; end if;
  perform auditar('foto.excluida', v.entidade, v.chave, jsonb_build_object('caminho', p_caminho, 'enviada_em', v.criado_em, 'enviada_por', v.conta));
end $$;

-- ---------- RLS: ninguém vê nada sem estar em "acessos" ----------
do $$
declare t text;
begin
  foreach t in array array['acessos', 'frentistas', 'frentistas_pin', 'sessoes_frentista', 'veiculos', 'motoristas', 'tanques',
                           'bombas', 'lotes', 'abastecimentos', 'chegadas', 'fechamentos', 'fotos', 'auditoria', 'configuracoes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon', t);
    execute format('drop policy if exists supervisor_le on %I', t);
    execute format('drop policy if exists supervisor_edita on %I', t);
  end loop;
  -- Leitura pelo painel (PINs, sessões e auditoria têm regra própria)
  foreach t in array array['acessos', 'frentistas', 'veiculos', 'motoristas', 'tanques', 'bombas',
                           'lotes', 'abastecimentos', 'chegadas', 'fechamentos', 'fotos', 'configuracoes'] loop
    execute format('create policy supervisor_le on %I for select to authenticated using (sou_gestor())', t);
  end loop;
  -- Cadastros: supervisor e administrador editam direto (com histórico automático pelos gatilhos)
  foreach t in array array['acessos', 'frentistas', 'veiculos', 'motoristas', 'tanques', 'bombas'] loop
    execute format('create policy supervisor_edita on %I for all to authenticated using (sou_gestor()) with check (sou_gestor())', t);
  end loop;
end $$;
-- frentistas_pin e sessoes_frentista: sem política nenhuma (só as funções acessam)
-- Horário do turno: só o administrador altera
drop policy if exists admin_edita on configuracoes;
create policy admin_edita on configuracoes for update to authenticated
  using (meu_papel() = 'administrador') with check (meu_papel() = 'administrador');

-- Auditoria: o administrador vê tudo; o supervisor não vê as ações de administradores
drop policy if exists supervisor_le on auditoria;
drop policy if exists auditoria_le on auditoria;
create policy auditoria_le on auditoria for select to authenticated
  using (meu_papel() = 'administrador' or (meu_papel() = 'supervisor' and papel is distinct from 'administrador'));

-- ---------- Storage: bucket privado "fotos" ----------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('fotos', 'fotos', false, 5242880, array['image/jpeg'])
    on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg'];
    execute 'drop policy if exists fotos_enviar on storage.objects';
    execute 'drop policy if exists fotos_ver on storage.objects';
    execute 'drop policy if exists fotos_apagar on storage.objects';
    -- Enviar: qualquer conta liberada, só no formato pasta/uuid.jpg. Apagar: só supervisor e administrador. Alterar: ninguém.
    execute $p$create policy fotos_enviar on storage.objects for insert to authenticated with check (
      bucket_id = 'fotos' and public.meu_papel() is not null
      and (public.foto_valida(name, 'fechamento') or public.foto_valida(name, 'chegada') or public.foto_valida(name, 'veiculo')))$p$;
    execute $p$create policy fotos_ver on storage.objects for select to authenticated using (
      bucket_id = 'fotos' and public.sou_gestor())$p$;
    execute $p$create policy fotos_apagar on storage.objects for delete to authenticated using (
      bucket_id = 'fotos' and public.sou_gestor())$p$;
  end if;
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

grant execute on function meu_email(), meu_papel(), estado_posto(), entrar_frentista(bigint, text), sair_frentista(text),
  registrar_abastecimento(text, jsonb), registrar_chegada(text, jsonb, text[]), registrar_fechamento(text, jsonb, text[]),
  cadastrar_veiculo_app(text, text, numeric, integer, text), cadastrar_motorista_app(text, text, text),
  definir_pin(bigint, text), decidir_autorizacao(bigint, boolean, text),
  decidir_abastecimento(bigint, text, text, jsonb), marcar_erro_kmm(bigint, text),
  gerar_lote(), linhas_lote(bigint), fechar_lote(bigint, text), calcular_fechamento(date), fotos_de(text, text), anexar_foto_veiculo(text, text), excluir_foto(text)
  to authenticated;
-- As políticas RLS, as do Storage e os gatilhos chamam estas; precisam estar liberadas para quem está logado
grant execute on function exigir(text[]), sou_gestor(), fora_do_turno(timestamp), agora_local(), hoje(), normaliza_placa(text), normaliza_nome(text),
  placa_valida(text), cpf_valido(text), fmt(numeric), foto_valida(text, text), normalizar_cadastro(), auditar_cadastro(),
  bloquear_alteracao(), proteger_acessos()
  to authenticated;
