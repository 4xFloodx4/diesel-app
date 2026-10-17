-- =====================================================================================
-- Lançamento de diesel: banco de dados (Supabase / PostgreSQL 15+)
--
-- Como aplicar: Supabase > SQL Editor > cole este arquivo inteiro > Run.
-- Pode ser rodado de novo: cria o que falta e atualiza funções e regras sem apagar dados.
--
-- Quem é quem (cada cargo pode tudo o que o de baixo pode):
--  * desenvolvedor: tudo, inclusive criar administradores e mexer no banco pelo painel. Outro desenvolvedor só pelo
--                   SQL Editor do Supabase (dono do projeto).
--  * administrador: o analista. Exporta o turno para o KMM, ajusta horário e regras, libera celulares e supervisores.
--  * supervisor:    o dia a dia: decisões, cadastros, frentistas e PIN. Não libera contas.
--  * posto:         conta Google do celular. Nele cada frentista entra com nome + PIN.
--  No histórico, cada um vê o próprio nível e os de baixo; o administrador também vê o que o desenvolvedor fez.
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
alter table acessos add constraint acessos_papel_check check (papel in ('posto', 'supervisor', 'administrador', 'desenvolvedor'));

-- Nível de cada cargo do painel (o celular do posto fica fora da escada: 0)
create or replace function nivel_papel(p text) returns integer
language sql immutable as $$
  select case p when 'supervisor' then 1 when 'administrador' then 2 when 'desenvolvedor' then 3 else 0 end
$$;

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
  select coalesce(nivel_papel(meu_papel()) >= 1, false)
$$;

-- Cargo acima pode tudo o que o de baixo pode: exigir(array['supervisor']) aceita supervisor, administrador e desenvolvedor
create or replace function exigir(p_papeis text[]) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_papel text := meu_papel();
        v_min integer := (select min(nivel_papel(x)) from unnest(p_papeis) x where nivel_papel(x) > 0);
begin
  if v_papel is null or not (v_papel = any (p_papeis) or (v_min is not null and nivel_papel(v_papel) >= v_min)) then
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
-- Regras da conferência (o administrador ajusta no painel, em Horário e regras). O app e o banco usam os mesmos valores.
alter table configuracoes add column if not exists km_salto integer not null default 3000 check (km_salto between 100 and 100000);
alter table configuracoes add column if not exists tol_encerrante numeric(6, 2) not null default 1 check (tol_encerrante between 0 and 50);
alter table configuracoes add column if not exists tol_capacidade numeric(4, 2) not null default 1.05 check (tol_capacidade between 1 and 2);
alter table configuracoes add column if not exists tol_regua numeric(8, 1) not null default 20 check (tol_regua between 0 and 5000);
alter table configuracoes add column if not exists tol_afericao numeric(6, 3) not null default 0.1 check (tol_afericao between 0 and 5);
alter table configuracoes add column if not exists tanque_padrao numeric(8, 1) not null default 1100 check (tanque_padrao > 0 and tanque_padrao < 5000);
-- Abastecimento só dentro do turno, lançado logo depois (a hora digitada pode ser de até N minutos atrás)
alter table configuracoes add column if not exists atraso_lancamento_min integer not null default 30 check (atraso_lancamento_min between 0 and 20160);
-- Prazo para fechar o turno depois do fim; depois disso o fechamento ainda vale, mas fica marcado como atrasado (alerta)
alter table configuracoes add column if not exists prazo_fechamento_min integer not null default 30 check (prazo_fechamento_min between 0 and 720);
-- Com o dia anterior aberto, o posto não abre: o frentista da manhã mede a régua (o tanque ficou parado à noite) e fecha
alter table configuracoes add column if not exists exigir_fechamento boolean not null default true;

-- Valor de uma regra da conferência (ex.: regra('km_salto'))
create or replace function regra(p_nome text) returns numeric
language sql stable security definer set search_path = public as $$
  select (to_jsonb(c) ->> p_nome)::numeric from configuracoes c where c.id = 1
$$;

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
-- Placa importada da planilha (só placa + motorista) entra sem capacidade: o frentista informa no primeiro abastecimento
alter table veiculos alter column capacidade_l drop not null;
-- Tanque do caminhão: o tanque padrão das regras (1100 L, se ninguém mudou) para placa nova, da planilha, do painel ou do
-- app. Se for diferente, o frentista corrige no app. Quem preenche é o gatilho normalizar_cadastro.
alter table veiculos alter column capacidade_l drop default;
update veiculos set capacidade_l = (select tanque_padrao from configuracoes where id = 1) where capacidade_l is null;
-- KM corrigido (pelo frentista no app ou no painel): vira o novo ponto de partida. A conferência de KM ignora os
-- abastecimentos anteriores a este momento (ex.: painel do caminhão trocado, ou um KM digitado errado antes).
alter table veiculos add column if not exists km_desde timestamp;

create table if not exists motoristas (
  id     bigint generated always as identity primary key,
  nome   text not null unique,
  cpf    text not null check (cpf ~ '^\d{11}$' and cpf_valido(cpf)),
  ativo  boolean not null default true
);
alter table motoristas add column if not exists criado_por text;
alter table motoristas add column if not exists criado_em timestamptz default now();
-- Motorista importado só com o nome entra sem CPF: o frentista informa no primeiro abastecimento dele.
-- Sem CPF o lançamento não vai para o KMM (a conferência aponta e o lote recusa).
alter table motoristas alter column cpf drop not null;
alter table motoristas drop constraint if exists motoristas_cpf_check;
alter table motoristas add constraint motoristas_cpf_check check (cpf is null or (cpf ~ '^\d{11}$' and cpf_valido(cpf)));

-- Quais motoristas costumam dirigir cada placa: no app, ao escolher a placa, eles aparecem primeiro.
-- Nasce do próprio lançamento (placa + motorista cadastrados) e da planilha importada no painel.
create table if not exists veiculo_motoristas (
  placa         text not null references veiculos (placa) on update cascade on delete cascade,
  motorista_id  bigint not null references motoristas (id) on delete cascade,
  criado_por    text,
  criado_em     timestamptz not null default now(),
  primary key (placa, motorista_id)
);
create index if not exists ix_vinculo_motorista on veiculo_motoristas (motorista_id);

-- Caminhões que trazem o diesel (fornecedor): cavalo, carreta, motorista e CPF. Na chegada, o frentista digita o começo
-- da placa do cavalo e o resto vem preenchido; caminhão novo ele cadastra ali mesmo. Guarda a última combinação usada.
create table if not exists caminhoes_diesel (
  placa_cavalo   text primary key check (placa_cavalo ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'),
  placa_carreta  text check (placa_carreta is null or placa_carreta ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'),
  motorista      text check (length(motorista) <= 120),
  cpf            text check (cpf is null or (cpf ~ '^\d{11}$' and cpf_valido(cpf))),
  ativo          boolean not null default true,
  criado_por     text,
  criado_em      timestamptz not null default now()
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
  if tg_table_name in ('veiculos', 'veiculo_motoristas') then
    new.placa := normaliza_placa(new.placa);
    if tg_table_name = 'veiculos' and tg_op = 'INSERT' then   -- if separado: veiculo_motoristas não tem capacidade_l
      if new.capacidade_l is null then new.capacidade_l := (select tanque_padrao from configuracoes where id = 1); end if;
    end if;
    if tg_table_name = 'veiculos' and tg_op = 'UPDATE' then   -- if separado: veiculo_motoristas não tem km_inicial
      if new.km_inicial is distinct from old.km_inicial then new.km_desde := agora_local(); end if;   -- KM mudou: conta daqui para frente
    end if;
  elsif tg_table_name = 'motoristas' then
    new.nome := normaliza_nome(new.nome);
    new.cpf := regexp_replace(new.cpf, '\D', '', 'g');
  elsif tg_table_name = 'frentistas' then new.nome := regexp_replace(trim(new.nome), '\s+', ' ', 'g');
  elsif tg_table_name = 'caminhoes_diesel' then
    new.placa_cavalo := normaliza_placa(new.placa_cavalo);
    new.placa_carreta := nullif(normaliza_placa(new.placa_carreta), '');
    new.motorista := nullif(normaliza_nome(new.motorista), '');
    new.cpf := nullif(regexp_replace(coalesce(new.cpf, ''), '\D', '', 'g'), '');
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

-- Fechamento do turno para o KMM: cada lote é de um dia que o frentista fechou no app. Entram os prontos daquele dia
-- e os de dias anteriores que ficaram pendentes e foram resolvidos depois (vão marcados como "de outro dia").
alter table lotes add column if not exists dia date;
create index if not exists ix_lotes_dia on lotes (dia);

-- Relatório diário em PDF (modelo da Ritmo), gerado no Google Drive pelo Apps Script depois do fechamento do turno.
-- fechamento_em: a hora do fechamento que o relatório mostra; turno reaberto e fechado de novo faz o PDF ser refeito.
create table if not exists relatorios_diarios (
  data           date primary key,
  drive_id       text not null,
  drive_url      text not null,
  fechamento_em  timestamptz not null,
  gerado_em      timestamptz not null default now()
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
-- Preço do litro usado no lançamento (o frentista toca em "usar o preço atual"); vai para a planilha do KMM
alter table abastecimentos add column if not exists preco_litro numeric(8, 3) check (preco_litro > 0 and preco_litro < 100);
alter table abastecimentos add column if not exists valor_total numeric(12, 2) generated always as (round(litros * preco_litro, 2)) stored;
-- Sem desconto do motorista não espera autorização (o diesel já saiu): vai para o KMM e vira alerta até alguém tocar em Visto
alter table abastecimentos add column if not exists alerta_visto_por text;
alter table abastecimentos add column if not exists alerta_visto_em timestamptz;
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

-- Aferição semanal de cada bomba: o frentista enche a medida padrão de 20 L e informa quanto o visor marcou.
-- O diesel volta para o tanque (não conta como saída), mas o encerrante da bomba anda: por isso a aferição
-- guarda o encerrante e entra na conta do "encerrante anterior" do próximo abastecimento.
create table if not exists afericoes (
  id                   bigint generated always as identity primary key,
  uuid                 uuid not null unique,
  bomba                integer not null references bombas (numero),
  data_hora            timestamp(0) not null,
  medida_l             numeric(6, 3) not null default 20 check (medida_l > 0),
  visor_l              numeric(6, 3) not null check (visor_l > 0 and visor_l < 100),
  diferenca_l          numeric(6, 3) generated always as (visor_l - medida_l) stored,
  encerrante_anterior  numeric(14, 3) not null,
  encerrante           numeric(14, 3) not null,
  frentista_id         bigint not null references frentistas (id),
  conta                text not null,
  recebido_em          timestamptz not null default now()
);
create index if not exists ix_afer_bomba on afericoes (bomba, data_hora);

-- Fechamento atrasado (depois do prazo; em geral o frentista da manhã fechando o turno da noite) e fechamento sem
-- medição (o supervisor fecha pelo painel quando não dá para medir). Os dois viram alerta até alguém tocar em Visto.
alter table fechamentos add column if not exists atrasado boolean not null default false;
alter table fechamentos add column if not exists sem_medicao boolean not null default false;
alter table fechamentos add column if not exists motivo text check (length(motivo) <= 500);
alter table fechamentos add column if not exists alerta_visto_por text;
alter table fechamentos add column if not exists alerta_visto_em timestamptz;

-- Preço do litro do diesel: o atual é o último registrado. O frentista altera no app (ele recebe o diesel e vê a NF).
-- Cada mudança fica guardada, com quem mudou e de onde veio (digitado no app ou sugerido pela NF da chegada).
create table if not exists precos_diesel (
  id            bigint generated always as identity primary key,
  preco         numeric(8, 3) not null check (preco > 0 and preco < 100),
  origem        text not null default 'app' check (origem in ('app', 'chegada', 'painel')),
  frentista_id  bigint references frentistas (id),
  conta         text not null,
  criado_em     timestamptz not null default now()
);

-- Fotos (os arquivos ficam no Storage, bucket "fotos"; aqui fica a qual registro cada uma pertence)
create table if not exists fotos (
  id            bigint generated always as identity primary key,
  entidade      text not null,
  chave         text not null,
  caminho       text not null unique,
  frentista_id  bigint references frentistas (id),
  conta         text not null,
  criado_em     timestamptz not null default now()
);
alter table fotos drop constraint if exists fotos_entidade_check;
alter table fotos add constraint fotos_entidade_check check (entidade in ('fechamento', 'chegada', 'veiculo', 'afericao', 'abastecimento'));
create index if not exists ix_fotos_chave on fotos (entidade, chave);
-- Comprovante do abastecimento (foto do comprovante junto com o visor da bomba) vai para o Google Drive: um Apps Script
-- copia para Abastecimentos/AAAA-MM/DD/Comprovante-PLACA-HHMM.jpg e apaga do Storage, que fica só como fila de passagem.
alter table fotos add column if not exists drive_id text;
alter table fotos add column if not exists drive_url text;
alter table fotos add column if not exists no_drive_em timestamptz;
alter table fotos add column if not exists fora_do_storage boolean not null default false;
create index if not exists ix_fotos_fila_drive on fotos (id) where entidade = 'abastecimento' and not fora_do_storage;

create table if not exists auditoria (
  id           bigint generated always as identity primary key,
  quando       timestamptz not null default now(),
  conta        text,
  acao         text not null,
  entidade     text,
  entidade_id  text,
  detalhes     jsonb
);
alter table auditoria add column if not exists papel text;   -- cargo de quem fez (cada um vê o próprio nível e os de baixo)

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
  if tg_op = 'UPDATE' and v_novo = v_velho then return new; end if;   -- reimportar a planilha sem mudar nada não enche o histórico
  if v_novo ? 'cpf' then v_novo := v_novo || jsonb_build_object('cpf', '***' || right(v_novo ->> 'cpf', 2)); end if;
  if v_velho ? 'cpf' then v_velho := v_velho || jsonb_build_object('cpf', '***' || right(v_velho ->> 'cpf', 2)); end if;
  if tg_table_name = 'veiculo_motoristas' then   -- o histórico mostra o nome, não só o número do motorista
    if v_novo is not null then v_novo := v_novo || jsonb_build_object('motorista', (select nome from motoristas where id = new.motorista_id)); end if;
    if v_velho is not null then v_velho := v_velho || jsonb_build_object('motorista', (select nome from motoristas where id = old.motorista_id)); end if;
  end if;
  v_chave := coalesce(v_novo, v_velho) ->> (case tg_table_name when 'veiculos' then 'placa' when 'veiculo_motoristas' then 'placa' when 'tanques' then 'codigo'
                                             when 'caminhoes_diesel' then 'placa_cavalo'
                                             when 'bombas' then 'numero' when 'acessos' then 'email' else 'id' end);
  perform auditar('cadastro.' || tg_table_name || '.' || lower(tg_op), tg_table_name, v_chave,
                  jsonb_build_object('antes', v_velho, 'depois', v_novo));
  return coalesce(new, old);
end $$;

-- Contas Google:
--  * desenvolvedor: só pelo dono do projeto (SQL Editor do Supabase); ninguém no painel cria, altera ou remove;
--  * administrador: só o desenvolvedor cria, altera ou remove;
--  * supervisor e celular do posto: administrador ou desenvolvedor. O supervisor não mexe em contas.
create or replace function proteger_acessos() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_papel text := meu_papel(); v_alvo text;
begin
  if meu_email() = '' then return coalesce(new, old); end if;   -- SQL Editor: dono do projeto
  foreach v_alvo in array array[case when tg_op <> 'INSERT' then old.papel end, case when tg_op <> 'DELETE' then new.papel end] loop
    continue when v_alvo is null;
    if v_alvo = 'desenvolvedor' then
      raise exception 'Desenvolvedores só podem ser criados, alterados ou removidos pelo dono do projeto no Supabase.' using errcode = '42501';
    elsif v_alvo = 'administrador' and v_papel is distinct from 'desenvolvedor' then
      raise exception 'Só o desenvolvedor cria, altera ou remove administradores.' using errcode = '42501';
    elsif nivel_papel(v_papel) < 2 then
      raise exception 'Só o administrador libera ou bloqueia contas de celular e de supervisor.' using errcode = '42501';
    end if;
  end loop;
  return coalesce(new, old);
end $$;

drop trigger if exists proteger on acessos;
create trigger proteger before insert or update or delete on acessos
  for each row execute function proteger_acessos();

do $$
declare t text;
begin
  foreach t in array array['veiculos', 'motoristas', 'veiculo_motoristas', 'frentistas', 'tanques', 'bombas', 'acessos', 'configuracoes', 'caminhoes_diesel'] loop
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
-- Foto registrada não muda; só as colunas do Google Drive são preenchidas depois (pelo Apps Script)
create or replace function proteger_foto() returns trigger
language plpgsql as $$
declare c text[] := array['drive_id', 'drive_url', 'no_drive_em', 'fora_do_storage'];
begin
  if to_jsonb(new) - c is distinct from to_jsonb(old) - c then
    raise exception 'Foto registrada não pode ser alterada; exclua e envie outra.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists fotos_imutaveis on fotos;
create trigger fotos_imutaveis before update on fotos
  for each row execute function proteger_foto();

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

-- Último encerrante conhecido da bomba antes de um momento (null = até agora): o cadastro inicial,
-- os abastecimentos não cancelados e as aferições (que fazem o encerrante andar sem ser saída do tanque).
create or replace function encerrante_ate(p_bomba integer, p_antes timestamp, p_excluir bigint default null) returns numeric
language sql stable as $$
  select greatest(
    (select encerrante_inicial from bombas where numero = p_bomba),
    (select max(encerrante) from abastecimentos where bomba = p_bomba and (p_antes is null or data_hora < p_antes)
        and id is distinct from p_excluir and status <> 'Cancelado'),
    (select max(encerrante) from afericoes where bomba = p_bomba and (p_antes is null or data_hora < p_antes)))
$$;

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
  v_outra integer;
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
  elsif coalesce(length(v_mot.cpf), 0) <> 11 then p := p || format('Motorista ''%s'' sem CPF válido no cadastro (o KMM exige CPF).', v_mot.nome);
  end if;

  -- KM crescente e salto razoável (só contam abastecimentos aceitos, anteriores a este e depois da última correção de KM).
  -- Maior que o último lançado; igual ao KM do cadastro vale (o frentista corrige e lança com o mesmo KM do painel).
  if v_veic.placa is not null then
    select max(km) into v_km_ant from abastecimentos
     where placa = v_placa and data_hora < p_data_hora and id is distinct from p_excluir
       and status in ('Pronto', 'Em lote', 'Lançado') and (v_veic.km_desde is null or data_hora >= v_veic.km_desde);
    if v_km_ant is not null and p_km <= v_km_ant then
      p := p || format('KM %s não é maior que o último KM da placa (%s).', fmt(p_km), fmt(v_km_ant));
    elsif v_veic.km_inicial is not null and p_km < v_veic.km_inicial then
      p := p || format('KM %s é menor que o KM do cadastro da placa (%s).', fmt(p_km), fmt(v_veic.km_inicial));
    elsif p_km - greatest(v_km_ant, v_veic.km_inicial) > regra('km_salto') then
      p := p || format('Salto de KM suspeito: %s km desde o último abastecimento.', fmt(p_km - greatest(v_km_ant, v_veic.km_inicial)));
    end if;
    if v_veic.capacidade_l is null then
      p := p || format('Placa %s sem o tamanho do tanque no cadastro.', v_placa);
    elsif p_litros > v_veic.capacidade_l * regra('tol_capacidade') then
      p := p || format('%s L acima da capacidade do tanque (%s L).', fmt(p_litros), fmt(v_veic.capacidade_l));
    end if;
  end if;

  -- Encerrante da bomba crescente e igual aos litros (tolerância 1 L)
  if v_bomba.numero is null then
    p := p || format('Bomba %s não existe.', p_bomba);
  else
    v_enc_ant := encerrante_ate(p_bomba, p_data_hora, p_excluir);
    if p_encerrante <= v_enc_ant then
      p := p || format('Encerrante %s não é maior que o anterior da bomba %s (%s).', fmt(p_encerrante), p_bomba, fmt(v_enc_ant));
    elsif abs(p_encerrante - v_enc_ant - p_litros) > regra('tol_encerrante') then
      p := p || format('Encerrante indica %s L (de %s para %s), mas foram informados %s L.',
                       fmt(p_encerrante - v_enc_ant), fmt(v_enc_ant), fmt(p_encerrante), fmt(p_litros));
    end if;
    -- Posto com mais de uma bomba: se o encerrante bate com outra bomba, o frentista provavelmente escolheu a errada
    if p_encerrante <= v_enc_ant or abs(p_encerrante - v_enc_ant - p_litros) > regra('tol_encerrante') then
      select o.numero into v_outra from bombas o
       where o.ativa and o.numero <> p_bomba
         and abs(p_encerrante - p_litros - encerrante_ate(o.numero, p_data_hora, p_excluir)) <= regra('tol_encerrante')
       order by o.numero limit 1;
      if v_outra is not null then
        p := p || format('O encerrante bate com a bomba %s. Confira se a bomba escolhida está certa.', v_outra);
      end if;
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
        -- km_ultimo: maior KM lançado desde a última correção; km_cadastro: o KM do cadastro (o app confere igual ao banco)
        'km_ultimo', (select max(km) from abastecimentos a where a.placa = v.placa and a.status in ('Pronto', 'Em lote', 'Lançado')
                         and (v.km_desde is null or a.data_hora >= v.km_desde)),
        'km_cadastro', v.km_inicial,
        'km_anterior', greatest(v.km_inicial, (select max(km) from abastecimentos a where a.placa = v.placa and a.status in ('Pronto', 'Em lote', 'Lançado')
                         and (v.km_desde is null or a.data_hora >= v.km_desde))),
        'motorista_sugerido', (select a.motorista from abastecimentos a where a.placa = v.placa order by a.id desc limit 1),
        -- motoristas vinculados à placa (ativos), para o app mostrar ao escolher a placa
        'motoristas', coalesce((select jsonb_agg(m.nome order by m.nome) from veiculo_motoristas vm
                                  join motoristas m on m.id = vm.motorista_id and m.ativo where vm.placa = v.placa), '[]')
      ) order by v.placa) from veiculos v where v.ativo), '[]'),
    -- Caminhões de diesel cadastrados (o celular não recebe o CPF: só se tem e os 2 últimos números)
    'caminhoes_diesel', coalesce((select jsonb_agg(jsonb_build_object('placa', c.placa_cavalo, 'carreta', c.placa_carreta, 'motorista', c.motorista,
        'cpf_fim', right(c.cpf, 2)) order by c.placa_cavalo) from caminhoes_diesel c where c.ativo), '[]'),
    -- O celular não recebe CPF
    'motoristas', coalesce((select jsonb_agg(nome order by nome) from motoristas where ativo), '[]'),
    -- só os nomes de quem ainda está sem CPF (o app pede o CPF no primeiro abastecimento)
    'motoristas_sem_cpf', coalesce((select jsonb_agg(nome order by nome) from motoristas where ativo and cpf is null), '[]'),
    'bombas', coalesce((select jsonb_agg(jsonb_build_object(
        'numero', b.numero, 'tanque', b.tanque, 'encerrante_anterior', encerrante_ate(b.numero, null),
        -- aferição é semanal: vencida se a última tem 7 dias ou mais (ou se nunca foi feita)
        'ultima_afericao', (select max(data_hora) from afericoes f where f.bomba = b.numero),
        'afericao_vencida', coalesce((select max(data_hora) from afericoes f where f.bomba = b.numero) <= agora_local() - interval '7 days', true)
      ) order by b.numero) from bombas b where b.ativa), '[]'),
    'tanques', calcular_fechamento(v_hoje),
    'turno', (select jsonb_build_object('abertura', to_char(abertura, 'HH24:MI'), 'fechamento', to_char(fechamento, 'HH24:MI'))
                from configuracoes where id = 1),
    'regras', (select jsonb_build_object('km_salto', km_salto, 'tol_encerrante', tol_encerrante, 'tol_capacidade', tol_capacidade,
                 'tol_regua', tol_regua, 'tol_afericao', tol_afericao, 'tanque_padrao', tanque_padrao,
                 'atraso_lancamento_min', atraso_lancamento_min, 'prazo_fechamento_min', prazo_fechamento_min) from configuracoes where id = 1),
    'preco_diesel', (select jsonb_build_object('preco', p.preco, 'em', p.criado_em, 'por', f.nome, 'origem', p.origem)
                       from precos_diesel p left join frentistas f on f.id = p.frentista_id order by p.id desc limit 1),
    -- histórico das aferições na aba Aferir, com quem fez
    'afericoes_recentes', coalesce((select jsonb_agg(x order by x.data_hora desc) from (
        select a.bomba, a.data_hora, a.visor_l, a.diferenca_l, f.nome as frentista from afericoes a join frentistas f on f.id = a.frentista_id
         order by a.data_hora desc limit 12) x), '[]'),
    'fechado_hoje', exists (select 1 from fechamentos where data = v_hoje),
    -- dia que ficou aberto: o app só deixa fechar ele (o posto não abre). Com mais de um, o supervisor fecha os antigos.
    'dias_sem_fechamento', case when (select exigir_fechamento from configuracoes where id = 1) then to_jsonb(dias_sem_fechamento()) else '[]' end,
    'tanques_pendente', case when (select exigir_fechamento from configuracoes where id = 1) and cardinality(dias_sem_fechamento()) = 1
                             then calcular_fechamento((dias_sem_fechamento())[1]) end,
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

-- Trava até o fim da transação: quem lança na mesma bomba ou na mesma placa espera o anterior gravar.
-- Trava "consultiva" (não prende linha de cadastro), então o painel continua editando bombas e veículos.
create or replace function trava_lancamento(p_bomba integer, p_placa text) returns void
language sql as $$
  select pg_advisory_xact_lock(1, coalesce(p_bomba, 0)), pg_advisory_xact_lock(2, hashtext(normaliza_placa(p_placa)))
$$;

-- Dias (dos últimos 7) que ficaram sem fechamento: antes de hoje, com abastecimento, chegada ou aferição, e sem fechamento
create or replace function dias_sem_fechamento() returns date[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(x.d order by x.d), '{}') from (
    select data_hora::date as d from abastecimentos where status <> 'Cancelado' and data_hora::date between hoje() - 7 and hoje() - 1
    union select data_hora::date from chegadas where not cancelada and data_hora::date between hoje() - 7 and hoje() - 1
    union select data_hora::date from afericoes where data_hora::date between hoje() - 7 and hoje() - 1) x
   where not exists (select 1 from fechamentos f where f.data = x.d)
$$;

-- O posto só abre com o turno anterior fechado (se a regra estiver ligada)
create or replace function exigir_turno_anterior_fechado() returns void
language plpgsql stable security definer set search_path = public as $$
declare v date[] := dias_sem_fechamento();
begin
  if cardinality(v) > 0 and (select exigir_fechamento from configuracoes where id = 1) then
    raise exception 'O turno de % não foi fechado. Feche o turno anterior antes de abrir o posto.', to_char(v[cardinality(v)], 'DD/MM')
      using errcode = '22023';
  end if;
end $$;

-- Abastecimento: agora tem que ser horário do turno, e a hora digitada também, de no máximo N minutos atrás
create or replace function validar_hora_abastecimento(p_dh timestamp) returns void
language plpgsql stable security definer set search_path = public as $$
declare c configuracoes;
begin
  select * into c from configuracoes where id = 1;
  if fora_do_turno(agora_local()) then
    raise exception 'O posto está fora do horário do turno (% às %). Abastecimento não é aceito agora.',
      to_char(c.abertura, 'HH24:MI'), to_char(c.fechamento, 'HH24:MI') using errcode = '22023';
  end if;
  if fora_do_turno(p_dh) then
    raise exception 'A hora % está fora do turno (% às %).', to_char(p_dh, 'HH24:MI'), to_char(c.abertura, 'HH24:MI'), to_char(c.fechamento, 'HH24:MI')
      using errcode = '22023';
  end if;
  if p_dh < agora_local() - make_interval(mins => c.atraso_lancamento_min) then
    raise exception 'A hora % é de mais de % minutos atrás. Lance logo depois de abastecer, com a hora certa.', to_char(p_dh, 'HH24:MI'), c.atraso_lancamento_min
      using errcode = '22023';
  end if;
end $$;

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

-- Foto do comprovante junto com o visor da bomba: obrigatória, uma por abastecimento
drop function if exists registrar_abastecimento(text, jsonb);
create or replace function registrar_abastecimento(p_sessao text, p_dados jsonb, p_fotos text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb := p_dados; v_ex abastecimentos; c jsonb; v_id bigint; v_status text;
  v_dh timestamp; v_km integer; v_lt numeric; v_enc numeric; v_bomba integer; v_frent bigint;
  v_desconto boolean; v_just text; v_fora boolean; v_just_h text; v_c configuracoes;
  v_veic veiculos; v_mot motoristas; v_cap numeric; v_cpf text; v_preco numeric;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  v_bomba := (r ->> 'bomba')::integer;
  -- Um lançamento por vez na mesma bomba e na mesma placa: senão dois envios simultâneos passam pela conferência
  -- do encerrante e do KM com o mesmo "anterior". Ordem fixa (bomba, depois placa) para não travar em ciclo.
  perform trava_lancamento(v_bomba, r ->> 'placa');
  select * into v_ex from abastecimentos where uuid = (r ->> 'uuid')::uuid;
  if v_ex.id is not null then   -- toque duplo ou reenvio: devolve o que já foi gravado
    return jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'status', v_ex.status, 'problemas', v_ex.problemas);
  end if;
  v_dh := date_trunc('second', (r ->> 'data_hora')::timestamp);
  v_km := (r ->> 'km')::integer; v_lt := (r ->> 'litros')::numeric; v_enc := (r ->> 'encerrante')::numeric;
  v_desconto := coalesce((r ->> 'desconto')::boolean, false);
  v_just := nullif(trim(coalesce(r ->> 'justificativa_desconto', '')), '');
  if v_km is null or v_km <= 0 or v_km >= 10000000 or v_lt is null or v_lt <= 0 or v_lt >= 5000
     or v_enc is null or v_enc <= 0 or v_bomba is null or v_bomba not between 1 and 99 then
    raise exception 'Valores fora do permitido.' using errcode = '22023';
  end if;
  if not v_desconto and (v_just is null or length(v_just) < 5) then
    raise exception 'Sem o desconto do motorista, escreva a justificativa (o supervisor vai ver).' using errcode = '22023';
  end if;
  v_preco := (r ->> 'preco')::numeric;
  if v_preco is not null and (v_preco <= 0 or v_preco >= 100) then raise exception 'Preço do litro inválido.' using errcode = '22023'; end if;
  if coalesce(cardinality(p_fotos), 0) <> 1 then
    raise exception 'Tire a foto do comprovante junto com o visor da bomba (uma foto).' using errcode = '22023';
  end if;
  perform exigir_turno_anterior_fechado();
  perform validar_data_lancamento(v_dh);
  perform validar_hora_abastecimento(v_dh);   -- fora do horário não entra mais (nem com justificativa)
  v_fora := false;
  -- Primeira vez de uma placa ou de um motorista vindos da planilha (só placa + nome): completa o cadastro.
  -- O KM não precisa: o deste lançamento vira o primeiro da placa.
  select * into v_veic from veiculos where placa = normaliza_placa(r ->> 'placa') and ativo;
  if v_veic.placa is not null and v_veic.capacidade_l is null then
    v_cap := (r ->> 'capacidade')::numeric;
    if v_cap is null or v_cap <= 0 or v_cap >= 5000 then
      raise exception 'Informe o tamanho do tanque do veículo % (primeiro abastecimento dele).', v_veic.placa using errcode = '22023';
    end if;
    update veiculos set capacidade_l = v_cap where placa = v_veic.placa;
  end if;
  select * into v_mot from motoristas where nome = normaliza_nome(r ->> 'motorista') and ativo;
  v_cpf := nullif(regexp_replace(coalesce(r ->> 'cpf', ''), '\D', '', 'g'), '');
  if v_mot.id is not null and v_mot.cpf is null and v_cpf is not null then
    if not cpf_valido(v_cpf) then raise exception 'CPF do motorista inválido.' using errcode = '22023'; end if;
    if exists (select 1 from motoristas where cpf = v_cpf and id <> v_mot.id) then
      raise exception 'Este CPF já é de outro motorista. Fale com o supervisor.' using errcode = '22023';
    end if;
    update motoristas set cpf = v_cpf where id = v_mot.id;
  end if;
  c := conferir_abastecimento(v_dh, r ->> 'placa', r ->> 'motorista', v_km, v_lt, v_enc, v_bomba);
  v_status := c ->> 'status';   -- sem desconto segue o caminho normal e vira alerta para o supervisor (com a justificativa)
  insert into abastecimentos (uuid, data_hora, placa, motorista, cpf, km, litros, encerrante, encerrante_anterior,
                              bomba, tanque, status, problemas, obs_frentista, frentista_id, conta,
                              desconto_confirmado, justificativa_desconto, fora_horario, justificativa_horario, preco_litro)
  values ((r ->> 'uuid')::uuid, v_dh, c ->> 'placa', c ->> 'motorista', c ->> 'cpf', v_km, v_lt, v_enc,
          (c ->> 'encerrante_anterior')::numeric, v_bomba, c ->> 'tanque', v_status, c -> 'problemas',
          left(nullif(trim(r ->> 'obs'), ''), 500), v_frent, meu_email(), v_desconto, left(v_just, 500),
          v_fora, case when v_fora then left(v_just_h, 500) end, v_preco)
  on conflict (uuid) do nothing
  returning id into v_id;
  if v_id is null then   -- mesmo envio gravado ao mesmo tempo por outra conexão
    select * into v_ex from abastecimentos where uuid = (r ->> 'uuid')::uuid;
    return jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'status', v_ex.status, 'problemas', v_ex.problemas);
  end if;
  -- Placa e motorista cadastrados: fica vinculado, e na próxima vez o motorista aparece ao escolher a placa
  insert into veiculo_motoristas (placa, motorista_id, criado_por)
  select v.placa, m.id, 'Frentista: ' || (select nome from frentistas where id = v_frent)
    from veiculos v join motoristas m on m.nome = c ->> 'motorista' and m.ativo
   where v.placa = c ->> 'placa'
  on conflict do nothing;
  perform registrar_fotos('abastecimento', v_id::text, p_fotos, v_frent);
  perform auditar('abastecimento.recebido', 'abastecimento', v_id::text,
                  jsonb_build_object('placa', c ->> 'placa', 'litros', v_lt, 'bomba', v_bomba, 'status', v_status, 'frentista_id', v_frent,
                                     'frentista', (select nome from frentistas where id = v_frent), 'desconto', v_desconto, 'fora_horario', v_fora,
                                     'fotos', cardinality(p_fotos)));
  return jsonb_build_object('uuid', r ->> 'uuid', 'id', v_id, 'status', v_status, 'problemas', c -> 'problemas');
end $$;

-- Chegada de diesel. O caminhão (cavalo) cadastrado completa carreta, motorista e CPF que o frentista deixar em branco;
-- caminhão novo é cadastrado aqui, e o cadastro guarda a última carreta, motorista e CPF usados.
create or replace function registrar_chegada(p_sessao text, p_dados jsonb, p_fotos text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb := p_dados; v_ex chegadas; v_id bigint; v_alerta text; v_sub numeric; v_lt numeric; v_frent bigint;
        v_cav text := nullif(normaliza_placa(r ->> 'placa_caminhao'), ''); v_car text := nullif(normaliza_placa(r ->> 'placa_carreta'), '');
        v_mot text := nullif(normaliza_nome(r ->> 'motorista'), ''); v_cpf text := nullif(regexp_replace(coalesce(r ->> 'cpf', ''), '\D', '', 'g'), '');
        v_cam caminhoes_diesel;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  select * into v_ex from chegadas where uuid = (r ->> 'uuid')::uuid;
  if v_ex.id is not null then return jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'alerta', v_ex.alerta); end if;
  perform exigir_turno_anterior_fechado();
  perform validar_data_lancamento(date_trunc('second', (r ->> 'data_hora')::timestamp));
  v_lt := (r ->> 'litros')::numeric;
  if v_lt is null or v_lt <= 0 or v_lt >= 100000 then raise exception 'Litros da nota fora do permitido.' using errcode = '22023'; end if;
  if v_cav is not null and not placa_valida(v_cav) then raise exception 'Placa do cavalo inválida.' using errcode = '22023'; end if;
  if v_car is not null and not placa_valida(v_car) then raise exception 'Placa da carreta inválida.' using errcode = '22023'; end if;
  if v_cpf is not null and not cpf_valido(v_cpf) then raise exception 'CPF do motorista do caminhão inválido.' using errcode = '22023'; end if;
  select * into v_cam from caminhoes_diesel where placa_cavalo = v_cav;
  v_car := coalesce(v_car, v_cam.placa_carreta); v_mot := coalesce(v_mot, v_cam.motorista); v_cpf := coalesce(v_cpf, v_cam.cpf);
  if r ->> 'regua_antes' is not null and r ->> 'regua_depois' is not null then
    v_sub := (r ->> 'regua_depois')::numeric - (r ->> 'regua_antes')::numeric;
    if abs(v_sub - v_lt) > regra('tol_regua') then v_alerta := format('NF diz %s L, mas a régua subiu %s L.', fmt(v_lt), fmt(v_sub)); end if;
  end if;
  insert into chegadas (uuid, tanque, data_hora, nf, litros, valor_total, regua_antes, regua_depois, placa_caminhao,
                        placa_carreta, motorista, cpf, alerta, frentista_id, conta)
  values ((r ->> 'uuid')::uuid, upper(r ->> 'tanque'), date_trunc('second', (r ->> 'data_hora')::timestamp), trim(r ->> 'nf'),
          v_lt, (r ->> 'valor_total')::numeric, (r ->> 'regua_antes')::numeric, (r ->> 'regua_depois')::numeric,
          v_cav, v_car, left(v_mot, 120), v_cpf, v_alerta, v_frent, meu_email())
  on conflict (uuid) do nothing
  returning id into v_id;
  if v_id is null then   -- mesmo envio gravado ao mesmo tempo por outra conexão
    select * into v_ex from chegadas where uuid = (r ->> 'uuid')::uuid;
    return jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'alerta', v_ex.alerta);
  end if;
  perform registrar_fotos('chegada', v_id::text, p_fotos, v_frent);
  if v_cav is not null then
    insert into caminhoes_diesel (placa_cavalo, placa_carreta, motorista, cpf, criado_por)
    values (v_cav, v_car, v_mot, v_cpf, 'Frentista: ' || (select nome from frentistas where id = v_frent))
    on conflict (placa_cavalo) do update set placa_carreta = excluded.placa_carreta, motorista = excluded.motorista, cpf = excluded.cpf, ativo = true
     where (caminhoes_diesel.placa_carreta, caminhoes_diesel.motorista, caminhoes_diesel.cpf, caminhoes_diesel.ativo)
           is distinct from (excluded.placa_carreta, excluded.motorista, excluded.cpf, true);
  end if;
  perform auditar('chegada.recebida', 'chegada', v_id::text,
                  jsonb_build_object('nf', r ->> 'nf', 'litros', v_lt, 'tanque', upper(r ->> 'tanque'), 'fotos', coalesce(cardinality(p_fotos), 0),
                                     'frentista', (select nome from frentistas where id = v_frent)));
  return jsonb_build_object('uuid', r ->> 'uuid', 'id', v_id, 'alerta', v_alerta);
end $$;

-- Fechar o turno: o de hoje, ou o dia que ficou aberto (o frentista da manhã mede a régua antes de abastecer; o tanque
-- ficou parado à noite). Depois do prazo (fim do turno + N minutos) o fechamento vale, mas fica marcado como atrasado.
-- Com mais de um dia aberto, os mais antigos o supervisor fecha pelo painel (sem medição): só o último dá para medir.
drop function if exists registrar_fechamento(text, jsonb, text[]);
create or replace function registrar_fechamento(p_sessao text, p_medidos jsonb, p_fotos text[] default '{}', p_dia date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dia date := coalesce(p_dia, hoje()); t jsonb; v_med numeric; v_dif numeric; v_res jsonb := '[]'; v_frent bigint;
        v_pend date[] := dias_sem_fechamento(); v_c configuracoes; v_atrasado boolean; v_quem text[];
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  if exists (select 1 from fechamentos where data = v_dia) then
    raise exception 'O dia já foi fechado.' using errcode = '22023';
  end if;
  if v_dia > hoje() then raise exception 'Não dá para fechar um dia que ainda não chegou.' using errcode = '22023'; end if;
  if v_dia < hoje() and not (v_dia = any (v_pend)) then
    raise exception 'O turno de % não está esperando fechamento.', to_char(v_dia, 'DD/MM') using errcode = '22023';
  end if;
  select * into v_c from configuracoes where id = 1;
  if v_c.exigir_fechamento and (cardinality(v_pend) > 1 or (v_dia = hoje() and cardinality(v_pend) > 0)) then
    raise exception 'Há dia sem fechamento antes deste (%). O supervisor fecha os mais antigos pelo painel; depois você fecha o de %.',
      (select string_agg(to_char(d, 'DD/MM'), ', ') from unnest(v_pend) d where d < coalesce(v_pend[cardinality(v_pend)], v_dia) or v_dia = hoje()),
      to_char(case when v_dia = hoje() and cardinality(v_pend) > 0 then v_pend[cardinality(v_pend)] else v_dia end, 'DD/MM') using errcode = '22023';
  end if;
  v_atrasado := agora_local() > v_dia::timestamp + v_c.fechamento + make_interval(mins => v_c.prazo_fechamento_min);
  select array_agg(distinct f.nome order by f.nome) into v_quem from abastecimentos a join frentistas f on f.id = a.frentista_id
   where a.data_hora::date = v_dia and a.status <> 'Cancelado';
  if not exists (select 1 from tanques) then
    raise exception 'Nenhum tanque cadastrado. Peça ao supervisor.' using errcode = '22023';
  end if;
  for t in select value from jsonb_array_elements(calcular_fechamento(v_dia)) loop
    v_med := (p_medidos ->> (t ->> 'tanque'))::numeric;
    if v_med is null or v_med < 0 then
      raise exception 'Informe a medição do tanque %.', t ->> 'tanque' using errcode = '22023';
    end if;
    v_dif := v_med - (t ->> 'saldo_calculado')::numeric;
    insert into fechamentos (tanque, data, saldo_inicial, chegadas, saidas, saldo_calculado, saldo_medido, diferenca, frentista_id, conta, atrasado)
    values (t ->> 'tanque', v_dia, (t ->> 'saldo_inicial')::numeric, (t ->> 'chegadas')::numeric, (t ->> 'saidas')::numeric,
            (t ->> 'saldo_calculado')::numeric, v_med, v_dif, v_frent, meu_email(), v_atrasado);
    v_res := v_res || jsonb_build_object('tanque', t ->> 'tanque', 'saldo_calculado', (t ->> 'saldo_calculado')::numeric,
                                         'saldo_medido', v_med, 'diferenca', v_dif, 'alerta', abs(v_dif) > regra('tol_regua'));
  end loop;
  perform registrar_fotos('fechamento', v_dia::text, p_fotos, v_frent);
  perform auditar('fechamento.registrado', 'fechamento', v_dia::text,
                  jsonb_build_object('medidos', p_medidos, 'frentista_id', v_frent, 'frentista', (select nome from frentistas where id = v_frent),
                                     'fotos', coalesce(cardinality(p_fotos), 0), 'atrasado', v_atrasado, 'frentistas_do_dia', to_jsonb(v_quem)));
  return v_res;
end $$;

-- Aferição semanal: bomba, litros que o visor marcou ao encher a medida de 20 L e foto (obrigatória).
-- Tolerância: 0,5% da medida (100 mL em 20 L); acima disso o supervisor vê o alerta.
create or replace function registrar_afericao(p_sessao text, p_dados jsonb, p_fotos text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb := p_dados; v_ex afericoes; v_id bigint; v_frent bigint; v_bomba integer; v_dh timestamp; v_visor numeric;
        v_ant numeric; v_dif numeric;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  v_bomba := (r ->> 'bomba')::integer;
  perform trava_lancamento(v_bomba, null);   -- o encerrante da bomba anda: espera quem está lançando nela
  select * into v_ex from afericoes where uuid = (r ->> 'uuid')::uuid;
  if v_ex.id is not null then
    return jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'diferenca', v_ex.diferenca_l, 'alerta', abs(v_ex.diferenca_l) > regra('tol_afericao'));
  end if;
  if not exists (select 1 from bombas where numero = v_bomba and ativa) then
    raise exception 'Bomba % não existe.', coalesce(v_bomba::text, '(vazia)') using errcode = '22023';
  end if;
  perform exigir_turno_anterior_fechado();
  v_dh := date_trunc('second', (r ->> 'data_hora')::timestamp);
  perform validar_data_lancamento(v_dh);
  v_visor := (r ->> 'visor')::numeric;
  if v_visor is null or v_visor < 15 or v_visor > 25 then
    raise exception 'Informe quantos litros o visor marcou ao encher a medida de 20 L.' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_fotos), 0) = 0 then
    raise exception 'Tire a foto da medida cheia junto com o visor da bomba.' using errcode = '22023';
  end if;
  v_ant := encerrante_ate(v_bomba, v_dh);
  insert into afericoes (uuid, bomba, data_hora, medida_l, visor_l, encerrante_anterior, encerrante, frentista_id, conta)
  values ((r ->> 'uuid')::uuid, v_bomba, v_dh, 20, v_visor, v_ant, v_ant + v_visor, v_frent, meu_email())
  on conflict (uuid) do nothing
  returning id into v_id;
  if v_id is null then   -- mesmo envio gravado ao mesmo tempo por outra conexão
    select * into v_ex from afericoes where uuid = (r ->> 'uuid')::uuid;
    return jsonb_build_object('uuid', v_ex.uuid, 'id', v_ex.id, 'diferenca', v_ex.diferenca_l, 'alerta', abs(v_ex.diferenca_l) > regra('tol_afericao'));
  end if;
  v_dif := v_visor - 20;
  perform registrar_fotos('afericao', v_id::text, p_fotos, v_frent);
  perform auditar('afericao.registrada', 'afericao', v_id::text,
                  jsonb_build_object('bomba', v_bomba, 'visor', v_visor, 'diferenca', v_dif, 'fotos', cardinality(p_fotos),
                                     'frentista', (select nome from frentistas where id = v_frent)));
  return jsonb_build_object('uuid', r ->> 'uuid', 'id', v_id, 'diferenca', v_dif, 'alerta', abs(v_dif) > regra('tol_afericao'));
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

-- O frentista atualiza o preço do litro do diesel (vale para os próximos lançamentos de todos). Origem: 'app' (digitado)
-- ou 'chegada' (sugerido pela NF da chegada de diesel). Fica guardado com quem mudou.
create or replace function definir_preco_diesel(p_sessao text, p_preco numeric, p_origem text default 'app') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_frent bigint; v_antes numeric; v_nome text;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  if p_preco is null or p_preco < 0.5 or p_preco >= 100 then raise exception 'Preço do litro inválido.' using errcode = '22023'; end if;
  if p_origem not in ('app', 'chegada') then raise exception 'Origem inválida.' using errcode = '22023'; end if;
  select preco into v_antes from precos_diesel order by id desc limit 1;
  select nome into v_nome from frentistas where id = v_frent;
  insert into precos_diesel (preco, origem, frentista_id, conta) values (round(p_preco, 3), p_origem, v_frent, meu_email());
  perform auditar('preco.alterado', 'precos_diesel', null, jsonb_build_object('antes', v_antes, 'depois', round(p_preco, 3), 'origem', p_origem, 'frentista', v_nome));
  return jsonb_build_object('preco', round(p_preco, 3), 'por', v_nome);
end $$;

-- O frentista corrige o tamanho do tanque ou o KM atual de um caminhão já cadastrado. Muda na hora e fica no histórico
-- com o nome dele. KM corrigido vira o novo ponto de partida da conferência (ver km_desde).
create or replace function corrigir_veiculo_app(p_sessao text, p_placa text, p_capacidade numeric, p_km integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_frent bigint; v_antes veiculos; v_depois veiculos;
begin
  perform exigir(array['posto', 'supervisor']);
  v_frent := frentista_da_sessao(p_sessao);
  select * into v_antes from veiculos where placa = normaliza_placa(p_placa) and ativo for update;
  if v_antes.placa is null then raise exception 'Placa não cadastrada.' using errcode = 'P0002'; end if;
  if p_capacidade is null and p_km is null then raise exception 'Informe o tanque ou o KM.' using errcode = '22023'; end if;
  if p_capacidade is not null and (p_capacidade <= 0 or p_capacidade >= 5000) then
    raise exception 'Tamanho do tanque inválido.' using errcode = '22023';
  end if;
  if p_km is not null and (p_km <= 0 or p_km >= 10000000) then raise exception 'KM inválido.' using errcode = '22023'; end if;
  update veiculos set capacidade_l = coalesce(p_capacidade, capacidade_l), km_inicial = coalesce(p_km, km_inicial)
   where placa = v_antes.placa returning * into v_depois;
  perform auditar('veiculo.corrigido', 'veiculos', v_antes.placa, jsonb_build_object(
    'frentista', (select nome from frentistas where id = v_frent),
    'capacidade', case when v_depois.capacidade_l is distinct from v_antes.capacidade_l then jsonb_build_array(v_antes.capacidade_l, v_depois.capacidade_l) end,
    'km', case when v_depois.km_inicial is distinct from v_antes.km_inicial then jsonb_build_array(v_antes.km_inicial, v_depois.km_inicial) end));
  return jsonb_build_object('placa', v_depois.placa, 'capacidade_l', v_depois.capacidade_l, 'km_inicial', v_depois.km_inicial);
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
-- Vínculos placa ↔ motorista vindos da planilha: [{linha, placa, motorista, cpf}]. O motorista é achado pelo CPF
-- (se vier) ou pelo nome. Placa ou motorista que ainda não existe é criado: a placa sem capacidade e o motorista
-- sem CPF (se não vier), e o frentista completa no primeiro abastecimento.
-- Só inclui: não apaga vínculo que não está na planilha. Devolve quantos deram certo, quantos foram criados e os erros.
create or replace function importar_vinculos(p_linhas jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l jsonb; i integer := 0; v_linha text; v_placa text; v_cpf text; v_nome text; v_mot bigint; v_ok integer := 0; v_erros text[] := '{}';
        v_veic_novos integer := 0; v_mot_novos integer := 0;
begin
  perform exigir(array['supervisor']);
  if jsonb_typeof(p_linhas) is distinct from 'array' or jsonb_array_length(p_linhas) > 5000 then
    raise exception 'Lista de vínculos inválida (máximo 5000 linhas).' using errcode = '22023';
  end if;
  for l in select value from jsonb_array_elements(p_linhas) loop
    i := i + 1;
    v_linha := coalesce(l ->> 'linha', (i + 1)::text);
    v_placa := normaliza_placa(l ->> 'placa');
    v_cpf := lpad(nullif(regexp_replace(coalesce(l ->> 'cpf', ''), '\D', '', 'g'), ''), 11, '0');
    v_nome := normaliza_nome(l ->> 'motorista');
    select id into v_mot from motoristas where case when v_cpf is not null then cpf = v_cpf else nome = v_nome end limit 1;
    if v_mot is null and v_cpf is not null then   -- CPF novo, mas o nome pode já existir (cadastrado sem CPF)
      select id into v_mot from motoristas where nome = v_nome and cpf is null;
    end if;
    if not placa_valida(v_placa) then
      v_erros := v_erros || format('Linha %s: placa %s inválida', v_linha, coalesce(nullif(v_placa, ''), '(vazia)'));
    elsif v_mot is null and length(v_nome) < 3 then
      v_erros := v_erros || format('Linha %s: falta o nome do motorista', v_linha);
    elsif v_cpf is not null and not cpf_valido(v_cpf) then
      v_erros := v_erros || format('Linha %s: CPF de %s inválido', v_linha, v_nome);
    elsif v_mot is null and exists (select 1 from motoristas where nome = v_nome) then
      v_erros := v_erros || format('Linha %s: %s já está cadastrado com outro CPF', v_linha, v_nome);
    else
      -- motorista que estava sem CPF e a planilha trouxe: completa
      if v_mot is not null and v_cpf is not null then update motoristas set cpf = v_cpf where id = v_mot and cpf is null; end if;
      if not exists (select 1 from veiculos where placa = v_placa) then
        insert into veiculos (placa, criado_por) values (v_placa, 'Planilha');
        v_veic_novos := v_veic_novos + 1;
      end if;
      if v_mot is null then
        insert into motoristas (nome, cpf, criado_por) values (v_nome, v_cpf, 'Planilha') returning id into v_mot;
        v_mot_novos := v_mot_novos + 1;
      end if;
      insert into veiculo_motoristas (placa, motorista_id, criado_por) values (v_placa, v_mot, 'Planilha') on conflict do nothing;
      v_ok := v_ok + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', v_ok, 'veiculos_novos', v_veic_novos, 'motoristas_novos', v_mot_novos, 'erros', to_jsonb(v_erros));
end $$;

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
    perform trava_lancamento(v.bomba, v.placa);
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
    -- Mudar a data para outro dia: não pode ir para o futuro nem para um dia cujo turno já foi fechado
    if v_dh::date <> v_antes.data_hora::date then
      if v_dh > agora_local() + interval '10 minutes' then
        raise exception 'A data % está no futuro.', to_char(v_dh, 'DD/MM HH24:MI') using errcode = '22023';
      end if;
      if exists (select 1 from fechamentos where data = v_dh::date) then
        raise exception 'O turno de % já foi fechado. Não dá para mover o lançamento para esse dia.', to_char(v_dh, 'DD/MM') using errcode = '22023';
      end if;
    end if;
    perform trava_lancamento(v_bomba, v_placa);
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
  perform exigir(array['administrador']);
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
  return coalesce((select jsonb_agg(jsonb_build_object('requisicao', a.id, 'data_hora', a.data_hora, 'placa', a.placa, 'cpf', a.cpf,
                   'motorista', a.motorista, 'km', a.km, 'litros', a.litros, 'bomba', a.bomba, 'preco', a.preco_litro, 'valor_total', a.valor_total,
                   'de_outro_dia', l.dia is not null and a.data_hora::date < l.dia) order by a.data_hora, a.id)
                   from abastecimentos a join lotes l on l.id = a.lote_id where a.lote_id = p_lote), '[]');
end $$;

-- Fechamento do turno de p_dia para o KMM (administrador): os prontos até aquele dia viram a planilha do importador.
drop function if exists gerar_lote();
create or replace function gerar_lote(p_dia date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_qtd integer; v_lt numeric; v_sem_cpf text;
begin
  perform exigir(array['administrador']);
  if p_dia is null or not exists (select 1 from fechamentos where data = p_dia) then
    raise exception 'O turno de % ainda não foi fechado no app.', coalesce(to_char(p_dia, 'DD/MM'), '(sem data)') using errcode = '22023';
  end if;
  -- Os totais saem das próprias linhas que entraram no lote (um lançamento que chegue no meio não fica de fora da conta).
  -- Qualquer erro abaixo desfaz tudo, inclusive o lote criado.
  insert into lotes (criado_por, quantidade, litros, situacao, dia) values (meu_email(), 0, 0, 'Gerado', p_dia) returning id into v_id;
  with u as (
    update abastecimentos set status = 'Em lote', lote_id = v_id, atualizado_em = now()
     where status = 'Pronto' and data_hora::date <= p_dia
    returning id, litros, cpf
  )
  select count(*), coalesce(sum(litros), 0), string_agg(id::text, ', ' order by id) filter (where cpf is null or length(cpf) <> 11)
    into v_qtd, v_lt, v_sem_cpf from u;
  if v_qtd = 0 then raise exception 'Nada novo para lançar no KMM até o turno de %.', to_char(p_dia, 'DD/MM') using errcode = '22023'; end if;
  if v_sem_cpf is not null then
    raise exception 'Registros sem CPF de motorista: %. Corrija o cadastro e revise.', v_sem_cpf using errcode = '22023';
  end if;
  update lotes set quantidade = v_qtd, litros = v_lt where id = v_id;
  perform auditar('lote.gerado', 'lote', v_id::text, jsonb_build_object('quantidade', v_qtd, 'litros', v_lt, 'dia', p_dia));
  return jsonb_build_object('id', v_id, 'dia', p_dia, 'quantidade', v_qtd, 'litros', v_lt, 'linhas', linhas_lote(v_id));
end $$;

-- Confirmar: o analista lançou no KMM. Desfazer: não lançou (ou lançou errado e vai refazer); volta tudo para Pronto.
create or replace function fechar_lote(p_lote bigint, p_acao text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_lote lotes; v_n integer;
begin
  perform exigir(array['administrador']);
  select * into v_lote from lotes where id = p_lote for update;
  if v_lote.id is null then raise exception 'Lote não encontrado.' using errcode = 'P0002'; end if;
  if v_lote.situacao = 'Desfeito' or (p_acao = 'confirmar' and v_lote.situacao <> 'Gerado') then
    raise exception 'Este fechamento já está %.', case v_lote.situacao when 'Confirmado' then 'lançado no KMM' else lower(v_lote.situacao) end using errcode = '22023';
  end if;
  if p_acao = 'confirmar' then
    update abastecimentos set status = 'Lançado', atualizado_em = now() where lote_id = p_lote and status = 'Em lote';
    get diagnostics v_n = row_count;
    update lotes set situacao = 'Confirmado', fechado_em = now(), fechado_por = meu_email() where id = p_lote;
  elsif p_acao = 'desfazer' then
    update abastecimentos set status = 'Pronto', lote_id = null, atualizado_em = now() where lote_id = p_lote and status in ('Em lote', 'Lançado');
    get diagnostics v_n = row_count;
    update lotes set situacao = 'Desfeito', fechado_em = now(), fechado_por = meu_email() where id = p_lote;
  else
    raise exception 'Ação inválida.' using errcode = '22023';
  end if;
  perform auditar('lote.' || p_acao, 'lote', p_lote::text, jsonb_build_object('registros', v_n));
  return jsonb_build_object('id', p_lote, 'situacao', case p_acao when 'confirmar' then 'Confirmado' else 'Desfeito' end, 'registros', v_n);
end $$;

-- Dia que ficou aberto e não dá para medir (régua quebrada, mais de um dia esquecido): o supervisor fecha pelo painel.
-- A régua fica igual ao esperado e o dia fica marcado "sem medição"; a diferença real aparece no próximo fechamento medido.
create or replace function fechar_sem_medicao(p_dia date, p_motivo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_pend date[] := dias_sem_fechamento(); t jsonb; v_n integer := 0;
begin
  perform exigir(array['supervisor']);
  if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Escreva o motivo para fechar sem medição.' using errcode = '22023'; end if;
  if not (p_dia = any (v_pend)) then raise exception 'O turno de % não está esperando fechamento.', to_char(p_dia, 'DD/MM') using errcode = '22023'; end if;
  if p_dia <> v_pend[1] then raise exception 'Feche antes o dia mais antigo (%).', to_char(v_pend[1], 'DD/MM') using errcode = '22023'; end if;
  for t in select value from jsonb_array_elements(calcular_fechamento(p_dia)) loop
    insert into fechamentos (tanque, data, saldo_inicial, chegadas, saidas, saldo_calculado, saldo_medido, diferenca, frentista_id, conta,
                             atrasado, sem_medicao, motivo, alerta_visto_por, alerta_visto_em)
    values (t ->> 'tanque', p_dia, (t ->> 'saldo_inicial')::numeric, (t ->> 'chegadas')::numeric, (t ->> 'saidas')::numeric,
            (t ->> 'saldo_calculado')::numeric, round((t ->> 'saldo_calculado')::numeric, 1), 0, null, meu_email(), true, true, left(trim(p_motivo), 500),
            meu_email(), now());
    v_n := v_n + 1;
  end loop;
  perform auditar('fechamento.sem_medicao', 'fechamento', p_dia::text, jsonb_build_object('motivo', left(trim(p_motivo), 500), 'tanques', v_n));
  return jsonb_build_object('data', p_dia, 'tanques', v_n);
end $$;

-- Alertas (sem desconto do motorista; turno fechado com atraso): quem confere toca em Visto
create or replace function marcar_visto(p_tipo text, p_chave text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exigir(array['supervisor']);
  if p_tipo = 'desconto' then
    update abastecimentos set alerta_visto_por = meu_email(), alerta_visto_em = now() where id = p_chave::bigint and not desconto_confirmado and alerta_visto_em is null;
  elsif p_tipo = 'fechamento' then
    update fechamentos set alerta_visto_por = meu_email(), alerta_visto_em = now() where data = p_chave::date and alerta_visto_em is null;
  else raise exception 'Tipo de alerta inválido.' using errcode = '22023';
  end if;
  if not found then raise exception 'Este alerta já foi visto ou não existe.' using errcode = 'P0002'; end if;
  perform auditar('alerta.visto', p_tipo, p_chave, null);
end $$;

-- Folha do dia (modelo da Ritmo) para baixar em PDF no painel e no app. O celular recebe o CPF mascarado.
create or replace function folha_do_dia(p_dia date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform exigir(array['posto', 'supervisor']);
  v := relatorio_do_dia(p_dia);
  if meu_papel() = 'posto' then
    v := jsonb_set(v, '{chegadas}', coalesce((select jsonb_agg(c || jsonb_build_object('cpf', case when c ->> 'cpf' is null then null else '*********' || right(c ->> 'cpf', 2) end))
                                               from jsonb_array_elements(v -> 'chegadas') c), '[]'));
  end if;
  return v || jsonb_build_object('fechado', exists (select 1 from fechamentos where data = p_dia));
end $$;

-- Exportar › Fechamento do turno: um cartão por dia fechado no app, com o que entrou, o que está pendente,
-- os fechamentos para o KMM daquele dia e o relatório diário em PDF.
create or replace function turnos_kmm(p_limite integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform exigir(array['supervisor']);
  return coalesce((select jsonb_agg(t order by t.dia desc) from (
    select d.dia,
           (select max(f.criado_em) from fechamentos f where f.data = d.dia) as fechado_em,
           (select fr.nome from fechamentos f join frentistas fr on fr.id = f.frentista_id where f.data = d.dia order by f.id desc limit 1) as fechado_por,
           (select bool_or(f.atrasado) from fechamentos f where f.data = d.dia) as atrasado,
           (select bool_or(f.sem_medicao) from fechamentos f where f.data = d.dia) as sem_medicao,
           (select count(*) from abastecimentos a where a.data_hora::date = d.dia and a.status <> 'Cancelado') as abastecimentos,
           (select coalesce(sum(a.litros), 0) from abastecimentos a where a.data_hora::date = d.dia and a.status <> 'Cancelado') as litros,
           (select count(*) from abastecimentos a where a.data_hora::date = d.dia and a.status in ('Aguardando autorização', 'Exceção', 'Erro')) as pendentes,
           (select count(*) from abastecimentos a where a.data_hora::date = d.dia and a.status = 'Pronto') as prontos,
           (select count(*) from abastecimentos a where a.data_hora::date < d.dia and a.status = 'Pronto') as prontos_de_antes,
           (select count(*) from chegadas c where c.data_hora::date = d.dia and not c.cancelada) as chegadas,
           coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'situacao', l.situacao, 'quantidade', l.quantidade, 'litros', l.litros,
                       'criado_em', l.criado_em, 'criado_por', coalesce((select nome from acessos where email = l.criado_por), l.criado_por),
                       'fechado_em', l.fechado_em, 'fechado_por', coalesce((select nome from acessos where email = l.fechado_por), l.fechado_por)) order by l.id)
                     from lotes l where l.dia = d.dia), '[]') as lotes,
           (select jsonb_build_object('drive_url', r.drive_url, 'gerado_em', r.gerado_em,
                                      'atualizado', r.fechamento_em >= (select max(f.criado_em) from fechamentos f where f.data = d.dia))
              from relatorios_diarios r where r.data = d.dia) as relatorio
      from (select distinct data as dia from fechamentos order by data desc limit greatest(1, least(coalesce(p_limite, 30), 120))) d) t), '[]');
end $$;

-- Dados do relatório diário (modelo "RELATÓRIO DIÁRIO DE ABASTECIMENTO - VERSÃO ONLINE"): cabeçalho, abastecimentos e chegadas
create or replace function relatorio_do_dia(p_dia date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'data', to_char(p_dia, 'YYYY-MM-DD'),
    'fechamento_em', (select max(criado_em) from fechamentos where data = p_dia),
    'hora', (select to_char(abertura, 'HH24:MI') from configuracoes where id = 1) || ' às '
            || coalesce((select to_char(max(criado_em) at time zone 'America/Sao_Paulo', 'HH24:MI') from fechamentos where data = p_dia), ''),
    'tanques', coalesce((select jsonb_agg(jsonb_build_object('tanque', tanque, 'saldo_inicial', saldo_inicial) order by tanque)
                         from fechamentos where data = p_dia), '[]'),
    'bombas', coalesce((select jsonb_agg(jsonb_build_object('bomba', numero, 'encerrante_inicial', encerrante_ate(numero, p_dia::timestamp)) order by numero)
                        from bombas where ativa), '[]'),
    'abastecimentos', coalesce((select jsonb_agg(jsonb_build_object('placa', placa, 'motorista', motorista, 'hora', to_char(data_hora, 'HH24:MI'),
                                  'km', km, 'litros', litros, 'encerrante', encerrante, 'bomba', bomba) order by data_hora, id)
                                from abastecimentos where data_hora::date = p_dia and status <> 'Cancelado'), '[]'),
    'chegadas', coalesce((select jsonb_agg(jsonb_build_object('data', to_char(data_hora, 'DD/MM/YYYY'), 'hora', to_char(data_hora, 'HH24:MI'),
                            'litros', litros, 'nf', nf, 'valor_total', valor_total, 'regua_antes', regua_antes, 'regua_depois', regua_depois,
                            'placa_caminhao', placa_caminhao, 'placa_carreta', placa_carreta, 'motorista', motorista, 'cpf', cpf) order by data_hora)
                          from chegadas where data_hora::date = p_dia and not cancelada), '[]'))
$$;

-- Apps Script: dias fechados (até 60 dias atrás) sem relatório, ou com relatório de um fechamento anterior (turno reaberto)
create or replace function relatorios_para_drive() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(relatorio_do_dia(d.data) order by d.data), '[]')
    from (select data, max(criado_em) as fech from fechamentos where data >= hoje() - 60 group by data) d
    left join relatorios_diarios r on r.data = d.data
   where r.data is null or r.fechamento_em < d.fech
$$;

create or replace function relatorio_no_drive(p_data date, p_drive_id text, p_drive_url text, p_fechamento_em timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_drive_id, '') !~ '^[A-Za-z0-9_-]{10,200}$' then raise exception 'ID do Drive inválido.' using errcode = '22023'; end if;
  if coalesce(p_drive_url, '') !~ '^https://drive\.google\.com/' then raise exception 'Link do Drive inválido.' using errcode = '22023'; end if;
  insert into relatorios_diarios (data, drive_id, drive_url, fechamento_em) values (p_data, p_drive_id, left(p_drive_url, 500), p_fechamento_em)
  on conflict (data) do update set drive_id = excluded.drive_id, drive_url = excluded.drive_url, fechamento_em = excluded.fechamento_em, gerado_em = now();
end $$;

-- Turno fechado sem querer: supervisor ou administrador reabre (só o último fechado, para não bagunçar o saldo dos
-- dias seguintes). Apaga o fechamento daquele dia; o frentista volta a lançar e fecha de novo. As medidas apagadas e o
-- motivo ficam na auditoria; as fotos da régua continuam guardadas.
create or replace function reabrir_turno(p_data date, p_motivo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ultimo date; v_apagados jsonb;
begin
  perform exigir(array['supervisor']);
  if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Escreva o motivo para reabrir o turno.' using errcode = '22023'; end if;
  select max(data) into v_ultimo from fechamentos;
  if v_ultimo is null or p_data is distinct from v_ultimo then
    raise exception 'Só dá para reabrir o último turno fechado%.', coalesce(' (' || to_char(v_ultimo, 'DD/MM') || ')', '') using errcode = '22023';
  end if;
  with d as (delete from fechamentos where data = p_data returning *)
  select jsonb_agg(jsonb_build_object('tanque', tanque, 'saldo_calculado', saldo_calculado, 'saldo_medido', saldo_medido, 'diferenca', diferenca,
                                      'frentista', (select nome from frentistas where id = d.frentista_id), 'fechado_em', criado_em) order by tanque)
    into v_apagados from d;
  perform auditar('turno.reaberto', 'fechamento', p_data::text, jsonb_build_object('motivo', left(trim(p_motivo), 500), 'fechamentos', v_apagados));
  return jsonb_build_object('data', p_data, 'tanques', jsonb_array_length(v_apagados));
end $$;

-- Fotos de um registro, para o painel abrir (o painel gera o link temporário no Storage)
create or replace function fotos_de(p_entidade text, p_chave text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform exigir(array['supervisor']);
  return coalesce((select jsonb_agg(jsonb_build_object('caminho', caminho, 'criado_em', criado_em, 'drive_id', drive_id, 'drive_url', drive_url,
                                                     'no_storage', not fora_do_storage) order by id)
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

-- ---------- Google Drive: comprovantes dos abastecimentos ----------
-- Chamadas só pelo Apps Script do Google (scripts/drive-comprovantes.gs), com a chave service_role guardada nas
-- propriedades do script. Fila: comprovante que ainda está no Storage (sem cópia no Drive, ou copiado e ainda não apagado).
create or replace function fotos_para_drive(p_limite integer default 25) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.id), '[]') from (
    select f.id, f.caminho, f.drive_id, a.id as abastecimento, a.placa, to_char(a.data_hora, 'YYYY-MM-DD"T"HH24:MI:SS') as data_hora
      from fotos f join abastecimentos a on a.id::text = f.chave
     where f.entidade = 'abastecimento' and not f.fora_do_storage
     order by f.id limit least(greatest(coalesce(p_limite, 25), 1), 100)) x
$$;

-- Copiado para o Drive (p_fora_do_storage = false) e, depois, apagado do Storage (true)
create or replace function foto_no_drive(p_caminho text, p_drive_id text, p_drive_url text, p_fora_do_storage boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_drive_id, '') !~ '^[A-Za-z0-9_-]{10,200}$' then raise exception 'ID do Drive inválido.' using errcode = '22023'; end if;
  if coalesce(p_drive_url, '') !~ '^https://drive\.google\.com/' then raise exception 'Link do Drive inválido.' using errcode = '22023'; end if;
  update fotos set drive_id = p_drive_id, drive_url = left(p_drive_url, 500), no_drive_em = coalesce(no_drive_em, now()),
         fora_do_storage = fora_do_storage or coalesce(p_fora_do_storage, false)
   where caminho = p_caminho and entidade = 'abastecimento';
  if not found then raise exception 'Foto não encontrada.' using errcode = 'P0002'; end if;
end $$;

-- ---------- Desenvolvedor: banco de dados pelo painel e saúde do sistema ----------
-- Celulares e versões das telas: cada celular avisa a versão que está usando quando abre (para o desenvolvedor ver quem
-- ficou para trás na atualização)
create table if not exists aparelhos (
  conta     text primary key,
  versao    text not null check (length(versao) <= 60),
  visto_em  timestamptz not null default now()
);

create or replace function informar_versao(p_versao text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exigir(array['posto', 'supervisor']);
  if coalesce(p_versao, '') !~ '^[\w.-]{1,60}$' then return; end if;
  insert into aparelhos (conta, versao) values (meu_email(), p_versao)
  on conflict (conta) do update set versao = excluded.versao, visto_em = now();
end $$;

-- Tabelas que o desenvolvedor edita pelo painel. Ficam de fora: PINs, sessões e o histórico (que só se lê).
-- As proteções continuam: abastecimento não se apaga, foto registrada não muda, conta de desenvolvedor só pelo SQL.
create or replace function dev_tabelas() returns text[]
language sql immutable as $$
  select array['abastecimentos', 'chegadas', 'fechamentos', 'afericoes', 'lotes', 'precos_diesel', 'fotos', 'relatorios_diarios',
               'veiculos', 'motoristas', 'veiculo_motoristas', 'caminhoes_diesel', 'frentistas', 'tanques', 'bombas', 'acessos', 'configuracoes', 'aparelhos']
$$;

create or replace function dev_chave(p_tabela text) returns text[]
language sql stable security definer set search_path = public as $$
  select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
   where i.indrelid = ('public.' || quote_ident(p_tabela))::regclass and i.indisprimary
$$;

create or replace function dev_estrutura() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform exigir(array['desenvolvedor']);
  return (select jsonb_agg(jsonb_build_object('tabela', t, 'chave', to_jsonb(dev_chave(t)),
            'colunas', (select jsonb_agg(jsonb_build_object('nome', c.column_name, 'tipo', c.data_type,
                          'editavel', c.is_generated = 'NEVER' and coalesce(c.identity_generation, '') <> 'ALWAYS') order by c.ordinal_position)
                          from information_schema.columns c where c.table_schema = 'public' and c.table_name = t)) order by t)
            from unnest(dev_tabelas()) t);
end $$;

-- Inclui (p_chave nulo) ou altera uma linha. Os valores chegam como JSON e o banco converte para o tipo de cada coluna.
create or replace function dev_salvar(p_tabela text, p_chave jsonb, p_valores jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_cols text; v_pk text[] := dev_chave(p_tabela); v_onde text; v_antes jsonb; v_depois jsonb;
begin
  perform exigir(array['desenvolvedor']);
  if not (p_tabela = any (dev_tabelas())) then raise exception 'Esta tabela não pode ser editada pelo painel.' using errcode = '42501'; end if;
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_cols
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = p_tabela and c.is_generated = 'NEVER' and coalesce(c.identity_generation, '') <> 'ALWAYS'
     and c.column_name in (select jsonb_object_keys(coalesce(p_valores, '{}')));
  if v_cols is null then raise exception 'Nada para salvar.' using errcode = '22023'; end if;
  if p_chave is null then
    execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1) returning to_jsonb(%I.*)',
                   p_tabela, v_cols, v_cols, p_tabela, p_tabela) into v_depois using p_valores;
  else
    v_onde := format('(%s) = (select %s from jsonb_populate_record(null::%I, $2))',
                     array_to_string(array(select quote_ident(x) from unnest(v_pk) x), ', '),
                     array_to_string(array(select quote_ident(x) from unnest(v_pk) x), ', '), p_tabela);
    execute format('select to_jsonb(t.*) from %I t where %s', p_tabela, replace(v_onde, '$2', '$1')) into v_antes using p_chave;
    if v_antes is null then raise exception 'Registro não encontrado (alguém mudou ou apagou?). Recarregue a tabela.' using errcode = 'P0002'; end if;
    execute format('update %I set (%s) = (select %s from jsonb_populate_record(null::%I, $1)) where %s returning to_jsonb(%I.*)',
                   p_tabela, v_cols, v_cols, p_tabela, v_onde, p_tabela) into v_depois using p_valores, p_chave;
  end if;
  perform auditar_dev(case when p_chave is null then 'dev.incluiu' else 'dev.alterou' end, p_tabela, v_antes, v_depois, v_pk);
  return v_depois - 'cpf';
end $$;

create or replace function dev_apagar(p_tabela text, p_chave jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_pk text[] := dev_chave(p_tabela); v_antes jsonb;
begin
  perform exigir(array['desenvolvedor']);
  if not (p_tabela = any (dev_tabelas())) then raise exception 'Esta tabela não pode ser editada pelo painel.' using errcode = '42501'; end if;
  execute format('delete from %I where (%s) = (select %s from jsonb_populate_record(null::%I, $1)) returning to_jsonb(%I.*)', p_tabela,
                 array_to_string(array(select quote_ident(x) from unnest(v_pk) x), ', '),
                 array_to_string(array(select quote_ident(x) from unnest(v_pk) x), ', '), p_tabela, p_tabela) into v_antes using p_chave;
  if v_antes is null then raise exception 'Registro não encontrado. Recarregue a tabela.' using errcode = 'P0002'; end if;
  perform auditar_dev('dev.apagou', p_tabela, v_antes, null, v_pk);
end $$;

-- Cadastros já entram no histórico pelos próprios gatilhos; o resto (movimento) é registrado aqui, com o CPF mascarado
create or replace function auditar_dev(p_acao text, p_tabela text, p_antes jsonb, p_depois jsonb, p_pk text[]) returns void
language plpgsql security definer set search_path = public as $$
declare m jsonb;
begin
  if p_tabela in ('veiculos', 'motoristas', 'veiculo_motoristas', 'caminhoes_diesel', 'frentistas', 'tanques', 'bombas', 'acessos', 'configuracoes') then return; end if;
  m := jsonb_build_object('antes', case when p_antes ? 'cpf' then p_antes || jsonb_build_object('cpf', '***' || right(p_antes ->> 'cpf', 2)) else p_antes end,
                          'depois', case when p_depois ? 'cpf' then p_depois || jsonb_build_object('cpf', '***' || right(p_depois ->> 'cpf', 2)) else p_depois end);
  perform auditar(p_acao, p_tabela, (select string_agg(coalesce(p_depois, p_antes) ->> x, ' · ') from unnest(p_pk) x), m);
end $$;

-- Saúde do sistema: fila do Drive, relatórios esperando, espaço usado e a versão das telas em cada celular
create or replace function dev_saude() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_fotos_bytes bigint;
begin
  perform exigir(array['desenvolvedor']);
  if to_regclass('storage.objects') is not null then
    execute $q$select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects where bucket_id = 'fotos'$q$ into v_fotos_bytes;
  end if;
  return jsonb_build_object(
    'comprovantes_na_fila', (select count(*) from fotos where entidade = 'abastecimento' and not fora_do_storage),
    'fila_desde', (select min(criado_em) from fotos where entidade = 'abastecimento' and not fora_do_storage),
    'ultimo_no_drive', (select max(no_drive_em) from fotos),
    'relatorios_esperando', jsonb_array_length(relatorios_para_drive()),
    'ultimo_relatorio', (select max(gerado_em) from relatorios_diarios),
    'banco_bytes', pg_database_size(current_database()),
    'fotos_bytes', v_fotos_bytes,
    'aparelhos', coalesce((select jsonb_agg(jsonb_build_object('conta', p.conta, 'nome', a.nome, 'papel', a.papel, 'versao', p.versao, 'visto_em', p.visto_em)
                                    order by p.visto_em desc) from aparelhos p left join acessos a on a.email = p.conta), '[]'));
end $$;

-- ---------- RLS: ninguém vê nada sem estar em "acessos" ----------
do $$
declare t text;
begin
  foreach t in array array['acessos', 'frentistas', 'frentistas_pin', 'sessoes_frentista', 'veiculos', 'motoristas', 'veiculo_motoristas', 'tanques', 'caminhoes_diesel',
                           'bombas', 'lotes', 'abastecimentos', 'chegadas', 'fechamentos', 'afericoes', 'precos_diesel', 'fotos', 'auditoria', 'configuracoes',
                           'relatorios_diarios', 'aparelhos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon', t);
    execute format('drop policy if exists supervisor_le on %I', t);
    execute format('drop policy if exists supervisor_edita on %I', t);
  end loop;
  -- Leitura pelo painel (PINs, sessões e auditoria têm regra própria)
  foreach t in array array['acessos', 'frentistas', 'veiculos', 'motoristas', 'veiculo_motoristas', 'tanques', 'bombas', 'caminhoes_diesel',
                           'lotes', 'abastecimentos', 'chegadas', 'fechamentos', 'afericoes', 'precos_diesel', 'fotos', 'configuracoes', 'relatorios_diarios'] loop
    execute format('create policy supervisor_le on %I for select to authenticated using (sou_gestor())', t);
  end loop;
  -- Cadastros: supervisor e administrador editam direto (com histórico automático pelos gatilhos)
  foreach t in array array['acessos', 'frentistas', 'veiculos', 'motoristas', 'veiculo_motoristas', 'tanques', 'bombas', 'caminhoes_diesel'] loop
    execute format('create policy supervisor_edita on %I for all to authenticated using (sou_gestor()) with check (sou_gestor())', t);
  end loop;
end $$;
-- frentistas_pin e sessoes_frentista: sem política nenhuma (só as funções acessam)
-- Celulares e versões: só o desenvolvedor lê (pelo painel, na saúde do sistema e no banco de dados)
drop policy if exists dev_le on aparelhos;
create policy dev_le on aparelhos for select to authenticated using (meu_papel() = 'desenvolvedor');
-- Horário do turno: administrador ou desenvolvedor
drop policy if exists admin_edita on configuracoes;
create policy admin_edita on configuracoes for update to authenticated
  using (nivel_papel(meu_papel()) >= 2) with check (nivel_papel(meu_papel()) >= 2);

-- Histórico: cada um vê o próprio nível e os de baixo (celular conta como 0); o administrador também vê o desenvolvedor
drop policy if exists supervisor_le on auditoria;
drop policy if exists auditoria_le on auditoria;
create policy auditoria_le on auditoria for select to authenticated
  using (sou_gestor() and (nivel_papel(meu_papel()) >= 2 or nivel_papel(papel) <= nivel_papel(meu_papel())));

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
      and (public.foto_valida(name, 'fechamento') or public.foto_valida(name, 'chegada') or public.foto_valida(name, 'veiculo')
           or public.foto_valida(name, 'afericao') or public.foto_valida(name, 'abastecimento')))$p$;
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

grant execute on function meu_email(), meu_papel(), estado_posto(), entrar_frentista(bigint, text), sair_frentista(text), informar_versao(text),
  dev_estrutura(), dev_salvar(text, jsonb, jsonb), dev_apagar(text, jsonb), dev_saude(),
  registrar_abastecimento(text, jsonb, text[]), registrar_chegada(text, jsonb, text[]), registrar_fechamento(text, jsonb, text[], date),
  fechar_sem_medicao(date, text), marcar_visto(text, text), folha_do_dia(date), dias_sem_fechamento(),
  registrar_afericao(text, jsonb, text[]),
  cadastrar_veiculo_app(text, text, numeric, integer, text), cadastrar_motorista_app(text, text, text),
  corrigir_veiculo_app(text, text, numeric, integer), definir_preco_diesel(text, numeric, text),
  definir_pin(bigint, text), decidir_autorizacao(bigint, boolean, text), importar_vinculos(jsonb),
  decidir_abastecimento(bigint, text, text, jsonb), marcar_erro_kmm(bigint, text),
  gerar_lote(date), linhas_lote(bigint), fechar_lote(bigint, text), reabrir_turno(date, text), turnos_kmm(integer), calcular_fechamento(date), fotos_de(text, text), anexar_foto_veiculo(text, text), excluir_foto(text)
  to authenticated;
-- As políticas RLS, as do Storage e os gatilhos chamam estas; precisam estar liberadas para quem está logado
grant execute on function exigir(text[]), sou_gestor(), nivel_papel(text), regra(text), fora_do_turno(timestamp), agora_local(), hoje(), normaliza_placa(text), normaliza_nome(text),
  placa_valida(text), cpf_valido(text), fmt(numeric), foto_valida(text, text), normalizar_cadastro(), auditar_cadastro(),
  bloquear_alteracao(), proteger_acessos(), proteger_foto()
  to authenticated;
-- Só o Apps Script do Google Drive (chave service_role)
grant execute on function fotos_para_drive(integer), foto_no_drive(text, text, text, boolean), relatorios_para_drive(),
  relatorio_no_drive(date, text, text, timestamptz) to service_role;

-- ---------- Ajuste de regra (sem desconto não espera mais autorização) ----------
-- Os que estavam esperando autorização só por falta de desconto passam pela conferência e seguem o caminho normal.
-- Os de fora do horário (regra antiga) continuam esperando a decisão do supervisor. Rodar de novo não muda nada.
do $$
declare a abastecimentos; c jsonb;
begin
  for a in select * from abastecimentos where status = 'Aguardando autorização' and not fora_horario loop
    c := conferir_abastecimento(a.data_hora, a.placa, a.motorista, a.km, a.litros, a.encerrante, a.bomba, a.id);
    update abastecimentos set status = c ->> 'status', problemas = c -> 'problemas', cpf = c ->> 'cpf',
           encerrante_anterior = (c ->> 'encerrante_anterior')::numeric, tanque = c ->> 'tanque', atualizado_em = now()
     where id = a.id;
  end loop;
end $$;
