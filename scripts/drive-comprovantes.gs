// Google Apps Script do Abastecimento Diesel. Roda sozinho a cada 10 minutos e faz duas coisas no Google Drive:
//
// 1. Comprovantes: o app envia a foto do comprovante (junto com o visor da bomba) para o Storage do Supabase, que serve
//    só de fila. O script copia cada foto para  Abastecimentos / AAAA-MM / DD / Comprovante-PLACA-HHMM.jpg (e as fotos da
//    abertura e do fechamento do turno, Abertura-HHMM-1.jpg e Fechamento-HHMM-1.jpg, na mesma pasta do dia; as fotos das
//    aferições vão para a pasta à parte  Aferições / AAAA / Semana NN (DD-MM a DD-MM) / Bomba-N-DD-MM-HHMM-1.jpg),
//    grava no banco o link do Drive (o painel abre a foto por ele) e apaga a foto do Supabase, que assim não enche.
// 2. Relatório diário: depois que o frentista fecha o turno, preenche uma cópia do modelo
//    "RELATÓRIO DIÁRIO DE ABASTECIMENTO - VERSÃO ONLINE" e salva o PDF em  Abastecimentos / AAAA-MM / DD /
//    Relatorio-diario-DD-MM.pdf. Turno reaberto e fechado de novo: o PDF é refeito. Mais de 35 abastecimentos ou mais
//    de uma chegada de diesel no dia: o PDF ganha outra folha igual.
//
// Como instalar: docs/CONFIGURAR.md, passo 8. Em resumo:
//  1. script.google.com, com a conta Google dona do Drive → Novo projeto → cole este arquivo inteiro.
//  2. Configurações do projeto → Propriedades do script:
//       SUPABASE_URL          https://xxxx.supabase.co
//       SUPABASE_SERVICE_KEY  a chave service_role do Supabase (Project Settings → API). SECRETA: só aqui, nunca no código.
//       PASTA_ID (opcional)   ID de uma pasta "Abastecimentos" que já exista; sem ela, o script cria uma no Meu Drive.
//       MODELO_ID             ID do modelo do relatório diário convertido em Planilha Google (passo 9 do CONFIGURAR.md).
//                             Sem ele, o script só leva os comprovantes.
//  3. Escolha a função "instalar" e clique em Executar (autorize o acesso ao Drive, às planilhas e à internet).

const PASTA_RAIZ = 'Abastecimentos';
const PASTA_AFERICOES = 'Aferições';   // pasta à parte: Aferições / AAAA / Semana NN (DD-MM a DD-MM) / fotos
const POR_VEZ = 40;                       // fotos por execução (25 abastecimentos por dia cabem com folga)
const LIMITE_MS = 4.5 * 60 * 1000;        // o Google corta a execução em 6 minutos

/** Cria o gatilho de 10 em 10 minutos (rodar uma vez). Rodar de novo não duplica. */
function instalar() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'copiarComprovantes').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('copiarComprovantes').timeBased().everyMinutes(10).create();
  testar();
  copiarComprovantes();
}

/** Confere as propriedades e a ligação com o Supabase, sem mexer em nada. */
function testar() {
  const cfg = config_();
  const fila = rpc_(cfg, 'fotos_para_drive', { p_limite: 100 });
  console.log(`Ligação com o Supabase OK. Comprovantes esperando: ${fila.length}${fila.length === 100 ? ' ou mais' : ''}. Pasta: ${pastaRaiz_(cfg).getUrl()}`);
}

/** O que o gatilho chama (o nome ficou o mesmo para não precisar refazer o gatilho). */
function copiarComprovantes() {
  const trava = LockService.getScriptLock();
  if (!trava.tryLock(1000)) return;   // a execução anterior ainda está trabalhando
  try {
    const cfg = config_(), inicio = Date.now(), falhas = [];
    const fila = rpc_(cfg, 'fotos_para_drive', { p_limite: POR_VEZ });
    const relatorios = cfg.modelo ? rpc_(cfg, 'relatorios_para_drive', {}) : [];
    if (!fila.length && !relatorios.length) return;
    const raiz = pastaRaiz_(cfg);
    let feitos = 0, pdfs = 0;
    for (const f of fila) {
      if (Date.now() - inicio > LIMITE_MS) break;   // o resto vai na próxima execução
      try { levar_(cfg, raiz, f); feitos++; } catch (e) { falhas.push(`${f.nome || f.caminho}: ${e.message}`); }
    }
    for (const r of relatorios) {
      if (Date.now() - inicio > LIMITE_MS) break;
      try { gerarRelatorio_(cfg, raiz, r); pdfs++; } catch (e) { falhas.push(`relatório de ${r.data}: ${e.message}`); }
    }
    console.log(`${feitos} comprovante(s) e ${pdfs} relatório(s) no Drive.`);
    // Erro aparece em "Execuções" e o Google manda e-mail (gatilho com notificação de falha)
    if (falhas.length) throw new Error(`${falhas.length} item(ns) não foram para o Drive; tentam de novo na próxima vez.\n${falhas.join('\n')}`);
  } finally {
    trava.releaseLock();
  }
}

/** Gera de novo, na hora, o relatório do dia mais recente fechado (para testar o modelo). */
function testarRelatorio() {
  const cfg = config_();
  if (!cfg.modelo) throw new Error('Falta a propriedade MODELO_ID (o modelo do relatório convertido em Planilha Google).');
  const fila = rpc_(cfg, 'relatorios_para_drive', {});
  if (!fila.length) { console.log('Nenhum dia fechado esperando relatório. Feche um turno no app (ou reabra e feche) e rode de novo.'); return; }
  const url = gerarRelatorio_(cfg, pastaRaiz_(cfg), fila[fila.length - 1]);
  console.log(`Relatório gerado: ${url}`);
}

// ---------- Relatório diário ----------
// Células do modelo (aba 1): cabeçalho nas linhas 5 a 7, abastecimentos nas linhas 10 a 44 (35 por folha),
// recebimento de diesel nas linhas 46 a 50. O rótulo fica na mesma célula do valor ("DATA: 02/09/2026").
const LINHAS_POR_FOLHA = 35, PRIMEIRA_LINHA = 10;
const num_ = (x, casas = 0) => x == null || x === '' ? '' : Number(x).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: Math.max(casas, 3) });
const litros_ = x => x == null || x === '' ? '' : Number(x).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const cpf_ = c => /^\d{11}$/.test(c || '') ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : (c || '');

function gerarRelatorio_(cfg, raiz, r) {
  const [ano, mes, dia] = r.data.split('-');
  const pasta = subpasta_(subpasta_(raiz, `${ano}-${mes}`), dia);
  const nome = `Relatorio-diario-${dia}-${mes}.pdf`;
  const copia = DriveApp.getFileById(cfg.modelo).makeCopy(`Relatorio-diario-${dia}-${mes} (gerando)`, pasta);
  try {
    const ss = SpreadsheetApp.openById(copia.getId());
    const base = ss.getSheets()[0];
    ss.getSheets().slice(1).forEach(sh => ss.deleteSheet(sh));
    const folhas = Math.max(1, Math.ceil(r.abastecimentos.length / LINHAS_POR_FOLHA), r.chegadas.length);
    const abas = [base];
    for (let k = 1; k < folhas; k++) abas.push(base.copyTo(ss).setName(`Folha ${k + 1}`));
    abas.forEach((sh, k) => preencher_(sh, r, k));
    SpreadsheetApp.flush();
    const pdf = UrlFetchApp.fetch(`https://docs.google.com/spreadsheets/d/${ss.getId()}/export?format=pdf&size=A4&portrait=true&fitw=true` +
      '&gridlines=false&printtitle=false&sheetnames=false&pagenum=UNDEFINED&fzr=false&horizontal_alignment=CENTER' +
      '&top_margin=0.4&bottom_margin=0.4&left_margin=0.4&right_margin=0.4',
      { headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }, muteHttpExceptions: true });
    if (pdf.getResponseCode() !== 200) throw new Error(`o Google não gerou o PDF (${pdf.getResponseCode()})`);
    const antigos = pasta.getFilesByName(nome);   // turno reaberto: o PDF novo substitui o antigo
    while (antigos.hasNext()) antigos.next().setTrashed(true);
    const arquivo = pasta.createFile(pdf.getBlob().setName(nome));
    arquivo.setDescription(`Relatório diário de ${dia}/${mes}/${ano} · fechamento ${r.fechamento_em}`);
    rpc_(cfg, 'relatorio_no_drive', { p_data: r.data, p_drive_id: arquivo.getId(), p_drive_url: linkDrive_(arquivo.getId()), p_fechamento_em: r.fechamento_em });
    return linkDrive_(arquivo.getId());
  } finally {
    copia.setTrashed(true);   // a planilha preenchida era só para gerar o PDF
  }
}

function preencher_(sh, r, k) {
  const [ano, mes, dia] = r.data.split('-');
  const t = r.tanques, b = r.bombas;
  const texto = (cel, rotulo, valor) => sh.getRange(cel).setNumberFormat('@').setValue(`${rotulo}${valor ?? ''}`);
  texto('A5', 'DATA: ', `${dia}/${mes}/${ano}${k ? ` (folha ${k + 1})` : ''}`);
  texto('F5', 'HORA: ', r.hora);
  texto('A6', 'SALDO INICIAL (TQ) 01: ', t[0] ? `${num_(t[0].saldo_inicial)} L` : '');
  texto('F6', 'SALDO INICIAL (TQ) 02: ', t[1] ? `${num_(t[1].saldo_inicial)} L` : '');
  ['A7', 'C7', 'E7', 'G7'].forEach((cel, i) => texto(cel, `BOMBA (0${i + 1}): `, b[i] ? num_(b[i].encerrante_inicial) : ''));
  // Abastecimentos desta folha: placa, motorista, hora, KM, litros, valor final da bomba (F:G) e bomba (H:I)
  const pedaco = r.abastecimentos.slice(k * LINHAS_POR_FOLHA, (k + 1) * LINHAS_POR_FOLHA);
  const valores = [];
  for (let i = 0; i < LINHAS_POR_FOLHA; i++) {
    const a = pedaco[i];
    valores.push(a ? [a.placa, a.motorista, a.hora, num_(a.km), litros_(a.litros), num_(a.encerrante), '', String(a.bomba), '']
      : ['', '', ':', '', '', '', '', '', '']);
  }
  sh.getRange(PRIMEIRA_LINHA, 1, LINHAS_POR_FOLHA, 9).setNumberFormat('@').setValues(valores);
  // Recebimento de diesel: uma chegada por folha; a assinatura fica em branco (o analista carimba e assina)
  const c = r.chegadas[k] || {};
  texto('A46', 'DATA: ', c.data);
  texto('C46', 'HORA: ', c.hora);
  texto('A47', 'LITRAGEM: ', c.litros != null ? `${num_(c.litros)} L` : '');
  texto('D47', 'NF: ', c.nf);
  texto('E47', 'VALOR TOTAL: ', c.valor_total != null ? `R$ ${num_(c.valor_total, 2)}` : '');
  texto('A48', 'TQ1 (INICIAL): ', c.regua_antes != null ? `${num_(c.regua_antes)} L` : '');
  texto('D48', 'TQ1 (FINAL): ', c.regua_depois != null ? `${num_(c.regua_depois)} L` : '');
  texto('A49', 'PLACA DO CAVALO: ', c.placa_caminhao);
  texto('D49', 'PLACA DA CARRETA: ', c.placa_carreta);
  texto('A50', 'MOTORISTA: ', c.motorista);
  texto('D50', 'CPF: ', cpf_(c.cpf));
}

// ---------- Por dentro ----------
function levar_(cfg, raiz, f) {
  let id = f.drive_id;
  if (!id) {
    const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(f.data_hora);
    if (!p) throw new Error(`data inválida: ${f.data_hora}`);
    // O banco diz o caminho (f.pasta); sem ele (banco antigo), a pasta do dia em Abastecimentos
    const base = f.raiz === 'afericoes' ? pastaAfericoes_(cfg) : raiz;
    const pasta = (f.pasta || [`${p[1]}-${p[2]}`, p[3]]).reduce((pai, nome) => subpasta_(pai, nome), base);
    // Já copiado numa execução que caiu antes de gravar no banco: usa o mesmo arquivo (a descrição guarda o caminho)
    // nome vem do banco: Comprovante-PLACA-HHMM, Abertura-HHMM-n ou Fechamento-HHMM-n
    const arquivo = jaCopiado_(pasta, f.caminho) || criar_(cfg, pasta, f, f.nome || `Comprovante-${f.placa}-${p[4]}${p[5]}`);
    id = arquivo.getId();
    rpc_(cfg, 'foto_no_drive', { p_caminho: f.caminho, p_drive_id: id, p_drive_url: linkDrive_(id), p_fora_do_storage: false });
  }
  apagarDoStorage_(cfg, f.caminho);
  rpc_(cfg, 'foto_no_drive', { p_caminho: f.caminho, p_drive_id: id, p_drive_url: linkDrive_(id), p_fora_do_storage: true });
}

function criar_(cfg, pasta, f, base) {
  const r = UrlFetchApp.fetch(`${cfg.url}/storage/v1/object/fotos/${f.caminho}`, { headers: cabecalhos_(cfg), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error(`Supabase não entregou a foto (${r.getResponseCode()}): ${r.getContentText().slice(0, 200)}`);
  let nome = `${base}.jpg`;
  for (let n = 2; pasta.getFilesByName(nome).hasNext(); n++) nome = `${base}-${n}.jpg`;   // mesmo caminhão duas vezes no mesmo minuto
  const arquivo = pasta.createFile(r.getBlob().setName(nome));
  arquivo.setDescription(`${f.abastecimento ? `Abastecimento #${f.abastecimento}` : f.entidade === 'afericao' ? 'Aferição' : `Turno (${f.entidade})`} · ${f.caminho}`);
  return arquivo;
}

function jaCopiado_(pasta, caminho) {
  const it = pasta.getFiles();
  while (it.hasNext()) { const a = it.next(); if ((a.getDescription() || '').endsWith(caminho)) return a; }
  return null;
}

function apagarDoStorage_(cfg, caminho) {
  // Mesmo pedido que o supabase-js usa para remover; arquivo que já não existe não dá erro
  const r = UrlFetchApp.fetch(`${cfg.url}/storage/v1/object/fotos`, { method: 'delete', contentType: 'application/json',
    headers: cabecalhos_(cfg), payload: JSON.stringify({ prefixes: [caminho] }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error(`não foi possível apagar do Supabase (${r.getResponseCode()}): ${r.getContentText().slice(0, 200)}`);
}

function rpc_(cfg, funcao, args) {
  const r = UrlFetchApp.fetch(`${cfg.url}/rest/v1/rpc/${funcao}`, { method: 'post', contentType: 'application/json',
    headers: cabecalhos_(cfg), payload: JSON.stringify(args), muteHttpExceptions: true });
  const txt = r.getContentText();
  if (r.getResponseCode() >= 300) throw new Error(`${funcao} (${r.getResponseCode()}): ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

// Chave antiga (JWT "eyJ...") vai nos dois cabeçalhos; a chave nova (sb_secret_...) só em "apikey"
function cabecalhos_(cfg) {
  return cfg.chave.startsWith('sb_secret_') ? { apikey: cfg.chave } : { apikey: cfg.chave, Authorization: `Bearer ${cfg.chave}` };
}

function subpasta_(pai, nome) {
  const it = pai.getFoldersByName(nome);
  return it.hasNext() ? it.next() : pai.createFolder(nome);
}

function pastaRaiz_(cfg) {
  if (cfg.pasta) return DriveApp.getFolderById(cfg.pasta);
  const pasta = subpasta_(DriveApp.getRootFolder(), PASTA_RAIZ);
  PropertiesService.getScriptProperties().setProperty('PASTA_ID', pasta.getId());   // da próxima vez vai direto
  return pasta;
}

// Aferições: ao lado da pasta Abastecimentos (mesma pasta-mãe); o ID fica guardado para as próximas vezes
function pastaAfericoes_(cfg) {
  const props = PropertiesService.getScriptProperties(), id = String(props.getProperty('PASTA_AFERICOES_ID') || '').trim();
  if (id) return DriveApp.getFolderById(id);
  const maes = pastaRaiz_(cfg).getParents();
  const pasta = subpasta_(maes.hasNext() ? maes.next() : DriveApp.getRootFolder(), PASTA_AFERICOES);
  props.setProperty('PASTA_AFERICOES_ID', pasta.getId());
  return pasta;
}

const linkDrive_ = id => `https://drive.google.com/file/d/${id}/view`;

function config_() {
  const p = PropertiesService.getScriptProperties();
  const url = String(p.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  const chave = String(p.getProperty('SUPABASE_SERVICE_KEY') || '').trim();
  if (!/^https:\/\/[\w-]+\.supabase\.co$/.test(url)) throw new Error('Propriedade SUPABASE_URL ausente ou inválida (ex.: https://xxxx.supabase.co).');
  if (!chave) throw new Error('Propriedade SUPABASE_SERVICE_KEY ausente (chave service_role do Supabase).');
  return { url, chave, pasta: String(p.getProperty('PASTA_ID') || '').trim(), modelo: String(p.getProperty('MODELO_ID') || '').trim() };
}
