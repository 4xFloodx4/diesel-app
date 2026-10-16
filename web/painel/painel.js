// Painel do supervisor e do administrador.
// Leituras vão direto às tabelas (o RLS só libera para quem é supervisor ou administrador);
// ações sensíveis passam pelas funções do banco, que conferem tudo de novo.
import * as XLSX from 'xlsx';
import { supabase, rpc, consulta, contaAtual, entrarComGoogle, sair } from '../comum/supa.js';
import { esc, nf, dataBR, dataHora, hojeISO, classeStatus } from '../comum/util.js';
import { planilhaKMM, avisosLote } from '../comum/kmm.js';
import { tirarFoto, enviarFotos, linksDasFotos } from '../comum/fotos.js';

const $ = id => document.getElementById(id);
const pagina = $('pagina');
let aba = 'resumo';
let meuPapel = null, minhaConta = null;
let cad = null;
let filtros = { de: '', ate: '', status: '', placa: '' };
const pill = s => `<span class="pill ${classeStatus(s)}">${esc(s)}</span>`;
const diasAtras = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const mascaraCpf = c => c ? `***.***.${c.slice(6, 9)}-${c.slice(9)}` : '';
const num = v => Number(String(v).replace(/\./g, '').replace(',', '.'));
const souAdmin = () => meuPapel === 'administrador';
const NOME_PAPEL = { posto: 'Celular do posto', supervisor: 'Supervisor', administrador: 'Administrador' };

function avisar(texto, tipo = 'ok') {
  const el = $('aviso');
  el.hidden = !texto;
  el.innerHTML = texto ? `<div class="toast ${tipo}" role="status">${esc(texto)}</div>` : '';
  if (texto) window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function chamar(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.semAcesso) { await mostrarLogin(e.message); return undefined; }
    avisar(e.message, 'warn');
    return undefined;
  }
}

// ---------- Login ----------
async function mostrarLogin(msg) {
  $('abas').hidden = true; $('sair').hidden = true; $('quem').textContent = '';
  avisar('');
  const conta = await contaAtual();
  pagina.innerHTML = `<div class="centro">
    <h2>Painel do Diesel</h2>
    ${conta ? `<p>Conectado como <b>${esc(conta)}</b>, mas esta conta não é de supervisor.</p>` : '<p>Entre com a sua conta Google de supervisor.</p>'}
    ${msg ? `<div class="toast warn">${esc(msg)}</div>` : ''}
    <button class="btn" type="button" id="google">${conta ? 'Entrar com outra conta' : 'Entrar com Google'}</button></div>`;
  $('google').addEventListener('click', async () => {
    if (conta) await sair();
    try { await entrarComGoogle(); } catch (e) { mostrarLogin(e.message); }
  });
}

async function iniciar() {
  const conta = await contaAtual();
  if (!conta) return mostrarLogin('');
  const papel = await chamar(() => rpc('meu_papel'));
  if (papel !== 'supervisor' && papel !== 'administrador') {
    return mostrarLogin(papel === 'posto' ? 'Esta é a conta de um celular do posto. Use a sua conta de supervisor.' : '');
  }
  meuPapel = papel; minhaConta = conta;
  $('quem').textContent = `${conta} · ${NOME_PAPEL[papel]}`;
  $('abas').hidden = false; $('sair').hidden = false;
  abrir(aba);
}

$('sair').addEventListener('click', async () => { await sair(); mostrarLogin('Você saiu.'); });
$('abas').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { avisar(''); abrir(b.dataset.aba); } });

const TELAS = { resumo, autorizacoes, excecoes, abastecimentos, lotes, fechamentos, frentistas, cadastros, acessos, auditoria };
async function abrir(nome) {
  aba = nome;
  document.querySelectorAll('#abas button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.aba === aba)));
  pagina.innerHTML = '<p class="hint">Carregando…</p>';
  atualizarContadores();
  await TELAS[nome]();
}

const contar = (filtro) => consulta(filtro(supabase.from('abastecimentos').select('id', { count: 'exact', head: true })).then(r => ({ ...r, data: r.count })));
async function atualizarContadores() {
  try {
    const [aut, exc] = await Promise.all([
      contar(q => q.eq('status', 'Aguardando autorização')),
      contar(q => q.in('status', ['Exceção', 'Erro'])),
    ]);
    for (const [id, n] of [['n-autorizacoes', aut], ['n-excecoes', exc]]) { $(id).hidden = !n; $(id).textContent = n; }
  } catch { /* contadores são só ajuda visual */ }
}

// ---------- Fotos ----------
async function verFotos(entidade, chave, titulo) {
  const lista = await chamar(() => rpc('fotos_de', { p_entidade: entidade, p_chave: String(chave) }));
  if (!lista) return;
  const links = await chamar(() => linksDasFotos(lista.map(f => f.caminho)));
  if (!links) return;
  const m = $('modal');
  m.dataset.entidade = entidade; m.dataset.chave = chave; m.dataset.titulo = titulo;
  m.innerHTML = `<div class="caixa" role="dialog" aria-label="${esc(titulo)}"><div class="acoes"><h2>${esc(titulo)}</h2>
      <button class="btn small ghost" type="button" data-acao="fechar-modal">Fechar</button></div>
    ${links.length ? `<div class="galeria">${links.map((u, i) => `<figure class="foto-item"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Foto ${i + 1}"></a>
        <button class="btn small warn" type="button" data-acao="excluir-foto" data-caminho="${esc(lista[i].caminho)}">Excluir foto</button></figure>`).join('')}</div>`
      : '<p class="hint">Sem fotos.</p>'}
    <p class="hint">Toque numa foto para abrir em tamanho real. Os links valem por 10 minutos. Excluir uma foto fica registrado na auditoria.</p></div>`;
  m.hidden = false;
}
$('modal').addEventListener('click', async e => {
  const m = $('modal');
  if (e.target.id === 'modal' || e.target.closest('[data-acao="fechar-modal"]')) { m.hidden = true; m.innerHTML = ''; abrir(aba); return; }
  const b = e.target.closest('[data-acao="excluir-foto"]');
  if (!b) return;
  if (b.dataset.confirmando !== '1') { b.dataset.confirmando = '1'; b.textContent = 'Clique de novo para excluir'; return; }
  b.disabled = true;
  const ok = await chamar(async () => {
    const { error } = await supabase.storage.from('fotos').remove([b.dataset.caminho]);
    if (error) throw new Error(`Não foi possível excluir o arquivo: ${error.message}`);
    await rpc('excluir_foto', { p_caminho: b.dataset.caminho });
    return true;
  });
  if (ok) { avisar('Foto excluída.'); verFotos(m.dataset.entidade, m.dataset.chave, m.dataset.titulo); } else b.disabled = false;
});
const botaoFotos = (entidade, chave, titulo, n) => n
  ? `<button class="btn small ghost" type="button" data-acao="ver-fotos" data-entidade="${entidade}" data-chave="${esc(chave)}" data-titulo="${esc(titulo)}">Fotos (${n})</button>` : '';
async function contarFotos(entidade) {
  const r = await consulta(supabase.from('fotos').select('chave').eq('entidade', entidade).limit(5000));
  return r.reduce((m, f) => (m[f.chave] = (m[f.chave] || 0) + 1, m), {});
}

// ---------- Resumo ----------
async function resumo() {
  const r = await chamar(async () => {
    const st = s => contar(q => q.eq('status', s));
    const [aut, exc, erro, pronto, emLote, lancado] = await Promise.all(['Aguardando autorização', 'Exceção', 'Erro', 'Pronto', 'Em lote', 'Lançado'].map(st));
    return {
      aut, exc: exc + erro, pronto, emLote, lancado,
      hoje: await rpc('calcular_fechamento', { p_dia: hojeISO() }),
      fech: await consulta(supabase.from('fechamentos').select('*').gte('data', diasAtras(7)).or('diferenca.gt.20,diferenca.lt.-20').order('data', { ascending: false })),
      cheg: await consulta(supabase.from('chegadas').select('id,tanque,data_hora,nf,alerta').not('alerta', 'is', null).gte('data_hora', diasAtras(7)).order('data_hora', { ascending: false })),
      lotes: await consulta(supabase.from('lotes').select('*').eq('situacao', 'Gerado')),
    };
  });
  if (!r) return;
  pagina.innerHTML = `
    <div class="cartoes">
      <div class="cartao ${r.aut ? 'alerta' : ''}"><b>${r.aut}</b><span>Aguardando sua autorização</span></div>
      <div class="cartao ${r.exc ? 'alerta' : ''}"><b>${r.exc}</b><span>Exceções e erros para resolver</span></div>
      <div class="cartao"><b>${r.pronto}</b><span>Prontos para o próximo lote</span></div>
      <div class="cartao"><b>${r.emLote}</b><span>Em lote, aguardando confirmação</span></div>
      <div class="cartao"><b>${r.lancado}</b><span>Lançados no KMM</span></div>
    </div>
    <div class="duas">
      <div class="bloco"><h2>Tanques hoje</h2>
        <div class="tabela"><table><thead><tr><th>Tanque</th><th>Inicial</th><th>+ Chegadas</th><th>− Saídas</th><th>Esperado</th><th>Medido</th></tr></thead><tbody>
        ${r.hoje.map(t => `<tr><td>${esc(t.tanque)}</td><td class="n">${nf(t.saldo_inicial, 0)}</td><td class="n">${nf(t.chegadas, 0)}</td>
          <td class="n">${nf(t.saidas, 0)}</td><td class="n">${nf(t.saldo_calculado, 0)}</td><td class="n">${t.fechado ? nf(t.fechado.saldo_medido, 0) : 'aberto'}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="bloco"><h2>Alertas dos últimos 7 dias</h2>
        ${r.fech.length + r.cheg.length + r.lotes.length === 0 ? '<p class="hint">Nenhum alerta.</p>' : ''}
        ${r.fech.map(f => `<div class="toast warn">Fechamento ${esc(f.tanque)} em ${dataBR(f.data)}: diferença de ${nf(f.diferenca, 0)} L (esperado ${nf(f.saldo_calculado, 0)}, medido ${nf(f.saldo_medido, 0)}).</div>`).join('')}
        ${r.cheg.map(c => `<div class="toast warn">Chegada NF ${esc(c.nf)} (${esc(c.tanque)}, ${dataHora(c.data_hora)}): ${esc(c.alerta)}</div>`).join('')}
        ${r.lotes.map(l => `<div class="toast info">Lote ${l.id} (${l.quantidade} registros) aguardando confirmação da importação no KMM.</div>`).join('')}
      </div>
    </div>`;
}

// ---------- Autorizações (lançados sem desconto do motorista) ----------
async function autorizacoes() {
  const lista = await chamar(() => consulta(supabase.from('abastecimentos').select('*, frentistas(nome)').eq('status', 'Aguardando autorização').order('data_hora')));
  if (!lista) return;
  pagina.innerHTML = `<h2>Autorizações pendentes (${lista.length})</h2>
    <p class="hint">Abastecimentos lançados sem o desconto do diesel no acerto do motorista. Aprovado, o lançamento segue para as conferências e para o KMM; recusado, é cancelado.</p>
    ${lista.length ? '' : '<p class="hint">Nenhum pedido aguardando.</p>'}
    ${lista.map(r => `<form class="bloco autorizacao" data-autorizacao="${r.id}">
      <div class="acoes"><b>#${r.id}</b> <span>${dataHora(r.data_hora)} · ${esc(r.placa)} · ${esc(r.motorista)} · Bomba ${r.bomba} · ${nf(r.litros)} L · lançado por ${esc(r.frentistas?.nome || '')}</span></div>
      <div class="justificativa"><b>Justificativa do frentista:</b> ${esc(r.justificativa_desconto || '')}</div>
      ${(r.problemas || []).length ? `<ul class="problemas">${r.problemas.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      <div class="field"><label class="lbl">Motivo da decisão (obrigatório, fica no histórico)</label><textarea name="motivo" rows="2" maxlength="500" required minlength="5"></textarea></div>
      <div class="acoes">
        <button class="btn small" type="submit" data-decisao="aprovar">Autorizar lançamento</button>
        <button class="btn small warn" type="submit" data-decisao="recusar">Recusar</button>
      </div></form>`).join('')}`;
}

// ---------- Exceções ----------
async function carregarCadastros() {
  const [veiculos, motoristas, bombas, tanques, frentistasLista] = await Promise.all([
    consulta(supabase.from('veiculos').select('*').order('placa')),
    consulta(supabase.from('motoristas').select('*').order('nome')),
    consulta(supabase.from('bombas').select('*').order('numero')),
    consulta(supabase.from('tanques').select('*').order('codigo')),
    consulta(supabase.from('frentistas').select('*').order('nome')),
  ]);
  return { veiculos, motoristas, bombas, tanques, frentistas: frentistasLista };
}

async function excecoes() {
  const r = await chamar(async () => ({
    lista: await consulta(supabase.from('abastecimentos').select('*, frentistas(nome)').in('status', ['Erro', 'Exceção']).order('data_hora', { ascending: false })),
    c: await carregarCadastros(),
  }));
  if (!r) return;
  cad = r.c;
  pagina.innerHTML = `<h2>Exceções e erros do KMM (${r.lista.length})</h2>
    ${r.lista.length ? '' : '<p class="hint">Nada para resolver.</p>'}
    ${r.lista.map(cartaoExcecao).join('')}`;
}

function cartaoExcecao(r) {
  const opc = (lista, atual) => lista.map(v => `<option ${v === atual ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const placas = cad.veiculos.map(v => v.placa), nomes = cad.motoristas.map(m => m.nome);
  return `<form class="bloco excecao" data-id="${r.id}">
    <div class="acoes"><b>#${r.id}</b> ${pill(r.status)} <span>${dataHora(r.data_hora)} · ${esc(r.placa)} · ${esc(r.motorista)} · Bomba ${r.bomba} · ${nf(r.litros)} L · lançado por ${esc(r.frentistas?.nome || '')}</span></div>
    <ul class="problemas">${(r.problemas || []).map(p => `<li>${esc(p)}</li>`).join('')}${r.erro_kmm ? `<li>KMM: ${esc(r.erro_kmm)}</li>` : ''}</ul>
    ${r.obs_frentista ? `<p class="detalhe">Frentista: ${esc(r.obs_frentista)}</p>` : ''}
    ${r.desconto_confirmado ? '' : `<p class="detalhe">Sem desconto do motorista, autorizado por ${esc(r.autorizado_por || '')}.</p>`}
    <div class="grade">
      <div class="field"><label class="lbl">Data e hora</label><input name="data_hora" type="datetime-local" value="${esc(String(r.data_hora).slice(0, 16))}"></div>
      <div class="field"><label class="lbl">Placa</label><select name="placa">${opc(placas, r.placa)}${placas.includes(r.placa) ? '' : `<option selected>${esc(r.placa)}</option>`}</select></div>
      <div class="field"><label class="lbl">Motorista</label><select name="motorista">${opc(nomes, r.motorista)}${nomes.includes(r.motorista) ? '' : `<option selected>${esc(r.motorista)}</option>`}</select></div>
      <div class="field"><label class="lbl">KM</label><input name="km" class="num" inputmode="numeric" value="${r.km}"></div>
      <div class="field"><label class="lbl">Litros</label><input name="litros" class="num" inputmode="decimal" value="${Number(r.litros)}"></div>
      <div class="field"><label class="lbl">Encerrante</label><input name="encerrante" class="num" inputmode="decimal" value="${Number(r.encerrante)}"></div>
      <div class="field"><label class="lbl">Bomba</label><select name="bomba">${cad.bombas.map(b => `<option value="${b.numero}" ${b.numero === r.bomba ? 'selected' : ''}>${b.numero} (${esc(b.tanque)})</option>`).join('')}</select></div>
    </div>
    <div class="field"><label class="lbl">Motivo da decisão (obrigatório, fica no histórico)</label><textarea name="obs" rows="2" maxlength="500" required minlength="5"></textarea></div>
    <div class="acoes">
      <button class="btn small" type="submit" data-acao="revalidar">Corrigir e conferir de novo</button>
      <button class="btn small ghost" type="submit" data-acao="aprovar">Aprovar mesmo assim</button>
      <button class="btn small warn" type="submit" data-acao="cancelar">Cancelar abastecimento</button>
    </div></form>`;
}

// ---------- Abastecimentos ----------
function consultaAbastecimentos() {
  let q = supabase.from('abastecimentos').select('*, frentistas(nome)').order('data_hora', { ascending: false });
  if (filtros.status) q = q.eq('status', filtros.status);
  if (filtros.de) q = q.gte('data_hora', filtros.de);
  if (filtros.ate) q = q.lt('data_hora', new Date(new Date(filtros.ate).getTime() + 86400000).toISOString().slice(0, 10));
  if (filtros.placa) q = q.eq('placa', filtros.placa.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return q;
}

async function abastecimentos() {
  const lista = await chamar(() => consulta(consultaAbastecimentos().limit(1000)));
  if (!lista) return;
  const st = ['', 'Aguardando autorização', 'Pronto', 'Exceção', 'Em lote', 'Lançado', 'Erro', 'Cancelado'];
  pagina.innerHTML = `<div class="bloco">
    <div class="filtros">
      <div class="field"><label class="lbl" for="fl-de">De</label><input id="fl-de" type="date" value="${esc(filtros.de)}"></div>
      <div class="field"><label class="lbl" for="fl-ate">Até</label><input id="fl-ate" type="date" value="${esc(filtros.ate)}"></div>
      <div class="field"><label class="lbl" for="fl-status">Status</label><select id="fl-status">${st.map(s => `<option value="${s}" ${s === filtros.status ? 'selected' : ''}>${s || 'Todos'}</option>`).join('')}</select></div>
      <div class="field"><label class="lbl" for="fl-placa">Placa</label><input id="fl-placa" value="${esc(filtros.placa)}" maxlength="8"></div>
      <button class="btn small" type="button" data-acao="filtrar">Filtrar</button>
      <button class="btn small ghost" type="button" data-acao="exportar">Exportar para Excel</button>
    </div>
    <p class="hint">${lista.length} registro(s)${lista.length === 1000 ? ' (limite da tela; a exportação traz todos)' : ''}.</p>
    <div class="tabela"><table><thead><tr><th>#</th><th>Data</th><th>Placa</th><th>Motorista</th><th>KM</th><th>Litros</th><th>Bomba</th><th>Desconto</th><th>Status</th><th>Frentista</th></tr></thead><tbody>
    ${lista.map(r => `<tr><td class="n">${r.id}</td><td>${dataHora(r.data_hora)}</td><td>${esc(r.placa)}</td><td>${esc(r.motorista)}</td>
      <td class="n">${nf(r.km, 0)}</td><td class="n">${nf(r.litros)}</td><td class="n">${r.bomba}</td><td>${r.desconto_confirmado ? 'Sim' : 'Não'}</td>
      <td>${pill(r.status)}${r.problemas?.length ? `<div class="detalhe">${esc(r.problemas.join(' '))}</div>` : ''}</td><td>${esc(r.frentistas?.nome || '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

async function exportarExcel() {
  const todos = [];
  for (let i = 0; ; i += 1000) {
    const parte = await chamar(() => consulta(consultaAbastecimentos().range(i, i + 999)));
    if (!parte) return;
    todos.push(...parte);
    if (parte.length < 1000) break;
  }
  const linhas = [['ID (requisição KMM)', 'Data e hora', 'Placa', 'Motorista', 'CPF', 'KM', 'Litros', 'Encerrante anterior', 'Encerrante',
    'Bomba', 'Tanque', 'Status', 'Problemas', 'Desconto do motorista', 'Justificativa sem desconto', 'Autorizado por', 'Obs. frentista',
    'Obs. supervisor', 'Frentista', 'Conta do celular', 'Recebido em', 'Lote', 'Erro KMM'],
    ...todos.reverse().map(r => [r.id, dataHora(r.data_hora), r.placa, r.motorista, r.cpf, r.km, Number(r.litros), Number(r.encerrante_anterior),
      Number(r.encerrante), r.bomba, r.tanque, r.status, (r.problemas || []).join('; '), r.desconto_confirmado ? 'Sim' : 'Não',
      r.justificativa_desconto, r.autorizado_por, r.obs_frentista, r.obs_supervisor, r.frentistas?.nome, r.conta,
      dataHora(String(r.recebido_em).slice(0, 19)), r.lote_id, r.erro_kmm])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Abastecimentos');
  XLSX.writeFile(wb, `abastecimentos_${hojeISO()}.xlsx`);
}

// ---------- Lotes do KMM ----------
function baixarLote(id, linhas) {
  XLSX.writeFile(planilhaKMM(XLSX, linhas), `kmm_lote_${id}.xlsx`, { bookType: 'xlsx' });
}

async function lotes() {
  const r = await chamar(async () => ({
    ls: await consulta(supabase.from('lotes').select('*').order('id', { ascending: false }).limit(100)),
    prontos: await consulta(supabase.from('abastecimentos').select('id, litros').eq('status', 'Pronto')),
    emLote: await consulta(supabase.from('abastecimentos').select('id, data_hora, placa, litros, lote_id').eq('status', 'Em lote').order('data_hora')),
  }));
  if (!r) return;
  const abertos = r.ls.filter(l => l.situacao === 'Gerado');
  pagina.innerHTML = `
    <div class="bloco"><h2>Novo lote</h2>
      <p>${r.prontos.length} abastecimento(s) pronto(s), ${nf(r.prontos.reduce((s, x) => s + Number(x.litros), 0))} L.</p>
      ${r.prontos.length === 1 ? '<p class="hint">Com 1 registro só, o importador do KMM pode recusar o arquivo. Se der erro, espere ter mais um.</p>' : ''}
      <div class="acoes"><button class="btn" type="button" data-acao="gerar" ${r.prontos.length ? '' : 'disabled'}>Gerar planilha do KMM</button></div>
      <p class="hint">Depois de gerar: importe a planilha no KMM (Importação de abastecimento > Interno), confira o resultado e confirme aqui.</p>
    </div>
    ${abertos.map(l => `<div class="bloco"><h2>Lote ${l.id}: aguardando confirmação</h2>
      <p>${l.quantidade} registro(s), ${nf(l.litros)} L, gerado em ${dataHora(String(l.criado_em).slice(0, 19))}.</p>
      <div class="acoes">
        <button class="btn small" type="button" data-acao="baixar" data-lote="${l.id}">Baixar planilha</button>
        <button class="btn small" type="button" data-acao="confirmar" data-lote="${l.id}">Confirmar: importado no KMM</button>
        <button class="btn small ghost" type="button" data-acao="desfazer" data-lote="${l.id}">Desfazer (não importei)</button>
      </div>
      <p class="hint">Se o KMM recusou alguma linha, marque o erro nela antes de confirmar. Ela volta para Exceções.</p>
      <div class="tabela"><table><thead><tr><th>#</th><th>Data</th><th>Placa</th><th>Litros</th><th>Erro do KMM</th></tr></thead><tbody>
      ${r.emLote.filter(x => x.lote_id === l.id).map(x => `<tr><td class="n">${x.id}</td><td>${dataHora(x.data_hora)}</td><td>${esc(x.placa)}</td><td class="n">${nf(x.litros)}</td>
        <td><div class="inline"><input data-erro="${x.id}" placeholder="Mensagem do KMM" maxlength="1000"><button class="btn small ghost" type="button" data-acao="erro" data-id="${x.id}">Marcar erro</button></div></td></tr>`).join('')}
      </tbody></table></div></div>`).join('')}
    <div class="bloco"><h2>Histórico</h2><div class="tabela"><table><thead><tr><th>Lote</th><th>Gerado</th><th>Registros</th><th>Litros</th><th>Situação</th><th>Por</th><th></th></tr></thead><tbody>
      ${r.ls.map(l => `<tr><td class="n">${l.id}</td><td>${dataHora(String(l.criado_em).slice(0, 19))}</td><td class="n">${l.quantidade}</td><td class="n">${nf(l.litros)}</td>
        <td>${esc(l.situacao)}</td><td>${esc(l.criado_por)}</td><td><button class="btn small ghost" type="button" data-acao="baixar" data-lote="${l.id}">Planilha</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ---------- Fechamentos e chegadas ----------
async function fechamentos() {
  const r = await chamar(async () => ({
    fs: await consulta(supabase.from('fechamentos').select('*, frentistas(nome)').order('data', { ascending: false }).order('tanque').limit(200)),
    cs: await consulta(supabase.from('chegadas').select('*, frentistas(nome)').order('data_hora', { ascending: false }).limit(200)),
    ff: await contarFotos('fechamento'), fc: await contarFotos('chegada'),
  }));
  if (!r) return;
  pagina.innerHTML = `<div class="bloco"><h2>Fechamentos de tanque</h2><div class="tabela"><table><thead><tr>
      <th>Data</th><th>Tanque</th><th>Inicial</th><th>+ Chegadas</th><th>− Saídas</th><th>Esperado</th><th>Medido</th><th>Diferença</th><th>Fechado por</th><th></th></tr></thead><tbody>
    ${r.fs.map(f => `<tr class="${Math.abs(f.diferenca) > 20 ? 'divergente' : ''}"><td>${dataBR(f.data)}</td><td>${esc(f.tanque)}</td><td class="n">${nf(f.saldo_inicial, 0)}</td>
      <td class="n">${nf(f.chegadas, 0)}</td><td class="n">${nf(f.saidas, 0)}</td><td class="n">${nf(f.saldo_calculado, 0)}</td><td class="n">${nf(f.saldo_medido, 0)}</td>
      <td class="n">${nf(f.diferenca, 0)}</td><td>${esc(f.frentistas?.nome || '')}</td><td>${botaoFotos('fechamento', f.data, `Fechamento de ${dataBR(f.data)}`, r.ff[f.data])}</td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="bloco"><h2>Chegadas de diesel</h2><div class="tabela"><table><thead><tr>
      <th>Data</th><th>Tanque</th><th>NF</th><th>Litros</th><th>Valor</th><th>Régua</th><th>Caminhão</th><th>Motorista</th><th>Lançado por</th><th>Alerta</th><th></th></tr></thead><tbody>
    ${r.cs.map(c => `<tr class="${c.alerta ? 'divergente' : ''}"><td>${dataHora(c.data_hora)}</td><td>${esc(c.tanque)}</td><td>${esc(c.nf)}</td><td class="n">${nf(c.litros, 0)}</td>
      <td class="n">${c.valor_total == null ? '' : 'R$ ' + nf(c.valor_total)}</td><td class="n">${c.regua_antes == null ? '' : `${nf(c.regua_antes, 0)} → ${nf(c.regua_depois, 0)}`}</td>
      <td>${esc([c.placa_caminhao, c.placa_carreta].filter(Boolean).join(' / '))}</td><td>${esc(c.motorista || '')}</td><td>${esc(c.frentistas?.nome || '')}</td>
      <td>${esc(c.alerta || '')}</td><td>${botaoFotos('chegada', c.id, `Chegada NF ${c.nf}`, r.fc[String(c.id)])}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ---------- Frentistas ----------
async function frentistas() {
  const lista = await chamar(() => consulta(supabase.from('frentistas').select('*').order('ativo', { ascending: false }).order('nome')));
  if (!lista) return;
  pagina.innerHTML = `
    <div class="bloco"><h2>Novo frentista</h2>
      <form class="grade" data-novo-frentista>
        <div class="field"><label class="lbl">Nome</label><input name="nome" required maxlength="120"></div>
        <div class="field"><label class="lbl">PIN (4 números)</label><input name="pin" class="num" inputmode="numeric" maxlength="4" pattern="\\d{4}" required autocomplete="off"></div>
        <button class="btn small" type="submit">Cadastrar</button></form>
      <p class="hint">É com o nome e o PIN que o frentista entra no app. Passe o PIN só para ele. PINs óbvios como 1234 e 0000 são recusados.</p></div>
    <div class="bloco"><h2>Frentistas (${lista.length})</h2><div class="tabela"><table><thead><tr><th>Nome</th><th>Situação</th><th>Novo PIN</th><th></th></tr></thead><tbody>
      ${lista.map(f => `<tr>
        <td><div class="inline"><input data-nome-frentista="${f.id}" value="${esc(f.nome)}" maxlength="120"><button class="btn small ghost" type="button" data-acao="renomear" data-id="${f.id}">Salvar nome</button></div></td>
        <td>${f.ativo ? 'Ativo' : 'Desativado'}</td>
        <td><div class="inline"><input data-pin="${f.id}" class="num" inputmode="numeric" maxlength="4" placeholder="4 números" autocomplete="off"><button class="btn small ghost" type="button" data-acao="pin" data-id="${f.id}">Definir PIN</button></div></td>
        <td><div class="acoes">${botaoAtivo('frentistas', 'id', f.id, 'ativo', f.ativo)}
          <button class="btn small warn" type="button" data-acao="excluir" data-tabela="frentistas" data-chave="id" data-id="${f.id}">Excluir</button></div></td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint">Definir um PIN novo também desbloqueia o frentista depois de 5 tentativas erradas e tira ele do app em todos os celulares. Frentista com lançamentos não pode ser excluído: desative.</p></div>`;
}

// ---------- Cadastros ----------
const botaoAtivo = (tabela, chave, id, campo, ativo) =>
  `<button class="btn small ghost" type="button" data-acao="alternar" data-tabela="${tabela}" data-chave="${chave}" data-id="${esc(id)}" data-campo="${campo}" data-valor="${!ativo}">${ativo ? 'Desativar' : 'Reativar'}</button>`;
const botaoEditar = (tabela, id) => `<button class="btn small ghost" type="button" data-acao="editar" data-tabela="${tabela}" data-id="${esc(id)}">Editar</button>`;

async function cadastros() {
  const c = await chamar(async () => ({ ...(await carregarCadastros()), fv: await contarFotos('veiculo') }));
  if (!c) return;
  cad = c;
  pagina.innerHTML = `
    <div class="duas">
      <div class="bloco"><h2>Veículos (${c.veiculos.length})</h2>
        <form class="grade" data-form="veiculos">
          <div class="field"><label class="lbl">Placa</label><input name="placa" required maxlength="8"></div>
          <div class="field"><label class="lbl">Capacidade do tanque (L)</label><input name="capacidade_l" class="num" required></div>
          <div class="field"><label class="lbl">Último KM conhecido</label><input name="km_inicial" class="num"></div>
          <div class="field"><label class="lbl">Ativo</label><select name="ativo"><option value="true">Sim</option><option value="false">Não</option></select></div>
          <button class="btn small" type="submit">Salvar veículo</button></form>
        <div class="field"><label class="lbl" for="imp-veiculos">Importar CSV do KMM (placa;capacidade_tanque_l;ultimo_km)</label><input id="imp-veiculos" type="file" accept=".csv,text/csv" data-importar="veiculos"></div>
        <div class="tabela"><table><thead><tr><th>Placa</th><th>Capacidade</th><th>KM inicial</th><th>Ativo</th><th>Cadastrado por</th><th></th></tr></thead><tbody>
        ${c.veiculos.map(v => `<tr><td>${esc(v.placa)}</td><td class="n">${nf(v.capacidade_l, 0)}</td><td class="n">${nf(v.km_inicial, 0)}</td><td>${v.ativo ? 'Sim' : 'Não'}</td>
          <td class="detalhe">${esc(v.criado_por || 'Painel')}</td>
          <td><div class="acoes">${botaoEditar('veiculos', v.placa)}${botaoFotos('veiculo', v.placa, `Veículo ${v.placa}`, c.fv[v.placa])}
            <button class="btn small ghost" type="button" data-acao="foto-veiculo" data-id="${esc(v.placa)}">+ Foto</button></div></td></tr>`).join('')}</tbody></table></div></div>
      <div class="bloco"><h2>Motoristas (${c.motoristas.length})</h2>
        <form class="grade" data-form="motoristas">
          <div class="field"><label class="lbl">Nome completo</label><input name="nome" required maxlength="120"></div>
          <div class="field"><label class="lbl">CPF</label><input name="cpf" class="num" required maxlength="14"></div>
          <div class="field"><label class="lbl">Ativo</label><select name="ativo"><option value="true">Sim</option><option value="false">Não</option></select></div>
          <button class="btn small" type="submit">Salvar motorista</button></form>
        <div class="field"><label class="lbl" for="imp-motoristas">Importar CSV do KMM (nome;cpf)</label><input id="imp-motoristas" type="file" accept=".csv,text/csv" data-importar="motoristas"></div>
        <div class="tabela"><table><thead><tr><th>Nome</th><th>CPF</th><th>Ativo</th><th>Cadastrado por</th><th></th></tr></thead><tbody>
        ${c.motoristas.map(m => `<tr><td>${esc(m.nome)}</td><td>${mascaraCpf(m.cpf)}</td><td>${m.ativo ? 'Sim' : 'Não'}</td>
          <td class="detalhe">${esc(m.criado_por || 'Painel')}</td><td>${botaoEditar('motoristas', m.id)}</td></tr>`).join('')}</tbody></table></div>
        <p class="hint">Ao editar um motorista, digite o CPF completo de novo (ele aparece mascarado na lista).</p></div>
    </div>
    <div class="bloco"><h2>Tanques e bombas</h2>
      <div class="duas">
        <div><div class="tabela"><table><thead><tr><th>Tanque</th><th>Capacidade</th><th>Saldo inicial</th><th></th></tr></thead><tbody>
          ${c.tanques.map(t => `<tr><td>${esc(t.codigo)}</td><td class="n">${nf(t.capacidade_l, 0)}</td><td class="n">${nf(t.saldo_inicial, 0)}</td><td>${botaoEditar('tanques', t.codigo)}</td></tr>`).join('')}</tbody></table></div>
          <form class="grade" data-form="tanques">
            <div class="field"><label class="lbl">Código</label><input name="codigo" required maxlength="20"></div>
            <div class="field"><label class="lbl">Capacidade (L)</label><input name="capacidade_l" class="num" required></div>
            <div class="field"><label class="lbl">Saldo inicial (L)</label><input name="saldo_inicial" class="num" required></div>
            <button class="btn small" type="submit">Salvar tanque</button></form></div>
        <div><div class="tabela"><table><thead><tr><th>Bomba</th><th>Tanque</th><th>Encerrante inicial</th><th>Ativa</th><th></th></tr></thead><tbody>
          ${c.bombas.map(b => `<tr><td class="n">${b.numero}</td><td>${esc(b.tanque)}</td><td class="n">${nf(b.encerrante_inicial)}</td><td>${b.ativa ? 'Sim' : 'Não'}</td><td>${botaoEditar('bombas', b.numero)}</td></tr>`).join('')}</tbody></table></div>
          <form class="grade" data-form="bombas">
            <div class="field"><label class="lbl">Número</label><input name="numero" class="num" required></div>
            <div class="field"><label class="lbl">Tanque</label><select name="tanque">${c.tanques.map(t => `<option>${esc(t.codigo)}</option>`).join('')}</select></div>
            <div class="field"><label class="lbl">Encerrante inicial</label><input name="encerrante_inicial" class="num" required></div>
            <div class="field"><label class="lbl">Ativa</label><select name="ativa"><option value="true">Sim</option><option value="false">Não</option></select></div>
            <button class="btn small" type="submit">Salvar bomba</button></form></div>
      </div>
      <p class="hint">O saldo inicial do tanque só vale até o primeiro fechamento. Depois, cada dia começa com a medição do anterior.</p></div>`;
}

function editarCadastro(tabela, id) {
  const lista = { veiculos: cad.veiculos, motoristas: cad.motoristas, tanques: cad.tanques, bombas: cad.bombas }[tabela];
  const chave = { veiculos: 'placa', motoristas: 'id', tanques: 'codigo', bombas: 'numero' }[tabela];
  const item = lista.find(x => String(x[chave]) === String(id));
  const f = pagina.querySelector(`form[data-form="${tabela}"]`);
  if (!item || !f) return;
  for (const el of f.elements) {
    if (!el.name || !(el.name in item)) continue;
    el.value = el.name === 'cpf' ? '' : (typeof item[el.name] === 'boolean' ? String(item[el.name]) : (item[el.name] ?? ''));
  }
  if (tabela === 'motoristas') f.dataset.editandoId = item.id; else delete f.dataset.editandoId;
  f.classList.add('editando');
  f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  (f.querySelector('[name="cpf"]') || f.elements[1])?.focus();
}

// ---------- Acessos (contas Google) ----------
async function acessos() {
  const lista = await chamar(() => consulta(supabase.from('acessos').select('*').order('papel').order('nome')));
  if (!lista) return;
  const podeMexer = a => a.papel === 'posto' || (souAdmin() && a.papel === 'supervisor');
  const acoes = a => {
    if (a.papel === 'administrador') return '<span class="hint">Protegido: só o dono do projeto altera</span>';
    if (!podeMexer(a)) return '<span class="hint">Só o administrador altera</span>';
    return `<div class="acoes">${botaoAtivo('acessos', 'email', a.email, 'ativo', a.ativo)}
      <button class="btn small warn" type="button" data-acao="excluir" data-tabela="acessos" data-chave="email" data-id="${esc(a.email)}">Excluir</button></div>`;
  };
  pagina.innerHTML = `
    <div class="bloco"><h2>Liberar uma conta Google</h2>
      <p>Só as contas desta lista conseguem usar o sistema. Qualquer outra conta Google que tentar entrar não vê nada.</p>
      <form class="grade" data-form="acessos">
        <div class="field"><label class="lbl">E-mail da conta Google</label><input name="email" type="email" required></div>
        <div class="field"><label class="lbl">Nome</label><input name="nome" required maxlength="120" placeholder="Ex.: Celular posto 1"></div>
        <div class="field"><label class="lbl">Tipo</label><select name="papel"><option value="posto">Celular do posto</option>
          ${souAdmin() ? '<option value="supervisor">Supervisor (painel)</option>' : ''}</select></div>
        <div class="field"><label class="lbl">Ativo</label><select name="ativo"><option value="true">Sim</option><option value="false">Não</option></select></div>
        <button class="btn small" type="submit">Salvar</button></form>
      <p class="hint">${souAdmin() ? 'Como administrador, você libera celulares e supervisores.' : 'O supervisor libera e bloqueia celulares do posto. Supervisores são liberados pelo administrador.'}
        Administradores só são criados ou alterados pelo dono do projeto, direto no Supabase.</p></div>
    <div class="bloco"><h2>Contas liberadas</h2><div class="tabela"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Tipo</th><th>Situação</th><th></th></tr></thead><tbody>
      ${lista.map(a => `<tr><td>${esc(a.nome)}${a.email === minhaConta ? ' <span class="hint">(você)</span>' : ''}</td><td>${esc(a.email)}</td><td>${NOME_PAPEL[a.papel] || esc(a.papel)}</td>
        <td>${a.ativo ? 'Ativo' : 'Bloqueado'}</td><td>${acoes(a)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint">Celular perdido ou roubado: bloqueie ou exclua a conta dele aqui. Ele perde o acesso na hora.</p></div>`;
}

// ---------- Auditoria ----------
async function auditoria() {
  const r = await chamar(() => consulta(supabase.from('auditoria').select('*').order('id', { ascending: false }).limit(300)));
  if (!r) return;
  pagina.innerHTML = `<div class="bloco"><h2>Auditoria (últimos 300 eventos)</h2>
    <p class="hint">Registro permanente de quem fez o quê. Não pode ser alterado nem apagado.${souAdmin() ? '' : ' Ações de administradores não aparecem para supervisores.'}</p>
    <div class="tabela"><table><thead><tr><th>Quando</th><th>Conta</th><th>Papel</th><th>Ação</th><th>Item</th><th>Detalhes</th></tr></thead><tbody>
    ${r.map(a => `<tr><td>${dataHora(new Date(a.quando).toLocaleString('sv-SE').replace(' ', 'T'))}</td><td>${esc(a.conta || '–')}</td><td>${esc(NOME_PAPEL[a.papel] || a.papel || '')}</td>
      <td>${esc(a.acao)}</td><td>${esc([a.entidade, a.entidade_id].filter(Boolean).join(' '))}</td><td class="detalhe">${esc(a.detalhes ? JSON.stringify(a.detalhes) : '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ---------- Ações (cliques e formulários) ----------
pagina.addEventListener('submit', async e => {
  const f = e.target.closest('form');
  if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));

  if (f.dataset.autorizacao) {
    const aprovar = e.submitter?.dataset.decisao === 'aprovar';
    const r = await chamar(() => rpc('decidir_autorizacao', { p_id: Number(f.dataset.autorizacao), p_aprovar: aprovar, p_motivo: d.motivo.trim() }));
    if (r) { avisar(aprovar ? `#${r.id} autorizado: ficou ${r.status}.` : `#${r.id} recusado e cancelado.`, r.status === 'Exceção' ? 'warn' : 'ok'); abrir(aba); }
    return;
  }
  if (f.classList.contains('excecao')) {
    const acao = e.submitter?.dataset.acao || 'revalidar';
    const alteracoes = { data_hora: d.data_hora + ':00', placa: d.placa, motorista: d.motorista, km: num(d.km),
      litros: Number(String(d.litros).replace(',', '.')), encerrante: Number(String(d.encerrante).replace(',', '.')), bomba: Number(d.bomba) };
    const r = await chamar(() => rpc('decidir_abastecimento', { p_id: Number(f.dataset.id), p_acao: acao, p_motivo: d.obs.trim(), p_alteracoes: alteracoes }));
    if (r) { avisar(`#${r.id} ficou ${r.status}.` + (r.status === 'Exceção' ? ' Ainda há problemas: veja abaixo.' : ''), r.status === 'Exceção' ? 'warn' : 'ok'); abrir(aba); }
    return;
  }
  if (f.hasAttribute('data-novo-frentista')) {
    const novo = await chamar(() => consulta(supabase.from('frentistas').insert({ nome: d.nome.trim() }).select()));
    if (!novo) return;
    const ok = await chamar(() => rpc('definir_pin', { p_frentista_id: novo[0].id, p_pin: d.pin }));
    avisar(ok === undefined ? `${novo[0].nome} cadastrado, mas o PIN foi recusado. Defina outro PIN na lista.` : `${novo[0].nome} cadastrado.`, ok === undefined ? 'warn' : 'ok');
    return frentistas();
  }
  const tabela = f.dataset.form;
  if (!tabela) return;
  for (const k of ['capacidade_l', 'saldo_inicial', 'encerrante_inicial', 'numero', 'km_inicial']) if (k in d) d[k] = d[k] === '' ? null : num(d[k]);
  for (const k of ['ativo', 'ativa']) if (k in d) d[k] = d[k] === 'true';
  if (tabela === 'motoristas') d.nome = d.nome.trim().toUpperCase();
  if (tabela === 'acessos') d.email = d.email.trim().toLowerCase();
  let r;
  if (tabela === 'motoristas' && f.dataset.editandoId) {
    r = await chamar(() => consulta(supabase.from('motoristas').update(d).eq('id', f.dataset.editandoId).select()));
  } else {
    const conflito = { veiculos: 'placa', motoristas: 'nome', tanques: 'codigo', bombas: 'numero', acessos: 'email' }[tabela];
    r = await chamar(() => consulta(supabase.from(tabela).upsert(d, { onConflict: conflito }).select()));
  }
  if (r) { avisar('Salvo.'); abrir(aba); }
});

pagina.addEventListener('click', async e => {
  const b = e.target.closest('button[data-acao]');
  if (!b || b.type === 'submit') return;
  const { acao, lote, id, tabela, chave } = b.dataset;
  const confirmarDuasVezes = texto => {
    if (b.dataset.confirmando === '1') return true;
    b.dataset.confirmando = '1'; b.textContent = texto; return false;
  };
  if (acao === 'filtrar') {
    filtros = { de: $('fl-de').value, ate: $('fl-ate').value, status: $('fl-status').value, placa: $('fl-placa').value.trim() };
    abastecimentos();
  } else if (acao === 'exportar') {
    exportarExcel();
  } else if (acao === 'gerar') {
    const r = await chamar(() => rpc('gerar_lote'));
    if (r) { avisar(`Lote ${r.id} gerado com ${r.quantidade} registro(s). ${avisosLote(r.linhas).join(' ')}`); baixarLote(r.id, r.linhas); lotes(); }
  } else if (acao === 'baixar') {
    const linhas = await chamar(() => rpc('linhas_lote', { p_lote: Number(lote) }));
    if (linhas) baixarLote(lote, linhas);
  } else if (acao === 'confirmar' || acao === 'desfazer') {
    if (!confirmarDuasVezes(acao === 'confirmar' ? 'Clique de novo para confirmar' : 'Clique de novo para desfazer')) return;
    const r = await chamar(() => rpc('fechar_lote', { p_lote: Number(lote), p_acao: acao }));
    if (r) { avisar(`Lote ${r.id}: ${r.situacao.toLowerCase()} (${r.registros} registro(s)).`); lotes(); }
  } else if (acao === 'erro') {
    const msg = pagina.querySelector(`[data-erro="${id}"]`).value.trim();
    if (msg.length < 3) { avisar('Escreva a mensagem de erro do KMM.', 'warn'); return; }
    if (await chamar(() => rpc('marcar_erro_kmm', { p_id: Number(id), p_mensagem: msg })) !== undefined) { avisar(`#${id} marcado com erro do KMM.`); lotes(); }
  } else if (acao === 'ver-fotos') {
    verFotos(b.dataset.entidade, b.dataset.chave, b.dataset.titulo);
  } else if (acao === 'foto-veiculo') {
    const foto = await chamar(tirarFoto);
    if (!foto) return;
    const ok = await chamar(async () => { const [caminho] = await enviarFotos('veiculo', [foto]); await rpc('anexar_foto_veiculo', { p_placa: id, p_foto: caminho }); return true; });
    if (ok) { avisar(`Foto anexada ao veículo ${id}.`); cadastros(); }
  } else if (acao === 'editar') {
    editarCadastro(tabela, id);
  } else if (acao === 'pin') {
    const pin = pagina.querySelector(`[data-pin="${id}"]`).value.trim();
    if (await chamar(() => rpc('definir_pin', { p_frentista_id: Number(id), p_pin: pin })) !== undefined) { avisar('PIN definido. Passe o PIN só para o frentista.'); frentistas(); }
  } else if (acao === 'renomear') {
    const nome = pagina.querySelector(`[data-nome-frentista="${id}"]`).value.trim();
    if (await chamar(() => consulta(supabase.from('frentistas').update({ nome }).eq('id', id).select()))) { avisar('Nome atualizado.'); frentistas(); }
  } else if (acao === 'alternar') {
    const { campo, valor } = b.dataset;
    const r = await chamar(() => consulta(supabase.from(tabela).update({ [campo]: valor === 'true' }).eq(chave, id).select()));
    if (r?.length) { avisar('Atualizado.'); abrir(aba); } else if (r) avisar('Nada foi alterado.', 'warn');
  } else if (acao === 'excluir') {
    if (!confirmarDuasVezes('Clique de novo para excluir')) return;
    const r = await chamar(() => consulta(supabase.from(tabela).delete().eq(chave, id).select()));
    if (r?.length) { avisar('Excluído.'); abrir(aba); } else if (r) avisar('Nada foi excluído.', 'warn');
  }
});

// Importação de CSV do KMM, linha por linha, para mostrar exatamente quais deram erro
pagina.addEventListener('change', async e => {
  const tipo = e.target.dataset.importar;
  if (!tipo || !e.target.files[0]) return;
  const texto = (await e.target.files[0].text()).replace(/^﻿/, '');
  const [cab, ...linhas] = texto.split(/\r?\n/).filter(l => l.trim());
  const nomes = cab.split(';').map(s => s.trim().toLowerCase());
  let ok = 0; const erros = [];
  for (const [i, l] of linhas.entries()) {
    const v = Object.fromEntries(l.split(';').map((x, j) => [nomes[j], x.trim()]));
    const reg = tipo === 'veiculos'
      ? { placa: v.placa, capacidade_l: num(v.capacidade_tanque_l), km_inicial: v.ultimo_km ? Math.round(num(v.ultimo_km)) : null, ativo: true }
      : { nome: (v.nome || '').toUpperCase(), cpf: v.cpf, ativo: true };
    avisar(`Importando ${i + 1} de ${linhas.length}…`, 'info');
    const r = await supabase.from(tipo).upsert(reg, { onConflict: tipo === 'veiculos' ? 'placa' : 'nome' });
    if (r.error) erros.push(`Linha ${i + 2}: ${/check constraint/.test(r.error.message) ? (tipo === 'veiculos' ? 'placa ou capacidade inválida' : 'CPF inválido') : r.error.message}`);
    else ok++;
  }
  avisar(`${ok} importado(s).` + (erros.length ? ` ${erros.length} com erro: ${erros.slice(0, 20).join(' | ')}` : ''), erros.length ? 'warn' : 'ok');
  if (!erros.length) cadastros();
});

supabase.auth.onAuthStateChange(evento => { if (evento === 'SIGNED_IN' || evento === 'SIGNED_OUT') iniciar(); });
iniciar();
