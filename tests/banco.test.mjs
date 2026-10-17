// Testa o schema.sql num PostgreSQL de verdade (PGlite), simulando o ambiente do Supabase:
// papéis anon/authenticated, permissões padrão e auth.jwt() com o e-mail de quem está logado.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const SUPABASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth, public to anon, authenticated, service_role;
  grant execute on function auth.jwt() to anon, authenticated;
  -- O Supabase dá estas permissões por padrão; quem protege é o RLS e os revokes do schema.sql
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
`;
const POSTO = 'posto1@empresa.com', CHEFE = 'chefe@empresa.com', ESTRANHO = 'qualquer@gmail.com', DONO = 'dono@empresa.com', DEV = 'dev@empresa.com';
let db, base, ana, carlos, sessao;

// Executa como um usuário logado (papel authenticated + claims do JWT), igual ao PostgREST do Supabase
async function como(email, sql, params = [], provider = 'google') {
  return db.transaction(async tx => {
    await tx.query('set local role authenticated');
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ email, app_metadata: { provider } })]);
    return (await tx.query(sql, params)).rows;
  });
}
const rpc = async (email, fn, args = {}) => {
  const nomes = Object.keys(args);
  const sql = `select ${fn}(${nomes.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  const valor = v => Array.isArray(v) && v.every(x => typeof x === 'string') ? v : (typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  return (await como(email, sql, nomes.map(n => valor(args[n]))))[0].r;
};
const dh = minutosAtras => {
  const d = new Date(base.getTime() - minutosAtras * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
};
const reg = (min, extra = {}) => ({ uuid: randomUUID(), data_hora: dh(min), placa: 'ABC1D23', motorista: 'João da Silva',
  km: 150200, litros: 640, encerrante: 7071686, bomba: 1, desconto: true, ...extra });
const foto = pasta => `${pasta}/${randomUUID()}.jpg`;
// Encerrante de cada bomba como o sistema conhece agora (o que o frentista lê no fechamento e na abertura)
const encerrantes = async () => Object.fromEntries((await db.query('select numero, encerrante_ate(numero, null)::float as e from bombas where ativa')).rows.map(r => [r.numero, r.e]));
const abastecer = (dados, s = sessao, fotos = [foto('abastecimento')]) => rpc(POSTO, 'registrar_abastecimento', { p_sessao: s, p_dados: dados, p_fotos: fotos });
// Apps Script do Google Drive: chama o banco com a chave service_role
async function comoServico(sql, params = []) {
  return db.transaction(async tx => {
    await tx.query('set local role service_role');
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })]);
    return (await tx.query(sql, params)).rows;
  });
}

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE);
  await db.exec(SCHEMA);
  await db.exec(SCHEMA);   // rodar de novo não pode dar erro (atualização do schema)
  await db.exec(`
    insert into acessos (email, nome, papel) values ('${POSTO}', 'Celular posto 1', 'posto'), ('${CHEFE}', 'Chefe', 'supervisor'),
                                                    ('${DONO}', 'Dono', 'administrador'), ('${DEV}', 'Dev', 'desenvolvedor');
    insert into frentistas (nome) values ('Ana Ribeiro'), ('Carlos Mendes');
    insert into tanques values ('TQ01', 30000, 12000);
    insert into bombas values (1, 'TQ01', 7071046, true), (2, 'TQ01', 512000, true);   -- 1 tanque, 2 bombas
    insert into veiculos (placa, capacidade_l, km_inicial) values ('ABC1D23', 700, 149500), ('DEF4567', 600, 97500);
    insert into motoristas (nome, cpf) values ('JOAO DA SILVA', '52998224725');
    -- Nos testes o turno é o dia inteiro, a hora pode ser de dias atrás e o dia anterior aberto não trava (cada regra tem o seu teste)
    update configuracoes set abertura = '00:00', fechamento = '23:59:59', atraso_lancamento_min = 20160, exigir_fechamento = false, exigir_abertura = false;`);
  [ana, carlos] = (await db.query("select id from frentistas order by nome")).rows.map(r => r.id);
  const t = (await db.query("select to_char(agora_local(), 'YYYY-MM-DD\"T\"HH24:MI:SS') as t")).rows[0].t;
  base = new Date(t);
});

// ---------- Acesso ----------
test('sem login (anon) não lê tabela nenhuma', async () => {
  await assert.rejects(db.transaction(async tx => { await tx.query('set local role anon'); await tx.query('select * from veiculos'); }), /permission denied/);
});

test('conta Google não autorizada não vê nada nem chama funções', async () => {
  assert.equal((await como(ESTRANHO, 'select * from veiculos')).length, 0);
  await assert.rejects(rpc(ESTRANHO, 'estado_posto'), /Acesso negado/);
  await assert.rejects(rpc(ESTRANHO, 'entrar_frentista', { p_frentista_id: 1, p_pin: '1234' }), /Acesso negado/);
  await assert.rejects(rpc(ESTRANHO, 'calcular_fechamento', { p_dia: dh(0).slice(0, 10) }), /Acesso negado/);
});

test('mesmo e-mail autorizado, mas sem ser login Google, é recusado', async () => {
  await assert.rejects(como(CHEFE, 'select turnos_kmm(5)', [], 'email'), /Acesso negado/);
});

test('celular não grava nem lê tabelas diretamente, e ninguém lê PINs ou sessões', async () => {
  await assert.rejects(como(POSTO, "insert into veiculos (placa, capacidade_l) values ('ZZZ1Z11', 500)"), /row-level security/);
  assert.equal((await como(POSTO, 'select * from motoristas')).length, 0);
  assert.equal((await como(CHEFE, 'select * from frentistas_pin')).length, 0);
  assert.equal((await como(DONO, 'select * from sessoes_frentista')).length, 0);
});

test('funções internas não podem ser chamadas de fora', async () => {
  await assert.rejects(como(POSTO, "select conferir_abastecimento(now()::timestamp, 'ABC1D23', 'X', 1, 1, 1, 1)"), /permission denied/);
  await assert.rejects(como(POSTO, "select auditar('x', null, null, null)"), /permission denied/);
  await assert.rejects(como(POSTO, "select frentista_da_sessao('x')"), /permission denied/);
  await assert.rejects(como(POSTO, "select registrar_fotos('chegada', '1', '{}', null)"), /permission denied/);
});

test('celular não pode chamar funções do supervisor', async () => {
  await assert.rejects(rpc(POSTO, 'gerar_lote', { p_dia: dh(0).slice(0, 10) }), /Acesso negado/);
  await assert.rejects(rpc(POSTO, 'definir_pin', { p_frentista_id: ana, p_pin: '4827' }), /Acesso negado/);
  await assert.rejects(rpc(POSTO, 'decidir_autorizacao', { p_id: 1, p_aprovar: true, p_motivo: 'teste' }), /Acesso negado/);
});

// ---------- Login do frentista ----------
test('supervisor define PIN; PIN fraco é recusado', async () => {
  await assert.rejects(rpc(CHEFE, 'definir_pin', { p_frentista_id: ana, p_pin: '1234' }), /fácil demais/);
  await assert.rejects(rpc(CHEFE, 'definir_pin', { p_frentista_id: ana, p_pin: '12a4' }), /4 números/);
  await rpc(CHEFE, 'definir_pin', { p_frentista_id: ana, p_pin: '4827' });
  await rpc(CHEFE, 'definir_pin', { p_frentista_id: carlos, p_pin: '9153' });
  const e = await rpc(POSTO, 'estado_posto');
  assert.ok(e.frentistas.every(f => f.tem_pin));
  assert.ok(!JSON.stringify(e).includes('52998224725'));    // CPF não vai para o celular
});

test('frentista entra com nome + PIN; PIN errado conta tentativas e bloqueia na 5ª', async () => {
  const errado = await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '0000' });
  assert.equal(errado.ok, false);
  assert.match(errado.erro, /Restam 4/);
  for (let i = 0; i < 4; i++) await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '0001' });
  const certoMasBloqueado = await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '9153' });
  assert.match(certoMasBloqueado.erro, /Bloqueado/);
  await rpc(CHEFE, 'definir_pin', { p_frentista_id: carlos, p_pin: '9153' });   // supervisor desbloqueia definindo o PIN de novo
  assert.equal((await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '9153' })).ok, true);

  const r = await rpc(POSTO, 'entrar_frentista', { p_frentista_id: ana, p_pin: '4827' });
  assert.equal(r.ok, true);
  assert.equal(r.frentista.nome, 'Ana Ribeiro');
  sessao = r.sessao;
  const guardados = (await db.query('select token_hash from sessoes_frentista')).rows.map(x => x.token_hash);
  assert.ok(!guardados.includes(sessao));                 // o banco guarda só o hash do token
});

test('sessão do frentista só vale no celular que fez login e cai quando o PIN muda', async () => {
  await assert.rejects(rpc(CHEFE, 'registrar_abastecimento', { p_sessao: sessao, p_dados: reg(20), p_fotos: [foto('abastecimento')] }), /Login do frentista expirou/);
  await assert.rejects(abastecer(reg(20), 'token-inventado'), /Login do frentista expirou/);
  const outra = (await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '9153' })).sessao;
  await rpc(CHEFE, 'definir_pin', { p_frentista_id: carlos, p_pin: '6402' });
  await assert.rejects(abastecer(reg(20), outra), /Login do frentista expirou/);
});

// ---------- Abastecimento e desconto ----------
test('abastecimento com desconto confirmado fica Pronto; toque duplo não duplica', async () => {
  const r = reg(9);
  const a = await abastecer(r);
  assert.equal(a.status, 'Pronto', JSON.stringify(a.problemas));
  assert.equal((await abastecer(r)).id, a.id);
  const linha = (await db.query('select frentista_id, conta from abastecimentos where id = $1', [a.id])).rows[0];
  assert.deepEqual(linha, { frentista_id: ana, conta: POSTO });
});

test('sem desconto: exige justificativa e segue o caminho normal (o diesel já saiu); vira alerta até alguém tocar em Visto', async () => {
  await assert.rejects(abastecer(reg(8, { km: 150300, litros: 100, encerrante: 7071786, desconto: false })), /justificativa/);
  const a = await abastecer(reg(8, { km: 150300, litros: 100, encerrante: 7071786, desconto: false,
    justificativa_desconto: 'Motorista agregado, acerto só no fim do mês' }));
  assert.equal(a.status, 'Pronto');   // não espera autorização: vai para o KMM
  await assert.rejects(rpc(POSTO, 'marcar_visto', { p_tipo: 'desconto', p_chave: String(a.id) }), /Acesso negado/);
  await rpc(CHEFE, 'marcar_visto', { p_tipo: 'desconto', p_chave: String(a.id) });
  assert.equal((await db.query('select alerta_visto_por from abastecimentos where id = $1', [a.id])).rows[0].alerta_visto_por, CHEFE);
  await assert.rejects(rpc(DONO, 'marcar_visto', { p_tipo: 'desconto', p_chave: String(a.id) }), /já foi visto/);
});

test('fora do horário não entra: nem com o posto fechado agora, nem com hora digitada fora do turno ou atrasada', async () => {
  const hora = d => `(agora_local() + interval '${d} minutes')::time`;
  const d = { placa: 'DEF4567', km: 98000, litros: 5, encerrante: 7071791 };
  try {
    await db.exec(`update configuracoes set abertura = ${hora(60)}, fechamento = ${hora(120)}`);   // turno só daqui a 1 hora
    await assert.rejects(abastecer(reg(0, d)), /fora do horário do turno/);
    await db.exec(`update configuracoes set abertura = ${hora(-10)}, fechamento = ${hora(60)}`);   // abriu há 10 minutos
    await assert.rejects(abastecer(reg(20, d)), /está fora do turno/);                               // hora digitada antes da abertura
    await db.exec(`update configuracoes set abertura = '00:00', fechamento = '23:59:59', atraso_lancamento_min = 30`);
    await assert.rejects(abastecer(reg(45, d)), /mais de 30 minutos atrás/);
  } finally {
    await db.exec("update configuracoes set abertura = '00:00', fechamento = '23:59:59', atraso_lancamento_min = 20160");
  }
  assert.equal((await db.query("select count(*)::int as n from abastecimentos where placa = 'DEF4567'")).rows[0].n, 0);
});

test('lançamento antigo que esperava autorização só por falta de desconto passa a seguir o caminho normal', async () => {
  const a = await abastecer(reg(7, { placa: 'DEF4567', km: 98000, litros: 10, encerrante: 7071796, desconto: false, justificativa_desconto: 'Sem tempo de descontar' }));
  await db.exec(`update abastecimentos set status = 'Aguardando autorização' where id = ${a.id}`);   // como ficava na regra antiga
  await db.exec(SCHEMA);
  assert.notEqual((await db.query('select status from abastecimentos where id = $1', [a.id])).rows[0].status, 'Aguardando autorização');
  await rpc(CHEFE, 'decidir_abastecimento', { p_id: a.id, p_acao: 'cancelar', p_motivo: 'Teste da regra nova' });   // não entra nas contas dos outros testes
});

test('banco reconfere: encerrante não bate vira Exceção, com número formatado', async () => {
  const a = await abastecer(reg(6, { km: 150400, litros: 50, encerrante: 7071900 }));
  assert.equal(a.status, 'Exceção');
  assert.ok(a.problemas.some(p => p.includes('Encerrante indica 114 L (de 7.071.786 para 7.071.900)')), a.problemas.join(' | '));
});

test('2 bombas no mesmo tanque: bomba trocada é apontada e o supervisor corrige', async () => {
  // encerrante da bomba 1 (7.071.900 + 20 L), mas o frentista marcou a bomba 2
  const errada = await abastecer(reg(4, { placa: 'DEF4567', km: 98100, litros: 20, encerrante: 7071920, bomba: 2 }));
  assert.equal(errada.status, 'Exceção');
  assert.ok(errada.problemas.some(p => p.includes('bate com a bomba 1')), errada.problemas.join(' | '));
  const certa = await rpc(CHEFE, 'decidir_abastecimento', { p_id: errada.id, p_acao: 'revalidar', p_motivo: 'Frentista marcou a bomba errada',
    p_alteracoes: { bomba: 1 } });
  assert.equal(certa.status, 'Pronto', JSON.stringify(certa.problemas));
  assert.equal(certa.tanque, 'TQ01');
  const b2 = await abastecer(reg(3, { placa: 'DEF4567', km: 98200, litros: 30, encerrante: 512030, bomba: 2 }));
  assert.equal(b2.status, 'Pronto', JSON.stringify(b2.problemas));
  const e = await rpc(POSTO, 'estado_posto');
  assert.deepEqual(e.bombas.map(b => [b.numero, b.tanque, Number(b.encerrante_anterior)]), [[1, 'TQ01', 7071920], [2, 'TQ01', 512030]]);
});

test('aferição semanal: bomba, visor na medida de 20 L e foto; o encerrante anda sem contar como saída', async () => {
  let e = await rpc(POSTO, 'estado_posto');
  assert.ok(e.bombas.every(b => b.afericao_vencida));            // nunca feita = vencida
  const dados = (extra = {}) => ({ uuid: randomUUID(), bomba: 2, data_hora: dh(2), visor: 20.05, ...extra });
  const aferir = (d, fotos = [foto('afericao')]) => rpc(POSTO, 'registrar_afericao', { p_sessao: sessao, p_dados: d, p_fotos: fotos });
  await assert.rejects(aferir(dados(), []), /foto/);
  await assert.rejects(aferir(dados({ visor: 30 })), /medida de 20 L/);
  await assert.rejects(aferir(dados(), [foto('chegada')]), /Foto inválida/);
  await assert.rejects(rpc(CHEFE, 'registrar_afericao', { p_sessao: sessao, p_dados: dados(), p_fotos: [foto('afericao')] }), /Login do frentista expirou/);
  const d = dados();
  const a = await aferir(d);
  assert.equal(a.alerta, false);                                   // +50 mL: dentro da tolerância
  assert.equal((await aferir(d)).id, a.id);                        // reenvio não duplica
  assert.equal((await aferir(dados({ bomba: 1, visor: 20.15 }))).alerta, true);   // +150 mL: alerta
  e = await rpc(POSTO, 'estado_posto');
  assert.ok(e.bombas.every(b => !b.afericao_vencida));
  assert.equal(Number(e.bombas.find(b => b.numero === 2).encerrante_anterior), 512050.05);
  // o próximo abastecimento na bomba 2 parte do encerrante depois da aferição
  const b2 = await abastecer(reg(1, { placa: 'DEF4567', km: 98300, litros: 10, encerrante: 512060.05, bomba: 2 }));
  assert.equal(b2.status, 'Pronto', JSON.stringify(b2.problemas));
  assert.equal((await rpc(CHEFE, 'fotos_de', { p_entidade: 'afericao', p_chave: String(a.id) })).length, 1);
  assert.equal((await como(POSTO, 'select * from afericoes')).length, 0);   // celular não lê a tabela direto
});

test('placa puxa os motoristas vinculados: o lançamento cria o vínculo sozinho', async () => {
  const e = await rpc(POSTO, 'estado_posto');
  const motoristasDa = p => e.veiculos.find(v => v.placa === p).motoristas;
  assert.deepEqual(motoristasDa('ABC1D23'), ['JOAO DA SILVA']);
  assert.deepEqual(motoristasDa('DEF4567'), ['JOAO DA SILVA']);
  assert.equal((await db.query("select count(*)::int as n from veiculo_motoristas where placa = 'ABC1D23'")).rows[0].n, 1);   // vários lançamentos, um vínculo
  const aud = (await db.query("select papel, detalhes from auditoria where acao = 'cadastro.veiculo_motoristas.insert' order by id limit 1")).rows[0];
  assert.equal(aud.papel, 'posto');
  assert.equal(aud.detalhes.depois.motorista, 'JOAO DA SILVA');   // o histórico mostra o nome
  assert.equal((await como(POSTO, 'select * from veiculo_motoristas')).length, 0);
  await assert.rejects(como(POSTO, "insert into veiculo_motoristas (placa, motorista_id) values ('ABC1D23', 1)"), /row-level security/);
});

// ---------- Cadastros pelo frentista ----------
test('frentista cadastra veículo novo com foto, mas não altera um existente', async () => {
  await assert.rejects(rpc(POSTO, 'cadastrar_veiculo_app', { p_sessao: sessao, p_placa: 'GHI8J90', p_capacidade: 500, p_km: 220000, p_foto: null }), /foto/);
  const f = foto('veiculo');
  const r = await rpc(POSTO, 'cadastrar_veiculo_app', { p_sessao: sessao, p_placa: 'ghi-8j90', p_capacidade: 500, p_km: 220000, p_foto: f });
  assert.equal(r.placa, 'GHI8J90');
  const v = (await db.query("select criado_por from veiculos where placa = 'GHI8J90'")).rows[0];
  assert.equal(v.criado_por, 'Frentista: Ana Ribeiro');
  assert.equal((await rpc(CHEFE, 'fotos_de', { p_entidade: 'veiculo', p_chave: 'GHI8J90' }))[0].caminho, f);
  await assert.rejects(rpc(POSTO, 'cadastrar_veiculo_app', { p_sessao: sessao, p_placa: 'ABC1D23', p_capacidade: 900, p_km: 1, p_foto: foto('veiculo') }), /já está cadastrada/);
  assert.equal((await como(POSTO, "update veiculos set capacidade_l = 900 where placa = 'GHI8J90' returning placa")).length, 0);
  assert.equal(Number((await db.query("select capacidade_l from veiculos where placa = 'GHI8J90'")).rows[0].capacidade_l), 500);
});

test('frentista cadastra motorista com CPF válido; duplicado é recusado', async () => {
  await assert.rejects(rpc(POSTO, 'cadastrar_motorista_app', { p_sessao: sessao, p_nome: 'Fulano de Tal', p_cpf: '111.111.111-11' }), /CPF inválido/);
  const r = await rpc(POSTO, 'cadastrar_motorista_app', { p_sessao: sessao, p_nome: 'Maria Souza', p_cpf: '111.444.777-35' });
  assert.equal(r.nome, 'MARIA SOUZA');
  await assert.rejects(rpc(POSTO, 'cadastrar_motorista_app', { p_sessao: sessao, p_nome: 'Outra Pessoa', p_cpf: '11144477735' }), /já cadastrado/);
});

test('supervisor importa planilha de placa + nome: cria o que falta, vincula e aponta os erros', async () => {
  await assert.rejects(rpc(POSTO, 'importar_vinculos', { p_linhas: [{ placa: 'ABC1D23', motorista: 'JOAO DA SILVA' }] }), /Acesso negado/);
  const r = await rpc(CHEFE, 'importar_vinculos', { p_linhas: [
    { linha: 2, placa: 'def-4567', motorista: 'maria souza' },
    { linha: 3, placa: 'JKL2M34', motorista: 'Pedro Novo' },          // placa e motorista novos: tanque de 1100 L e sem CPF
    { linha: 4, placa: 'ABC1D23', cpf: '111.444.777-35' },            // achado pelo CPF
    { linha: 5, placa: 'ABC1D23', motorista: 'João da Silva' },       // já vinculado: conta como certo e não duplica
    { linha: 6, placa: 'XX1', motorista: 'Fulano de Tal' },
    { linha: 7, placa: 'ABC1D23', motorista: 'Maria Souza', cpf: '123.456.789-09' },
    { linha: 8, placa: 'MNO3P45', motorista: '' },
  ] });
  assert.deepEqual([r.ok, r.veiculos_novos, r.motoristas_novos], [4, 1, 1]);
  assert.deepEqual(r.erros, ['Linha 6: placa XX1 inválida', 'Linha 7: MARIA SOUZA já está cadastrado com outro CPF', 'Linha 8: falta o nome do motorista']);
  const novo = (await db.query("select capacidade_l::float as capacidade_l, criado_por from veiculos where placa = 'JKL2M34'")).rows[0];
  assert.deepEqual(novo, { capacidade_l: 1100, criado_por: 'Planilha' });
  const e = await rpc(POSTO, 'estado_posto');
  assert.deepEqual(e.veiculos.find(v => v.placa === 'ABC1D23').motoristas, ['JOAO DA SILVA', 'MARIA SOUZA']);
  assert.deepEqual(e.veiculos.find(v => v.placa === 'DEF4567').motoristas, ['JOAO DA SILVA', 'MARIA SOUZA']);
  // o supervisor tira um vínculo pelo painel
  assert.equal((await como(CHEFE, "delete from veiculo_motoristas where placa = 'DEF4567' and motorista_id = (select id from motoristas where nome = 'MARIA SOUZA') returning placa")).length, 1);
});

test('placa e motorista da planilha: o tanque já vem com 1100 L e o frentista completa o CPF no primeiro abastecimento', async () => {
  let e = await rpc(POSTO, 'estado_posto');
  const jkl = () => e.veiculos.find(v => v.placa === 'JKL2M34');
  assert.equal(Number(jkl().capacidade_l), 1100);
  assert.deepEqual(jkl().motoristas, ['PEDRO NOVO']);
  assert.ok(e.motoristas_sem_cpf.includes('PEDRO NOVO'));
  assert.ok(!JSON.stringify(e).includes('11144477735'));   // continua sem mandar CPF para o celular
  const base = { placa: 'JKL2M34', motorista: 'Pedro Novo', km: 50000, litros: 10, encerrante: 512070.05, bomba: 2 };
  await assert.rejects(abastecer(reg(0, { ...base, cpf: '529.982.247-25' })), /outro motorista/);
  await assert.rejects(abastecer(reg(0, { ...base, cpf: '111.111.111-12' })), /CPF do motorista inválido/);
  const a = await abastecer(reg(0, { ...base, cpf: '123.456.789-09' }));
  assert.equal(a.status, 'Pronto', JSON.stringify(a.problemas));   // KM do lançamento vira o primeiro da placa
  e = await rpc(POSTO, 'estado_posto');
  assert.equal(Number(jkl().capacidade_l), 1100);
  assert.ok(!e.motoristas_sem_cpf.includes('PEDRO NOVO'));
  assert.equal((await db.query("select cpf from motoristas where nome = 'PEDRO NOVO'")).rows[0].cpf, '12345678909');
});

test('frentista corrige tanque e KM do caminhão: vale na hora, o KM vira o ponto de partida e fica no histórico', async () => {
  const corrigir = (args, s = sessao) => rpc(POSTO, 'corrigir_veiculo_app', { p_sessao: s, p_placa: 'JKL2M34', p_capacidade: null, p_km: null, ...args });
  await assert.rejects(corrigir({}), /tanque ou o KM/);
  await assert.rejects(corrigir({ p_capacidade: 9000 }), /Tamanho do tanque inválido/);
  await assert.rejects(corrigir({ p_km: 10 }, 'token-inventado'), /Login do frentista expirou/);
  const r = await corrigir({ p_capacidade: 450 });
  assert.equal(Number(r.capacidade_l), 450);
  // o painel do caminhão foi trocado: KM menor que o último lançado (50.000); depois da correção, vale o novo
  let e = await rpc(POSTO, 'estado_posto');
  assert.equal(Number(e.veiculos.find(v => v.placa === 'JKL2M34').km_ultimo), 50000);
  await corrigir({ p_km: 1200 });
  e = await rpc(POSTO, 'estado_posto');
  const v = e.veiculos.find(x => x.placa === 'JKL2M34');
  assert.deepEqual([v.km_ultimo, Number(v.km_cadastro), Number(v.km_anterior)], [null, 1200, 1200]);
  // mesmo KM do painel na hora da correção é aceito; menor não
  const base = { placa: 'JKL2M34', motorista: 'Pedro Novo', litros: 10, bomba: 2 };
  const menor = await abastecer({ ...reg(0, { ...base, km: 1100, encerrante: 512080.05 }), data_hora: dh(-1) });
  assert.equal(menor.status, 'Exceção');
  assert.ok(menor.problemas.some(p => p.includes('menor que o KM do cadastro')), menor.problemas.join(' | '));
  await rpc(CHEFE, 'decidir_abastecimento', { p_id: menor.id, p_acao: 'cancelar', p_motivo: 'Teste: KM errado' });
  const igual = await abastecer({ ...reg(0, { ...base, km: 1200, encerrante: 512080.05 }), data_hora: dh(-2) });
  assert.equal(igual.status, 'Pronto', JSON.stringify(igual.problemas));
  const aud = (await db.query("select detalhes from auditoria where acao = 'veiculo.corrigido' and entidade_id = 'JKL2M34' order by id")).rows.map(x => x.detalhes);
  assert.deepEqual(aud.map(d => [d.frentista, d.capacidade, d.km]), [['Ana Ribeiro', [1100, 450], null], ['Ana Ribeiro', null, [null, 1200]]]);
});

test('preço do diesel: o frentista atualiza, o lançamento usa e grava o valor; aferições vêm com o nome de quem fez', async () => {
  let e = await rpc(POSTO, 'estado_posto');
  assert.equal(e.preco_diesel, null);   // ainda não informado
  const preco = (p, origem = 'app') => rpc(POSTO, 'definir_preco_diesel', { p_sessao: sessao, p_preco: p, p_origem: origem });
  await assert.rejects(preco(0), /Preço do litro inválido/);
  await assert.rejects(preco(6, 'painel'), /Origem inválida/);
  await preco(6.05);
  assert.equal((await preco(6.19, 'chegada')).por, 'Ana Ribeiro');
  e = await rpc(POSTO, 'estado_posto');
  assert.deepEqual([Number(e.preco_diesel.preco), e.preco_diesel.por, e.preco_diesel.origem], [6.19, 'Ana Ribeiro', 'chegada']);
  const aud = (await db.query("select papel, detalhes from auditoria where acao = 'preco.alterado' order by id")).rows;
  assert.deepEqual(aud.map(x => [x.papel, x.detalhes.antes, x.detalhes.depois]), [['posto', null, 6.05], ['posto', 6.05, 6.19]]);
  assert.equal((await como(POSTO, 'select * from precos_diesel')).length, 0);   // celular não lê a tabela direto
  // lançamento com o preço: valor total = litros x preço
  const base = { placa: 'JKL2M34', motorista: 'Pedro Novo', km: 1250, litros: 10, encerrante: 512090.05, bomba: 2 };
  await assert.rejects(abastecer({ ...reg(0, { ...base, preco: 500 }), data_hora: dh(-3) }), /Preço do litro inválido/);
  const a = await abastecer({ ...reg(0, { ...base, preco: 6.19 }), data_hora: dh(-3) });
  assert.equal(a.status, 'Pronto', JSON.stringify(a.problemas));
  assert.deepEqual((await db.query('select preco_litro::float as p, valor_total::float as v from abastecimentos where id = $1', [a.id])).rows[0], { p: 6.19, v: 61.9 });
  // histórico de aferições no app: as duas feitas pela Ana, com a diferença
  assert.equal(e.afericoes_recentes.length, 2);
  assert.ok(e.afericoes_recentes.every(x => x.frentista === 'Ana Ribeiro'));
  assert.deepEqual(e.afericoes_recentes.map(x => [x.bomba, Number(x.diferenca_l)]).sort(), [[1, 0.15], [2, 0.05]]);
});

test('todo abastecimento exige uma foto do comprovante com o visor da bomba', async () => {
  const d = reg(3, { km: 150500, litros: 20, encerrante: 7071706 });
  await assert.rejects(abastecer(d, sessao, []), /foto do comprovante/);
  await assert.rejects(abastecer(d, sessao, [foto('abastecimento'), foto('abastecimento')]), /foto do comprovante/);
  await assert.rejects(abastecer(d, sessao, [foto('chegada')]), /Foto inválida/);
  assert.equal((await db.query('select count(*)::int as n from abastecimentos where uuid = $1', [d.uuid])).rows[0].n, 0);
  const f = foto('abastecimento');
  const a = await abastecer(d, sessao, [f]);
  assert.equal((await rpc(CHEFE, 'fotos_de', { p_entidade: 'abastecimento', p_chave: String(a.id) }))[0].caminho, f);
  assert.equal((await abastecer(d, sessao, [foto('abastecimento')])).id, a.id);   // reenvio devolve o já gravado
  await rpc(CHEFE, 'decidir_abastecimento', { p_id: a.id, p_acao: 'cancelar', p_motivo: 'Teste da foto' });   // não entra nas contas dos outros testes
});

test('comprovantes vão para o Google Drive: só o Apps Script (service_role) lê a fila e marca o que foi copiado', async () => {
  await assert.rejects(como(POSTO, 'select fotos_para_drive(10)'), /permission denied/);
  await assert.rejects(como(CHEFE, "select foto_no_drive('x', 'y', 'z', true)"), /permission denied/);
  const fila = (await comoServico('select fotos_para_drive(100) as r'))[0].r;
  assert.ok(fila.length >= 1);
  assert.ok(fila.every(x => /^abastecimento\//.test(x.caminho) && /^[A-Z]{3}\d/.test(x.placa) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(x.data_hora)));
  const [x] = fila;
  const marcar = (id, url, fora) => comoServico('select foto_no_drive($1, $2, $3, $4)', [x.caminho, id, url, fora]);
  await assert.rejects(marcar('../x', 'https://drive.google.com/file/d/abc/view', false), /ID do Drive inválido/);
  await assert.rejects(marcar('1AbCdEfGhIjKlMn', 'https://exemplo.com/x', false), /Link do Drive inválido/);
  const url = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view';
  await marcar('1AbCdEfGhIjKlMn', url, false);   // copiado, mas ainda não apagado do Storage: continua na fila
  let nova = (await comoServico('select fotos_para_drive(100) as r'))[0].r;
  assert.equal(nova.find(y => y.caminho === x.caminho).drive_id, '1AbCdEfGhIjKlMn');
  await marcar('1AbCdEfGhIjKlMn', url, true);    // apagado do Storage: sai da fila
  nova = (await comoServico('select fotos_para_drive(100) as r'))[0].r;
  assert.ok(!nova.some(y => y.caminho === x.caminho));
  const [vista] = await rpc(CHEFE, 'fotos_de', { p_entidade: 'abastecimento', p_chave: String(x.abastecimento) });
  assert.deepEqual([vista.drive_url, vista.no_storage], [url, false]);
  await assert.rejects(db.exec(`update fotos set entidade = 'chegada' where caminho = '${x.caminho}'`), /não pode ser alterada/);
});

test('caminhão de diesel: a primeira chegada cadastra; nas próximas a placa do cavalo completa carreta, motorista e CPF', async () => {
  const chegada = d => rpc(POSTO, 'registrar_chegada', { p_sessao: sessao, p_dados: { uuid: randomUUID(), tanque: 'TQ01', data_hora: dh(60 * 24), nf: '900', litros: 10, ...d } });
  await assert.rejects(chegada({ placa_caminhao: 'SUT4I8', motorista: 'X' }), /Placa do cavalo inválida/);
  await assert.rejects(chegada({ placa_caminhao: 'SUT4I86', cpf: '111.111.111-12' }), /CPF do motorista do caminhão inválido/);
  await chegada({ placa_caminhao: 'sut-4i86', placa_carreta: 'SWH0H70', motorista: 'Marcos Lima', cpf: '529.982.247-25' });
  let e = await rpc(POSTO, 'estado_posto');
  assert.deepEqual(e.caminhoes_diesel, [{ placa: 'SUT4I86', carreta: 'SWH0H70', motorista: 'MARCOS LIMA', cpf_fim: '25' }]);
  assert.ok(!JSON.stringify(e.caminhoes_diesel).includes('52998224725'));   // o celular não recebe o CPF
  const c2 = await chegada({ placa_caminhao: 'SUT4I86' });
  assert.deepEqual((await db.query('select placa_carreta, motorista, cpf from chegadas where id = $1', [c2.id])).rows[0],
    { placa_carreta: 'SWH0H70', motorista: 'MARCOS LIMA', cpf: '52998224725' });
  await chegada({ placa_caminhao: 'SUT4I86', placa_carreta: 'QPA7C03' });   // trocou a carreta: o cadastro guarda a última
  e = await rpc(POSTO, 'estado_posto');
  assert.equal(e.caminhoes_diesel[0].carreta, 'QPA7C03');
  await assert.rejects(como(POSTO, "insert into caminhoes_diesel (placa_cavalo) values ('ABC1D99')"), /row-level security/);
  assert.equal((await como(CHEFE, "update caminhoes_diesel set motorista = 'marcos  de lima' where placa_cavalo = 'SUT4I86' returning motorista"))[0].motorista, 'MARCOS DE LIMA');
  const aud = (await db.query("select papel from auditoria where acao = 'cadastro.caminhoes_diesel.insert'")).rows;
  assert.deepEqual(aud, [{ papel: 'posto' }]);
});

test('posto não abre com o turno anterior aberto: o frentista da manhã fecha (atrasado, vira alerta); com dois dias, o supervisor fecha o antigo sem medição', async () => {
  const dia = n => dh(60 * 24 * n).slice(0, 10);
  // dois dias atrás e ontem com movimento e sem fechamento (aferição: não mexe nas contas dos outros testes)
  const aferir = n => rpc(POSTO, 'registrar_afericao', { p_sessao: sessao, p_fotos: [foto('afericao')],
    p_dados: { uuid: randomUUID(), bomba: 1, data_hora: dh(60 * 24 * n), visor: 20 } });
  await aferir(2); await aferir(1);
  await db.exec('update configuracoes set exigir_fechamento = true');
  try {
    let e = await rpc(POSTO, 'estado_posto');
    assert.deepEqual(e.dias_sem_fechamento, [dia(2), dia(1)]);
    await assert.rejects(abastecer(reg(0, { km: 150250, litros: 1, encerrante: 1 })), /não foi fechado/);
    await assert.rejects(rpc(POSTO, 'registrar_fechamento', { p_sessao: sessao, p_encerrantes: await encerrantes(), p_medidos: { TQ01: 12000 }, p_dia: dia(1), p_fotos: [foto('fechamento')] }), /O supervisor fecha os mais antigos/);
    await assert.rejects(rpc(CHEFE, 'fechar_sem_medicao', { p_dia: dia(1), p_motivo: 'Dois dias sem fechar' }), /dia mais antigo/);
    const r = await rpc(CHEFE, 'fechar_sem_medicao', { p_dia: dia(2), p_motivo: 'Frentista esqueceu dois dias' });
    assert.equal(r.tanques, 1);
    e = await rpc(POSTO, 'estado_posto');
    assert.deepEqual(e.dias_sem_fechamento, [dia(1)]);
    assert.equal(e.tanques_pendente[0].tanque, 'TQ01');
    // o frentista da manhã mede a régua e fecha o de ontem: fica marcado como atrasado, com quem trabalhou no dia
    await assert.rejects(rpc(POSTO, 'registrar_fechamento', { p_sessao: sessao, p_encerrantes: await encerrantes(), p_medidos: { TQ01: 12000 }, p_dia: dia(1) }), /foto da régua/);
    await rpc(POSTO, 'registrar_fechamento', { p_sessao: sessao, p_encerrantes: await encerrantes(), p_medidos: { TQ01: 12000 }, p_dia: dia(1), p_fotos: [foto('fechamento')] });
    const f = (await db.query('select atrasado, sem_medicao from fechamentos where data = $1', [dia(1)])).rows[0];
    assert.deepEqual(f, { atrasado: true, sem_medicao: false });
    assert.deepEqual((await rpc(POSTO, 'estado_posto')).dias_sem_fechamento, []);
    await rpc(DONO, 'marcar_visto', { p_tipo: 'fechamento', p_chave: dia(1) });
    // depois de fechar, a folha do dia sai para o PDF; no celular, o CPF vem mascarado
    const folha = await rpc(POSTO, 'folha_do_dia', { p_dia: dia(1) });
    assert.equal(folha.fechado, true);
  } finally {
    await db.exec('update configuracoes set exigir_fechamento = false');
    await db.exec(`delete from fechamentos where data in ('${dia(1)}', '${dia(2)}')`);   // os outros testes usam esses dias abertos
  }
});

test('abertura do turno: sem ela o posto não lança; régua, encerrantes e de 1 a 5 fotos; oscilação e encerrante da noite viram alerta', async () => {
  await db.exec('update configuracoes set exigir_abertura = true');
  try {
    await assert.rejects(abastecer(reg(0, { km: 150250, litros: 1, encerrante: 1 })), /Abra o turno/);
    assert.equal((await rpc(POSTO, 'estado_posto')).aberto_hoje, false);
    const enc = await encerrantes();
    const abrir = (fotos, e = enc) => rpc(POSTO, 'registrar_abertura', { p_sessao: sessao, p_medidos: { TQ01: 12005 }, p_encerrantes: e, p_fotos: fotos });
    await assert.rejects(abrir([]), /foto da régua/);
    await assert.rejects(abrir(Array.from({ length: 6 }, () => foto('abertura'))), /No máximo 5 fotos/);
    await assert.rejects(abrir([foto('abertura')], { 1: enc[1] }), /encerrante da bomba 2/);
    const r = await abrir([foto('abertura'), foto('abertura')], { ...enc, 2: enc[2] + 35 });   // a bomba 2 andou 35 L de noite sem lançamento
    assert.equal(r.tanques[0].regua, 12005);
    assert.match(r.alerta, /bomba 2: .*35 L a mais, sem lançamento/);
    const e = await rpc(POSTO, 'estado_posto');
    assert.equal(e.aberto_hoje, true);
    assert.equal(Number(e.tanques[0].saldo_inicial), 12005);   // a régua da abertura vira o saldo inicial do dia
    await assert.rejects(abrir([foto('abertura')]), /já foi aberto/);
    await rpc(CHEFE, 'marcar_visto', { p_tipo: 'abertura', p_chave: dh(0).slice(0, 10) });
    assert.equal((await rpc(CHEFE, 'fotos_de', { p_entidade: 'abertura', p_chave: dh(0).slice(0, 10) })).length, 2);
    const fila = (await comoServico('select fotos_para_drive(100) as r'))[0].r.filter(x => x.entidade === 'abertura');
    assert.deepEqual(fila.map(x => x.nome.replace(/\d{4}/, 'HHMM')), ['Abertura-HHMM-1', 'Abertura-HHMM-2']);
  } finally {
    await db.exec(`update configuracoes set exigir_abertura = false; delete from aberturas; delete from leituras_bomba; delete from fotos where entidade = 'abertura';`);
  }
});

// ---------- Chegada, fechamento e fotos ----------
test('chegada com data no futuro ou antiga é recusada', async () => {
  await assert.rejects(rpc(POSTO, 'registrar_chegada', { p_sessao: sessao, p_dados: { uuid: randomUUID(), tanque: 'TQ01', data_hora: dh(-120), nf: '7', litros: 100 } }), /no futuro/);
  await assert.rejects(rpc(POSTO, 'registrar_chegada', { p_sessao: sessao, p_dados: { uuid: randomUUID(), tanque: 'TQ01', data_hora: dh(60 * 24 * 8), nf: '7', litros: 100 } }), /7 dias/);
});

test('chegada e fechamento guardam fotos; caminho de foto fora do padrão é recusado', async () => {
  await assert.rejects(rpc(POSTO, 'registrar_chegada', { p_sessao: sessao, p_dados: { uuid: randomUUID(), tanque: 'TQ01', data_hora: dh(5), nf: '1', litros: 100 },
    p_fotos: ['../segredo.jpg'] }), /Foto inválida/);
  const fotos = [foto('chegada'), foto('chegada')];
  const c = await rpc(POSTO, 'registrar_chegada', { p_sessao: sessao, p_dados: { uuid: randomUUID(), tanque: 'TQ01', data_hora: dh(5), nf: '45871',
    litros: 1000, regua_antes: 11000, regua_depois: 12000 }, p_fotos: fotos });
  assert.equal((await rpc(CHEFE, 'fotos_de', { p_entidade: 'chegada', p_chave: String(c.id) })).length, 2);
  const [t] = await rpc(POSTO, 'registrar_fechamento', { p_sessao: sessao, p_encerrantes: await encerrantes(), p_medidos: { TQ01: 12000 }, p_fotos: [foto('fechamento')] });
  // saídas do tanque pelas 2 bombas: bomba 1 = 640 + 100 + 114 + 20 (os recusados foram cancelados e não contam), bomba 2 = 30 + 10 + 10 + 10 + 10;
  // as aferições (20,05 L e 20,15 L) voltaram para o tanque e não contam; entrada: 1000
  assert.equal(Number(t.saldo_calculado), 12000 + 1000 - 944);
  await assert.rejects(rpc(POSTO, 'registrar_fechamento', { p_sessao: sessao, p_encerrantes: await encerrantes(), p_medidos: { TQ01: 1 }, p_fotos: [] }), /já foi fechado/);
  // depois do fechamento, nada mais entra com a data do dia
  await assert.rejects(abastecer(reg(1, { km: 150900, litros: 10, encerrante: 7071910 })), /já foi fechado/);
  await assert.rejects(rpc(POSTO, 'registrar_chegada', { p_sessao: sessao, p_dados: { uuid: randomUUID(), tanque: 'TQ01', data_hora: dh(1), nf: '9', litros: 10 } }), /já foi fechado/);
  await assert.rejects(db.exec("update fotos set chave = chave || 'x'"), /não pode ser alterada/);
});

test('turno fechado sem querer: o supervisor reabre, o frentista lança e fecha de novo', async () => {
  const dia = dh(0).slice(0, 10);
  await assert.rejects(rpc(POSTO, 'reabrir_turno', { p_data: dia, p_motivo: 'Fechou sem querer' }), /Acesso negado/);
  await assert.rejects(rpc(CHEFE, 'reabrir_turno', { p_data: dia, p_motivo: 'x' }), /motivo/);
  await assert.rejects(rpc(CHEFE, 'reabrir_turno', { p_data: '2020-01-01', p_motivo: 'Fechou sem querer' }), /último turno fechado/);
  const r = await rpc(CHEFE, 'reabrir_turno', { p_data: dia, p_motivo: 'Frentista fechou antes do último abastecimento' });
  assert.equal(r.tanques, 1);
  assert.equal((await rpc(POSTO, 'estado_posto')).fechado_hoje, false);
  const a = await abastecer(reg(1, { km: 150900, litros: 10, encerrante: 7071910 }));
  assert.ok(a.id);
  await rpc(CHEFE, 'decidir_abastecimento', { p_id: a.id, p_acao: 'cancelar', p_motivo: 'Teste do turno reaberto' });
  const [t] = await rpc(POSTO, 'registrar_fechamento', { p_sessao: sessao, p_encerrantes: await encerrantes(), p_medidos: { TQ01: 12000 }, p_fotos: [foto('fechamento')] });
  assert.equal(Number(t.saldo_calculado), 12000 + 1000 - 944);
  const [aud] = (await db.query("select conta, detalhes from auditoria where acao = 'turno.reaberto'")).rows;
  assert.equal(aud.conta, CHEFE);
  assert.equal(aud.detalhes.fechamentos[0].saldo_medido, 12000);
  assert.equal((await rpc(CHEFE, 'fotos_de', { p_entidade: 'fechamento', p_chave: dia })).length, 2);   // a foto do primeiro fechamento continua, mais a do novo
});

test('supervisor não move lançamento para um dia já fechado', async () => {
  const ontem = await abastecer(reg(60 * 24, { placa: 'GHI8J90', km: 220100, litros: 10, encerrante: 512050, bomba: 2 }));
  assert.equal(ontem.status, 'Exceção');   // encerrante não bate: fica fora do lote
  await assert.rejects(rpc(CHEFE, 'decidir_abastecimento', { p_id: ontem.id, p_acao: 'revalidar', p_motivo: 'Data errada no celular',
    p_alteracoes: { data_hora: dh(30) } }), /já foi fechado/);
});

// ---------- Fechamento do turno para o KMM ----------
test('fechamento do turno para o KMM: só o administrador gera, só de turno fechado, só entra o Pronto e não repete', async () => {
  const hoje = dh(0).slice(0, 10), ontem = dh(60 * 24).slice(0, 10);
  await assert.rejects(rpc(CHEFE, 'gerar_lote', { p_dia: hoje }), /Acesso negado/);   // supervisor só baixa
  await assert.rejects(rpc(DONO, 'gerar_lote', { p_dia: ontem }), /ainda não foi fechado/);
  let [cartao] = await rpc(CHEFE, 'turnos_kmm');
  assert.equal(cartao.dia, hoje);
  assert.equal(cartao.prontos, 8);
  assert.deepEqual(cartao.lotes, []);
  const lote = await rpc(DONO, 'gerar_lote', { p_dia: hoje });
  assert.equal(lote.quantidade, 8);
  assert.equal(Number(lote.litros), 640 + 100 + 20 + 30 + 10 + 10 + 10 + 10);
  assert.equal(lote.linhas.length, lote.quantidade);
  assert.deepEqual((await db.query('select quantidade, litros::float as litros from lotes where id = $1', [lote.id])).rows[0], { quantidade: 8, litros: 830 });
  assert.equal(lote.linhas[0].cpf, '52998224725');
  const comPreco = lote.linhas.filter(l => l.preco != null);   // preço e valor total vão para a planilha do KMM
  assert.deepEqual(comPreco.map(l => [Number(l.preco), Number(l.valor_total)]), [[6.19, 61.9]]);
  const lotesAntes = (await db.query('select count(*)::int as n from lotes')).rows[0].n;
  await assert.rejects(rpc(DONO, 'gerar_lote', { p_dia: hoje }), /Nada novo para lançar/);
  assert.equal((await db.query('select count(*)::int as n from lotes')).rows[0].n, lotesAntes);   // lote vazio não fica gravado
  assert.equal((await rpc(CHEFE, 'linhas_lote', { p_lote: lote.id })).length, 8);   // supervisor baixa a planilha
  assert.ok(lote.linhas.every(l => l.de_outro_dia === false));
  [cartao] = await rpc(CHEFE, 'turnos_kmm');
  assert.deepEqual([cartao.prontos, cartao.lotes.length, cartao.lotes[0].situacao, cartao.lotes[0].criado_por], [0, 1, 'Gerado', 'Dono']);
  await assert.rejects(rpc(CHEFE, 'marcar_erro_kmm', { p_id: lote.linhas[0].requisicao, p_mensagem: 'Placa bloqueada' }), /Acesso negado/);
  await rpc(DONO, 'marcar_erro_kmm', { p_id: lote.linhas[0].requisicao, p_mensagem: 'Placa bloqueada no KMM' });
  await assert.rejects(rpc(CHEFE, 'fechar_lote', { p_lote: lote.id, p_acao: 'confirmar' }), /Acesso negado/);
  assert.equal((await rpc(DONO, 'fechar_lote', { p_lote: lote.id, p_acao: 'confirmar' })).registros, 7);
  await assert.rejects(rpc(DONO, 'fechar_lote', { p_lote: lote.id, p_acao: 'confirmar' }), /já está lançado no KMM/);
  // lançou errado no KMM: o administrador desfaz um fechamento já lançado; tudo volta para Pronto e sai de novo
  assert.equal((await rpc(DONO, 'fechar_lote', { p_lote: lote.id, p_acao: 'desfazer' })).registros, 7);
  const refeito = await rpc(DONO, 'gerar_lote', { p_dia: hoje });
  assert.equal(refeito.quantidade, 7);
  assert.equal((await rpc(DEV, 'fechar_lote', { p_lote: refeito.id, p_acao: 'confirmar' })).registros, 7);
  await assert.rejects(rpc(CHEFE, 'decidir_abastecimento', { p_id: refeito.linhas[0].requisicao, p_acao: 'cancelar', p_motivo: 'teste de trava' }), /não pode ser alterado/);
});

test('relatório diário: o Apps Script pega o dia fechado com cabeçalho, abastecimentos e chegadas, e marca quando o PDF está no Drive', async () => {
  const hoje = dh(0).slice(0, 10);
  await assert.rejects(como(CHEFE, 'select relatorios_para_drive()'), /permission denied/);
  let fila = (await comoServico('select relatorios_para_drive() as r'))[0].r;
  const r = fila.find(x => x.data === hoje);
  assert.ok(r, JSON.stringify(fila.map(x => x.data)));
  assert.deepEqual(r.tanques.map(t => [t.tanque, Number(t.saldo_inicial)]), [['TQ01', 12000]]);
  assert.deepEqual(r.bombas.map(b => b.bomba), [1, 2]);
  assert.ok(r.abastecimentos.length >= 8 && r.abastecimentos.every(a => /^\d{2}:\d{2}$/.test(a.hora) && a.placa));
  assert.equal(r.chegadas[0].nf, '45871');
  assert.match(r.hora, /^\d{2}:\d{2} às \d{2}:\d{2}$/);
  await comoServico('select relatorio_no_drive($1, $2, $3, $4)', [hoje, '1RelatorioDriveId', 'https://drive.google.com/file/d/1RelatorioDriveId/view', r.fechamento_em]);
  fila = (await comoServico('select relatorios_para_drive() as r'))[0].r;
  assert.ok(!fila.some(x => x.data === hoje));
  const [cartao] = await rpc(CHEFE, 'turnos_kmm');
  assert.deepEqual([cartao.relatorio.drive_url, cartao.relatorio.atualizado], ['https://drive.google.com/file/d/1RelatorioDriveId/view', true]);
});

test('regras da conferência: o administrador ajusta e o banco passa a conferir com o valor novo', async () => {
  const km = Number((await db.query("select greatest(max(km), 0) as k from abastecimentos where placa = 'ABC1D23' and status in ('Pronto', 'Em lote', 'Lançado')")).rows[0].k);
  const salto = async () => (await db.query("select conferir_abastecimento(agora_local(), 'ABC1D23', 'JOAO DA SILVA', $1, 10, 99999999, 1) as c", [km + 600])).rows[0].c.problemas
    .some(p => p.startsWith('Salto de KM'));
  assert.equal(await salto(), false);   // 600 km: dentro dos 3.000 padrão
  assert.equal((await como(CHEFE, 'update configuracoes set km_salto = 500 where id = 1 returning id')).length, 0);   // supervisor não muda
  await como(DONO, 'update configuracoes set km_salto = 500, tanque_padrao = 900 where id = 1');
  assert.equal(await salto(), true);
  assert.deepEqual((await rpc(POSTO, 'estado_posto')).regras.km_salto, 500);
  await db.exec("insert into veiculos (placa) values ('XYZ9W88')");
  assert.equal(Number((await db.query("select capacidade_l from veiculos where placa = 'XYZ9W88'")).rows[0].capacidade_l), 900);
  await assert.rejects(como(DONO, 'update configuracoes set km_salto = 5 where id = 1'), /check constraint/);
  await como(DONO, 'update configuracoes set km_salto = 3000, tanque_padrao = 1100 where id = 1');
  await db.exec("delete from veiculos where placa = 'XYZ9W88'");
});

test('banco de dados pelo painel: só o desenvolvedor; edita, inclui e apaga com histórico; as proteções continuam', async () => {
  await assert.rejects(rpc(DONO, 'dev_estrutura'), /Acesso negado/);
  await assert.rejects(rpc(CHEFE, 'dev_salvar', { p_tabela: 'veiculos', p_chave: { placa: 'ABC1D23' }, p_valores: { km_inicial: 1 } }), /Acesso negado/);
  const est = await rpc(DEV, 'dev_estrutura');
  const tab = Object.fromEntries(est.map(t => [t.tabela, t]));
  assert.deepEqual(tab.abastecimentos.chave, ['id']);
  assert.deepEqual(tab.veiculo_motoristas.chave, ['placa', 'motorista_id']);
  assert.ok(!tab.frentistas_pin && !tab.sessoes_frentista && !tab.auditoria);
  assert.equal(tab.abastecimentos.colunas.find(c => c.nome === 'valor_total').editavel, false);   // coluna calculada
  // altera um abastecimento direto (vai para o histórico com o CPF mascarado)
  const [ab] = (await db.query("select id from abastecimentos where cpf is not null order by id limit 1")).rows;
  const depois = await rpc(DEV, 'dev_salvar', { p_tabela: 'abastecimentos', p_chave: { id: ab.id }, p_valores: { obs_supervisor: 'Ajuste feito pelo desenvolvedor' } });
  assert.equal(depois.obs_supervisor, 'Ajuste feito pelo desenvolvedor');
  assert.ok(!('cpf' in depois));
  const [aud] = (await db.query("select papel, entidade_id, detalhes from auditoria where acao = 'dev.alterou' order by id desc limit 1")).rows;
  assert.deepEqual([aud.papel, aud.entidade_id, aud.detalhes.depois.cpf.startsWith('***')], ['desenvolvedor', String(ab.id), true]);
  await assert.rejects(rpc(DEV, 'dev_apagar', { p_tabela: 'abastecimentos', p_chave: { id: ab.id } }), /não pode ser apagado/);
  // inclui e apaga um caminhão de diesel; tabela de fora da lista é recusada; conta de desenvolvedor continua só pelo SQL
  await rpc(DEV, 'dev_salvar', { p_tabela: 'caminhoes_diesel', p_chave: null, p_valores: { placa_cavalo: 'dev-1a23', motorista: 'teste dev' } });
  assert.equal((await db.query("select motorista from caminhoes_diesel where placa_cavalo = 'DEV1A23'")).rows[0].motorista, 'TESTE DEV');
  await rpc(DEV, 'dev_apagar', { p_tabela: 'caminhoes_diesel', p_chave: { placa_cavalo: 'DEV1A23' } });
  await assert.rejects(rpc(DEV, 'dev_salvar', { p_tabela: 'frentistas_pin', p_chave: null, p_valores: { hash: 'x' } }), /não pode ser editada/);
  await assert.rejects(rpc(DEV, 'dev_salvar', { p_tabela: 'acessos', p_chave: { email: DEV }, p_valores: { nome: 'Eu' } }), /dono do projeto/);
  await assert.rejects(rpc(DEV, 'dev_salvar', { p_tabela: 'abastecimentos', p_chave: { id: 999999 }, p_valores: { obs_supervisor: 'x' } }), /não encontrado/);
});

test('saúde do sistema: fila do Drive e a versão das telas em cada celular', async () => {
  await rpc(POSTO, 'informar_versao', { p_versao: 'a1b2c3' });
  await rpc(POSTO, 'informar_versao', { p_versao: '<script>' });   // versão estranha é ignorada
  await assert.rejects(rpc(DONO, 'dev_saude'), /Acesso negado/);
  const s = await rpc(DEV, 'dev_saude');
  assert.equal(typeof s.comprovantes_na_fila, 'number');
  assert.ok(s.banco_bytes > 0);
  assert.deepEqual(s.aparelhos.map(a => [a.conta, a.versao]), [[POSTO, 'a1b2c3']]);
  assert.equal((await como(DONO, 'select * from aparelhos')).length, 0);   // só o desenvolvedor lê
});

test('ninguém apaga abastecimento nem mexe na auditoria', async () => {
  await assert.rejects(db.exec('delete from abastecimentos'), /não pode ser apagado/);
  await assert.rejects(db.exec('delete from auditoria'), /somente inclusão/);
  assert.equal((await como(DONO, 'delete from auditoria returning id')).length, 0);
});

// ---------- Papéis no painel ----------
test('supervisor gerencia frentistas e cadastros', async () => {
  await como(CHEFE, "insert into frentistas (nome) values ('Rafael Costa')");
  await como(CHEFE, "update frentistas set nome = 'Rafael C. Costa' where nome = 'Rafael Costa'");
  assert.equal((await como(CHEFE, "delete from frentistas where nome = 'Rafael C. Costa' returning id")).length, 1);
  await assert.rejects(como(CHEFE, `delete from frentistas where id = ${ana}`), /foreign key/);   // com lançamentos: só desativar
  assert.equal((await como(CHEFE, "update veiculos set capacidade_l = 520 where placa = 'GHI8J90' returning placa")).length, 1);
  await assert.rejects(como(CHEFE, "insert into motoristas (nome, cpf) values ('Fulano', '111.111.111-11')"), /check constraint/);
});

test('contas: só administrador ou desenvolvedor liberam celular e supervisor; administrador só o desenvolvedor; desenvolvedor só pelo SQL', async () => {
  // supervisor não mexe em conta nenhuma
  await assert.rejects(como(CHEFE, "insert into acessos (email, nome, papel) values ('posto9@empresa.com', 'Celular 9', 'posto')"), /Só o administrador libera/);
  await assert.rejects(como(CHEFE, `update acessos set nome = 'Eu' where email = '${CHEFE}'`), /Só o administrador libera/);
  await assert.rejects(como(CHEFE, `delete from acessos where email = '${DONO}'`), /Só o desenvolvedor/);
  // administrador: celulares e supervisores, mas não administradores (nem ele mesmo) nem desenvolvedores
  await como(DONO, "insert into acessos (email, nome, papel) values ('posto9@empresa.com', 'Celular 9', 'posto'), ('sup2@empresa.com', 'Sup 2', 'supervisor')");
  assert.equal((await como(DONO, "delete from acessos where email in ('posto9@empresa.com', 'sup2@empresa.com') returning email")).length, 2);
  await assert.rejects(como(DONO, `update acessos set ativo = false where email = '${DONO}'`), /Só o desenvolvedor/);
  await assert.rejects(como(DONO, "insert into acessos (email, nome, papel) values ('x@empresa.com', 'X', 'administrador')"), /Só o desenvolvedor/);
  await assert.rejects(como(DONO, `update acessos set ativo = false where email = '${DEV}'`), /dono do projeto/);
  // desenvolvedor: cria e remove administrador; outro desenvolvedor (ou ele mesmo) só pelo SQL
  await como(DEV, "insert into acessos (email, nome, papel) values ('adm2@empresa.com', 'Adm 2', 'administrador')");
  assert.equal((await como(DEV, "delete from acessos where email = 'adm2@empresa.com' returning email")).length, 1);
  await assert.rejects(como(DEV, "insert into acessos (email, nome, papel) values ('dev2@empresa.com', 'Dev 2', 'desenvolvedor')"), /dono do projeto/);
  await assert.rejects(como(DEV, `update acessos set papel = 'administrador' where email = '${DEV}'`), /dono do projeto/);
  // dono do projeto (SQL Editor, sem login) pode tudo
  await db.exec(`update acessos set nome = 'Dono da empresa' where email = '${DONO}'`);
});

test('desenvolvedor pode tudo o que o administrador pode; o horário do turno é do administrador para cima', async () => {
  assert.equal((await rpc(DEV, 'estado_posto')).papel, 'desenvolvedor');
  assert.equal((await como(DEV, "update configuracoes set abertura = '00:00' where id = 1 returning id")).length, 1);
  assert.equal((await como(CHEFE, "update configuracoes set abertura = '00:00' where id = 1 returning id")).length, 0);
  await assert.rejects(rpc(POSTO, 'turnos_kmm'), /Acesso negado/);
});

test('histórico: cada cargo vê o próprio nível e os de baixo; o administrador também vê o desenvolvedor', async () => {
  await rpc(DONO, 'definir_pin', { p_frentista_id: ana, p_pin: '5820' });
  await rpc(DEV, 'definir_pin', { p_frentista_id: carlos, p_pin: '5831' });
  const papeis = async email => new Set((await como(email, 'select papel from auditoria')).map(a => a.papel));
  const chefe = await papeis(CHEFE), dono = await papeis(DONO), dev = await papeis(DEV);
  assert.ok(chefe.has('posto') && !chefe.has('administrador') && !chefe.has('desenvolvedor'));
  assert.ok(dono.has('administrador') && dono.has('desenvolvedor') && dono.has('posto'));
  assert.ok(dev.has('administrador') && dev.has('desenvolvedor'));
  // o PIN que o desenvolvedor trocou derrubou o login do Carlos; o teste segue com a Ana
});

test('supervisor anexa foto a um veículo pelo painel; celular não pode', async () => {
  const f = foto('veiculo');
  await rpc(CHEFE, 'anexar_foto_veiculo', { p_placa: 'abc-1d23', p_foto: f });
  assert.equal((await rpc(CHEFE, 'fotos_de', { p_entidade: 'veiculo', p_chave: 'ABC1D23' }))[0].caminho, f);
  await assert.rejects(rpc(POSTO, 'anexar_foto_veiculo', { p_placa: 'ABC1D23', p_foto: foto('veiculo') }), /Acesso negado/);
});

test('bloqueio do PIN dura 5 minutos', async () => {
  await rpc(CHEFE, 'definir_pin', { p_frentista_id: carlos, p_pin: '7391' });
  for (let i = 0; i < 4; i++) await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '0000' });
  const r = await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '0000' });
  assert.match(r.erro, /Bloqueado por 5 minutos/);
  const minutos = (await db.query('select extract(epoch from bloqueado_ate - now()) / 60 as m from frentistas_pin where frentista_id = $1', [carlos])).rows[0].m;
  assert.ok(minutos > 4.9 && minutos <= 5, `bloqueio de ${minutos} min`);
});

test('supervisor e administrador excluem foto, com auditoria; celular não', async () => {
  const [f1, f2] = [foto('veiculo'), foto('veiculo')];
  await rpc(CHEFE, 'anexar_foto_veiculo', { p_placa: 'DEF4567', p_foto: f1 });
  await rpc(CHEFE, 'anexar_foto_veiculo', { p_placa: 'DEF4567', p_foto: f2 });
  await assert.rejects(rpc(POSTO, 'excluir_foto', { p_caminho: f1 }), /Acesso negado/);
  await rpc(CHEFE, 'excluir_foto', { p_caminho: f1 });
  await rpc(DONO, 'excluir_foto', { p_caminho: f2 });
  assert.equal((await rpc(CHEFE, 'fotos_de', { p_entidade: 'veiculo', p_chave: 'DEF4567' })).length, 0);
  const a = (await db.query("select conta, detalhes from auditoria where acao = 'foto.excluida' and entidade_id = 'DEF4567' order by id")).rows;
  assert.deepEqual(a.map(x => x.conta), [CHEFE, DONO]);
  await assert.rejects(rpc(CHEFE, 'excluir_foto', { p_caminho: f1 }), /não encontrada/);
});

test('15 PINs errados no mesmo dia bloqueiam até o supervisor definir um PIN novo', async () => {
  await rpc(CHEFE, 'definir_pin', { p_frentista_id: carlos, p_pin: '2958' });
  for (let i = 0; i < 15; i++) {
    await db.exec(`update frentistas_pin set bloqueado_ate = null where frentista_id = ${carlos} and bloqueado_ate <> 'infinity'`);   // pula a espera de 5 min
    await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '0000' });
  }
  const r = await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '2958' });
  assert.match(r.erro, /muitas tentativas erradas hoje/);
  await rpc(CHEFE, 'definir_pin', { p_frentista_id: carlos, p_pin: '2958' });
  assert.equal((await rpc(POSTO, 'entrar_frentista', { p_frentista_id: carlos, p_pin: '2958' })).ok, true);
});

test('sair_frentista exige conta liberada e só derruba sessão do próprio celular', async () => {
  const nova = (await rpc(POSTO, 'entrar_frentista', { p_frentista_id: ana, p_pin: '5820' })).sessao;
  const valida = () => db.query("select count(*)::int as n from sessoes_frentista where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [nova]).then(r => r.rows[0].n);
  await assert.rejects(rpc(ESTRANHO, 'sair_frentista', { p_sessao: nova }), /Acesso negado/);
  await rpc(CHEFE, 'sair_frentista', { p_sessao: nova });   // outra conta não derruba a sessão do celular
  assert.equal(await valida(), 1);
  await rpc(POSTO, 'sair_frentista', { p_sessao: nova });
  assert.equal(await valida(), 0);
});

test('horário do turno: só o administrador altera, e o celular recebe', async () => {
  assert.equal((await como(CHEFE, "update configuracoes set fechamento = '22:00' returning id")).length, 0);
  assert.equal((await como(DONO, "update configuracoes set abertura = '05:00', fechamento = '23:00' returning id")).length, 1);
  assert.deepEqual((await rpc(POSTO, 'estado_posto')).turno, { abertura: '05:00', fechamento: '23:00' });
  assert.ok((await db.query("select 1 from auditoria where acao = 'cadastro.configuracoes.update'")).rows.length);
  await db.exec("update configuracoes set abertura = '00:00', fechamento = '23:59:59'");
});

test('supervisor e administrador excluem placa e motorista errados; o histórico continua', async () => {
  const historico = sql => db.query(sql).then(r => r.rows.length);
  const antesPlaca = await historico("select 1 from abastecimentos where placa = 'GHI8J90'");
  const antesMotorista = await historico("select 1 from abastecimentos where motorista = 'PEDRO NOVO' and cpf = '12345678909'");
  assert.ok(antesPlaca > 0 && antesMotorista > 0);
  // celular não exclui cadastro
  assert.equal((await como(POSTO, "delete from veiculos where placa = 'GHI8J90' returning placa")).length, 0);
  assert.equal((await como(CHEFE, "delete from veiculos where placa = 'GHI8J90' returning placa")).length, 1);
  assert.equal((await como(DONO, "delete from motoristas where nome = 'PEDRO NOVO' returning id")).length, 1);
  // os lançamentos ficam como estavam (placa, nome e CPF escritos neles) e o vínculo sai junto
  assert.equal(await historico("select 1 from abastecimentos where placa = 'GHI8J90'"), antesPlaca);
  assert.equal(await historico("select 1 from abastecimentos where motorista = 'PEDRO NOVO' and cpf = '12345678909'"), antesMotorista);
  assert.equal(await historico("select 1 from veiculo_motoristas vm join motoristas m on m.id = vm.motorista_id where m.nome = 'PEDRO NOVO'"), 0);
  const e = await rpc(POSTO, 'estado_posto');
  assert.ok(!e.veiculos.some(v => v.placa === 'GHI8J90') && !e.motoristas.includes('PEDRO NOVO'));
  assert.ok(await historico("select 1 from auditoria where acao = 'cadastro.veiculos.delete' and entidade_id = 'GHI8J90'"));
  // bomba com aferição e tanque com movimento não saem (desativar em vez de excluir)
  await assert.rejects(como(CHEFE, 'delete from bombas where numero = 2'), /foreign key/);
  await assert.rejects(como(CHEFE, "delete from tanques where codigo = 'TQ01'"), /foreign key/);
});
