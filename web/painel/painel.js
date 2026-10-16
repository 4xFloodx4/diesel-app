// Painel do supervisor e do administrador (no computador e no celular).
// Leituras vão direto às tabelas (o RLS só libera para quem é supervisor ou administrador);
// ações sensíveis passam pelas funções do banco, que conferem tudo de novo.
import * as XLSX from 'xlsx';
import { supabase, rpc, consulta, contaAtual, entrarComGoogle, sair, nativo, aoVoltarDoLogin } from '../comum/supa.js';
import { esc, nf, parseNum, dataBR, dataHora, hojeISO, classeStatus, ler, gravar } from '../comum/util.js';
import { planilhaKMM, avisosLote } from '../comum/kmm.js';
import { tirarFoto, enviarFotos, linksDasFotos } from '../comum/fotos.js';
import { aplicarTema, definirTema, htmlTema, demoLigado, alternarDemo, htmlChaveDemo, htmlFaixaDemo, protegerContraMoldura } from '../comum/tema.js';
import { htmlGuia, htmlAbasGuia } from '../comum/guia.js';
import { htmlAuditoria, htmlFiltroAud, descrever } from '../comum/auditoria.js';
import { prepararAtualizacao } from '../comum/atualizacao.js';
import { dadosDemo } from './demo.js';

protegerContraMoldura();
aplicarTema();

// No APK o app do frentista fica na raiz; no site, em /app/
const URL_APP = __ALVO__ === 'android' ? '../index.html' : '../app/';
const $ = id => document.getElementById(id);
const trabalho = $('trabalho');
const NOME_PAPEL = { posto: 'Celular do posto', supervisor: 'Supervisor', administrador: 'Administrador' };
const STATUS_DECISAO = ['Aguardando autorização', 'Exceção', 'Erro'];
const TODOS_STATUS = ['Aguardando autorização', 'Pronto', 'Exceção', 'Em lote', 'Lançado', 'Erro', 'Cancelado'];

const est = {
  papel: null, conta: null, nome: '', tela: ler('painel-tela', 'resumo'), sel: null,
  filtros: { de: '', ate: '', status: '', placa: '' }, aud: { filtro: 'todos', busca: '', eventos: [], ctx: {} },
  guia: 'supervisor', turno: { abertura: '05:00', fechamento: '23:00' }, cad: null, carregando: 0,
};
const souAdmin = () => est.papel === 'administrador';
const demo = () => souAdmin() && demoLigado();
const pill = s => `<span class="pill ${esc(classeStatus(s))}">${esc(s)}</span>`;
const placa = p => `<span class="placa">${esc(p)}</span>`;
const mascaraCpf = c => c ? `***.***.${esc(c.slice(6, 9))}-${esc(c.slice(9))}` : '';
const soDigitos = v => String(v ?? '').replace(/\D/g, '');
const soPlaca = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hora = iso => String(iso || '').slice(11, 16);
const quandoLocal = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '') : '';
const primeiroNome = n => String(n || '').split(' ')[0];

// ---------- Avisos ----------
function avisar(texto, tipo = 'ok') {
  const caixa = $('aviso');
  if (!texto) { caixa.innerHTML = ''; return; }
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.setAttribute('role', tipo === 'warn' ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(texto)}</span><button type="button" aria-label="Fechar aviso">×</button>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  caixa.replaceChildren(el);
  setTimeout(() => el.remove(), tipo === 'warn' ? 12000 : 6000);
}

async function chamar(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.semAcesso) { await mostrarLogin(e.message); return undefined; }
    avisar(e.message, 'warn');
    return undefined;
  }
}
// Ações que gravam: bloqueadas no modo demonstração
async function agir(fn) {
  if (demo()) { avisar('Modo demonstração: nada foi gravado.', 'info'); return undefined; }
  return chamar(fn);
}
const carregar = (real, ficticio) => demo() ? Promise.resolve(ficticio(dadosDemo())) : chamar(real);

// ---------- Login ----------
async function mostrarLogin(msg) {
  est.papel = null;
  $('app').classList.add('sem-menu');
  $('lado').innerHTML = '';
  const conta = await contaAtual();
  trabalho.innerHTML = `<div class="entrada"><div class="cartao">
    <div class="marca marca-entrada">${LOGO}<div><b>Diesel</b><span>Painel do supervisor</span></div></div>
    <h1>${conta ? 'Conta sem acesso ao painel' : 'Entrar no painel'}</h1>
    ${conta ? `<p>Conectado como <b>${esc(conta)}</b>.</p>` : '<p>Entre com a sua conta Google de supervisor ou administrador.</p>'}
    ${msg ? `<div class="toast warn">${esc(msg)}</div>` : ''}
    <button class="btn" type="button" id="google">${conta ? 'Entrar com outra conta' : 'Entrar com Google'}</button></div>
    ${htmlTema()}</div>`;
  $('google').addEventListener('click', async () => {
    if (conta) await sair();
    try { await entrarComGoogle(); } catch (e) { mostrarLogin(e.message); }
  });
}

let iniciando = null;
const iniciar = () => (iniciando ||= iniciarAgora().finally(() => { iniciando = null; }));
async function iniciarAgora() {
  const conta = await contaAtual();
  if (!conta) return mostrarLogin('');
  const papel = await chamar(() => rpc('meu_papel'));
  if (papel === undefined) return;
  if (papel === 'posto') {
    if (nativo) { location.replace(URL_APP); return; }
    return mostrarLogin('Esta conta é de um celular do posto. Ela usa o app do frentista, não o painel.');
  }
  if (papel !== 'supervisor' && papel !== 'administrador') return mostrarLogin('Esta conta não está liberada. Peça ao administrador.');
  est.papel = papel; est.conta = conta;
  const eu = await chamar(() => consulta(supabase.from('acessos').select('nome').eq('email', conta).maybeSingle()));
  est.nome = eu?.nome || conta;
  const cfg = await chamar(() => consulta(supabase.from('configuracoes').select('abertura, fechamento').eq('id', 1).maybeSingle()));
  if (cfg) est.turno = { abertura: String(cfg.abertura).slice(0, 5), fechamento: String(cfg.fechamento).slice(0, 5) };
  $('app').classList.remove('sem-menu');
  if (!MENU.some(([, itens]) => itens.some(i => i[0] === est.tela && (!i[3] || souAdmin())))) est.tela = 'resumo';
  montarMenu();
  abrir(est.tela);
}

// ---------- Menu lateral ----------
const svg = d => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const LOGO = `<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="30" rx="7" fill="#b86a07"/>
  <rect x="8" y="6.5" width="10.5" height="17" rx="1.6" fill="#fff"/><rect x="9.8" y="8.6" width="6.9" height="4.4" rx=".8" fill="#b86a07"/>
  <path d="M18.5 17.5h3.4V10" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/><rect x="6.6" y="22.6" width="13.4" height="1.9" rx=".9" fill="#fff"/></svg>`;
const IC = {
  grade: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  lista: '<path d="M2 4h12M2 8h8M2 12h5"/>', doc: '<path d="M3 2h10v12H3zM6 5h4M6 8h4M6 11h2"/>', gota: '<path d="M8 2s4 4.6 4 7.5a4 4 0 0 1-8 0C4 6.6 8 2 8 2z"/>',
  kmm: '<path d="M3 3h10v3H3zM3 8h10v5H3z"/>', pessoa: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/>',
  caminhao: '<path d="M1.5 10.5V6h8v4.5M9.5 7.5h3l2 2v1h-5"/><circle cx="4.5" cy="11.5" r="1.5"/><circle cx="12" cy="11.5" r="1.5"/>',
  cadeado: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>', historico: '<path d="M8 3v5l3 2"/><circle cx="8" cy="8" r="6"/>',
  turno: '<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/><circle cx="8" cy="8" r="3"/>',
  ajuda: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3M8 11.4v.1"/>',
};
// [id, rótulo, ícone, só administrador]
const MENU = [
  ['Operação', [['resumo', 'Visão do dia', 'grade'], ['decisoes', 'Decisões', 'lista'], ['abastecimentos', 'Abastecimentos', 'doc'], ['tanques', 'Tanques e fechamentos', 'gota']]],
  ['KMM', [['lotes', 'Lotes', 'kmm']]],
  ['Cadastros', [['frentistas', 'Frentistas', 'pessoa'], ['veiculos', 'Veículos e motoristas', 'caminhao']]],
  ['Sistema', [['acessos', 'Acessos', 'cadeado'], ['auditoria', 'Auditoria', 'historico'], ['turno', 'Horário do turno', 'turno', true]]],
  ['Ajuda', [['guia', 'Guia de uso', 'ajuda']]],
];
const TITULO = Object.fromEntries(MENU.flatMap(([, itens]) => itens.map(i => [i[0], i[1]])));

function montarMenu() {
  $('lado').innerHTML = `<div class="marca">${LOGO}<div><b>Diesel</b><span>Posto interno</span></div></div>
    ${MENU.map(([grupo, itens]) => `<div class="grupo"><h4>${grupo}</h4>${itens.filter(i => !i[3] || souAdmin()).map(([id, rot, ic]) =>
      `<button type="button" class="item" data-tela="${id}">${svg(IC[ic])}${rot}<span class="qtd num" data-qtd="${id}" hidden></span></button>`).join('')}</div>`).join('')}
    <div class="conta"><div><b>${esc(est.nome)}</b>${NOME_PAPEL[est.papel]}${est.nome !== est.conta ? `<br>${esc(est.conta)}` : ''}</div>
      <div class="ajustes"><span class="rot">Tema</span>${htmlTema()}${souAdmin() ? htmlChaveDemo() : ''}</div>
      <button type="button" class="sair" id="sair">Sair da conta</button></div>`;
  marcarMenu();
}
function marcarMenu() {
  document.querySelectorAll('.item').forEach(b => b.toggleAttribute('aria-current', false));
  document.querySelector(`.item[data-tela="${est.tela}"]`)?.setAttribute('aria-current', 'page');
  $('titulo-movel').textContent = TITULO[est.tela] || 'Diesel';
}

async function atualizarContadores() {
  const r = await (demo()
    ? Promise.resolve(dadosDemo().porStatus)
    : Promise.all([...STATUS_DECISAO, 'Pronto'].map(s => supabase.from('abastecimentos').select('id', { count: 'exact', head: true }).eq('status', s)))
      .then(rs => Object.fromEntries(rs.map((x, i) => [[...STATUS_DECISAO, 'Pronto'][i], x.count || 0]))).catch(() => null));
  if (!r) return;
  const dec = STATUS_DECISAO.reduce((s, k) => s + (r[k] || 0), 0);
  const marcar = (id, n, vermelho) => { const el = document.querySelector(`[data-qtd="${id}"]`); if (!el) return; el.hidden = !n; el.textContent = n; el.classList.toggle('vermelho', !!vermelho); };
  marcar('decisoes', dec, true); marcar('lotes', r.Pronto || 0);
  $('badge-menu').hidden = !dec; $('badge-menu').textContent = dec;
}

const TELAS = {};
async function abrir(nome, opcoes = {}) {
  est.tela = TELAS[nome] ? nome : 'resumo';
  gravar('painel-tela', est.tela);
  if (!opcoes.manterSelecao) est.sel = null;
  marcarMenu();
  const minha = ++est.carregando;
  if (!opcoes.semCarregando) trabalho.innerHTML = `${htmlFaixaDemo()}<p class="hint">Carregando…</p>`;
  const html = await TELAS[est.tela]();
  if (minha !== est.carregando || html === undefined) return;   // outra tela foi aberta no meio do caminho
  trabalho.innerHTML = (est.tela === 'guia' ? '' : htmlFaixaDemo()) + html;
  estilizar(trabalho);
  atualizarContadores();
}
function estilizar(raiz) {
  for (const el of raiz.querySelectorAll('[data-css]')) {
    for (const decl of el.dataset.css.split(';')) { const [prop, valor] = decl.split(':'); if (prop && valor) el.style.setProperty(prop.trim(), valor.trim()); }
  }
}
const cabeca = (titulo, sub, acoes = '') => `<div class="cabeca"><div><h1>${titulo}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${acoes ? `<div class="acoes">${acoes}</div>` : ''}</div>`;
const soComputador = texto => `<div class="somente-leitura">${texto}</div>`;

// ---------- Visão do dia ----------
function tanqueHtml(t) {
  const calc = Number(t.saldo_calculado), cap = Number(t.capacidade_l) || 1;
  const pct = Math.max(0, Math.min(100, Math.round(calc / cap * 100)));
  const med = t.fechado ? Number(t.fechado.saldo_medido) : null;
  const dif = t.fechado ? Number(t.fechado.diferenca) : null;
  const ticks = [25, 50, 75].map(p => `<i data-css="bottom:${p}%"></i>`).join('');
  const linhaMed = med === null ? '' : `<div class="medido" data-css="bottom:${Math.max(0, Math.min(100, med / cap * 100))}%"></div>`;
  const chip = med === null ? '<span class="chip neutro">Aguardando medição da régua</span>'
    : `<span class="chip ${Math.abs(dif) > 20 ? 'alerta' : 'ok'}">Régua ${nf(med, 0)} L · diferença ${dif > 0 ? '+' : ''}${nf(dif, 0)} L</span>`;
  return `<div class="tanque">
    <div class="cilindro" role="img" aria-label="${esc(t.tanque)} com ${nf(calc, 0)} litros esperados de ${nf(cap, 0)} (${pct}%)">${ticks}<div class="nivel" data-css="height:${pct}%"></div>${linhaMed}</div>
    <dl><div class="nome"><b>${esc(t.tanque)}</b><span>${pct}%</span></div>
      <dt>Saldo inicial</dt><dd>${nf(t.saldo_inicial, 0)}</dd><dt>+ Chegadas</dt><dd>${nf(t.chegadas, 0)}</dd>
      <dt>− Saídas</dt><dd>${nf(t.saidas, 0)}</dd><dt class="total">Esperado</dt><dd class="total">${nf(calc, 0)} L</dd>
      <dt>Capacidade</dt><dd>${nf(cap, 0)} L</dd><div class="dif">${chip}</div></dl></div>`;
}

function tipoDecisao(r) {
  if (r.status === 'Aguardando autorização') {
    const chips = [];
    if (!r.desconto_confirmado) chips.push(['pend', 'Sem desconto']);
    if (r.fora_horario) chips.push(['hora', 'Fora do horário']);
    if (!chips.length) chips.push(['pend', 'Autorização']);
    return { tarja: r.desconto_confirmado && r.fora_horario ? 'hora' : 'pend', chips,
      texto: r.justificativa_desconto || r.justificativa_horario || '', citar: true };
  }
  return { tarja: 'alerta', chips: [['alerta', r.status === 'Erro' ? 'Erro do KMM' : 'Exceção']],
    texto: r.erro_kmm ? `KMM: ${r.erro_kmm}` : (r.problemas || [])[0] || '', citar: false };
}
function caixaHtml(lista, selecionado) {
  if (!lista.length) return '<p class="vazio">Nada esperando por você. Tudo em dia.</p>';
  return `<ul class="caixa">${lista.map(r => {
    const t = tipoDecisao(r);
    return `<li data-decisao="${r.id}" tabindex="0" ${selecionado !== undefined ? `aria-selected="${r.id === selecionado}"` : ''}>
      <span class="tarja ${t.tarja}"></span>
      <div><div class="linha1">${placa(r.placa)}${t.chips.map(([c, n]) => `<span class="chip ${c}">${n}</span>`).join('')}
        <span class="meta">${esc(r.motorista)} · ${nf(r.litros)} L · bomba ${esc(r.bomba)}</span></div>
        ${t.texto ? `<p>${t.citar ? `<q>${esc(t.texto)}</q>` : esc(t.texto)}</p>` : ''}</div>
      <div class="quando">${r.data_hora.slice(0, 10) === hojeISO() ? hora(r.data_hora) : dataBR(r.data_hora).slice(0, 5)}<br>${esc(primeiroNome(r.frentistas?.nome))}</div></li>`;
  }).join('')}</ul>`;
}

const passoBonito = v => { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 5, 10].map(m => m * p).find(s => s >= v); };
function graficoHoras(abHoje) {
  const porHora = {};
  for (const a of abHoje) if (a.status !== 'Cancelado') { const h = Number(hora(a.data_hora).slice(0, 2)); porHora[h] = (porHora[h] || 0) + Number(a.litros); }
  const hAb = Number(est.turno.abertura.slice(0, 2)), hFe = Number(est.turno.fechamento.slice(0, 2));
  const comDados = Object.keys(porHora).map(Number);
  const agora = new Date().getHours();
  let ini = Math.min(hAb, ...comDados), fim = Math.max(hFe <= hAb ? 23 : hFe - 1, ...comDados);
  if (hFe <= hAb) { ini = 0; fim = 23; }   // turno que vira a meia-noite: mostra o dia todo
  const horas = Array.from({ length: fim - ini + 1 }, (_, i) => ini + i);
  const max = Math.max(1, ...Object.values(porHora));
  const passo = passoBonito(max / 3), maxY = passo * Math.ceil(max / passo);
  const estreito = innerWidth < 760;
  const W = estreito ? 380 : 1100, H = estreito ? 200 : 170, ml = estreito ? 34 : 40, mb = 22, mt = 8;
  const larg = (W - ml) / horas.length, bw = Math.max(4, Math.min(34, larg - (estreito ? 6 : 10)));
  const y = v => mt + (H - mt - mb) * (1 - v / maxY);
  const grid = Array.from({ length: Math.round(maxY / passo) + 1 }, (_, i) => i * passo)
    .map(v => `<line class="${v ? 'grid' : 'base'}" x1="${ml}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${ml - 6}" y="${y(v) + 3.5}" text-anchor="end">${nf(v, 0)}</text>`).join('');
  const cada = horas.length > 12 && estreito ? 3 : horas.length > 18 ? 2 : 1;
  const barras = horas.map((h, i) => {
    const v = porHora[h] || 0, x = ml + i * larg + (larg - bw) / 2, topo = y(v), alt = y(0) - topo, r = Math.min(4, alt / 2);
    const forma = v ? `<path class="barra${h === agora ? ' agora' : ''}" d="M${x},${y(0)} V${topo + r} Q${x},${topo} ${x + r},${topo} H${x + bw - r} Q${x + bw},${topo} ${x + bw},${topo + r} V${y(0)} Z"/>` : '';
    const rot = (h - ini) % cada === 0 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${String(h).padStart(2, '0')}h</text>` : '';
    return `${forma}${rot}<rect class="alvo" x="${ml + i * larg}" y="${mt}" width="${larg}" height="${H - mt - mb}" data-h="${h}" data-v="${v}" data-x="${x + bw / 2}" data-y="${v ? topo : y(0)}"/>`;
  }).join('');
  const total = Object.values(porHora).reduce((a, b) => a + b, 0);
  return `<div class="grafico"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Litros lançados por hora hoje: ${nf(total, 0)} litros no total">${grid}${barras}</svg>
    <div class="dica-graf" hidden></div></div>`;
}
function tabelaLancamentos(lista) {
  if (!lista.length) return '<p class="vazio">Nenhum lançamento.</p>';
  return `<div class="tabela"><table><thead><tr><th>Nº</th><th>Data</th><th>Veículo</th><th class="n">KM</th><th class="n">Litros</th><th class="n">Bomba</th><th>Desconto</th><th>Frentista</th><th>Situação</th></tr></thead><tbody>
    ${lista.map(r => `<tr><td class="n">#${esc(r.id)}</td><td class="num">${r.data_hora.slice(0, 10) === hojeISO() ? hora(r.data_hora) : dataHora(r.data_hora)}</td>
      <td>${placa(r.placa)}<span class="sub">${esc(r.motorista)}</span></td><td class="n">${nf(r.km, 0)}</td><td class="n">${nf(r.litros)}</td><td class="n">${esc(r.bomba)}</td>
      <td>${r.desconto_confirmado ? 'Sim' : '<b>Não</b>'}${r.fora_horario ? '<span class="sub">fora do horário</span>' : ''}</td><td>${esc(r.frentistas?.nome || '')}</td>
      <td>${pill(r.status)}${r.problemas?.length ? `<span class="sub">${esc(r.problemas.join(' '))}</span>` : ''}</td></tr>`).join('')}
  </tbody></table></div>`;
}

TELAS.resumo = async () => {
  const r = await carregar(async () => {
    const [hoje, abHoje, pend, prontos, ultLote, bombas, af] = await Promise.all([
      rpc('calcular_fechamento', { p_dia: hojeISO() }),
      consulta(supabase.from('abastecimentos').select('id, data_hora, placa, motorista, km, litros, bomba, status, problemas, desconto_confirmado, fora_horario, frentistas(nome)')
        .gte('data_hora', hojeISO()).order('data_hora', { ascending: false }).limit(2000)),
      consulta(supabase.from('abastecimentos').select('*, frentistas(nome)').in('status', STATUS_DECISAO).order('data_hora', { ascending: false }).limit(200)),
      consulta(supabase.from('abastecimentos').select('litros').eq('status', 'Pronto').limit(10000)),
      consulta(supabase.from('lotes').select('*').order('id', { ascending: false }).limit(1)),
      consulta(supabase.from('bombas').select('numero').eq('ativa', true).order('numero')),
      consulta(supabase.from('afericoes').select('bomba, data_hora').order('data_hora', { ascending: false }).limit(500)),
    ]);
    return { hoje, abHoje, pend, prontos, ultLote: ultLote[0], bombas, af };
  }, d => ({ hoje: d.hoje, abHoje: d.abastecimentos.filter(a => a.data_hora.startsWith(hojeISO())), pend: d.abastecimentos.filter(a => STATUS_DECISAO.includes(a.status)),
    prontos: d.abastecimentos.filter(a => a.status === 'Pronto'), ultLote: d.lotes.find(l => l.situacao === 'Confirmado'),
    bombas: d.bombas.filter(b => b.ativa), af: d.afericoes }));
  if (!r) return;
  const saida = r.hoje.reduce((s, t) => s + Number(t.saidas), 0);
  const nAut = r.pend.filter(a => a.status === 'Aguardando autorização').length;
  const fechado = r.hoje.length && r.hoje.every(t => t.fechado);
  const l = r.ultLote;
  const validos = r.abHoje.filter(a => a.status !== 'Cancelado');
  return `${cabeca('Visão do dia', `${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })} · atualizado às ${new Date().toTimeString().slice(0, 5)}`,
      `<button class="btn small ghost" type="button" data-acao="recarregar">Atualizar</button>${nativo ? '' : '<button class="btn small" type="button" data-ir="lotes">Gerar lote do KMM</button>'}`)}
    <section class="faixa" aria-label="Situação de hoje">
      <div><small>Saída hoje</small><b class="num">${nf(saida, 0)} L</b><em>${validos.length} abastecimento(s)</em></div>
      <div class="${r.pend.length ? 'precisa' : ''}"><small>Precisa de você</small><b class="num">${r.pend.length}</b><em>${nAut} autorização(ões) · ${r.pend.length - nAut} exceção(ões)</em></div>
      <div><small>Prontos para o KMM</small><b class="num">${r.prontos.length}</b><em>${nf(r.prontos.reduce((s, x) => s + Number(x.litros), 0), 0)} L no próximo lote</em></div>
      <div><small>Último lote</small><b class="num">${l ? `lote ${esc(l.id)}` : '—'}</b><em>${l ? `${esc(l.situacao.toLowerCase())} · ${quandoLocal(l.fechado_em || l.criado_em)}` : 'nenhum lote ainda'}</em></div>
      <div><small>Fechamento</small><b class="num">${fechado ? 'fechado' : 'aberto'}</b><em>turno ${esc(est.turno.abertura)}–${esc(est.turno.fechamento)}</em></div>
    </section>
    ${r.bombas.length ? `<section class="painel"><header><h2>Aferição das bombas</h2><span>1 vez por semana · <button class="link" type="button" data-ir="tanques">ver aferições</button></span></header>
      <div class="corpo">${r.bombas.map(b => `<b>Bomba ${esc(b.numero)}</b> ${chipAfericao(ultimaAfericao(r.af, b.numero))}`).join(' &nbsp; ')}</div></section>` : ''}
    <div class="grade">
      <section class="painel"><header><h2>Tanques</h2><span>esperado = inicial + chegadas − saídas</span></header>
        <div class="corpo">${r.hoje.length ? `<div class="tanques">${r.hoje.map(tanqueHtml).join('')}</div>` : '<p class="hint">Nenhum tanque cadastrado. Cadastre em Tanques e fechamentos.</p>'}</div></section>
      <section class="painel"><header><h2>Precisa de você</h2><span><button class="link" type="button" data-ir="decisoes">ver todas</button></span></header>
        ${caixaHtml(r.pend.slice(0, 5))}</section>
    </div>
    <section class="painel"><header><h2>Saída por hora</h2><span>litros lançados hoje · hora atual em tom claro</span></header>
      <div class="corpo">${graficoHoras(r.abHoje)}</div></section>
    <section class="painel"><header><h2>Últimos lançamentos</h2><span>${Math.min(8, r.abHoje.length)} de ${r.abHoje.length} hoje · <button class="link" type="button" data-ir="abastecimentos">ver todos</button></span></header>
      ${tabelaLancamentos(r.abHoje.slice(0, 8))}</section>`;
};

// ---------- Decisões (autorizações e exceções) ----------
async function carregarCadastros() {
  const [veiculos, motoristas, bombas, tanques, frentistas] = await Promise.all([
    consulta(supabase.from('veiculos').select('*').order('placa')),
    consulta(supabase.from('motoristas').select('*').order('nome')),
    consulta(supabase.from('bombas').select('*').order('numero')),
    consulta(supabase.from('tanques').select('*').order('codigo')),
    consulta(supabase.from('frentistas').select('*').order('ativo', { ascending: false }).order('nome')),
  ]);
  return { veiculos, motoristas, bombas, tanques, frentistas };
}
const cadDemo = d => ({ veiculos: d.veiculos, motoristas: d.motoristas, bombas: d.bombas, tanques: d.tanques, frentistas: d.frentistas });

TELAS.decisoes = async () => {
  const r = await carregar(async () => ({
    lista: await consulta(supabase.from('abastecimentos').select('*, frentistas(nome)').in('status', STATUS_DECISAO).order('data_hora').limit(300)),
    cad: await carregarCadastros(),
  }), d => ({ lista: d.abastecimentos.filter(a => STATUS_DECISAO.includes(a.status)).reverse(), cad: cadDemo(d) }));
  if (!r) return;
  est.cad = r.cad;
  // Autorizações primeiro (o frentista pode estar esperando), depois exceções, do mais antigo para o mais novo
  const lista = [...r.lista.filter(a => a.status === 'Aguardando autorização'), ...r.lista.filter(a => a.status !== 'Aguardando autorização')];
  if (!lista.some(a => a.id === est.sel)) est.sel = lista[0]?.id ?? null;
  const sel = lista.find(a => a.id === est.sel);
  return `${cabeca('Decisões', 'Autorizações (sem desconto ou fora do horário) e exceções das conferências. Toda decisão pede um motivo e fica na auditoria.')}
    <div class="dividido">
      <section class="painel"><header><h2>Fila</h2><span>${lista.length} pendente(s)</span></header>${caixaHtml(lista, est.sel)}</section>
      ${sel ? `<section class="painel" id="detalhe-decisao">${detalheDecisao(sel)}</section>` : ''}
    </div>`;
};

function detalheDecisao(r) {
  const t = tipoDecisao(r), aut = r.status === 'Aguardando autorização', c = est.cad;
  const opc = (lista, atual) => lista.map(v => `<option ${v === atual ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const placas = c.veiculos.map(v => v.placa), nomes = c.motoristas.map(m => m.nome);
  const citacoes = [
    !r.desconto_confirmado && r.justificativa_desconto ? ['pend', 'Por que não foi descontado do motorista (frentista)', esc(r.justificativa_desconto)] : null,
    r.fora_horario ? ['hora', `Lançado fora do horário do turno (${esc(est.turno.abertura)}–${esc(est.turno.fechamento)})`, esc(r.justificativa_horario || 'Sem justificativa')] : null,
    r.problemas?.length ? ['alerta', aut ? 'Depois de autorizado, ainda vai para conferência por causa de' : 'O que a conferência encontrou', `<ul>${r.problemas.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`] : null,
    r.erro_kmm ? ['alerta', 'Erro informado pelo KMM', esc(r.erro_kmm)] : null,
    r.obs_frentista ? ['pend', 'Observação do frentista', esc(r.obs_frentista)] : null,
  ].filter(Boolean);
  return `<form class="detalhe" data-decidir="${esc(r.id)}" data-tipo="${aut ? 'autorizacao' : 'excecao'}">
    <div class="acoes">${`<h2>${esc(r.placa)}</h2>`}${t.chips.map(([k, n]) => `<span class="chip ${k}">${n}</span>`).join('')}<span class="hint">#${esc(r.id)}</span></div>
    <div class="ficha">
      <div><small>Motorista</small><b class="txt">${esc(r.motorista)}</b></div><div><small>Litros</small><b>${nf(r.litros)}</b></div>
      <div><small>KM</small><b>${nf(r.km, 0)}</b></div><div><small>Bomba</small><b>${esc(r.bomba)}</b></div>
      <div><small>Encerrante anterior</small><b>${nf(r.encerrante_anterior, 3)}</b></div><div><small>Encerrante final</small><b>${nf(r.encerrante, 3)}</b></div>
      <div><small>Data e hora</small><b>${dataHora(r.data_hora)}</b></div><div><small>Frentista</small><b class="txt">${esc(r.frentistas?.nome || '')}</b></div>
    </div>
    ${citacoes.map(([k, rot, txt]) => `<div class="citacao ${k}"><small>${rot}</small>${txt}</div>`).join('')}
    ${aut ? '' : `<div class="formulario">
      <div class="field"><label class="lbl" for="d-data">Data e hora</label><input id="d-data" name="data_hora" type="datetime-local" value="${esc(String(r.data_hora).slice(0, 16))}"></div>
      <div class="field"><label class="lbl" for="d-placa">Placa</label><select id="d-placa" name="placa">${opc(placas, r.placa)}${placas.includes(r.placa) ? '' : `<option selected>${esc(r.placa)}</option>`}</select></div>
      <div class="field"><label class="lbl" for="d-mot">Motorista</label><select id="d-mot" name="motorista">${opc(nomes, r.motorista)}${nomes.includes(r.motorista) ? '' : `<option selected>${esc(r.motorista)}</option>`}</select></div>
      <div class="field"><label class="lbl" for="d-km">KM</label><input id="d-km" name="km" class="num" inputmode="numeric" value="${esc(r.km)}"></div>
      <div class="field"><label class="lbl" for="d-lt">Litros</label><input id="d-lt" name="litros" class="num" inputmode="decimal" value="${esc(Number(r.litros))}"></div>
      <div class="field"><label class="lbl" for="d-enc">Encerrante final</label><input id="d-enc" name="encerrante" class="num" inputmode="decimal" value="${esc(Number(r.encerrante))}"></div>
      <div class="field"><label class="lbl" for="d-bomba">Bomba</label><select id="d-bomba" name="bomba">${c.bombas.map(b => `<option value="${esc(b.numero)}" ${b.numero === r.bomba ? 'selected' : ''}>${esc(b.numero)} (${esc(b.tanque)})</option>`).join('')}</select></div>
    </div>`}
    <div class="field"><label class="lbl" for="d-motivo">Motivo da decisão (obrigatório, fica no histórico)</label>
      <textarea id="d-motivo" name="motivo" rows="2" maxlength="500" required minlength="5" placeholder="${aut ? 'Ex.: desconto será feito no acerto de 30/10' : 'Ex.: visor da bomba 3 com defeito; vale o encerrante'}"></textarea></div>
    <div class="acoes">${aut
      ? '<button class="btn" type="submit" data-decisao="aprovar">Autorizar lançamento</button><button class="btn ghost" type="submit" data-decisao="recusar">Recusar (cancela)</button>'
      : '<button class="btn" type="submit" data-decisao="revalidar">Corrigir e conferir de novo</button><button class="btn ghost" type="submit" data-decisao="aprovar">Aprovar mesmo assim</button><button class="btn warn" type="submit" data-decisao="cancelar">Cancelar abastecimento</button>'}</div>
  </form>`;
}

async function decidir(f, decisao) {
  const id = Number(f.dataset.decidir), motivo = f.elements.motivo.value.trim();
  if (motivo.length < 5) { avisar('Escreva o motivo da decisão (pelo menos 5 letras).', 'warn'); f.elements.motivo.focus(); return; }
  let r;
  if (f.dataset.tipo === 'autorizacao') {
    r = await agir(() => rpc('decidir_autorizacao', { p_id: id, p_aprovar: decisao === 'aprovar', p_motivo: motivo }));
    if (r) avisar(decisao === 'aprovar' ? `#${r.id} autorizado: ficou ${r.status}.` : `#${r.id} recusado e cancelado.`, r.status === 'Exceção' ? 'warn' : 'ok');
  } else {
    const v = f.elements;
    const alteracoes = { data_hora: v.data_hora.value ? `${v.data_hora.value}:00` : undefined, placa: v.placa.value, motorista: v.motorista.value,
      km: Number(soDigitos(v.km.value)), litros: parseNum(v.litros.value), encerrante: parseNum(v.encerrante.value), bomba: Number(v.bomba.value) };
    if (!(alteracoes.km > 0) || !(alteracoes.litros > 0) || !(alteracoes.encerrante > 0)) { avisar('Confira KM, litros e encerrante.', 'warn'); return; }
    r = await agir(() => rpc('decidir_abastecimento', { p_id: id, p_acao: decisao, p_motivo: motivo, p_alteracoes: alteracoes }));
    if (r) avisar(`#${r.id} ficou ${r.status}.${r.status === 'Exceção' ? ' Ainda há problemas: veja a lista.' : ''}`, r.status === 'Exceção' ? 'warn' : 'ok');
  }
  if (r) abrir('decisoes', { manterSelecao: r.status === 'Exceção', semCarregando: true });
}

// ---------- Abastecimentos ----------
function consultaAbastecimentos() {
  const fl = est.filtros;
  let q = supabase.from('abastecimentos').select('*, frentistas(nome)').order('data_hora', { ascending: false });
  if (fl.status) q = q.eq('status', fl.status);
  if (fl.de) q = q.gte('data_hora', fl.de);
  if (fl.ate) q = q.lt('data_hora', new Date(new Date(`${fl.ate}T12:00:00`).getTime() + 86400000).toLocaleDateString('sv-SE'));
  if (fl.placa) q = q.eq('placa', fl.placa.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return q;
}
const filtrarDemo = lista => lista.filter(a => (!est.filtros.status || a.status === est.filtros.status)
  && (!est.filtros.placa || a.placa === est.filtros.placa.toUpperCase().replace(/[^A-Z0-9]/g, ''))
  && (!est.filtros.de || a.data_hora >= est.filtros.de) && (!est.filtros.ate || a.data_hora.slice(0, 10) <= est.filtros.ate));

TELAS.abastecimentos = async () => {
  const lista = await carregar(() => consulta(consultaAbastecimentos().limit(1000)), d => filtrarDemo(d.abastecimentos));
  if (!lista) return;
  const fl = est.filtros;
  return `${cabeca('Abastecimentos', 'Todos os lançamentos, com filtro por data, situação e placa.', nativo ? '' : '<button class="btn small ghost" type="button" data-acao="exportar">Exportar para Excel</button>')}
    <section class="painel">
      <form class="filtros" data-filtros>
        <div class="field"><label class="lbl" for="fl-de">De</label><input id="fl-de" name="de" type="date" value="${esc(fl.de)}"></div>
        <div class="field"><label class="lbl" for="fl-ate">Até</label><input id="fl-ate" name="ate" type="date" value="${esc(fl.ate)}"></div>
        <div class="field"><label class="lbl" for="fl-status">Situação</label><select id="fl-status" name="status"><option value="">Todas</option>
          ${TODOS_STATUS.map(s => `<option ${s === fl.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
        <div class="field"><label class="lbl" for="fl-placa">Placa</label><input id="fl-placa" name="placa" value="${esc(fl.placa)}" maxlength="8" autocomplete="off"></div>
        <button class="btn small" type="submit">Filtrar</button>
        ${fl.de || fl.ate || fl.status || fl.placa ? '<button class="btn small ghost" type="button" data-acao="limpar-filtros">Limpar</button>' : ''}
      </form>
      <div class="contagem">${lista.length} registro(s)${lista.length === 1000 ? ' (limite da tela; a exportação traz todos)' : ''}</div>
      ${tabelaLancamentos(lista)}
    </section>`;
};

async function exportarExcel() {
  const todos = [];
  if (demo()) todos.push(...filtrarDemo(dadosDemo().abastecimentos));
  else for (let i = 0; ; i += 1000) {
    const parte = await chamar(() => consulta(consultaAbastecimentos().range(i, i + 999)));
    if (!parte) return;
    todos.push(...parte);
    if (parte.length < 1000) break;
  }
  const linhas = [['ID (requisição KMM)', 'Data e hora', 'Placa', 'Motorista', 'CPF', 'KM', 'Litros', 'Encerrante anterior', 'Encerrante',
    'Bomba', 'Tanque', 'Status', 'Problemas', 'Desconto do motorista', 'Justificativa sem desconto', 'Fora do horário', 'Justificativa fora do horário',
    'Autorizado por', 'Obs. frentista', 'Obs. supervisor', 'Frentista', 'Conta do celular', 'Recebido em', 'Lote', 'Erro KMM'],
    ...todos.reverse().map(r => [r.id, dataHora(r.data_hora), r.placa, r.motorista, r.cpf, r.km, Number(r.litros), Number(r.encerrante_anterior),
      Number(r.encerrante), r.bomba, r.tanque, r.status, (r.problemas || []).join('; '), r.desconto_confirmado ? 'Sim' : 'Não',
      r.justificativa_desconto, r.fora_horario ? 'Sim' : 'Não', r.justificativa_horario, r.autorizado_por, r.obs_frentista, r.obs_supervisor,
      r.frentistas?.nome, r.conta, quandoLocal(r.recebido_em), r.lote_id, r.erro_kmm])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Abastecimentos');
  XLSX.writeFile(wb, `abastecimentos_${hojeISO()}.xlsx`);
}

// ---------- Fotos ----------
async function verFotos(entidade, chave, titulo) {
  if (demo()) { avisar('Modo demonstração: não há fotos de exemplo.', 'info'); return; }
  const lista = await chamar(() => rpc('fotos_de', { p_entidade: entidade, p_chave: String(chave) }));
  if (!lista) return;
  const links = await chamar(() => linksDasFotos(lista.map(f => f.caminho)));
  if (!links) return;
  const m = $('modal');
  Object.assign(m.dataset, { entidade, chave, titulo });
  m.innerHTML = `<div class="janela" role="dialog" aria-modal="true" aria-label="${esc(titulo)}"><div class="acoes entre"><h2>${esc(titulo)}</h2>
      <button class="btn small ghost" type="button" data-acao="fechar-modal">Fechar</button></div>
    ${links.length ? `<div class="galeria">${links.map((u, i) => `<figure><a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(u)}" alt="Foto ${i + 1}" loading="lazy"></a>
        <figcaption class="hint">${esc(quandoLocal(lista[i].criado_em))}</figcaption>
        <button class="btn small warn" type="button" data-acao="excluir-foto" data-caminho="${esc(lista[i].caminho)}">Excluir foto</button></figure>`).join('')}</div>`
      : '<p class="hint">Sem fotos.</p>'}
    <p class="hint">Toque numa foto para abrir em tamanho real. Os links valem por 10 minutos. Excluir uma foto fica registrado na auditoria.</p></div>`;
  m.hidden = false;
  m.querySelector('[data-acao="fechar-modal"]').focus();
}
function fecharModal() { const m = $('modal'); if (m.hidden) return; m.hidden = true; m.innerHTML = ''; abrir(est.tela, { semCarregando: true }); }
$('modal').addEventListener('click', async e => {
  const m = $('modal');
  if (e.target === m || e.target.closest('[data-acao="fechar-modal"]')) { fecharModal(); return; }
  const b = e.target.closest('[data-acao="excluir-foto"]');
  if (!b) return;
  if (b.dataset.confirmando !== '1') { b.dataset.confirmando = '1'; b.textContent = 'Toque de novo para excluir'; return; }
  b.disabled = true;
  const ok = await agir(async () => {
    const { error } = await supabase.storage.from('fotos').remove([b.dataset.caminho]);
    if (error) throw new Error(`Não foi possível excluir o arquivo: ${error.message}`);
    await rpc('excluir_foto', { p_caminho: b.dataset.caminho });
    return true;
  });
  if (ok) { avisar('Foto excluída.'); verFotos(m.dataset.entidade, m.dataset.chave, m.dataset.titulo); } else b.disabled = false;
});
const botaoFotos = (entidade, chave, titulo, n) => n
  ? `<button class="btn small ghost" type="button" data-acao="ver-fotos" data-entidade="${esc(entidade)}" data-chave="${esc(chave)}" data-titulo="${esc(titulo)}">Fotos (${esc(n)})</button>` : '';
async function contarFotos(entidade) {
  const r = await consulta(supabase.from('fotos').select('chave').eq('entidade', entidade).limit(5000));
  return r.reduce((m, f) => ((m[f.chave] = (m[f.chave] || 0) + 1), m), {});
}

// ---------- Aferição das bombas (semanal) ----------
const TOL_AFERICAO = 0.1;   // 0,5% da medida de 20 L
const ultimaAfericao = (af, numero) => af.find(a => a.bomba === numero);   // af vem do mais novo para o mais antigo
function chipAfericao(a) {
  if (!a) return '<span class="chip alerta">nunca feita</span>';
  const dias = Math.floor((Date.now() - new Date(a.data_hora).getTime()) / 86400000);
  return `<span class="chip ${dias >= 7 ? 'alerta' : 'ok'}">${dataBR(a.data_hora)}${dias >= 7 ? ' · vencida' : ''}</span>`;
}
const mL = x => `${Number(x) > 0 ? '+' : ''}${nf(Number(x) * 1000, 0)} mL`;

// ---------- Tanques e fechamentos ----------
const botaoAtivo = (tabela, chave, id, campo, ativo) =>
  `<button class="btn small ghost" type="button" data-acao="alternar" data-tabela="${tabela}" data-chave="${chave}" data-id="${esc(id)}" data-campo="${campo}" data-valor="${!ativo}">${ativo ? 'Desativar' : 'Reativar'}</button>`;
const botaoEditar = (tabela, id) => `<button class="btn small ghost" type="button" data-acao="editar" data-tabela="${tabela}" data-id="${esc(id)}">Editar</button>`;
let nCampo = 0;
const rotulo = (rot, controle) => { const id = `cp-${++nCampo}`; return `<div class="field"><label class="lbl" for="${id}">${rot}</label>${controle.replace(/^<(\w+)/, `<$1 id="${id}"`)}</div>`; };
const campo = (rot, nome, extra = '') => rotulo(rot, `<input name="${nome}" ${extra}>`);
const simNao = (rot, nome) => rotulo(rot, `<select name="${nome}"><option value="true">Sim</option><option value="false">Não</option></select>`);

TELAS.tanques = async () => {
  const r = await carregar(async () => ({
    hoje: await rpc('calcular_fechamento', { p_dia: hojeISO() }),
    fs: await consulta(supabase.from('fechamentos').select('*, frentistas(nome)').order('data', { ascending: false }).order('tanque').limit(200)),
    cs: await consulta(supabase.from('chegadas').select('*, frentistas(nome)').order('data_hora', { ascending: false }).limit(200)),
    af: await consulta(supabase.from('afericoes').select('*, frentistas(nome)').order('data_hora', { ascending: false }).limit(200)),
    ff: await contarFotos('fechamento'), fc: await contarFotos('chegada'), fa: await contarFotos('afericao'), cad: await carregarCadastros(),
  }), d => ({ hoje: d.hoje, fs: d.fechamentos, cs: d.chegadas, af: d.afericoes, ff: { [d.fechamentos[0].data]: 2 }, fc: { 7: 1 }, fa: {}, cad: cadDemo(d) }));
  if (!r) return;
  est.cad = r.cad;
  const c = r.cad;
  return `${cabeca('Tanques e fechamentos', 'Saldo de hoje, medições da régua, chegadas de diesel e o cadastro de tanques e bombas.')}
    <section class="painel"><header><h2>Hoje</h2><span>a linha tracejada é a medição da régua no fechamento</span></header>
      <div class="corpo">${r.hoje.length ? `<div class="tanques">${r.hoje.map(tanqueHtml).join('')}</div>` : '<p class="hint">Nenhum tanque cadastrado.</p>'}</div></section>
    <section class="painel"><header><h2>Fechamentos</h2><span>diferença acima de 20 L fica destacada</span></header>
      ${r.fs.length ? `<div class="tabela"><table><thead><tr><th>Data</th><th>Tanque</th><th class="n">Inicial</th><th class="n">+ Chegadas</th><th class="n">− Saídas</th><th class="n">Esperado</th><th class="n">Régua</th><th class="n">Diferença</th><th>Fechado por</th><th></th></tr></thead><tbody>
      ${r.fs.map(f => `<tr class="${Math.abs(f.diferenca) > 20 ? 'divergente' : ''}"><td>${dataBR(f.data)}</td><td>${esc(f.tanque)}</td><td class="n">${nf(f.saldo_inicial, 0)}</td>
        <td class="n">${nf(f.chegadas, 0)}</td><td class="n">${nf(f.saidas, 0)}</td><td class="n">${nf(f.saldo_calculado, 0)}</td><td class="n">${nf(f.saldo_medido, 0)}</td>
        <td class="n">${Number(f.diferenca) > 0 ? '+' : ''}${nf(f.diferenca, 0)}</td><td>${esc(f.frentistas?.nome || '')}</td><td>${botaoFotos('fechamento', f.data, `Fechamento de ${dataBR(f.data)}`, r.ff[f.data])}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="vazio">Nenhum fechamento ainda.</p>'}</section>
    <section class="painel"><header><h2>Chegadas de diesel</h2><span>notas fiscais lançadas pelo posto</span></header>
      ${r.cs.length ? `<div class="tabela"><table><thead><tr><th>Data</th><th>Tanque</th><th>NF</th><th class="n">Litros</th><th class="n">Valor</th><th class="n">Régua</th><th>Caminhão</th><th>Lançado por</th><th>Alerta</th><th></th></tr></thead><tbody>
      ${r.cs.map(x => `<tr class="${x.alerta ? 'divergente' : ''}"><td>${dataHora(x.data_hora)}</td><td>${esc(x.tanque)}</td><td>${esc(x.nf)}</td><td class="n">${nf(x.litros, 0)}</td>
        <td class="n">${x.valor_total == null ? '' : `R$ ${nf(x.valor_total)}`}</td><td class="n">${x.regua_antes == null ? '' : `${nf(x.regua_antes, 0)} → ${nf(x.regua_depois, 0)}`}</td>
        <td>${esc([x.placa_caminhao, x.placa_carreta].filter(Boolean).join(' / '))}<span class="sub">${esc(x.motorista || '')}</span></td><td>${esc(x.frentistas?.nome || '')}</td>
        <td class="quebra">${esc(x.alerta || '')}</td><td>${botaoFotos('chegada', x.id, `Chegada NF ${x.nf}`, r.fc[String(x.id)])}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="vazio">Nenhuma chegada ainda.</p>'}</section>
    <section class="painel"><header><h2>Aferições</h2><span>1 vez por semana em cada bomba · medida de 20 L · diferença acima de 100 mL fica destacada</span></header>
      ${r.af.length ? `<div class="tabela"><table><thead><tr><th>Data</th><th class="n">Bomba</th><th class="n">Medida</th><th class="n">Visor</th><th class="n">Diferença</th><th>Aferido por</th><th></th></tr></thead><tbody>
      ${r.af.map(a => `<tr class="${Math.abs(a.diferenca_l) > TOL_AFERICAO ? 'divergente' : ''}"><td>${dataHora(a.data_hora)}</td><td class="n">${esc(a.bomba)}</td>
        <td class="n">${nf(a.medida_l, 3)} L</td><td class="n">${nf(a.visor_l, 3)} L</td><td class="n">${mL(a.diferenca_l)}</td><td>${esc(a.frentistas?.nome || '')}</td>
        <td>${botaoFotos('afericao', a.id, `Aferição da bomba ${a.bomba} em ${dataBR(a.data_hora)}`, r.fa[String(a.id)])}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="vazio">Nenhuma aferição ainda.</p>'}</section>
    <div class="duas">
      <section class="painel"><header><h2>Tanques</h2><span>${c.tanques.length} cadastrado(s)</span></header>
        <div class="tabela"><table><thead><tr><th>Tanque</th><th class="n">Capacidade</th><th class="n">Saldo inicial</th><th></th></tr></thead><tbody>
          ${c.tanques.map(t => `<tr><td>${esc(t.codigo)}</td><td class="n">${nf(t.capacidade_l, 0)}</td><td class="n">${nf(t.saldo_inicial, 0)}</td><td>${botaoEditar('tanques', t.codigo)}</td></tr>`).join('')}</tbody></table></div>
        <div class="corpo"><form class="formulario" data-form="tanques">
          ${campo('Código', 'codigo', 'required maxlength="20"')}${campo('Capacidade (L)', 'capacidade_l', 'class="num" inputmode="decimal" required')}
          ${campo('Saldo inicial (L)', 'saldo_inicial', 'class="num" inputmode="decimal" required')}<button class="btn small" type="submit">Salvar tanque</button></form>
          <p class="hint">O saldo inicial só vale até o primeiro fechamento. Depois, cada dia começa com a medição do anterior.</p></div></section>
      <section class="painel"><header><h2>Bombas</h2><span>${c.bombas.length} cadastrada(s)</span></header>
        <div class="tabela"><table><thead><tr><th class="n">Bomba</th><th>Tanque</th><th class="n">Encerrante inicial</th><th>Ativa</th><th>Última aferição</th><th></th></tr></thead><tbody>
          ${c.bombas.map(b => `<tr><td class="n">${esc(b.numero)}</td><td>${esc(b.tanque)}</td><td class="n">${nf(b.encerrante_inicial, 3)}</td><td>${b.ativa ? 'Sim' : 'Não'}</td>
            <td>${b.ativa ? chipAfericao(ultimaAfericao(r.af, b.numero)) : ''}</td><td>${botaoEditar('bombas', b.numero)}</td></tr>`).join('')}</tbody></table></div>
        <div class="corpo"><form class="formulario" data-form="bombas">
          ${campo('Número', 'numero', 'class="num" inputmode="numeric" required')}
          ${rotulo('Tanque', `<select name="tanque">${c.tanques.map(t => `<option>${esc(t.codigo)}</option>`).join('')}</select>`)}
          ${campo('Encerrante inicial', 'encerrante_inicial', 'class="num" inputmode="decimal" required')}${simNao('Ativa', 'ativa')}
          <button class="btn small" type="submit">Salvar bomba</button></form></div></section>
    </div>`;
};

// ---------- Lotes do KMM ----------
function baixarLote(id, linhas) { XLSX.writeFile(planilhaKMM(XLSX, linhas), `kmm_lote_${id}.xlsx`, { bookType: 'xlsx' }); }

TELAS.lotes = async () => {
  const r = await carregar(async () => ({
    ls: await consulta(supabase.from('lotes').select('*').order('id', { ascending: false }).limit(100)),
    prontos: await consulta(supabase.from('abastecimentos').select('id, litros').eq('status', 'Pronto').limit(10000)),
    emLote: await consulta(supabase.from('abastecimentos').select('id, data_hora, placa, motorista, litros, lote_id').eq('status', 'Em lote').order('data_hora')),
  }), d => ({ ls: d.lotes, prontos: d.abastecimentos.filter(a => a.status === 'Pronto'), emLote: [] }));
  if (!r) return;
  const abertos = r.ls.filter(l => l.situacao === 'Gerado');
  const litrosProntos = r.prontos.reduce((s, x) => s + Number(x.litros), 0);
  return `${cabeca('Lotes do KMM', 'Os abastecimentos prontos viram uma planilha para importar no KMM (Importação de abastecimento › Interno).',
      nativo ? '' : `<button class="btn" type="button" data-acao="gerar" ${r.prontos.length ? '' : 'disabled'}>Gerar lote do KMM</button>`)}
    ${nativo ? soComputador('No celular os lotes são só para consulta. Gerar, baixar, confirmar e marcar erros do KMM é feito no computador.') : ''}
    <section class="faixa" aria-label="Situação dos lotes" data-colunas="3">
      <div><small>Prontos para o próximo lote</small><b class="num">${r.prontos.length}</b><em>${nf(litrosProntos, 0)} L</em></div>
      <div class="${abertos.length ? 'precisa' : ''}"><small>Aguardando confirmação</small><b class="num">${abertos.length}</b><em>lote(s) gerado(s) e não confirmado(s)</em></div>
      <div><small>Último confirmado</small><b class="num">${(l => l ? `lote ${esc(l.id)}` : '—')(r.ls.find(l => l.situacao === 'Confirmado'))}</b><em>&nbsp;</em></div>
    </section>
    ${r.prontos.length === 1 && !nativo ? '<p class="hint">Com 1 registro só, o importador do KMM pode recusar o arquivo. Se der erro, espere ter mais um.</p>' : ''}
    ${abertos.map(l => `<section class="painel"><header><h2>Lote ${esc(l.id)}: aguardando confirmação</h2><span>${esc(l.quantidade)} registro(s) · ${nf(l.litros)} L · gerado ${quandoLocal(l.criado_em)}</span></header>
      ${nativo ? '' : `<div class="corpo"><div class="acoes">
        <button class="btn small ghost" type="button" data-acao="baixar" data-lote="${esc(l.id)}">Baixar planilha</button>
        <button class="btn small" type="button" data-acao="confirmar" data-lote="${esc(l.id)}">Confirmar: importado no KMM</button>
        <button class="btn small ghost" type="button" data-acao="desfazer" data-lote="${esc(l.id)}">Desfazer (não importei)</button></div>
        <p class="hint">Se o KMM recusou alguma linha, marque o erro nela antes de confirmar. Ela volta para Decisões.</p></div>`}
      <div class="tabela"><table><thead><tr><th>Nº</th><th>Data</th><th>Veículo</th><th class="n">Litros</th>${nativo ? '' : '<th>Erro do KMM</th>'}</tr></thead><tbody>
      ${r.emLote.filter(x => x.lote_id === l.id).map(x => `<tr><td class="n">#${esc(x.id)}</td><td>${dataHora(x.data_hora)}</td><td>${placa(x.placa)}<span class="sub">${esc(x.motorista)}</span></td><td class="n">${nf(x.litros)}</td>
        ${nativo ? '' : `<td><div class="inline"><input data-erro="${esc(x.id)}" placeholder="Mensagem do KMM" maxlength="1000" aria-label="Erro do KMM no #${esc(x.id)}"><button class="btn small ghost" type="button" data-acao="erro" data-id="${esc(x.id)}">Marcar erro</button></div></td>`}</tr>`).join('')}
      </tbody></table></div></section>`).join('')}
    <section class="painel"><header><h2>Histórico</h2><span>últimos 100 lotes</span></header>
      ${r.ls.length ? `<div class="tabela"><table><thead><tr><th class="n">Lote</th><th>Gerado</th><th class="n">Registros</th><th class="n">Litros</th><th>Situação</th><th>Por</th>${nativo ? '' : '<th></th>'}</tr></thead><tbody>
      ${r.ls.map(l => `<tr><td class="n">${esc(l.id)}</td><td>${quandoLocal(l.criado_em)}</td><td class="n">${esc(l.quantidade)}</td><td class="n">${nf(l.litros)}</td>
        <td><span class="chip ${l.situacao === 'Confirmado' ? 'ok' : l.situacao === 'Gerado' ? 'pend' : 'neutro'}">${esc(l.situacao)}</span></td><td>${esc(l.criado_por)}</td>
        ${nativo ? '' : `<td><button class="btn small ghost" type="button" data-acao="baixar" data-lote="${esc(l.id)}">Planilha</button></td>`}</tr>`).join('')}
      </tbody></table></div>` : '<p class="vazio">Nenhum lote ainda.</p>'}</section>`;
};

// ---------- Frentistas ----------
TELAS.frentistas = async () => {
  const lista = await carregar(() => consulta(supabase.from('frentistas').select('*').order('ativo', { ascending: false }).order('nome')), d => d.frentistas);
  if (!lista) return;
  return `${cabeca('Frentistas', 'Quem entra no app do posto, com o nome e um PIN de 4 números.')}
    <section class="painel"><header><h2>Novo frentista</h2></header><div class="corpo">
      <form class="formulario" data-novo-frentista>
        ${campo('Nome', 'nome', 'required maxlength="120" autocomplete="off"')}
        ${campo('PIN (4 números)', 'pin', 'class="num" inputmode="numeric" maxlength="4" pattern="\\d{4}" required autocomplete="off"')}
        <button class="btn small" type="submit">Cadastrar</button></form>
      <p class="hint">Passe o PIN só para o frentista. PINs óbvios como 1234 e 0000 são recusados.</p></div></section>
    <section class="painel"><header><h2>Frentistas</h2><span>${lista.filter(f => f.ativo).length} ativo(s)</span></header>
      <div class="tabela"><table><thead><tr><th>Nome</th><th>Situação</th><th>PIN novo</th><th></th></tr></thead><tbody>
      ${lista.map(f => `<tr>
        <td><div class="inline"><input data-nome-frentista="${esc(f.id)}" value="${esc(f.nome)}" maxlength="120" aria-label="Nome do frentista"><button class="btn small ghost" type="button" data-acao="renomear" data-id="${esc(f.id)}">Salvar nome</button></div></td>
        <td><span class="chip ${f.ativo ? 'ok' : 'neutro'}">${f.ativo ? 'Ativo' : 'Desativado'}</span></td>
        <td><div class="inline"><input data-pin="${esc(f.id)}" inputmode="numeric" maxlength="4" placeholder="4 números" autocomplete="off" aria-label="PIN novo para ${esc(f.nome)}" class="num curto">
          <button class="btn small ghost" type="button" data-acao="pin" data-id="${esc(f.id)}">Definir PIN</button></div></td>
        <td><div class="acoes">${botaoAtivo('frentistas', 'id', f.id, 'ativo', f.ativo)}
          <button class="btn small warn" type="button" data-acao="excluir" data-tabela="frentistas" data-chave="id" data-id="${esc(f.id)}">Excluir</button></div></td></tr>`).join('')}
      </tbody></table></div>
      <div class="corpo"><p class="hint">Um PIN novo desbloqueia o frentista (depois de 5 erros) e tira ele do app em todos os celulares. Frentista com lançamentos não pode ser excluído: desative.</p></div></section>`;
};

// ---------- Veículos e motoristas ----------
TELAS.veiculos = async () => {
  const c = await carregar(async () => ({ ...(await carregarCadastros()), fv: await contarFotos('veiculo'),
    vinculos: await consulta(supabase.from('veiculo_motoristas').select('placa, motorista_id, motoristas(nome, cpf)').limit(20000)) }),
  d => ({ ...cadDemo(d), fv: {}, vinculos: d.vinculos }));
  if (!c) return;
  est.cad = c;
  const porPlaca = c.vinculos.reduce((m, x) => ((m[x.placa] ||= []).push(x), m), {});
  return `${cabeca('Veículos e motoristas', 'Cadastros usados nas conferências e no KMM. O frentista só cadastra o que não existe; alterar é aqui.')}
    ${nativo ? '' : `<section class="painel"><header><h2>Base em Excel</h2><span>veículos, motoristas e quem dirige cada placa</span></header>
      <div class="corpo"><div class="acoes"><button class="btn small" type="button" data-acao="exportar-base">Exportar base (Excel)</button>
        ${rotulo('Importar base (Excel ou CSV)', '<input type="file" accept=".xlsx,.xls,.csv" data-importar-base>')}</div>
        <p class="hint"><b>Planilha simples:</b> só as colunas <b>PLACA</b> e <b>NOME</b> (do motorista). Placa e motorista que não existem são criados e vinculados;
          o tamanho do tanque e o CPF o frentista informa no primeiro abastecimento.</p>
        <p class="hint"><b>Base completa:</b> a planilha exportada tem 3 abas: <b>Veiculos</b> (placa, capacidade_tanque_l, km_inicial, ativo), <b>Motoristas</b> (nome, cpf, ativo) e
          <b>Vinculos</b> (placa, motorista, cpf). O jeito mais fácil: exporte, edite no Excel e importe de volta. A importação inclui e atualiza;
          para tirar alguém de uso, ponha <b>Não</b> em "ativo". Vínculo se remove aqui na lista, no × ao lado do nome.</p></div></section>`}
    <div class="duas">
      <section class="painel"><header><h2>Veículos</h2><span>${c.veiculos.length} cadastrado(s)</span></header>
        <div class="corpo"><form class="formulario" data-form="veiculos">
          ${campo('Placa', 'placa', 'required maxlength="8" autocomplete="off"')}${campo('Tanque do veículo (L)', 'capacidade_l', 'class="num" inputmode="decimal" required')}
          ${campo('Último KM conhecido', 'km_inicial', 'class="num" inputmode="numeric"')}${simNao('Ativo', 'ativo')}
          <button class="btn small" type="submit">Salvar veículo</button></form></div>
        <div class="tabela"><table><thead><tr><th>Placa</th><th class="n">Tanque</th><th class="n">KM inicial</th><th>Ativo</th><th>Motoristas</th><th></th></tr></thead><tbody>
        ${c.veiculos.map(v => `<tr><td>${placa(v.placa)}<span class="sub">${esc(v.criado_por || 'Painel')}</span></td><td class="n">${v.capacidade_l == null ? '<span class="chip pend">a informar</span>' : nf(v.capacidade_l, 0)}</td><td class="n">${nf(v.km_inicial, 0)}</td><td>${v.ativo ? 'Sim' : 'Não'}</td>
          <td class="quebra">${(porPlaca[v.placa] || []).map(x => `<span class="vinculo">${esc(x.motoristas?.nome || '')}<button type="button" class="link" data-acao="desvincular"
            data-id="${esc(v.placa)}" data-motorista="${esc(x.motorista_id)}" aria-label="Tirar ${esc(x.motoristas?.nome || '')} da placa ${esc(v.placa)}">×</button></span>`).join(' ')}</td>
          <td><div class="acoes">${botaoEditar('veiculos', v.placa)}${botaoFotos('veiculo', v.placa, `Veículo ${v.placa}`, c.fv[v.placa])}
            <button class="btn small ghost" type="button" data-acao="foto-veiculo" data-id="${esc(v.placa)}">+ Foto</button></div></td></tr>`).join('')}</tbody></table></div></section>
      <section class="painel"><header><h2>Motoristas</h2><span>${c.motoristas.length} cadastrado(s)</span></header>
        <div class="corpo"><form class="formulario" data-form="motoristas">
          ${campo('Nome completo', 'nome', 'required maxlength="120" autocomplete="off"')}${campo('CPF', 'cpf', 'class="num" inputmode="numeric" required maxlength="14" autocomplete="off"')}
          ${simNao('Ativo', 'ativo')}<button class="btn small" type="submit">Salvar motorista</button></form>
          <p class="hint">Ao editar um motorista, digite o CPF completo de novo (na lista ele aparece mascarado).</p></div>
        <div class="tabela"><table><thead><tr><th>Nome</th><th>CPF</th><th>Ativo</th><th></th></tr></thead><tbody>
        ${c.motoristas.map(m => `<tr><td>${esc(m.nome)}<span class="sub">${esc(m.criado_por || 'Painel')}</span></td><td class="num">${m.cpf ? mascaraCpf(m.cpf) : '<span class="chip pend">a informar</span>'}</td><td>${m.ativo ? 'Sim' : 'Não'}</td>
          <td>${botaoEditar('motoristas', m.id)}</td></tr>`).join('')}</tbody></table></div></section>
    </div>`;
};

function editarCadastro(tabela, id) {
  const lista = est.cad?.[tabela];
  const chave = { veiculos: 'placa', motoristas: 'id', tanques: 'codigo', bombas: 'numero' }[tabela];
  const item = lista?.find(x => String(x[chave]) === String(id));
  const f = trabalho.querySelector(`form[data-form="${tabela}"]`);
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
TELAS.acessos = async () => {
  const lista = await carregar(() => consulta(supabase.from('acessos').select('*').order('papel').order('nome')), d => d.acessos);
  if (!lista) return;
  const podeMexer = a => a.papel === 'posto' || (souAdmin() && a.papel === 'supervisor');
  const acoes = a => {
    if (a.papel === 'administrador') return '<span class="hint">Protegido</span>';
    if (!podeMexer(a)) return '<span class="hint">Só o administrador altera</span>';
    return `<div class="acoes">${botaoAtivo('acessos', 'email', a.email, 'ativo', a.ativo).replace('Desativar', 'Bloquear').replace('Reativar', 'Liberar')}
      <button class="btn small warn" type="button" data-acao="excluir" data-tabela="acessos" data-chave="email" data-id="${esc(a.email)}">Excluir</button></div>`;
  };
  return `${cabeca('Acessos', 'Só as contas Google desta lista usam o sistema. Qualquer outra conta que tentar entrar não vê nada.')}
    <section class="painel"><header><h2>Liberar uma conta Google</h2></header><div class="corpo">
      <form class="formulario" data-form="acessos">
        ${campo('E-mail da conta Google', 'email', 'type="email" required autocomplete="off"')}${campo('Nome', 'nome', 'required maxlength="120" placeholder="Ex.: Celular posto 1"')}
        ${rotulo('Tipo', `<select name="papel"><option value="posto">Celular do posto</option>${souAdmin() ? '<option value="supervisor">Supervisor</option>' : ''}</select>`)}
        ${simNao('Ativo', 'ativo')}<button class="btn small" type="submit">Salvar</button></form>
      <p class="hint">${souAdmin() ? 'Como administrador, você libera celulares do posto e supervisores.' : 'Você libera e bloqueia celulares do posto. Supervisores são liberados pelo administrador.'}
        Contas de administrador não podem ser criadas, alteradas ou removidas pelo painel.</p></div></section>
    <section class="painel"><header><h2>Contas liberadas</h2><span>celular perdido ou roubado: bloqueie na hora</span></header>
      <div class="tabela"><table><thead><tr><th>Nome</th><th>Tipo</th><th>Situação</th><th></th></tr></thead><tbody>
      ${lista.map(a => `<tr><td>${esc(a.nome)}${a.email === est.conta ? ' <span class="hint">(você)</span>' : ''}<span class="sub">${esc(a.email)}</span></td><td>${NOME_PAPEL[a.papel] || esc(a.papel)}</td>
        <td><span class="chip ${a.ativo ? 'ok' : 'alerta'}">${a.ativo ? 'Liberado' : 'Bloqueado'}</span></td><td>${acoes(a)}</td></tr>`).join('')}
      </tbody></table></div></section>`;
};

// ---------- Auditoria ----------
TELAS.auditoria = async () => {
  const r = await carregar(async () => {
    const [eventos, contas, frentistas] = await Promise.all([
      consulta(supabase.from('auditoria').select('*').order('id', { ascending: false }).limit(500)),
      consulta(supabase.from('acessos').select('email, nome')),
      consulta(supabase.from('frentistas').select('id, nome')),
    ]);
    return { eventos, contas, frentistas };
  }, d => ({ eventos: d.auditoria, contas: d.acessos, frentistas: d.frentistas }));
  if (!r) return;
  est.aud.eventos = r.eventos;
  est.aud.ctx = { contas: Object.fromEntries(r.contas.map(a => [a.email, a.nome])), frentistas: Object.fromEntries(r.frentistas.map(f => [f.id, f.nome])) };
  return `${cabeca('Auditoria', 'Quem fez o quê, em linguagem simples. Abra "Ver detalhes técnicos" para ver o antes e o depois de cada campo.',
      nativo ? '' : '<button class="btn small ghost" type="button" data-acao="exportar-auditoria">Exportar para Excel</button>')}
    ${htmlFiltroAud(est.aud.filtro, est.aud.busca)}
    <div id="aud-resultado" class="aud-resultado">${htmlAuditoria(est.aud.eventos, est.aud.ctx, est.aud.filtro, est.aud.busca)}</div>
    <p class="hint">Últimos 500 registros. O histórico não pode ser alterado nem apagado.${souAdmin() ? ' Supervisores não veem as ações de administradores.' : ' Ações de administradores não aparecem aqui.'}</p>`;
};
function exportarAuditoria() {
  const texto = html => new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
  const linhas = [['Data e hora', 'Quem', 'Papel', 'O que fez', 'Motivo', 'Ação', 'Registro', 'Conta', 'Detalhes'],
    ...est.aud.eventos.map(e => { const x = descrever(e, est.aud.ctx); return [new Date(e.quando).toLocaleString('pt-BR'), x.quem, x.papel, texto(x.frase), x.motivo || '',
      e.acao, [e.entidade, e.entidade_id].filter(Boolean).join(' '), e.conta || '', JSON.stringify(e.detalhes ?? null).slice(0, 32000)]; })];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Auditoria');
  XLSX.writeFile(wb, `auditoria_${hojeISO()}.xlsx`);
}

// ---------- Guia de uso ----------
TELAS.guia = async () => `${cabeca('Guia de uso', 'Como usar o app e o painel, e o procedimento certo em cada situação.')}
  ${htmlAbasGuia(est.guia)}${htmlGuia(est.guia, est.turno)}`;

// ---------- Horário do turno (só administrador) ----------
TELAS.turno = async () => {
  if (!souAdmin()) return TELAS.resumo();
  const t = est.turno;
  return `${cabeca('Horário do turno', 'Fora deste horário, o lançamento só entra com justificativa e autorização de um supervisor ou administrador.')}
    <section class="painel estreito-560"><header><h2>Turno do posto</h2><span>vale para todos os celulares</span></header><div class="corpo">
      <form class="formulario" data-turno>
        ${campo('Abertura', 'abertura', `type="time" required value="${esc(t.abertura)}"`)}
        ${campo('Fechamento', 'fechamento', `type="time" required value="${esc(t.fechamento)}"`)}
        <button class="btn small" type="submit">Salvar horário</button></form>
      <p class="hint">Depois que o turno do dia é fechado no app, nada mais entra com a data daquele dia. A mudança fica na auditoria.</p></div></section>`;
};

// ---------- Ações: formulários ----------
trabalho.addEventListener('submit', async e => {
  const f = e.target.closest('form');
  if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));

  if (f.dataset.decidir) return decidir(f, e.submitter?.dataset.decisao || 'revalidar');
  if (f.hasAttribute('data-filtros')) { est.filtros = { de: d.de, ate: d.ate, status: d.status, placa: d.placa.trim() }; return abrir('abastecimentos'); }
  if (f.hasAttribute('data-turno')) {
    if (d.abertura === d.fechamento) { avisar('Abertura e fechamento não podem ser iguais.', 'warn'); return; }
    const r = await agir(() => consulta(supabase.from('configuracoes').update({ abertura: d.abertura, fechamento: d.fechamento, atualizado_em: new Date().toISOString() }).eq('id', 1).select()));
    if (r?.length) { est.turno = { abertura: d.abertura.slice(0, 5), fechamento: d.fechamento.slice(0, 5) }; avisar(`Turno salvo: ${est.turno.abertura} às ${est.turno.fechamento}.`); }
    else if (r) avisar('Só o administrador altera o horário.', 'warn');
    return;
  }
  if (f.hasAttribute('data-novo-frentista')) {
    if (!/^\d{4}$/.test(d.pin)) { avisar('O PIN tem 4 números.', 'warn'); return; }
    const novo = await agir(() => consulta(supabase.from('frentistas').insert({ nome: d.nome.trim() }).select()));
    if (!novo) return;
    const ok = await chamar(() => rpc('definir_pin', { p_frentista_id: novo[0].id, p_pin: d.pin }));
    avisar(ok === undefined ? `${novo[0].nome} cadastrado, mas o PIN foi recusado. Defina outro PIN na lista.` : `${novo[0].nome} cadastrado.`, ok === undefined ? 'warn' : 'ok');
    return abrir('frentistas', { semCarregando: true });
  }
  const tabela = f.dataset.form;
  if (!['veiculos', 'motoristas', 'tanques', 'bombas', 'acessos'].includes(tabela)) return;
  for (const k of ['capacidade_l', 'saldo_inicial', 'encerrante_inicial']) if (k in d) d[k] = d[k] === '' ? null : parseNum(d[k]);
  for (const k of ['numero', 'km_inicial']) if (k in d) d[k] = d[k] === '' ? null : Number(soDigitos(d[k]));
  for (const k of ['ativo', 'ativa']) if (k in d) d[k] = d[k] === 'true';
  if ('cpf' in d) d.cpf = soDigitos(d.cpf);
  if (tabela === 'motoristas') d.nome = d.nome.trim().toUpperCase();
  if (tabela === 'acessos') { d.email = d.email.trim().toLowerCase(); d.nome = d.nome.trim(); if (!souAdmin()) d.papel = 'posto'; }
  if (tabela === 'veiculos') d.placa = d.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (tabela === 'tanques') d.codigo = d.codigo.trim().toUpperCase();
  for (const [k, v] of Object.entries(d)) if (typeof v === 'number' && Number.isNaN(v)) { avisar('Confira os números digitados.', 'warn'); return; }
  let r;
  if (tabela === 'motoristas' && f.dataset.editandoId) {
    r = await agir(() => consulta(supabase.from('motoristas').update(d).eq('id', f.dataset.editandoId).select()));
  } else {
    const conflito = { veiculos: 'placa', motoristas: 'nome', tanques: 'codigo', bombas: 'numero', acessos: 'email' }[tabela];
    r = await agir(() => consulta(supabase.from(tabela).upsert(d, { onConflict: conflito }).select()));
  }
  if (r?.length) { avisar('Salvo.'); abrir(est.tela, { semCarregando: true }); } else if (r) avisar('Nada foi salvo: sem permissão para esse registro.', 'warn');
});

// ---------- Ações: cliques ----------
document.addEventListener('click', async e => {
  const t = s => e.target.closest(s);
  if (t('[data-tema]')) { definirTema(t('[data-tema]').dataset.tema); return; }
  if (t('[data-demo-alternar]')) { if (!souAdmin()) return; alternarDemo(); montarMenu(); abrir(est.tela); return; }
  if (t('#sair')) { est.conta = null; await sair(); mostrarLogin('Você saiu.'); return; }
  const item = t('.item[data-tela]');
  if (item) { if (suprimirClique) return; fecharMenuSeEstreito(); abrir(item.dataset.tela); return; }
  if (!trabalho.contains(e.target)) return;
  if (t('[data-ir]')) { abrir(t('[data-ir]').dataset.ir); return; }
  if (t('[data-aud-filtro]')) { est.aud.filtro = t('[data-aud-filtro]').dataset.audFiltro; mostrarAuditoria(); return; }
  if (t('[data-guia]')) { est.guia = t('[data-guia]').dataset.guia; abrir('guia', { semCarregando: true }); return; }
  const li = t('.caixa li[data-decisao]');
  if (li) { selecionarDecisao(Number(li.dataset.decisao)); return; }
  const b = t('button[data-acao]');
  if (!b || b.type === 'submit') return;
  const { acao, lote, id, tabela, chave } = b.dataset;
  const confirmarDuasVezes = texto => {
    if (b.dataset.confirmando === '1') return true;
    b.dataset.confirmando = '1'; b.textContent = texto; return false;
  };
  if (acao === 'recarregar') abrir(est.tela);
  else if (acao === 'limpar-filtros') { est.filtros = { de: '', ate: '', status: '', placa: '' }; abrir('abastecimentos'); }
  else if (acao === 'exportar') exportarExcel();
  else if (acao === 'exportar-auditoria') exportarAuditoria();
  else if (acao === 'exportar-base') exportarBase(est.cad);
  else if (acao === 'desvincular') {
    if (demo()) { avisar('Modo demonstração: nada foi gravado.', 'info'); return; }
    const r = await agir(() => consulta(supabase.from('veiculo_motoristas').delete().eq('placa', id).eq('motorista_id', b.dataset.motorista).select()));
    if (r?.length) { avisar('Motorista tirado da placa.'); abrir('veiculos', { semCarregando: true }); } else if (r) avisar('Nada foi alterado: sem permissão.', 'warn');
  }
  else if (acao === 'gerar') {
    const r = await agir(() => rpc('gerar_lote'));
    if (r) { avisar(`Lote ${r.id} gerado com ${r.quantidade} registro(s). ${avisosLote(r.linhas).join(' ')}`); baixarLote(r.id, r.linhas); abrir('lotes', { semCarregando: true }); }
  } else if (acao === 'baixar') {
    const linhas = await agir(() => rpc('linhas_lote', { p_lote: Number(lote) }));
    if (linhas) baixarLote(lote, linhas);
  } else if (acao === 'confirmar' || acao === 'desfazer') {
    if (!confirmarDuasVezes(acao === 'confirmar' ? 'Clique de novo para confirmar' : 'Clique de novo para desfazer')) return;
    const r = await agir(() => rpc('fechar_lote', { p_lote: Number(lote), p_acao: acao }));
    if (r) { avisar(`Lote ${r.id}: ${r.situacao.toLowerCase()} (${r.registros} registro(s)).`); abrir('lotes', { semCarregando: true }); }
  } else if (acao === 'erro') {
    const msg = trabalho.querySelector(`[data-erro="${CSS.escape(id)}"]`).value.trim();
    if (msg.length < 3) { avisar('Escreva a mensagem de erro do KMM.', 'warn'); return; }
    if (await agir(() => rpc('marcar_erro_kmm', { p_id: Number(id), p_mensagem: msg })) !== undefined) { avisar(`#${id} marcado com erro do KMM.`); abrir('lotes', { semCarregando: true }); }
  } else if (acao === 'ver-fotos') {
    verFotos(b.dataset.entidade, b.dataset.chave, b.dataset.titulo);
  } else if (acao === 'foto-veiculo') {
    if (demo()) { avisar('Modo demonstração: nada foi gravado.', 'info'); return; }
    const foto = await chamar(tirarFoto);
    if (!foto) return;
    const ok = await chamar(async () => { const [caminho] = await enviarFotos('veiculo', [foto]); await rpc('anexar_foto_veiculo', { p_placa: id, p_foto: caminho }); return true; });
    if (ok) { avisar(`Foto anexada ao veículo ${id}.`); abrir('veiculos', { semCarregando: true }); }
  } else if (acao === 'editar') {
    editarCadastro(tabela, id);
  } else if (acao === 'pin') {
    const pin = trabalho.querySelector(`[data-pin="${CSS.escape(id)}"]`).value.trim();
    if (!/^\d{4}$/.test(pin)) { avisar('O PIN tem 4 números.', 'warn'); return; }
    if (await agir(() => rpc('definir_pin', { p_frentista_id: Number(id), p_pin: pin })) !== undefined) { avisar('PIN definido. Passe o PIN só para o frentista.'); abrir('frentistas', { semCarregando: true }); }
  } else if (acao === 'renomear') {
    const nome = trabalho.querySelector(`[data-nome-frentista="${CSS.escape(id)}"]`).value.trim();
    if (!nome) return;
    if (await agir(() => consulta(supabase.from('frentistas').update({ nome }).eq('id', id).select()))) { avisar('Nome atualizado.'); abrir('frentistas', { semCarregando: true }); }
  } else if (acao === 'alternar') {
    if (!['frentistas', 'acessos'].includes(tabela)) return;
    const { campo: col, valor } = b.dataset;
    const r = await agir(() => consulta(supabase.from(tabela).update({ [col]: valor === 'true' }).eq(chave, id).select()));
    if (r?.length) { avisar('Atualizado.'); abrir(est.tela, { semCarregando: true }); } else if (r) avisar('Nada foi alterado: sem permissão para esse registro.', 'warn');
  } else if (acao === 'excluir') {
    if (!['frentistas', 'acessos'].includes(tabela)) return;
    if (!confirmarDuasVezes('Clique de novo para excluir')) return;
    const r = await agir(() => consulta(supabase.from(tabela).delete().eq(chave, id).select()));
    if (r?.length) { avisar('Excluído.'); abrir(est.tela, { semCarregando: true }); } else if (r) avisar('Nada foi excluído: sem permissão para esse registro.', 'warn');
  }
});

function selecionarDecisao(id) {
  if (est.tela !== 'decisoes') { est.sel = id; abrir('decisoes', { manterSelecao: true }); return; }
  est.sel = id;
  abrir('decisoes', { manterSelecao: true, semCarregando: true }).then(() => {
    if (innerWidth < 1100) $('detalhe-decisao')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
trabalho.addEventListener('keydown', e => {
  const li = e.target.closest?.('.caixa li[data-decisao]');
  if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selecionarDecisao(Number(li.dataset.decisao)); }
});

function mostrarAuditoria() {
  const res = $('aud-resultado');
  if (!res) return;
  res.innerHTML = htmlAuditoria(est.aud.eventos, est.aud.ctx, est.aud.filtro, est.aud.busca);
  document.querySelectorAll('[data-aud-filtro]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.audFiltro === est.aud.filtro)));
}
trabalho.addEventListener('input', e => { if (e.target.id === 'aud-busca') { est.aud.busca = e.target.value; mostrarAuditoria(); } });

// ---------- Base de veículos e motoristas em Excel ----------
// Exporta as 3 abas no mesmo formato que a importação lê: dá para exportar, editar no Excel e importar de volta.
function exportarBase(c) {
  if (!c) return;
  const simNaoTxt = b => (b ? 'Sim' : 'Não');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['placa', 'capacidade_tanque_l', 'km_inicial', 'ativo'],
    ...c.veiculos.map(v => [v.placa, v.capacidade_l == null ? '' : Number(v.capacidade_l), v.km_inicial ?? '', simNaoTxt(v.ativo)])]), 'Veiculos');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['nome', 'cpf', 'ativo'],
    ...c.motoristas.map(m => [m.nome, m.cpf ? String(m.cpf) : '', simNaoTxt(m.ativo)])]), 'Motoristas');   // CPF como texto: não perde zero à esquerda
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['placa', 'motorista', 'cpf'],
    ...c.vinculos.map(x => [x.placa, x.motoristas?.nome || '', String(x.motoristas?.cpf || '')])]), 'Vinculos');
  XLSX.writeFile(wb, `base_veiculos_motoristas_${hojeISO()}.xlsx`);
}

// Cabeçalho tolerante: "Capacidade (L)", "capacidade_tanque_l" e "CAPACIDADE" valem igual
const chaveColuna = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const coluna = (linha, ...nomes) => {
  for (const [k, v] of Object.entries(linha)) if (nomes.includes(chaveColuna(k))) return String(v ?? '').trim();
  return '';
};
const lerAtivo = s => (s === '' ? undefined : !/^(n|nao|false|0|inativ|desativ)/i.test(chaveColuna(s)));
// O tipo de cada aba sai das colunas (o nome da aba não importa; um CSV do KMM também serve)
// Placa + nome do motorista (sem capacidade) = vínculos: cria a placa e o motorista que faltarem
function tipoDaAba(colunas) {
  const temMotorista = ['motorista', 'nome', 'nome_motorista', 'motorista_nome'].some(c => colunas.includes(c));
  const temCapacidade = ['capacidade_tanque_l', 'capacidade_l', 'capacidade', 'tanque_l'].some(c => colunas.includes(c));
  if (colunas.includes('placa') && (temMotorista || colunas.includes('cpf')) && !temCapacidade) return 'vinculos';
  if (colunas.includes('nome') && colunas.includes('cpf')) return 'motoristas';
  if (colunas.includes('placa')) return 'veiculos';
  return null;
}

async function importarBase(arquivo) {
  const csv = /\.csv$/i.test(arquivo.name);
  const texto = csv ? (await arquivo.text()).replace(/^﻿/, '') : null;
  // CSV lido como texto puro (raw): "600,5" é vírgula decimal, não milhar, e o CPF mantém o zero à esquerda
  const wb = csv ? XLSX.read(texto, { type: 'string', raw: true, FS: texto.split(/\r?\n/)[0].includes(';') ? ';' : ',' })
    : XLSX.read(await arquivo.arrayBuffer(), { type: 'array' });
  const abas = { veiculos: [], motoristas: [], vinculos: [] };
  for (const nome of wb.SheetNames) {
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nome], { defval: '' });
    const tipo = linhas.length ? tipoDaAba(Object.keys(linhas[0]).map(chaveColuna)) : null;
    if (tipo) abas[tipo].push(...linhas.map((l, i) => ({ l, linha: i + 2, aba: nome })));
  }
  const total = abas.veiculos.length + abas.motoristas.length + abas.vinculos.length;
  if (!total) { avisar('Nenhuma aba reconhecida. Use as colunas do arquivo exportado (placa, nome, cpf…).', 'warn'); return; }
  const resultado = { veiculos: 0, motoristas: 0, vinculos: 0 }, erros = [];
  let feitos = 0;
  // Ordem: veículos e motoristas antes dos vínculos, que dependem deles
  for (const tipo of ['veiculos', 'motoristas']) {
    for (const { l, linha, aba } of abas[tipo]) {
      avisar(`Importando ${++feitos} de ${total}…`, 'info');
      let reg;
      if (tipo === 'veiculos') {
        const cap = coluna(l, 'capacidade_tanque_l', 'capacidade_l', 'capacidade', 'tanque_l', 'tanque'), km = coluna(l, 'km_inicial', 'ultimo_km', 'km');
        reg = { placa: soPlaca(coluna(l, 'placa')) };
        if (cap) reg.capacidade_l = parseNum(cap);
        if (km) reg.km_inicial = Number(soDigitos(km));
      } else {
        reg = { nome: coluna(l, 'nome').toUpperCase(), cpf: soDigitos(coluna(l, 'cpf')).padStart(11, '0') };
      }
      const ativo = lerAtivo(coluna(l, 'ativo'));
      if (ativo !== undefined) reg.ativo = ativo;
      const r = await supabase.from(tipo).upsert(reg, { onConflict: tipo === 'veiculos' ? 'placa' : 'nome' });
      if (!r.error) { resultado[tipo]++; continue; }
      const motivo = /null value/.test(r.error.message) ? 'falta a capacidade do tanque'
        : /check constraint|invalid input/.test(r.error.message) ? (tipo === 'veiculos' ? 'placa ou capacidade inválida' : 'CPF inválido') : r.error.message;
      erros.push(`${aba} linha ${linha}: ${motivo}`);
    }
  }
  if (abas.vinculos.length) {
    avisar(`Importando os vínculos (${abas.vinculos.length})…`, 'info');
    const r = await chamar(() => rpc('importar_vinculos', { p_linhas: abas.vinculos.map(({ l, linha }) => ({
      linha, placa: coluna(l, 'placa'), motorista: coluna(l, 'motorista', 'nome', 'nome_motorista', 'motorista_nome'), cpf: coluna(l, 'cpf') })) }));
    if (r) {
      resultado.vinculos = r.ok; resultado.veiculos += r.veiculos_novos; resultado.motoristas += r.motoristas_novos;
      erros.push(...r.erros.map(x => `Vinculos ${x.replace(/^Linha/, 'linha')}`));
    }
  }
  avisar(`Importado: ${resultado.veiculos} veículo(s), ${resultado.motoristas} motorista(s), ${resultado.vinculos} vínculo(s).`
    + ' O que veio sem capacidade ou sem CPF o frentista completa no primeiro abastecimento.'
    + (erros.length ? ` ${erros.length} com erro: ${erros.slice(0, 20).join(' | ')}${erros.length > 20 ? ' …' : ''}` : ''), erros.length ? 'warn' : 'ok');
  abrir('veiculos', { semCarregando: true });
}

trabalho.addEventListener('change', async e => {
  if (!e.target.hasAttribute('data-importar-base') || !e.target.files[0]) return;
  if (demo()) { avisar('Modo demonstração: nada foi gravado.', 'info'); return; }
  if (e.target.files[0].size > 5_000_000) { avisar('Arquivo grande demais (máximo 5 MB).', 'warn'); return; }
  try { await importarBase(e.target.files[0]); } catch (err) { avisar(`Não foi possível ler a planilha: ${err.message}`, 'warn'); }
  e.target.value = '';
});

// Dica do gráfico de saída por hora
trabalho.addEventListener('pointermove', e => {
  const dica = trabalho.querySelector('.dica-graf');
  if (!dica) return;
  const alvo = e.target.closest?.('.alvo');
  if (!alvo) { dica.hidden = true; return; }
  const svgEl = alvo.ownerSVGElement, escala = svgEl.getBoundingClientRect().width / svgEl.viewBox.baseVal.width;
  const h = Number(alvo.dataset.h), atual = h === new Date().getHours();
  dica.innerHTML = `${String(h).padStart(2, '0')}h–${String(h + 1).padStart(2, '0')}h · <b>${nf(alvo.dataset.v, 0)} L</b>${atual ? ' (em andamento)' : ''}`;
  dica.style.left = `${Number(alvo.dataset.x) * escala}px`; dica.style.top = `${Number(alvo.dataset.y) * escala}px`; dica.hidden = false;
});
trabalho.addEventListener('pointerleave', () => { const d = trabalho.querySelector('.dica-graf'); if (d) d.hidden = true; });

// ---------- Gaveta do menu em tela estreita: botão, tocar fora, Esc e arrastar da borda ----------
const lado = $('lado'), veu = $('veu-menu'), app = $('app');
const estreita = () => matchMedia('(max-width: 760px)').matches;
let fracao = 0, arraste = null, suprimirClique = false;
function posicionar(f, animar) {
  fracao = Math.max(0, Math.min(1, f));
  app.classList.toggle('animar', !!animar);
  lado.style.transform = estreita() ? `translateX(${(fracao - 1) * 100}%)` : '';
  veu.style.opacity = estreita() ? fracao : 0; veu.classList.toggle('visivel', estreita() && fracao > 0);
  $('abrir-menu').setAttribute('aria-expanded', String(fracao === 1));
  if (estreita()) lado.toggleAttribute('inert', fracao === 0); else lado.removeAttribute('inert');
}
function fecharMenuSeEstreito() { if (estreita()) posicionar(0, true); }
$('abrir-menu').addEventListener('click', () => { posicionar(1, true); lado.querySelector('[aria-current="page"]')?.focus(); });
veu.addEventListener('click', () => posicionar(0, true));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('modal').hidden) { fecharModal(); return; }
  if (fracao > 0) { posicionar(0, true); $('abrir-menu').focus(); }
});
matchMedia('(max-width: 760px)').addEventListener('change', () => posicionar(0, false));
const comecar = e => { arraste = { x0: e.clientX, y0: e.clientY, f0: fracao, larg: lado.getBoundingClientRect().width || 280, ativo: false }; };
$('puxador').addEventListener('pointerdown', e => { if (fracao === 0) comecar(e); });
lado.addEventListener('pointerdown', e => { if (estreita() && fracao === 1) comecar(e); });
veu.addEventListener('pointerdown', e => { if (fracao === 1) comecar(e); });
addEventListener('pointermove', e => {
  if (!arraste) return;
  const dx = e.clientX - arraste.x0, dy = e.clientY - arraste.y0;
  if (!arraste.ativo) { if (Math.abs(dx) < 8 || Math.abs(dy) > Math.abs(dx)) return; arraste.ativo = true; }
  posicionar(arraste.f0 + dx / arraste.larg, false);
});
addEventListener('pointerup', () => {
  if (!arraste) return;
  const { ativo, f0 } = arraste; arraste = null;
  if (!ativo) return;
  posicionar(fracao >= (f0 === 0 ? 0.35 : 0.65) ? 1 : 0, true);
  suprimirClique = true; setTimeout(() => { suprimirClique = false; }, 0);
});
addEventListener('pointercancel', () => { if (arraste?.ativo) posicionar(fracao >= 0.5 ? 1 : 0, true); arraste = null; });

// ---------- Início ----------
posicionar(0, false);
if (nativo) prepararAtualizacao();
aoVoltarDoLogin(erro => (erro ? mostrarLogin(erro.message) : iniciar()));
supabase.auth.onAuthStateChange((evento, sessao) => {
  const email = sessao?.user?.email ?? null;
  if ((evento === 'SIGNED_OUT' && est.papel) || (evento === 'SIGNED_IN' && email !== est.conta)) setTimeout(iniciar, 0);
});
iniciar();
