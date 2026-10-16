import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { COLUNAS, planilhaKMM, serialExcel, avisosLote } from '../web/comum/kmm.js';

test('planilha no layout do importador do KMM', () => {
  const wb = planilhaKMM(XLSX, [
    { requisicao: 1001, data_hora: '2026-10-14T06:10:00', placa: 'ABC1D23', cpf: '01122233344', km: 150200, litros: 640, bomba: 1 },
    { requisicao: 1002, data_hora: '2026-10-14T07:05:00', placa: 'DEF4567', cpf: '22233344455', km: 98000, litros: 380.5, bomba: 3,
      preco: 6.19, valor_total: 2355.30 },
  ]);
  const lido = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellDates: false });
  const ws = lido.Sheets[lido.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  assert.deepEqual(linhas[0], COLUNAS);
  assert.deepEqual(linhas[1], [serialExcel('2026-10-14T06:10:00'), 1001, 0, null, 'ABC1D23', '01122233344', 150200, null, 0, 640, 0, 1]);
  assert.equal(linhas[2][9], 380.5);
  assert.deepEqual([linhas[2][8], linhas[2][10]], [6.19, 2355.3]);   // com preço: valor unitário e total; sem preço: 0
  assert.equal(ws.F2.t, 's');          // CPF como texto
  assert.equal(ws.A2.t, 'n');          // data como número de data do Excel
  assert.equal(linhas.length, 3);
});

test('data vira o serial certo do Excel, sem depender do fuso', () => {
  assert.equal(serialExcel('1900-01-01T00:00:00'), 2);
  assert.equal(serialExcel('2026-10-14T12:00:00'), 46309.5);
});

test('avisa quando o lote tem um registro só', () => {
  assert.equal(avisosLote([{}]).length, 1);
  assert.equal(avisosLote([{}, {}]).length, 0);
});
