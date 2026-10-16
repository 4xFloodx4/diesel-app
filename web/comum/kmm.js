// Planilha no layout do importador "Abastecimento interno" do KMM (ImportaAbastecimento, KMM 3.23.1).
// Linha 1 = cabeçalho; dados a partir da linha 2; 12 colunas nesta ordem. Cabeçalho igual ao modelo oficial
// "Modelo Importacao Abastecimento Interno.xls". CNPJ Filial e Produto ficam vazios (o KMM usa o que for
// escolhido no assistente). Valor unitário e valor total vêm do preço usado no lançamento (0 se não teve preço);
// cupom vai 0.

export const COLUNAS = [
  'Data Transação', 'Nº Requisição', 'Nº Cupom', 'CNPJ Filial', 'Placa', 'CPF Motorista',
  'Hodometro', 'Produto', 'Valor Un.', 'Quantidade', 'Valor Total', 'Nº Bomba',
];

// "2026-10-14T06:10:00" -> número de série do Excel, sem depender do fuso do computador
export function serialExcel(iso) {
  const [d, h = '00:00:00'] = String(iso).split('T');
  const [a, m, dia] = d.split('-').map(Number);
  const [hh, mi, ss = 0] = h.split(':').map(Number);
  return (Date.UTC(a, m - 1, dia, hh, mi, ss) - Date.UTC(1899, 11, 30)) / 86400000;
}

export function avisosLote(linhas) {
  return linhas.length === 1
    ? ['Só 1 registro: o validador do KMM 3.23.1 recusa arquivo com exatamente uma linha de dados.'] : [];
}

/** Monta o arquivo .xlsx. `XLSX` é o SheetJS; `linhas` vem de gerar_lote()/linhas_lote(). Retorna um Workbook. */
export function planilhaKMM(XLSX, linhas) {
  const ws = XLSX.utils.aoa_to_sheet([COLUNAS]);
  linhas.forEach((l, i) => {
    const r = i + 1;
    const cel = (c, valor) => { ws[XLSX.utils.encode_cell({ r, c })] = valor; };
    cel(0, { t: 'n', v: serialExcel(l.data_hora), z: 'dd/mm/yyyy hh:mm:ss' });
    cel(1, { t: 'n', v: Number(l.requisicao) });
    cel(2, { t: 'n', v: 0 });
    cel(4, { t: 's', v: String(l.placa) });
    cel(5, { t: 's', v: String(l.cpf), z: '@' });     // texto: preserva zeros à esquerda
    cel(6, { t: 'n', v: Number(l.km) });
    cel(8, { t: 'n', v: Number(l.preco) || 0 });
    cel(9, { t: 'n', v: Number(l.litros) });
    cel(10, { t: 'n', v: Number(l.valor_total) || 0 });
    cel(11, { t: 'n', v: Number(l.bomba) });
  });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: linhas.length, c: COLUNAS.length - 1 } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Abastecimentos');
  return wb;
}
