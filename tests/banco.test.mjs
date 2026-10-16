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
let db, base, frentistaId;

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
  return (await como(email, sql, nomes.map(n => typeof args[n] === 'object' && args[n] !== null ? JSON.stringify(args[n]) : args[n])))[0].r;
};
const dh = minutosAtras => {
  const d = new Date(base.getTime() - minutosAtras * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
};
const reg = (min, extra = {}) => ({ uuid: randomUUID(), data_hora: dh(min), placa: 'ABC1D23', motorista: 'João da Silva',
  km: 150200, litros: 640, encerrante: 7071686, bomba: 1, frentista_id: frentistaId, ...extra });

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE);
  await db.exec(SCHEMA);
  await db.exec(SCHEMA);   // rodar de novo não pode dar erro (atualização do schema)
  await db.exec(`
    insert into acessos (email, nome, papel) values ('${POSTO}', 'Celular posto 1', 'posto'), ('${CHEFE}', 'Chefe', 'supervisor'), ('${DONO}', 'Dono', 'administrador');
    insert into frentistas (nome) values ('Ana Ribeiro'), ('Carlos Mendes');
    insert into tanques values ('TQ01', 30000, 12000);
    insert into bombas values (1, 'TQ01', 7071046, true);
    insert into veiculos values ('ABC1D23', 700, 149500, true), ('DEF4567', 600, 97500, true);
    insert into motoristas (nome, cpf) values ('JOAO DA SILVA', '52998224725');`);
  frentistaId = (await db.query("select id from frentistas where nome = 'Ana Ribeiro'")).rows[0].id;
  // "agora" no fuso de São Paulo, como o banco enxerga
  const t = (await db.query("select to_char(agora_local(), 'YYYY-MM-DD\"T\"HH24:MI:SS') as t")).rows[0].t;
  base = new Date(t);
});

// ---------- Acesso ----------
test('sem login (anon) não lê tabela nenhuma', async () => {
  await assert.rejects(db.transaction(async tx => { await tx.query('set local role anon'); await tx.query('select * from veiculos'); }), /permission denied/);
});

test('conta Google não autorizada não vê nada nem chama funções', async () => {
  assert.equal((await como(ESTRANHO, 'select * from veiculos')).length, 0);
  assert.equal((await como(ESTRANHO, 'select * from abastecimentos')).length, 0);
  await assert.rejects(rpc(ESTRANHO, 'estado_posto'), /Acesso negado/);
  await assert.rejects(rpc(ESTRANHO, 'registrar_abastecimentos', { p_registros: [reg(30)] }), /Acesso negado/);
  await assert.rejects(rpc(ESTRANHO, 'calcular_fechamento', { p_dia: dh(0).slice(0, 10) }), /Acesso negado/);
});

test('mesmo e-mail autorizado, mas sem ser login Google, é recusado', async () => {
  await assert.rejects(como(CHEFE, 'select gerar_lote()', [], 'email'), /Acesso negado/);
});

test('celular não grava nem lê tabelas diretamente', async () => {
  await assert.rejects(como(POSTO, "insert into veiculos values ('ZZZ1Z11', 500, 1, true)"), /row-level security/);
  assert.equal((await como(POSTO, 'select * from motoristas')).length, 0);
  await assert.rejects(como(POSTO, `insert into abastecimentos (uuid, data_hora, placa, motorista, km, litros, encerrante, bomba, status, frentista_id, conta)
    values ('${randomUUID()}', now(), 'ABC1D23', 'X', 1, 1, 1, 1, 'Pronto', ${frentistaId}, 'x')`), /row-level security|permission denied/);
});

test('funções internas não podem ser chamadas de fora', async () => {
  await assert.rejects(como(POSTO, "select conferir_abastecimento(now()::timestamp, 'ABC1D23', 'X', 1, 1, 1, 1)"), /permission denied/);
  await assert.rejects(como(POSTO, "select auditar('x', null, null, null)"), /permission denied/);
});

test('celular não pode chamar funções do supervisor', async () => {
  await assert.rejects(rpc(POSTO, 'gerar_lote'), /Acesso negado/);
  await assert.rejects(rpc(POSTO, 'decidir_abastecimento', { p_id: 1, p_acao: 'cancelar', p_motivo: 'teste' }), /Acesso negado/);
});

test('estado do posto não leva CPF para o celular', async () => {
  const e = await rpc(POSTO, 'estado_posto');
  assert.equal(e.papel, 'posto');
  assert.ok(!JSON.stringify(e).includes('52998224725'));
  assert.equal(Number(e.bombas[0].encerrante_anterior), 7071046);
  assert.deepEqual(e.frentistas.map(f => f.nome), ['Ana Ribeiro', 'Carlos Mendes']);
});

// ---------- Fluxo ----------
test('abastecimento certo fica Pronto e reenvio não duplica', async () => {
  const r = reg(9);
  const [a] = await rpc(POSTO, 'registrar_abastecimentos', { p_registros: [r] });
  assert.equal(a.status, 'Pronto', JSON.stringify(a.problemas));
  const [b] = await rpc(POSTO, 'registrar_abastecimentos', { p_registros: [r] });
  assert.equal(b.id, a.id);
  const n = (await db.query('select count(*)::int as n from abastecimentos where uuid = $1', [r.uuid])).rows[0].n;
  assert.equal(n, 1);
});

test('banco reconfere: encerrante não bate vira Exceção, com número formatado', async () => {
  const [a] = await rpc(POSTO, 'registrar_abastecimentos', { p_registros: [reg(8, { km: 150300, litros: 100, encerrante: 7071800 })] });
  assert.equal(a.status, 'Exceção');
  assert.ok(a.problemas.some(p => p.includes('Encerrante indica 114 L (de 7.071.686 para 7.071.800)')), a.problemas.join(' | '));
});

test('hora no futuro e frentista inválido', async () => {
  const [a] = await rpc(POSTO, 'registrar_abastecimentos', { p_registros: [reg(-60, { placa: 'DEF4567', km: 98000, litros: 10, encerrante: 9999999, bomba: 2 })] });
  assert.ok(a.problemas.some(p => p.includes('futuro')));
  assert.ok(a.problemas.some(p => p.includes('Bomba 2 não existe')));
  await assert.rejects(rpc(POSTO, 'registrar_abastecimentos', { p_registros: [reg(10, { frentista_id: 99999 })] }), /Frentista/);
  await assert.rejects(rpc(POSTO, 'registrar_abastecimentos', { p_registros: [reg(10, { litros: -5 })] }), /fora do permitido/);
});

test('supervisor corrige exceção e o histórico guarda o antes e o depois', async () => {
  const exc = (await como(CHEFE, "select id from abastecimentos where status = 'Exceção' and litros = 100"))[0];
  const r = await rpc(CHEFE, 'decidir_abastecimento', { p_id: exc.id, p_acao: 'revalidar', p_motivo: 'Visor mostrava 114 L', p_alteracoes: { litros: 114 } });
  assert.equal(r.status, 'Pronto');
  assert.equal(r.cpf, undefined);
  const h = await como(CHEFE, "select detalhes from auditoria where entidade = 'abastecimento' and entidade_id = $1 and acao = 'abastecimento.revalidar'", [String(exc.id)]);
  assert.deepEqual(h[0].detalhes.alterado.litros.map(Number), [100, 114]);
});

test('lote do KMM: gera, não repete, marca erro, confirma e trava alteração', async () => {
  const lote = await rpc(CHEFE, 'gerar_lote');
  assert.equal(lote.quantidade, 2);
  assert.equal(lote.linhas[0].cpf, '52998224725');
  await assert.rejects(rpc(CHEFE, 'gerar_lote'), /Não há abastecimentos prontos/);
  await rpc(CHEFE, 'marcar_erro_kmm', { p_id: lote.linhas[0].requisicao, p_mensagem: 'Placa bloqueada no KMM' });
  const f = await rpc(CHEFE, 'fechar_lote', { p_lote: lote.id, p_acao: 'confirmar' });
  assert.equal(f.registros, 1);
  await assert.rejects(rpc(CHEFE, 'decidir_abastecimento', { p_id: lote.linhas[1].requisicao, p_acao: 'cancelar', p_motivo: 'teste de trava' }), /Corrija no KMM/);
  await assert.rejects(rpc(CHEFE, 'fechar_lote', { p_lote: lote.id, p_acao: 'desfazer' }), /já está confirmado/);
});

test('fechamento do dia: conta certa e não fecha duas vezes', async () => {
  const [t] = await rpc(POSTO, 'registrar_fechamento', { p_medidos: { TQ01: 11200 }, p_frentista_id: frentistaId });
  // saídas pelo encerrante da bomba 1: 640 + 114 (o registro "do futuro" foi na bomba 2, que não existe, e não conta)
  assert.equal(Number(t.saldo_calculado), 12000 - 754);
  assert.equal(Number(t.diferenca), 11200 - 11246);
  assert.equal(t.alerta, true);
  await assert.rejects(rpc(POSTO, 'registrar_fechamento', { p_medidos: { TQ01: 1 }, p_frentista_id: frentistaId }), /já foi fechado/);
});

test('ninguém apaga abastecimento nem mexe na auditoria', async () => {
  await assert.rejects(db.exec('delete from abastecimentos'), /não pode ser apagado/);
  await assert.rejects(db.exec('delete from auditoria'), /somente inclusão/);
  await assert.rejects(db.exec("update auditoria set acao = 'x'"), /somente inclusão/);
  assert.equal((await como(CHEFE, 'delete from auditoria returning id')).length, 0);   // RLS: nem chega a apagar
});

// ---------- Cadastros pelo painel ----------
test('supervisor cadastra: normaliza placa, valida CPF e registra no histórico com CPF mascarado', async () => {
  await como(CHEFE, "insert into veiculos (placa, capacidade_l, km_inicial) values ('ghi-8j90', 500, 220000)");
  assert.equal((await db.query("select placa from veiculos where placa = 'GHI8J90'")).rows.length, 1);
  await assert.rejects(como(CHEFE, "insert into motoristas (nome, cpf) values ('Fulano', '111.111.111-11')"), /check constraint/);
  await como(CHEFE, "insert into motoristas (nome, cpf) values ('Maria Souza', '111.444.777-35')");
  const a = (await db.query("select conta, detalhes from auditoria where acao = 'cadastro.motoristas.insert' order by id desc limit 1")).rows[0];
  assert.equal(a.conta, CHEFE);
  assert.equal(a.detalhes.depois.cpf, '***35');
  assert.equal(a.detalhes.depois.nome, 'MARIA SOUZA');
});

// ---------- Administrador ----------
test('administrador pode tudo que o supervisor pode', async () => {
  assert.equal(await rpc(DONO, 'meu_papel'), 'administrador');
  assert.ok((await como(DONO, 'select * from veiculos')).length > 0);
  assert.ok(Array.isArray(await rpc(DONO, 'linhas_lote', { p_lote: 1 })));
});

test('supervisor não exclui, não desativa, não rebaixa e não cria administrador', async () => {
  await assert.rejects(como(CHEFE, `delete from acessos where email = '${DONO}'`), /Somente um administrador/);
  await assert.rejects(como(CHEFE, `update acessos set ativo = false where email = '${DONO}'`), /Somente um administrador/);
  await assert.rejects(como(CHEFE, `update acessos set papel = 'supervisor' where email = '${DONO}'`), /Somente um administrador/);
  await assert.rejects(como(CHEFE, "insert into acessos (email, nome, papel) values ('outro@empresa.com', 'Outro', 'administrador')"), /Somente um administrador/);
  await assert.rejects(como(CHEFE, `update acessos set papel = 'administrador' where email = '${CHEFE}'`), /Somente um administrador/);
  const dono = (await db.query(`select papel, ativo from acessos where email = '${DONO}'`)).rows[0];
  assert.deepEqual(dono, { papel: 'administrador', ativo: true });
});

test('supervisor exclui acesso de celular, e fica na auditoria', async () => {
  await como(CHEFE, "insert into acessos (email, nome, papel) values ('posto9@empresa.com', 'Celular 9', 'posto')");
  const apagados = await como(CHEFE, "delete from acessos where email = 'posto9@empresa.com' returning email");
  assert.equal(apagados.length, 1);
  const a = (await db.query("select conta from auditoria where acao = 'cadastro.acessos.delete' and entidade_id = 'posto9@empresa.com'")).rows;
  assert.equal(a[0].conta, CHEFE);
});

test('o único administrador ativo não pode sair, nem por conta própria', async () => {
  await assert.rejects(como(DONO, `update acessos set ativo = false where email = '${DONO}'`), /único administrador/);
  await assert.rejects(como(DONO, `delete from acessos where email = '${DONO}'`), /único administrador/);
  await assert.rejects(como(DONO, `update acessos set papel = 'supervisor' where email = '${DONO}'`), /único administrador/);
});

test('com dois administradores, um pode remover o outro; o dono do projeto (SQL Editor) sempre pode', async () => {
  await como(DONO, "insert into acessos (email, nome, papel) values ('socio@empresa.com', 'Sócio', 'administrador')");
  assert.equal((await como(DONO, "update acessos set ativo = false where email = 'socio@empresa.com' returning email")).length, 1);
  await como(DONO, "delete from acessos where email = 'socio@empresa.com'");
  await db.exec(`update acessos set ativo = false where email = '${DONO}'`);   // SQL Editor: sem login
  await db.exec(`update acessos set ativo = true where email = '${DONO}'`);
});
