// Google Apps Script: leva os comprovantes dos abastecimentos do Supabase para o Google Drive.
// O app envia a foto do comprovante (junto com o visor da bomba) para o Storage do Supabase, que serve só de fila.
// Este script roda sozinho a cada 10 minutos: copia cada foto para
//   Abastecimentos / AAAA-MM / DD / Comprovante-PLACA-HHMM.jpg
// grava no banco o link do Drive (o painel abre a foto por ele) e apaga a foto do Supabase, que assim não enche.
//
// Como instalar: docs/CONFIGURAR.md, passo 8. Em resumo:
//  1. script.google.com, com a conta Google dona do Drive → Novo projeto → cole este arquivo inteiro.
//  2. Configurações do projeto → Propriedades do script:
//       SUPABASE_URL          https://xxxx.supabase.co
//       SUPABASE_SERVICE_KEY  a chave service_role do Supabase (Project Settings → API). SECRETA: só aqui, nunca no código.
//       PASTA_ID (opcional)   ID de uma pasta "Abastecimentos" que já exista; sem ela, o script cria uma no Meu Drive.
//  3. Escolha a função "instalar" e clique em Executar (autorize o acesso ao Drive e à internet).

const PASTA_RAIZ = 'Abastecimentos';
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

/** O que o gatilho chama. */
function copiarComprovantes() {
  const trava = LockService.getScriptLock();
  if (!trava.tryLock(1000)) return;   // a execução anterior ainda está trabalhando
  try {
    const cfg = config_(), inicio = Date.now();
    const fila = rpc_(cfg, 'fotos_para_drive', { p_limite: POR_VEZ });
    if (!fila.length) return;
    const raiz = pastaRaiz_(cfg), falhas = [];
    let feitos = 0;
    for (const f of fila) {
      if (Date.now() - inicio > LIMITE_MS) break;   // o resto vai na próxima execução
      try { levar_(cfg, raiz, f); feitos++; } catch (e) { falhas.push(`#${f.abastecimento} ${f.placa}: ${e.message}`); }
    }
    console.log(`${feitos} comprovante(s) no Drive.`);
    // Erro aparece em "Execuções" e o Google manda e-mail (gatilho com notificação de falha)
    if (falhas.length) throw new Error(`${falhas.length} comprovante(s) não foram para o Drive; tentam de novo na próxima vez.\n${falhas.join('\n')}`);
  } finally {
    trava.releaseLock();
  }
}

// ---------- Por dentro ----------
function levar_(cfg, raiz, f) {
  let id = f.drive_id;
  if (!id) {
    const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(f.data_hora);
    if (!p) throw new Error(`data inválida: ${f.data_hora}`);
    const pasta = subpasta_(subpasta_(raiz, `${p[1]}-${p[2]}`), p[3]);
    // Já copiado numa execução que caiu antes de gravar no banco: usa o mesmo arquivo (a descrição guarda o caminho)
    const arquivo = jaCopiado_(pasta, f.caminho) || criar_(cfg, pasta, f, `Comprovante-${f.placa}-${p[4]}${p[5]}`);
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
  arquivo.setDescription(`Abastecimento #${f.abastecimento} · ${f.caminho}`);
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

const linkDrive_ = id => `https://drive.google.com/file/d/${id}/view`;

function config_() {
  const p = PropertiesService.getScriptProperties();
  const url = String(p.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  const chave = String(p.getProperty('SUPABASE_SERVICE_KEY') || '').trim();
  if (!/^https:\/\/[\w-]+\.supabase\.co$/.test(url)) throw new Error('Propriedade SUPABASE_URL ausente ou inválida (ex.: https://xxxx.supabase.co).');
  if (!chave) throw new Error('Propriedade SUPABASE_SERVICE_KEY ausente (chave service_role do Supabase).');
  return { url, chave, pasta: String(p.getProperty('PASTA_ID') || '').trim() };
}
