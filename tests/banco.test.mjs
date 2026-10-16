// Testa o schema.sql num PostgreSQL de verdade (PGlite), simulando o ambiente do Supabase:
// papéis anon/authenticated, permissões padrão e auth.jwt() com o e-mail de quem está logado.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const SUPABASE = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.jwt() to anon, authenticated;
  -- O Supabase dá estas permissões por padrão; quem protege é o RLS e os revokes do schema.sql
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
`;
const POSTO = 'posto1@empresa.com', CHEFE = 'chefe@empresa.com', ESTRANHO = 'qualquer@gmail.com', DONO = 'dono@empresa.com';
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
const abastecer = (dados, s = sessao) => rpc(POSTO, 'registrar_abastecimento', { p_sessao: s, p_dados: dados });

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE);
  await db.exec(SCHEMA);
  await db.exec(SCHEMA);   // rodar de novo não pode dar erro (atualização do schema)
  await db.exec(`
    insert into acessos (email, nome, papel) values ('${POSTO}', 'Celular posto 1', 'posto'), ('${CHEFE}', 'Chefe', 'supervisor'),
                                                    ('${DONO}', 'Dono', 'administrador');
    insert into frentistas (nome) values ('Ana Ribeiro'), ('Carlos Mendes');
    insert into tanques values ('TQ01', 30000, 12000);
    insert into bombas values (1, 'TQ01', 7071046, true), (2, 'TQ01', 512000, true);   -- 1 tanque, 2 bombas
    insert into veiculos (placa, capacidade_l, km_inicial) values ('ABC1D23', 700, 149500), ('DEF4567', 600, 97500);
    insert into motoristas (nome, cpf) values ('JOAO DA SILVA', '52998224725');
    update configuracoes set abertura = '00:00', fechamento = '23:59:59';`);
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
  await assert.rejects(como(CHEFE, 'select gerar_lote()', [], 'email'), /Acesso negado/);
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
  await assert.rejects(rpc(POSTO, 'gerar_lote'), /Acesso negado/);
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
  await assert.rejects(rpc(CHEFE, 'registrar_abastecimento', { p_sessao: sessao, p_dados: reg(20) }), /Login do frentista expirou/);
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

test('sem desconto: exige justificativa, espera autorização e não entra em lote até ser aprovado', async () => {
  await assert.rejects(abastecer(reg(8, { km: 150300, litros: 100, encerrante: 7071786, desconto: false })), /justificativa/);
  const a = await abastecer(reg(8, { km: 150300, litros: 100, encerrante: 7071786, desconto: false,
    justificativa_desconto: 'Motorista agregado, acerto só no fim do mês' }));
  assert.equal(a.status, 'Aguardando autorização');
  const ok = await rpc(CHEFE, 'decidir_autorizacao', { p_id: a.id, p_aprovar: true, p_motivo: 'Desconto será feito no acerto' });
  assert.equal(ok.status, 'Pronto');
  assert.equal(ok.autorizado_por, CHEFE);
  await assert.rejects(rpc(CHEFE, 'decidir_autorizacao', { p_id: a.id, p_aprovar: true, p_motivo: 'de novo' }), /não está aguardando/);
});

test('fora do horário do turno: exige justificativa e vai para autorização', async () => {
  const hora = (await db.query("select to_char(agora_local() - interval '3 minutes', 'HH24:MI:SS') as h")).rows[0].h;
  await db.exec(`update configuracoes set abertura = '${hora}', fechamento = '${hora}'::time + interval '1 minute'`);
  try {
    await assert.rejects(abastecer(reg(5, { placa: 'DEF4567', km: 98000, litros: 5, encerrante: 7071791 })), /fora do horário do turno/);
    const a = await abastecer(reg(5, { placa: 'DEF4567', km: 98000, litros: 5, encerrante: 7071791, justificativa_horario: 'Entrega urgente depois do fechamento' }));
    assert.equal(a.status, 'Aguardando autorização');
    const linha = (await db.query('select fora_horario, justificativa_horario from abastecimentos where id = $1', [a.id])).rows[0];
    assert.deepEqual(linha, { fora_horario: true, justificativa_horario: 'Entrega urgente depois do fechamento' });
    await rpc(CHEFE, 'decidir_autorizacao', { p_id: a.id, p_aprovar: false, p_motivo: 'Teste: recusado' });
  } finally {
    await db.exec("update configuracoes set abertura = '00:00', fechamento = '23:59:59'");
  }
});

test('autorização recusada cancela o lançamento', async () => {
  const a = await abastecer(reg(7, { placa: 'DEF4567', km: 98000, litros: 10, encerrante: 7071796, desconto: false,
    justificativa_desconto: 'Sem tempo de descontar' }));
  const r = await rpc(CHEFE, 'decidir_autorizacao', { p_id: a.id, p_aprovar: false, p_motivo: 'Precisa descontar antes' });
  assert.equal(r.status, 'Cancelado');
  assert.match(r.obs_supervisor, /recusada/);
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
    { linha: 3, placa: 'JKL2M34', motorista: 'Pedro Novo' },          // placa e motorista novos: criados sem capacidade e sem CPF
    { linha: 4, placa: 'ABC1D23', cpf: '111.444.777-35' },            // achado pelo CPF
    { linha: 5, placa: 'ABC1D23', motorista: 'João da Silva' },       // já vinculado: conta como certo e não duplica
    { linha: 6, placa: 'XX1', motorista: 'Fulano de Tal' },
    { linha: 7, placa: 'ABC1D23', motorista: 'Maria Souza', cpf: '123.456.789-09' },
    { linha: 8, placa: 'MNO3P45', motorista: '' },
  ] });
  assert.deepEqual([r.ok, r.veiculos_novos, r.motoristas_novos], [4, 1, 1]);
  assert.deepEqual(r.erros, ['Linha 6: placa XX1 inválida', 'Linha 7: MARIA SOUZA já está cadastrado com outro CPF', 'Linha 8: falta o nome do motorista']);
  const novo = (await db.query("select capacidade_l, criado_por from veiculos where placa = 'JKL2M34'")).rows[0];
  assert.deepEqual(novo, { capacidade_l: null, criado_por: 'Planilha' });
  const e = await rpc(POSTO, 'estado_posto');
  assert.deepEqual(e.veiculos.find(v => v.placa === 'ABC1D23').motoristas, ['JOAO DA SILVA', 'MARIA SOUZA']);
  assert.deepEqual(e.veiculos.find(v => v.placa === 'DEF4567').motoristas, ['JOAO DA SILVA', 'MARIA SOUZA']);
  // o supervisor tira um vínculo pelo painel
  assert.equal((await como(CHEFE, "delete from veiculo_motoristas where placa = 'DEF4567' and motorista_id = (select id from motoristas where nome = 'MARIA SOUZA') returning placa")).length, 1);
});

test('placa e motorista da planilha: o frentista completa o tanque e o CPF no primeiro abastecimento', async () => {
  let e = await rpc(POSTO, 'estado_posto');
  const jkl = () => e.veiculos.find(v => v.placa === 'JKL2M34');
  assert.equal(jkl().capacidade_l, null);
  assert.deepEqual(jkl().motoristas, ['PEDRO NOVO']);
  assert.ok(e.motoristas_sem_cpf.includes('PEDRO NOVO'));
  assert.ok(!JSON.stringify(e).includes('11144477735'));   // continua sem mandar CPF para o celular
  const base = { placa: 'JKL2M34', motorista: 'Pedro Novo', km: 50000, litros: 10, encerrante: 512070.05, bomba: 2 };
  await assert.rejects(abastecer(reg(0, base)), /tamanho do tanque/);
  await assert.rejects(abastecer(reg(0, { ...base, capacidade: 400, cpf: '529.982.247-25' })), /outro motorista/);
  await assert.rejects(abastecer(reg(0, { ...base, capacidade: 400, cpf: '111.111.111-12' })), /CPF do motorista inválido/);
  const a = await abastecer(reg(0, { ...base, capacidade: 400, cpf: '123.456.789-09' }));
  assert.equal(a.status, 'Pronto', JSON.stringify(a.problemas));   // KM do lançamento vira o primeiro da placa
  e = await rpc(POSTO, 'estado_posto');
  assert.equal(Number(jkl().capacidade_l), 400);
  assert.ok(!e.motoristas_sem_cpf.includes('PEDRO NOVO'));
  assert.equal((await db.query("select cpf from motoristas where nome = 'PEDRO NOVO'")).rows[0].cpf, '12345678909');
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
  const [t] = await rpc(POSTO, 'registrar_fechamento', { p_sessao: sessao, p_medidos: { TQ01: 12000 }, p_fotos: [foto('fechamento')] });
  // saídas do tanque pelas 2 bombas: bomba 1 = 640 + 100 + 114 + 20 (os recusados foram cancelados e não contam), bomba 2 = 30 + 10 + 10;
  // as aferições (20,05 L e 20,15 L) voltaram para o tanque e não contam; entrada: 1000
  assert.equal(Number(t.saldo_calculado), 12000 + 1000 - 924);
  await assert.rejects(rpc(POSTO, 'registrar_fechamento', { p_sessao: sessao, p_medidos: { TQ01: 1 }, p_fotos: [] }), /já foi fechado/);
  // depois do fechamento, nada mais entra com a data do dia
  await assert.rejects(abastecer(reg(1, { km: 150900, litros: 10, encerrante: 7071910 })), /já foi fechado/);
  await assert.rejects(rpc(POSTO, 'registrar_chegada', { p_sessao: sessao, p_dados: { uuid: randomUUID(), tanque: 'TQ01', data_hora: dh(1), nf: '9', litros: 10 } }), /já foi fechado/);
  await assert.rejects(db.exec('update fotos set chave = chave'), /não pode ser alterada/);
});

test('supervisor não move lançamento para um dia já fechado', async () => {
  const ontem = await abastecer(reg(60 * 24, { placa: 'GHI8J90', km: 220100, litros: 10, encerrante: 512050, bomba: 2 }));
  assert.equal(ontem.status, 'Exceção');   // encerrante não bate: fica fora do lote
  await assert.rejects(rpc(CHEFE, 'decidir_abastecimento', { p_id: ontem.id, p_acao: 'revalidar', p_motivo: 'Data errada no celular',
    p_alteracoes: { data_hora: dh(30) } }), /já foi fechado/);
});

// ---------- Lote do KMM ----------
test('lote do KMM: só entra o Pronto, não repete, marca erro e trava alteração', async () => {
  const lote = await rpc(CHEFE, 'gerar_lote');
  assert.equal(lote.quantidade, 6);
  assert.equal(Number(lote.litros), 640 + 100 + 20 + 30 + 10 + 10);
  assert.equal(lote.linhas.length, lote.quantidade);
  assert.deepEqual((await db.query('select quantidade, litros::float as litros from lotes where id = $1', [lote.id])).rows[0], { quantidade: 6, litros: 810 });
  assert.equal(lote.linhas[0].cpf, '52998224725');
  const lotesAntes = (await db.query('select count(*)::int as n from lotes')).rows[0].n;
  await assert.rejects(rpc(CHEFE, 'gerar_lote'), /Não há abastecimentos prontos/);
  assert.equal((await db.query('select count(*)::int as n from lotes')).rows[0].n, lotesAntes);   // lote vazio não fica gravado
  await rpc(CHEFE, 'marcar_erro_kmm', { p_id: lote.linhas[0].requisicao, p_mensagem: 'Placa bloqueada no KMM' });
  assert.equal((await rpc(CHEFE, 'fechar_lote', { p_lote: lote.id, p_acao: 'confirmar' })).registros, 5);
  await assert.rejects(rpc(CHEFE, 'decidir_abastecimento', { p_id: lote.linhas[1].requisicao, p_acao: 'cancelar', p_motivo: 'teste de trava' }), /não pode ser alterado/);
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

test('supervisor só gerencia contas de celular; administradores só pelo dono do projeto', async () => {
  await como(CHEFE, "insert into acessos (email, nome, papel) values ('posto9@empresa.com', 'Celular 9', 'posto')");
  assert.equal((await como(CHEFE, "delete from acessos where email = 'posto9@empresa.com' returning email")).length, 1);
  await assert.rejects(como(CHEFE, "insert into acessos (email, nome, papel) values ('sup2@empresa.com', 'Sup 2', 'supervisor')"), /só gerencia contas de celular/);
  await assert.rejects(como(CHEFE, `update acessos set papel = 'posto' where email = '${CHEFE}'`), /só gerencia contas de celular/);
  await assert.rejects(como(CHEFE, `delete from acessos where email = '${DONO}'`), /dono do projeto/);
  // administrador: gerencia supervisores e celulares, mas não mexe em administrador (nem em si mesmo)
  await como(DONO, "insert into acessos (email, nome, papel) values ('sup2@empresa.com', 'Sup 2', 'supervisor')");
  assert.equal((await como(DONO, "delete from acessos where email = 'sup2@empresa.com' returning email")).length, 1);
  await assert.rejects(como(DONO, `update acessos set ativo = false where email = '${DONO}'`), /dono do projeto/);
  await assert.rejects(como(DONO, "insert into acessos (email, nome, papel) values ('x@empresa.com', 'X', 'administrador')"), /dono do projeto/);
  // dono do projeto (SQL Editor, sem login) pode
  await db.exec(`update acessos set nome = 'Dono da empresa' where email = '${DONO}'`);
});

test('supervisor vê a auditoria, menos as ações de administradores', async () => {
  await rpc(DONO, 'definir_pin', { p_frentista_id: ana, p_pin: '5820' });
  assert.ok((await como(DONO, "select acao from auditoria where papel = 'administrador'")).length > 0);
  const vistoPeloChefe = await como(CHEFE, 'select acao, papel from auditoria');
  assert.ok(vistoPeloChefe.length > 0);
  assert.ok(vistoPeloChefe.every(a => a.papel !== 'administrador'));
  assert.ok(vistoPeloChefe.some(a => a.papel === 'posto'));       // vê o que foi feito pelos celulares
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
