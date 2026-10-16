// Testa o arquivo de uma vez "zerar-movimento.sql" num banco à parte: sem o SIM não apaga nada;
// com o SIM apaga o movimento, mantém os cadastros e a numeração dos abastecimentos volta ao 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const ler = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const SCHEMA = ler('../supabase/schema.sql'), ZERAR = ler('../supabase/uma-vez/zerar-movimento.sql');
const SUPABASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
`;

test('zerar o movimento: só com SIM; apaga o movimento e mantém os cadastros', async () => {
  const db = new PGlite();
  await db.exec(SUPABASE);
  await db.exec(SCHEMA);
  await db.exec(`
    insert into frentistas (nome) values ('Ana');
    insert into tanques values ('TQ01', 30000, 12000);
    insert into bombas values (1, 'TQ01', 1000, true);
    insert into veiculos (placa, km_inicial) values ('ABC1D23', 100);
    insert into abastecimentos (uuid, data_hora, placa, motorista, km, litros, encerrante, bomba, status, frentista_id, conta)
      values (gen_random_uuid(), now(), 'ABC1D23', 'JOAO', 200, 10, 1010, 1, 'Pronto', 1, 'x');
    insert into fotos (entidade, chave, caminho, conta) values ('abastecimento', '1', 'abastecimento/a.jpg', 'x'), ('veiculo', 'ABC1D23', 'veiculo/b.jpg', 'x');
    insert into auditoria (acao) values ('teste');`);
  const n = async t => (await db.query(`select count(*)::int as n from ${t}`)).rows[0].n;
  await assert.rejects(db.exec(ZERAR), /Nada foi apagado/);
  assert.equal(await n('abastecimentos'), 1);
  await db.exec(ZERAR.replace("confirmo constant text := 'NAO'", "confirmo constant text := 'SIM'"));
  for (const t of ['abastecimentos', 'chegadas', 'fechamentos', 'afericoes', 'precos_diesel', 'lotes', 'auditoria']) assert.equal(await n(t), 0, t);
  assert.deepEqual((await db.query('select entidade from fotos')).rows, [{ entidade: 'veiculo' }]);
  for (const t of ['frentistas', 'tanques', 'bombas', 'veiculos']) assert.equal(await n(t), 1, t);
  const r = await db.query(`insert into abastecimentos (uuid, data_hora, placa, motorista, km, litros, encerrante, bomba, status, frentista_id, conta)
    values (gen_random_uuid(), now(), 'ABC1D23', 'JOAO', 300, 10, 1020, 1, 'Pronto', 1, 'x') returning id`);
  assert.equal(Number(r.rows[0].id), 1);   // o Nº da requisição recomeça
});
