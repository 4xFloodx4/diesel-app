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
import { prepararAtualizacao, versaoAtual } from '../comum/atualizacao.js';
import { dadosDemo } from './demo.js';

protegerContraMoldura();
aplicarTema();

// No APK o app do frentista fica na raiz; no site, em /app/
const URL_APP = __ALVO__ === 'android' ? '../index.html' : '../app/';
const $ = id => document.getElementById(id);
const trabalho = $('trabalho');
const NOME_PAPEL = { posto: 'Celular do posto', supervisor: 'Supervisor', administrador: 'Administrador', desenvolvedor: 'Desenvolvedor' };
const NIVEL = { supervisor: 1, administrador: 2, desenvolvedor: 3 };   // cada cargo pode tudo o que o de baixo pode
const STATUS_DECISAO = ['Aguardando autorização', 'Exceção', 'Erro'];
const TODOS_STATUS = ['Aguardando autorização', 'Pronto', 'Exceção', 'Em lote', 'Lançado', 'Erro', 'Cancelado'];

const est = {
  papel: null, conta: null, nome: '', tela: ler('painel-tela', 'resumo'), sel: null,
  filtros: { de: '', ate: '', status: '', placa: '' }, aud: { filtro: 'todos', busca: '', eventos: [], ctx: {} },
  guia: 'supervisor', turno: { abertura: '05:00', fechamento: '23:00' }, cad: null, carregando: 0,
};
const souAdmin = () => (NIVEL[est.papel] || 0) >= 2;   // administrador ou desenvolvedor
const souDev = () => est.papel === 'desenvolvedor';
const demo = () => souDev() && demoLigado();
// Item do menu: i[3] = 'admin' (administrador para cima) ou 'dev' (só desenvolvedor)
const podeVer = i => !i[3] || (i[3] === 'dev' ? souDev() : souAdmin());
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
    <div class="marca marca-entrada">${LOGO}<div><b>Abastecimento</b><span>Painel do diesel</span></div></div>
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
  if (!NIVEL[papel]) return mostrarLogin('Esta conta não está liberada. Peça ao administrador.');
  est.papel = papel; est.conta = conta;
  const eu = await chamar(() => consulta(supabase.from('acessos').select('nome').eq('email', conta).maybeSingle()));
  est.nome = eu?.nome || conta;
  const cfg = await chamar(() => consulta(supabase.from('configuracoes').select('*').eq('id', 1).maybeSingle()));
  if (cfg?.abertura) {
    est.turno = { abertura: String(cfg.abertura).slice(0, 5), fechamento: String(cfg.fechamento).slice(0, 5) };
    est.regras = cfg; TOL_AFERICAO = Number(cfg.tol_afericao); TOL_REGUA = Number(cfg.tol_regua);
  }
  $('app').classList.remove('sem-menu');
  if (!MENU.some(([, itens]) => itens.some(i => i[0] === est.tela && podeVer(i)))) est.tela = 'resumo';
  montarMenu();
  abrir(est.tela);
  if (nativo) versaoAtual().then(v => rpc('informar_versao', { p_versao: v })).catch(() => {});   // painel aberto no app do celular
}

// ---------- Menu lateral ----------
const svg = d => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
// Logo original do site da Ritmo (no APK o painel fica em painel/, no site também: o logo está em ../comum/)
const LOGO = '<img class="logo-ritmo" src="../comum/logo-ritmo.jpg" alt="Ritmo Logística" width="100" height="40">';
const IC = {
  grade: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  lista: '<path d="M2 4h12M2 8h8M2 12h5"/>', doc: '<path d="M3 2h10v12H3zM6 5h4M6 8h4M6 11h2"/>', gota: '<path d="M8 2s4 4.6 4 7.5a4 4 0 0 1-8 0C4 6.6 8 2 8 2z"/>',
  kmm: '<path d="M3 3h10v3H3zM3 8h10v5H3z"/>', baixar: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>', pessoa: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/>',
  caminhao: '<path d="M1.5 10.5V6h8v4.5M9.5 7.5h3l2 2v1h-5"/><circle cx="4.5" cy="11.5" r="1.5"/><circle cx="12" cy="11.5" r="1.5"/>',
  cadeado: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>', historico: '<path d="M8 3v5l3 2"/><circle cx="8" cy="8" r="6"/>',
  turno: '<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/><circle cx="8" cy="8" r="3"/>',
  ajuda: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3M8 11.4v.1"/>',
};
// [id, rótulo, ícone, quem vê: nada = todos do painel, 'admin' = administrador para cima, 'dev' = só desenvolvedor]
const MENU = [
  ['Operação', [['resumo', 'Visão do dia', 'grade'], ['decisoes', 'Decisões', 'lista'], ['abastecimentos', 'Abastecimentos', 'doc'], ['tanques', 'Tanques e fechamentos', 'gota']]],
  ['Exportar', [['turnos', 'Fechamento do turno', 'kmm'], ['relatorios', 'Relatório diário', 'doc'], ['consultas', 'Consultas', 'baixar']]],
  ['Cadastros', [['frentistas', 'Frentistas', 'pessoa'], ['veiculos', 'Veículos e motoristas', 'caminhao'], ['caminhoes', 'Caminhões de diesel', 'caminhao']]],
  ['Sistema', [['acessos', 'Acessos', 'cadeado', 'admin'], ['auditoria', 'Histórico', 'historico'], ['turno', 'Horário e regras', 'turno', 'admin']]],
  ['Desenvolvedor', [['banco', 'Banco de dados', 'grade', 'dev'], ['saude', 'Saúde do sistema', 'historico', 'dev']]],
  ['Ajuda', [['guia', 'Guia de uso', 'ajuda']]],
];
const TITULO = Object.fromEntries(MENU.flatMap(([, itens]) => itens.map(i => [i[0], i[1]])));

function montarMenu() {
  $('lado').innerHTML = `<div class="marca">${LOGO}</div>
    ${MENU.map(([grupo, itens]) => [grupo, itens.filter(podeVer)]).filter(([, itens]) => itens.length).map(([grupo, itens]) => `<div class="grupo"><h4>${grupo}</h4>${itens.map(([id, rot, ic]) =>
      `<button type="button" class="item" data-tela="${id}">${svg(IC[ic])}${rot}<span class="qtd num" data-qtd="${id}" hidden></span></button>`).join('')}</div>`).join('')}
    <div class="conta"><div><b>${esc(est.nome)}</b>${NOME_PAPEL[est.papel]}${est.nome !== est.conta ? `<br>${esc(est.conta)}` : ''}</div>
      ${souDev() ? `<div class="ajustes">${htmlChaveDemo()}</div>` : ''}
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
  marcar('decisoes', dec, true); marcar('turnos', r.Pronto || 0);
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
    : `<span class="chip ${Math.abs(dif) > TOL_REGUA ? 'alerta' : 'ok'}">Régua ${nf(med, 0)} L · diferença ${dif > 0 ? '+' : ''}${nf(dif, 0)} L</span>`;
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
const botaoComprovante = (r, texto = 'Ver') => `<button class="btn small ghost" type="button" data-acao="ver-fotos" data-entidade="abastecimento"
  data-chave="${esc(r.id)}" data-titulo="${esc(`Comprovante #${r.id} · ${r.placa}`)}">${texto}</button>`;
function tabelaLancamentos(lista, comComprovante = false) {
  if (!lista.length) return '<p class="vazio">Nenhum lançamento.</p>';
  return `<div class="tabela"><table><thead><tr><th>Nº</th><th>Data</th><th>Veículo</th><th class="n">KM</th><th class="n">Litros</th><th class="n">Bomba</th><th>Desconto</th><th>Frentista</th><th>Situação</th>${comComprovante ? '<th>Comprovante</th>' : ''}</tr></thead><tbody>
    ${lista.map(r => `<tr><td class="n">#${esc(r.id)}</td><td class="num">${r.data_hora.slice(0, 10) === hojeISO() ? hora(r.data_hora) : dataHora(r.data_hora)}</td>
      <td>${placa(r.placa)}<span class="sub">${esc(r.motorista)}</span></td><td class="n">${nf(r.km, 0)}</td><td class="n">${nf(r.litros)}</td><td class="n">${esc(r.bomba)}</td>
      <td>${r.desconto_confirmado ? 'Sim' : '<b>Não</b>'}${r.fora_horario ? '<span class="sub">fora do horário</span>' : ''}</td><td>${esc(r.frentistas?.nome || '')}</td>
      <td>${pill(r.status)}${r.problemas?.length ? `<span class="sub">${esc(r.problemas.join(' '))}</span>` : ''}</td>${comComprovante ? `<td>${botaoComprovante(r)}</td>` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}

TELAS.resumo = async () => {
  const r = await carregar(async () => {
    const [hoje, abHoje, pend, prontos, ultLote, bombas, af, preco] = await Promise.all([
      rpc('calcular_fechamento', { p_dia: hojeISO() }),
      consulta(supabase.from('abastecimentos').select('id, data_hora, placa, motorista, km, litros, bomba, status, problemas, desconto_confirmado, fora_horario, frentistas(nome)')
        .gte('data_hora', hojeISO()).order('data_hora', { ascending: false }).limit(2000)),
      consulta(supabase.from('abastecimentos').select('*, frentistas(nome)').in('status', STATUS_DECISAO).order('data_hora', { ascending: false }).limit(200)),
      consulta(supabase.from('abastecimentos').select('litros').eq('status', 'Pronto').limit(10000)),
      consulta(supabase.from('lotes').select('*').eq('situacao', 'Confirmado').order('id', { ascending: false }).limit(1)),
      consulta(supabase.from('bombas').select('numero').eq('ativa', true).order('numero')),
      consulta(supabase.from('afericoes').select('bomba, data_hora').order('data_hora', { ascending: false }).limit(500)),
      consulta(supabase.from('precos_diesel').select('preco, origem, criado_em, frentistas(nome)').order('id', { ascending: false }).limit(1)),
    ]);
    return { hoje, abHoje, pend, prontos, ultLote: ultLote[0], bombas, af, preco: preco[0] };
  }, d => ({ hoje: d.hoje, abHoje: d.abastecimentos.filter(a => a.data_hora.startsWith(hojeISO())), pend: d.abastecimentos.filter(a => STATUS_DECISAO.includes(a.status)),
    prontos: d.abastecimentos.filter(a => a.status === 'Pronto'), ultLote: d.lotes.find(l => l.situacao === 'Confirmado'),
    bombas: d.bombas.filter(b => b.ativa), af: d.afericoes, preco: d.precos[0] }));
  if (!r) return;
  const saida = r.hoje.reduce((s, t) => s + Number(t.saidas), 0);
  const nAut = r.pend.filter(a => a.status === 'Aguardando autorização').length;
  const fechado = r.hoje.length && r.hoje.every(t => t.fechado);
  const l = r.ultLote;
  const validos = r.abHoje.filter(a => a.status !== 'Cancelado');
  return `${cabeca('Visão do dia', `${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })} · atualizado às ${new Date().toTimeString().slice(0, 5)}`,
      `<button class="btn small ghost" type="button" data-acao="recarregar">Atualizar</button>${nativo ? '' : '<button class="btn small" type="button" data-ir="turnos">Fechamento do turno</button>'}`)}
    <section class="faixa" aria-label="Situação de hoje">
      <div><small>Saída hoje</small><b class="num">${nf(saida, 0)} L</b><em>${validos.length} abastecimento(s)</em></div>
      <div class="${r.pend.length ? 'precisa' : ''}"><small>Precisa de você</small><b class="num">${r.pend.length}</b><em>${nAut} autorização(ões) · ${r.pend.length - nAut} exceção(ões)</em></div>
      <div><small>Prontos para o KMM</small><b class="num">${r.prontos.length}</b><em>${nf(r.prontos.reduce((s, x) => s + Number(x.litros), 0), 0)} L no próximo fechamento</em></div>
      <div><small>Último lançado no KMM</small><b class="num">${l?.dia ? dataBR(l.dia).slice(0, 5) : l ? `nº ${esc(l.id)}` : '—'}</b><em>${l ? `${l.situacao === 'Confirmado' ? 'lançado' : esc(l.situacao.toLowerCase())} · ${quandoLocal(l.fechado_em || l.criado_em)}` : 'nenhum ainda'}</em></div>
      <div><small>Fechamento</small><b class="num">${fechado ? 'fechado' : 'aberto'}</b><em>turno ${esc(est.turno.abertura)}–${esc(est.turno.fechamento)}</em></div>
    </section>
    ${r.bombas.length ? `<section class="painel"><header><h2>Bombas e preço do diesel</h2><span>aferição 1 vez por semana · <button class="link" type="button" data-ir="tanques">ver aferições</button></span></header>
      <div class="corpo">${r.bombas.map(b => `<b>Bomba ${esc(b.numero)}</b> ${chipAfericao(ultimaAfericao(r.af, b.numero))}`).join(' &nbsp; ')}
        <p class="hint">${r.preco ? `Preço do litro: <b>R$ ${esc(nf(r.preco.preco, 3))}</b>, atualizado em ${quandoLocal(r.preco.criado_em)}${r.preco.frentistas?.nome ? ` por ${esc(r.preco.frentistas.nome)}` : ''}${r.preco.origem === 'chegada' ? ' (pela NF da chegada)' : ''}.`
          : 'O preço do diesel ainda não foi informado. O frentista informa no app, na tela de abastecer.'}</p></div></section>` : ''}
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
    <div class="acoes">${`<h2>${esc(r.placa)}</h2>`}${t.chips.map(([k, n]) => `<span class="chip ${k}">${n}</span>`).join('')}<span class="hint">#${esc(r.id)}</span>${botaoComprovante(r, 'Ver comprovante')}</div>
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
function consultaAbastecimentos(fl = est.filtros) {
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
      ${tabelaLancamentos(lista, true)}
    </section>`;
};

// Exportar abastecimentos: com os filtros da tela Abastecimentos, ou com o período da tela Consultas (de/até)
async function exportarExcel(de, ate) {
  const todos = [];
  const filtros = de ? { de, ate, status: '', placa: '' } : est.filtros;
  if (demo()) todos.push(...filtrarDemo(dadosDemo().abastecimentos));
  else for (let i = 0; ; i += 1000) {
    const parte = await chamar(() => consulta(consultaAbastecimentos(filtros).range(i, i + 999)));
    if (!parte) return;
    todos.push(...parte);
    if (parte.length < 1000) break;
  }
  const comprovante = demo() ? {} : await chamar(() => linksDoDrive('abastecimento', todos.map(r => r.id))) || {};
  const linhas = [['ID (requisição KMM)', 'Data e hora', 'Placa', 'Motorista', 'CPF', 'KM', 'Litros', 'Preço do litro', 'Valor total', 'Encerrante anterior', 'Encerrante',
    'Bomba', 'Tanque', 'Status', 'Problemas', 'Desconto do motorista', 'Justificativa sem desconto', 'Fora do horário', 'Justificativa fora do horário',
    'Autorizado por', 'Obs. frentista', 'Obs. supervisor', 'Frentista', 'Conta do celular', 'Recebido em', 'Fechamento do turno', 'Erro KMM', 'Comprovante'],
    ...todos.reverse().map(r => [r.id, dataHora(r.data_hora), r.placa, r.motorista, r.cpf, r.km, Number(r.litros),
      r.preco_litro == null ? '' : Number(r.preco_litro), r.valor_total == null ? '' : Number(r.valor_total), Number(r.encerrante_anterior),
      Number(r.encerrante), r.bomba, r.tanque, r.status, (r.problemas || []).join('; '), r.desconto_confirmado ? 'Sim' : 'Não',
      r.justificativa_desconto, r.fora_horario ? 'Sim' : 'Não', r.justificativa_horario, r.autorizado_por, r.obs_frentista, r.obs_supervisor,
      r.frentistas?.nome, r.conta, quandoLocal(r.recebido_em), r.lote_id, r.erro_kmm, comprovante[r.id] || ''])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Abastecimentos');
  XLSX.writeFile(wb, de ? `abastecimentos_${de}_a_${ate}.xlsx` : `abastecimentos_${hojeISO()}.xlsx`);
}

// ---------- Fotos ----------
async function verFotos(entidade, chave, titulo) {
  if (demo()) { avisar('Modo demonstração: não há fotos de exemplo.', 'info'); return; }
  const lista = await chamar(() => rpc('fotos_de', { p_entidade: entidade, p_chave: String(chave) }));
  if (!lista) return;
  // Comprovante já levado para o Google Drive saiu do Storage: abre pelo Drive (a miniatura só carrega para quem tem acesso à pasta)
  const doStorage = lista.filter(f => f.no_storage !== false);
  const assinados = await chamar(() => linksDasFotos(doStorage.map(f => f.caminho)));
  if (!assinados) return;
  const link = new Map(doStorage.map((f, i) => [f.caminho, assinados[i]]));
  const figura = (f, i) => {
    const u = link.get(f.caminho);
    if (!u && f.drive_url) {
      return `<figure><a href="${esc(f.drive_url)}" target="_blank" rel="noopener noreferrer"><img data-drive src="https://drive.google.com/thumbnail?id=${encodeURIComponent(f.drive_id)}&amp;sz=w1000" alt="Foto ${i + 1}" loading="lazy"></a>
        <figcaption class="hint">${esc(quandoLocal(f.criado_em))} · no Google Drive</figcaption>
        <a class="btn small ghost" href="${esc(f.drive_url)}" target="_blank" rel="noopener noreferrer">Abrir no Google Drive</a></figure>`;
    }
    if (!u) return `<figure><figcaption class="hint">${esc(quandoLocal(f.criado_em))} · arquivo não encontrado</figcaption></figure>`;
    return `<figure><a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(u)}" alt="Foto ${i + 1}" loading="lazy"></a>
        <figcaption class="hint">${esc(quandoLocal(f.criado_em))}${entidade === 'abastecimento' ? ' · ainda indo para o Google Drive' : ''}</figcaption>
        <button class="btn small warn" type="button" data-acao="excluir-foto" data-caminho="${esc(f.caminho)}">Excluir foto</button></figure>`;
  };
  const m = $('modal');
  Object.assign(m.dataset, { entidade, chave, titulo });
  m.innerHTML = `<div class="janela" role="dialog" aria-modal="true" aria-label="${esc(titulo)}"><div class="acoes entre"><h2>${esc(titulo)}</h2>
      <button class="btn small ghost" type="button" data-acao="fechar-modal">Fechar</button></div>
    ${lista.length ? `<div class="galeria">${lista.map(figura).join('')}</div>`
      : `<p class="hint">${entidade === 'abastecimento' ? 'Sem foto do comprovante (lançamento de antes da foto obrigatória).' : 'Sem fotos.'}</p>`}
    <p class="hint">Toque numa foto para abrir em tamanho real. Os links valem por 10 minutos. Excluir uma foto fica registrado na auditoria.</p></div>`;
  // Sem acesso à pasta do Drive neste navegador, a miniatura não carrega: fica só o botão de abrir no Drive
  m.querySelectorAll('img[data-drive]').forEach(img => img.addEventListener('error', () => img.closest('a').remove(), { once: true }));
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
let TOL_AFERICAO = 0.1, TOL_REGUA = 20;   // regras da conferência (lidas do banco ao entrar; o administrador ajusta em Horário e regras)
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
// Excluir cadastro (supervisor e administrador): os lançamentos guardam placa, nome e CPF escritos neles, então o histórico fica
const botaoExcluir = (tabela, chave, id) =>
  `<button class="btn small warn" type="button" data-acao="excluir" data-tabela="${tabela}" data-chave="${chave}" data-id="${esc(id)}">Excluir</button>`;
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
    <section class="painel"><header><h2>Fechamentos</h2><span>diferença acima de ${nf(TOL_REGUA, 0)} L fica destacada</span></header>
      ${r.fs.length ? `<div class="tabela"><table><thead><tr><th>Data</th><th>Tanque</th><th class="n">Inicial</th><th class="n">+ Chegadas</th><th class="n">− Saídas</th><th class="n">Esperado</th><th class="n">Régua</th><th class="n">Diferença</th><th>Fechado por</th><th></th></tr></thead><tbody>
      ${r.fs.map(f => `<tr class="${Math.abs(f.diferenca) > TOL_REGUA ? 'divergente' : ''}"><td>${dataBR(f.data)}</td><td>${esc(f.tanque)}</td><td class="n">${nf(f.saldo_inicial, 0)}</td>
        <td class="n">${nf(f.chegadas, 0)}</td><td class="n">${nf(f.saidas, 0)}</td><td class="n">${nf(f.saldo_calculado, 0)}</td><td class="n">${nf(f.saldo_medido, 0)}</td>
        <td class="n">${Number(f.diferenca) > 0 ? '+' : ''}${nf(f.diferenca, 0)}</td><td>${esc(f.frentistas?.nome || '')}</td><td>${botaoFotos('fechamento', f.data, `Fechamento de ${dataBR(f.data)}`, r.ff[f.data])}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="vazio">Nenhum fechamento ainda.</p>'}
      ${r.fs.length ? `<div class="corpo"><form class="formulario" data-reabrir="${esc(r.fs[0].data)}">
        <div class="field"><label class="lbl" for="re-motivo">Fechou sem querer? Reabrir o turno de ${dataBR(r.fs[0].data)}: o fechamento é apagado e o frentista volta a lançar e fecha de novo</label>
          <textarea id="re-motivo" name="motivo" rows="2" maxlength="500" required minlength="5" placeholder="Ex.: frentista fechou antes do último abastecimento"></textarea></div>
        <button class="btn small warn" type="submit">Reabrir turno de ${dataBR(r.fs[0].data)}</button></form></div>` : ''}</section>
    <section class="painel"><header><h2>Chegadas de diesel</h2><span>notas fiscais lançadas pelo posto</span></header>
      ${r.cs.length ? `<div class="tabela"><table><thead><tr><th>Data</th><th>Tanque</th><th>NF</th><th class="n">Litros</th><th class="n">Valor</th><th class="n">Régua</th><th>Caminhão</th><th>Lançado por</th><th>Alerta</th><th></th></tr></thead><tbody>
      ${r.cs.map(x => `<tr class="${x.alerta ? 'divergente' : ''}"><td>${dataHora(x.data_hora)}</td><td>${esc(x.tanque)}</td><td>${esc(x.nf)}</td><td class="n">${nf(x.litros, 0)}</td>
        <td class="n">${x.valor_total == null ? '' : `R$ ${nf(x.valor_total)}`}</td><td class="n">${x.regua_antes == null ? '' : `${nf(x.regua_antes, 0)} → ${nf(x.regua_depois, 0)}`}</td>
        <td>${esc([x.placa_caminhao, x.placa_carreta].filter(Boolean).join(' / '))}<span class="sub">${esc(x.motorista || '')}</span></td><td>${esc(x.frentistas?.nome || '')}</td>
        <td class="quebra">${esc(x.alerta || '')}</td><td>${botaoFotos('chegada', x.id, `Chegada NF ${x.nf}`, r.fc[String(x.id)])}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="vazio">Nenhuma chegada ainda.</p>'}</section>
    <section class="painel"><header><h2>Aferições</h2><span>1 vez por semana em cada bomba · medida de 20 L · diferença acima de ${nf(TOL_AFERICAO * 1000, 0)} mL fica destacada</span></header>
      ${r.af.length ? `<div class="tabela"><table><thead><tr><th>Data</th><th class="n">Bomba</th><th class="n">Medida</th><th class="n">Visor</th><th class="n">Diferença</th><th>Aferido por</th><th></th></tr></thead><tbody>
      ${r.af.map(a => `<tr class="${Math.abs(a.diferenca_l) > TOL_AFERICAO ? 'divergente' : ''}"><td>${dataHora(a.data_hora)}</td><td class="n">${esc(a.bomba)}</td>
        <td class="n">${nf(a.medida_l, 3)} L</td><td class="n">${nf(a.visor_l, 3)} L</td><td class="n">${mL(a.diferenca_l)}</td><td>${esc(a.frentistas?.nome || '')}</td>
        <td>${botaoFotos('afericao', a.id, `Aferição da bomba ${a.bomba} em ${dataBR(a.data_hora)}`, r.fa[String(a.id)])}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="vazio">Nenhuma aferição ainda.</p>'}</section>
    <div class="duas">
      <section class="painel"><header><h2>Tanques</h2><span>${c.tanques.length} cadastrado(s)</span></header>
        <div class="tabela"><table><thead><tr><th>Tanque</th><th class="n">Capacidade</th><th class="n">Saldo inicial</th><th></th></tr></thead><tbody>
          ${c.tanques.map(t => `<tr><td>${esc(t.codigo)}</td><td class="n">${nf(t.capacidade_l, 0)}</td><td class="n">${nf(t.saldo_inicial, 0)}</td><td><div class="acoes">${botaoEditar('tanques', t.codigo)}${botaoExcluir('tanques', 'codigo', t.codigo)}</div></td></tr>`).join('')}</tbody></table></div>
        <div class="corpo"><form class="formulario" data-form="tanques">
          ${campo('Código', 'codigo', 'required maxlength="20"')}${campo('Capacidade (L)', 'capacidade_l', 'class="num" inputmode="decimal" required')}
          ${campo('Saldo inicial (L)', 'saldo_inicial', 'class="num" inputmode="decimal" required')}<button class="btn small" type="submit">Salvar tanque</button></form>
          <p class="hint">O saldo inicial só vale até o primeiro fechamento. Depois, cada dia começa com a medição do anterior.</p></div></section>
      <section class="painel"><header><h2>Bombas</h2><span>${c.bombas.length} cadastrada(s)</span></header>
        <div class="tabela"><table><thead><tr><th class="n">Bomba</th><th>Tanque</th><th class="n">Encerrante inicial</th><th>Ativa</th><th>Última aferição</th><th></th></tr></thead><tbody>
          ${c.bombas.map(b => `<tr><td class="n">${esc(b.numero)}</td><td>${esc(b.tanque)}</td><td class="n">${nf(b.encerrante_inicial, 3)}</td><td>${b.ativa ? 'Sim' : 'Não'}</td>
            <td>${b.ativa ? chipAfericao(ultimaAfericao(r.af, b.numero)) : ''}</td><td><div class="acoes">${botaoEditar('bombas', b.numero)}${botaoExcluir('bombas', 'numero', b.numero)}</div></td></tr>`).join('')}</tbody></table></div>
        <div class="corpo"><form class="formulario" data-form="bombas">
          ${campo('Número', 'numero', 'class="num" inputmode="numeric" required')}
          ${rotulo('Tanque', `<select name="tanque">${c.tanques.map(t => `<option>${esc(t.codigo)}</option>`).join('')}</select>`)}
          ${campo('Encerrante inicial', 'encerrante_inicial', 'class="num" inputmode="decimal" required')}${simNao('Ativa', 'ativa')}
          <button class="btn small" type="submit">Salvar bomba</button></form></div></section>
    </div>`;
};

// ---------- Lotes do KMM ----------
function baixarLote(id, linhas, dia) { XLSX.writeFile(planilhaKMM(XLSX, linhas), dia ? `kmm_turno_${dia}_n${id}.xlsx` : `kmm_lote_${id}.xlsx`, { bookType: 'xlsx' }); }

// ---------- Exportar › Fechamento do turno (para o KMM) ----------
// Um cartão por dia fechado no app. O administrador gera a planilha do importador do KMM, confere, lança e marca como
// lançado. O supervisor só baixa. Abastecimento resolvido depois do fechamento entra no próximo, marcado "de outro dia".
const diaSemana = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
const nomeCurto = s => esc(String(s || '').split('@')[0]);
function situacaoTurno(t) {
  const gerado = t.lotes.find(l => l.situacao === 'Gerado'), lancado = [...t.lotes].reverse().find(l => l.situacao === 'Confirmado');
  if (gerado) return ['pend', 'Esperando o analista'];
  if (lancado && !t.prontos) return ['ok', `Lançado no KMM · ${nomeCurto(lancado.fechado_por)}, ${quandoLocal(lancado.fechado_em)}`];
  if (t.prontos || t.prontos_de_antes) return ['diesel', 'Pronto para exportar'];
  return ['neutro', t.abastecimentos ? 'Nada pronto para exportar' : 'Sem abastecimentos'];
}
function cartaoTurno(t, emLote) {
  const [classe, texto] = situacaoTurno(t);
  const gerados = t.lotes.filter(l => l.situacao === 'Gerado'), confirmados = t.lotes.filter(l => l.situacao === 'Confirmado');
  const rel = t.relatorio, pode = souAdmin() && !nativo;
  const passo = (feito, agora, txt) => `<div class="${feito ? 'feito' : agora ? 'agora' : ''}">${feito ? '✓ ' : ''}${txt}</div>`;
  const vaiJunto = t.prontos + t.prontos_de_antes;
  return `<section class="painel turno-card"><header><h2>${esc(diaSemana(t.dia))}</h2><span class="chip ${classe}">${texto}</span></header>
    <div class="corpo">
      <div class="passos">${passo(true, false, `Turno fechado ${quandoLocal(t.fechado_em).slice(6)}${t.fechado_por ? ` · ${esc(t.fechado_por)}` : ''}`)}
        ${passo(rel?.atualizado, false, rel ? (rel.atualizado ? 'Relatório no Drive' : 'Relatório sendo refeito') : 'Relatório sendo gerado')}
        ${passo(confirmados.length && !gerados.length && !t.prontos, gerados.length || vaiJunto, 'Conferir e lançar no KMM')}
        ${passo(confirmados.length && !gerados.length && !t.prontos, false, 'Lançado no KMM')}</div>
      <div class="numeros"><div><b class="num">${esc(t.abastecimentos)}</b>abastecimentos</div><div><b class="num">${nf(t.litros, 0)} L</b>saída</div>
        <div><b class="num">${esc(t.chegadas)}</b>chegada(s)</div>
        ${t.pendentes ? `<div class="precisa"><b class="num">${esc(t.pendentes)}</b><button class="link" type="button" data-ir="decisoes">com o supervisor</button></div>` : ''}
        ${t.prontos_de_antes ? `<div><b class="num">${esc(t.prontos_de_antes)}</b>de dias anteriores</div>` : ''}</div>
      <div class="acoes">
        ${pode && vaiJunto && !gerados.length ? `<button class="btn small" type="button" data-acao="gerar" data-dia="${esc(t.dia)}">Gerar planilha do KMM (${vaiJunto})</button>` : ''}
        ${[...gerados, ...confirmados].map(l => `<button class="btn small ghost" type="button" data-acao="baixar" data-lote="${esc(l.id)}" data-dia="${esc(t.dia)}">Planilha do KMM${t.lotes.length > 1 ? ` nº ${esc(l.id)}` : ''}</button>
          <button class="btn small ghost" type="button" data-acao="conferencia" data-lote="${esc(l.id)}" data-dia="${esc(t.dia)}">Lista para conferência</button>`).join('')}
        ${rel ? `<a class="btn small ghost" href="${esc(rel.drive_url)}" target="_blank" rel="noopener noreferrer">Relatório diário (PDF)</a>` : ''}
        ${pode ? gerados.map(l => `<button class="btn small" type="button" data-acao="confirmar" data-lote="${esc(l.id)}">Marcar como lançado no KMM</button>
          <button class="btn small ghost" type="button" data-acao="desfazer" data-lote="${esc(l.id)}">Desfazer (não lancei)</button>`).join('') : ''}
        ${pode ? confirmados.map(l => `<button class="btn small ghost" type="button" data-acao="desfazer" data-lote="${esc(l.id)}">Desfazer lançamento nº ${esc(l.id)}</button>`).join('') : ''}
      </div>
      ${gerados.length && pode ? `<details class="erros-kmm"><summary>O KMM recusou alguma linha?</summary>
        <p class="hint">Marque o erro na linha antes de marcar como lançado. Ela volta para Decisões e entra no próximo fechamento depois de corrigida.</p>
        <div class="tabela"><table><thead><tr><th>Nº</th><th>Data</th><th>Veículo</th><th class="n">Litros</th><th>Erro do KMM</th></tr></thead><tbody>
        ${emLote.filter(x => gerados.some(l => l.id === x.lote_id)).map(x => `<tr><td>#${esc(x.id)}</td><td>${dataHora(x.data_hora)}${x.data_hora.slice(0, 10) < t.dia ? ' <span class="chip hora">de outro dia</span>' : ''}</td>
          <td>${placa(x.placa)}<span class="sub">${esc(x.motorista)}</span></td><td class="n">${nf(x.litros)}</td>
          <td><div class="inline"><input data-erro="${esc(x.id)}" placeholder="Mensagem do KMM" maxlength="1000" aria-label="Erro do KMM no #${esc(x.id)}"><button class="btn small ghost" type="button" data-acao="erro" data-id="${esc(x.id)}">Marcar erro</button></div></td></tr>`).join('')}
        </tbody></table></div></details>` : ''}
    </div></section>`;
}
const turnosDemo = d => d.fechamentos.map(f => ({ dia: f.data, fechado_em: `${f.data}T23:02:00`, fechado_por: f.frentistas?.nome, abastecimentos: 24, litros: 9870, pendentes: 0,
  prontos: 0, prontos_de_antes: 0, chegadas: 0, relatorio: null, lotes: d.lotes.filter(l => l.situacao === 'Confirmado').map(l => ({ ...l, fechado_por: 'Administrador (demo)' })) }));

TELAS.turnos = async () => {
  const r = await carregar(async () => ({
    ts: await rpc('turnos_kmm', { p_limite: 30 }),
    emLote: await consulta(supabase.from('abastecimentos').select('id, data_hora, placa, motorista, litros, lote_id').eq('status', 'Em lote').order('data_hora')),
  }), d => ({ ts: turnosDemo(d), emLote: [] }));
  if (!r) return;
  return `${cabeca('Fechamento do turno', 'Cada turno fechado no app vira uma planilha no modelo do importador do KMM (Importação de abastecimento › Interno) e um relatório diário em PDF.')}
    ${nativo ? soComputador('No celular é só consulta. Gerar a planilha, baixar e marcar como lançado é feito no computador.') : ''}
    ${!souAdmin() && !nativo ? soComputador('Você baixa a planilha e o relatório. Gerar a planilha e marcar como lançado no KMM é com o administrador.') : ''}
    ${r.ts.length ? r.ts.map(t => cartaoTurno(t, r.emLote)).join('') : '<div class="sem-dados"><b>Nenhum turno fechado ainda</b>O cartão do turno aparece aqui quando o frentista toca em Fechar turno no app.</div>'}`;
};

// ---------- Exportar › Relatório diário ----------
TELAS.relatorios = async () => {
  const ts = await carregar(() => rpc('turnos_kmm', { p_limite: 60 }), d => turnosDemo(d));
  if (!ts) return;
  return `${cabeca('Relatório diário', 'A folha do dia no modelo da Ritmo, preenchida sozinha depois do fechamento do turno e guardada no Google Drive.')}
    <section class="painel"><div class="tabela"><table><thead><tr><th>Dia</th><th>Turno fechado</th><th class="n">Abastecimentos</th><th class="n">Chegadas</th><th>Relatório</th></tr></thead><tbody>
    ${ts.map(t => `<tr><td>${esc(diaSemana(t.dia))}</td><td>${quandoLocal(t.fechado_em)}${t.fechado_por ? `<span class="sub">${esc(t.fechado_por)}</span>` : ''}</td>
      <td class="n">${esc(t.abastecimentos)}</td><td class="n">${esc(t.chegadas)}</td>
      <td>${t.relatorio ? `<a class="lk" href="${esc(t.relatorio.drive_url)}" target="_blank" rel="noopener noreferrer">Abrir PDF</a>${t.relatorio.atualizado ? '' : '<span class="sub">turno reaberto: o PDF vai ser refeito</span>'}`
        : '<span class="hint">Sendo gerado (até 10 minutos depois do fechamento)</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="vazio">Nenhum turno fechado ainda.</td></tr>'}
    </tbody></table></div></section>
    <p class="hint">O PDF fica no Drive em Abastecimentos › mês › dia, junto com os comprovantes. Para imprimir, abra o PDF e imprima; a assinatura fica em branco para o carimbo do analista.</p>`;
};

// ---------- Exportar › Consultas (Excel com detalhes) ----------
const EXPORTS = [
  ['abastecimentos', 'Abastecimentos', 'Todos os campos de cada lançamento, com o link do comprovante no Drive.'],
  ['chegadas', 'Chegadas de diesel', 'NF, litros, valor, régua antes e depois, caminhão, carreta, motorista e quem recebeu.'],
  ['afericoes', 'Aferições', 'Bomba, litros do visor na medida de 20 L, diferença, quem fez e o link da foto.'],
  ['decisoes', 'Decisões', 'Autorizações, correções, cancelamentos e turnos reabertos: o quê, por quem e com qual motivo.'],
  ['fechamentos', 'Fechamentos de tanque', 'Saldo inicial, chegadas, saídas, esperado, régua e diferença de cada dia.'],
  ['precos', 'Preço do diesel', 'Cada mudança do preço do litro, com quem mudou e de onde veio.'],
];
TELAS.consultas = async () => {
  const fim = hojeISO(), ini = new Date(Date.now() - 30 * 86400000).toLocaleDateString('sv-SE');
  return `${cabeca('Consultas', 'Planilhas em Excel com todos os detalhes, para conferir, guardar ou mandar para alguém.')}
    ${nativo ? soComputador('As planilhas são baixadas no computador.') : ''}
    <section class="painel"><div class="corpo">
      <form class="filtros" data-periodo><div class="field"><label class="lbl" for="ex-de">De</label><input id="ex-de" name="de" type="date" value="${ini}"></div>
        <div class="field"><label class="lbl" for="ex-ate">Até</label><input id="ex-ate" name="ate" type="date" value="${fim}"></div></form>
      <div class="lista-exp">${EXPORTS.map(([id, rot, txt]) => `<div><b>${rot}</b><span>${txt}</span>
        ${nativo ? '' : `<button class="btn small ghost" type="button" data-acao="exportar-consulta" data-tipo="${id}">Baixar Excel</button>`}</div>`).join('')}
        <div><b>Histórico</b><span>Tudo o que foi feito no sistema, em linguagem simples.</span><button class="btn small ghost" type="button" data-ir="auditoria">Abrir o histórico</button></div>
      </div></div></section>`;
};
async function todasAsLinhas(montar) {   // o Supabase devolve no máximo 1000 por vez
  const todos = [];
  for (let de = 0; ; de += 1000) {
    const parte = await consulta(montar().range(de, de + 999));
    todos.push(...parte);
    if (parte.length < 1000) return todos;
  }
}
async function linksDoDrive(entidade, chaves) {
  const m = {};
  for (let i = 0; i < chaves.length; i += 150) {
    const r = await consulta(supabase.from('fotos').select('chave, drive_url').eq('entidade', entidade).in('chave', chaves.slice(i, i + 150).map(String)));
    for (const f of r) m[f.chave] = f.drive_url || m[f.chave] || 'no Supabase (indo para o Drive)';
  }
  return m;
}
async function exportarConsulta(tipo) {
  const de = $('ex-de')?.value, ate = $('ex-ate')?.value;
  if (!de || !ate || de > ate) { avisar('Confira o período: a data inicial vem antes da final.', 'warn'); return; }
  const ateFim = new Date(new Date(`${ate}T12:00:00`).getTime() + 86400000).toLocaleDateString('sv-SE');
  const periodo = (q, col) => q.gte(col, de).lt(col, ateFim);
  let cab, linhas;
  if (tipo === 'abastecimentos') return exportarExcel(de, ate);
  if (tipo === 'chegadas') {
    const r = await todasAsLinhas(() => periodo(supabase.from('chegadas').select('*, frentistas(nome)'), 'data_hora').order('data_hora'));
    const fotos = await linksDoDrive('chegada', r.map(x => x.id));
    cab = ['Data e hora', 'Tanque', 'NF', 'Litros', 'Valor total', 'Régua antes', 'Régua depois', 'Placa do cavalo', 'Placa da carreta', 'Motorista', 'CPF', 'Alerta', 'Recebido por', 'Cancelada', 'Foto'];
    linhas = r.map(x => [dataHora(x.data_hora), x.tanque, x.nf, Number(x.litros), x.valor_total == null ? '' : Number(x.valor_total), x.regua_antes ?? '', x.regua_depois ?? '',
      x.placa_caminhao || '', x.placa_carreta || '', x.motorista || '', x.cpf || '', x.alerta || '', x.frentistas?.nome || '', x.cancelada ? 'Sim' : 'Não', fotos[x.id] || '']);
  } else if (tipo === 'afericoes') {
    const r = await todasAsLinhas(() => periodo(supabase.from('afericoes').select('*, frentistas(nome)'), 'data_hora').order('data_hora'));
    const fotos = await linksDoDrive('afericao', r.map(x => x.id));
    cab = ['Data e hora', 'Bomba', 'Medida (L)', 'Visor (L)', 'Diferença (mL)', 'Fora da tolerância', 'Encerrante antes', 'Encerrante depois', 'Frentista', 'Foto'];
    linhas = r.map(x => [dataHora(x.data_hora), x.bomba, Number(x.medida_l), Number(x.visor_l), Math.round(Number(x.diferenca_l) * 1000), Math.abs(Number(x.diferenca_l)) > TOL_AFERICAO ? 'Sim' : 'Não',
      Number(x.encerrante_anterior), Number(x.encerrante), x.frentistas?.nome || '', fotos[x.id] || '']);
  } else if (tipo === 'decisoes') {
    const acoes = ['autorizacao.aprovada', 'autorizacao.recusada', 'abastecimento.revalidar', 'abastecimento.aprovar', 'abastecimento.cancelar', 'abastecimento.erro_kmm', 'turno.reaberto', 'lote.confirmar', 'lote.desfazer'];
    const [r, contas] = await Promise.all([todasAsLinhas(() => periodo(supabase.from('auditoria').select('*').in('acao', acoes), 'quando').order('quando')),
      consulta(supabase.from('acessos').select('email, nome'))]);
    const ctx = { contas: Object.fromEntries(contas.map(a => [a.email, a.nome])), frentistas: {} };
    const texto = html => new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
    cab = ['Data e hora', 'Quem', 'Cargo', 'O que fez', 'Motivo', 'Registro'];
    linhas = r.map(e => { const x = descrever(e, ctx); return [new Date(e.quando).toLocaleString('pt-BR'), x.quem, x.papel, texto(x.frase), x.motivo || '', [e.entidade, e.entidade_id].filter(Boolean).join(' ')]; });
  } else if (tipo === 'fechamentos') {
    const r = await todasAsLinhas(() => supabase.from('fechamentos').select('*, frentistas(nome)').gte('data', de).lte('data', ate).order('data').order('tanque'));
    cab = ['Dia', 'Tanque', 'Saldo inicial', '+ Chegadas', '− Saídas', 'Esperado', 'Régua (medido)', 'Diferença', 'Fechado por', 'Fechado em'];
    linhas = r.map(f => [dataBR(f.data), f.tanque, Number(f.saldo_inicial), Number(f.chegadas), Number(f.saidas), Number(f.saldo_calculado), Number(f.saldo_medido),
      Number(f.diferenca), f.frentistas?.nome || '', quandoLocal(f.criado_em)]);
  } else if (tipo === 'precos') {
    const r = await todasAsLinhas(() => periodo(supabase.from('precos_diesel').select('*, frentistas(nome)'), 'criado_em').order('id'));
    cab = ['Quando', 'Preço do litro', 'Origem', 'Quem mudou'];
    linhas = r.map(p => [quandoLocal(p.criado_em), Number(p.preco), { app: 'Digitado no app', chegada: 'Pela NF da chegada', painel: 'Painel' }[p.origem] || p.origem, p.frentistas?.nome || p.conta]);
  } else return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cab, ...linhas]), EXPORTS.find(x => x[0] === tipo)[1].slice(0, 31));
  XLSX.writeFile(wb, `${tipo}_${de}_a_${ate}.xlsx`);
  avisar(`${linhas.length} linha(s) exportada(s).`);
}

// Lista para conferência: o que vai na planilha do KMM, legível, com uma coluna para marcar e o total
function baixarConferencia(lote, dia, linhas) {
  const cab = ['Nº requisição', 'Data e hora', 'Placa', 'Motorista', 'KM', 'Litros', 'Bomba', 'Preço do litro', 'Valor total', 'Observação', 'Conferido'];
  const corpo = linhas.map(l => [Number(l.requisicao), dataHora(l.data_hora), l.placa, l.motorista || '', Number(l.km), Number(l.litros), Number(l.bomba),
    l.preco == null ? '' : Number(l.preco), l.valor_total == null ? '' : Number(l.valor_total), l.de_outro_dia ? `de ${dataBR(l.data_hora).slice(0, 5)}` : '', '☐']);
  const total = ['', '', '', 'Total', '', linhas.reduce((s, l) => s + Number(l.litros), 0), '', '', linhas.reduce((s, l) => s + (Number(l.valor_total) || 0), 0), `${linhas.length} abastecimento(s)`, ''];
  const ws = XLSX.utils.aoa_to_sheet([[`Fechamento do turno de ${dataBR(dia)} · planilha nº ${lote}`], [], cab, ...corpo, [], total, [], ['Conferido por:', '', '', 'Data:', '', '', 'Assinatura:']]);
  ws['!cols'] = [12, 17, 10, 24, 10, 9, 7, 12, 12, 14, 10].map(wch => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Conferência');
  XLSX.writeFile(wb, `conferencia_turno_${dia}_n${lote}.xlsx`);
}

// ---------- Desenvolvedor › Banco de dados ----------
// Escolha a tabela, procure, toque na célula e mude. As mudanças ficam esperando até Salvar; cada uma vai para o histórico.
// As proteções do banco continuam valendo (abastecimento não se apaga, foto registrada não muda, PIN nunca aparece).
est.banco = { tabela: 'abastecimentos', estrutura: null, linhas: [], pend: {}, novo: null, busca: '' };
const valorCelula = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const chaveLinha = (t, l) => JSON.stringify(Object.fromEntries(t.chave.map(k => [k, l[k]])));
TELAS.banco = async () => {
  if (!souDev()) return TELAS.resumo();
  const b = est.banco;
  if (!b.estrutura) { b.estrutura = await chamar(() => rpc('dev_estrutura')); if (!b.estrutura) return; }
  const t = b.estrutura.find(x => x.tabela === b.tabela) || b.estrutura[0];
  b.tabela = t.tabela;
  const linhas = await chamar(() => consulta(supabase.from(t.tabela).select('*').order(t.chave[0], { ascending: false }).limit(300)));
  if (!linhas) return;
  b.linhas = linhas; b.pend = {}; b.novo = null;
  return `${cabeca('Banco de dados', 'Toque numa célula para mudar. Nada é gravado até você tocar em Salvar; cada mudança vai para o histórico com o seu nome.',
      `<button class="btn small ghost" type="button" data-acao="recarregar">Recarregar</button>`)}
    <section class="painel"><div class="corpo">
      <div class="tabs-db">${b.estrutura.map(x => `<button type="button" data-db-tabela="${esc(x.tabela)}" aria-pressed="${x.tabela === t.tabela}">${esc(x.tabela)}</button>`).join('')}</div>
      <div class="filtros-db"><input id="db-busca" placeholder="Procurar nas linhas carregadas" value="${esc(b.busca)}" autocomplete="off">
        <span class="hint">${linhas.length} linha(s)${linhas.length === 300 ? ' (as 300 mais recentes)' : ''} · chave: ${esc(t.chave.join(' + '))}</span>
        <button class="btn small ghost" type="button" data-acao="db-nova">+ Nova linha</button></div>
      <div class="aviso-db" id="db-pend" hidden></div>
      <div class="tabela grade-db"><table><thead><tr>${t.colunas.map(c => `<th title="${esc(c.tipo)}">${esc(c.nome)}${c.editavel ? '' : ' 🔒'}</th>`).join('')}<th></th></tr></thead>
        <tbody id="db-corpo">${linhasBanco(t, linhas)}</tbody></table></div>
      <p class="hint">🔒 coluna calculada ou numeração automática: não muda. Campo vazio grava vazio (nulo). Listas e objetos são JSON.</p>
    </div></section>`;
};
function linhasBanco(t, linhas) {
  const q = est.banco.busca.trim().toLowerCase();
  return linhas.filter(l => !q || JSON.stringify(l).toLowerCase().includes(q)).map(l => {
    const k = chaveLinha(t, l);
    return `<tr data-db-linha="${esc(k)}">${t.colunas.map(c => `<td class="${c.editavel ? 'ed' : ''}" data-db-col="${esc(c.nome)}">${esc(valorCelula(l[c.nome]))}</td>`).join('')}
      <td><button class="btn small warn" type="button" data-acao="db-apagar" data-db-chave="${esc(k)}">Apagar</button></td></tr>`;
  }).join('');
}
function mostrarPendentes() {
  const b = est.banco, n = Object.values(b.pend).reduce((s, x) => s + Object.keys(x).length, 0) + (b.novo ? 1 : 0);
  const el = $('db-pend'); if (!el) return;
  el.hidden = !n;
  el.innerHTML = n ? `${n} mudança(s) esperando. <button class="btn small" type="button" data-acao="db-salvar">Salvar</button>
    <button class="btn small ghost" type="button" data-acao="db-desfazer">Desfazer</button>` : '';
}
// Texto digitado → valor para o banco: vazio é nulo; JSON para listas e objetos; sim/não para booleano
function valorDigitado(tipo, txt) {
  if (txt === '') return null;
  if (tipo === 'boolean') return /^(true|sim|s|1)$/i.test(txt.trim());
  if (/json/.test(tipo)) { try { return JSON.parse(txt); } catch { throw new Error(`O campo JSON está mal escrito: ${txt.slice(0, 40)}`); } }
  return txt;
}
trabalho.addEventListener('click', e => {
  const td = e.target.closest('td.ed[data-db-col]');
  if (!td || td.querySelector('input')) return;
  const tr = td.closest('tr'), atual = td.textContent;
  td.innerHTML = `<input value="${esc(atual)}" aria-label="${esc(td.dataset.dbCol)}">`;
  const inp = td.querySelector('input'); inp.focus(); inp.select();
  const fim = () => {
    const b = est.banco, novo = inp.value, k = tr.dataset.dbLinha;
    td.textContent = novo;
    if (k === 'novo') { b.novo[td.dataset.dbCol] = novo; }
    else if (novo !== valorCelula(b.linhas.find(l => chaveLinha(b.estrutura.find(x => x.tabela === b.tabela), l) === k)?.[td.dataset.dbCol])) {
      (b.pend[k] ||= {})[td.dataset.dbCol] = novo; td.classList.add('mudou');
    }
    mostrarPendentes();
  };
  inp.addEventListener('blur', fim, { once: true });
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = atual; inp.blur(); } });
});
trabalho.addEventListener('input', e => {
  if (e.target.id !== 'db-busca') return;
  const b = est.banco; b.busca = e.target.value;
  const t = b.estrutura.find(x => x.tabela === b.tabela);
  $('db-corpo').innerHTML = linhasBanco(t, b.linhas);
});
async function salvarBanco() {
  const b = est.banco, t = b.estrutura.find(x => x.tabela === b.tabela), tipo = Object.fromEntries(t.colunas.map(c => [c.nome, c.tipo]));
  const converter = m => Object.fromEntries(Object.entries(m).map(([c, v]) => [c, valorDigitado(tipo[c], v)]));
  let feitos = 0;
  try {
    if (b.novo) { await rpc('dev_salvar', { p_tabela: t.tabela, p_chave: null, p_valores: converter(Object.fromEntries(Object.entries(b.novo).filter(([, v]) => v !== ''))) }); feitos++; }
    for (const [k, m] of Object.entries(b.pend)) { await rpc('dev_salvar', { p_tabela: t.tabela, p_chave: JSON.parse(k), p_valores: converter(m) }); feitos++; }
    avisar(`${feitos} linha(s) salva(s). Ficou no histórico.`);
  } catch (err) { avisar(`${feitos ? `${feitos} linha(s) salva(s); ` : ''}a próxima deu erro: ${err.message}`, 'warn'); }
  abrir('banco', { semCarregando: true });
}

// ---------- Desenvolvedor › Saúde do sistema ----------
const tamanho = b => b == null ? '—' : b > 1e9 ? `${nf(b / 1e9, 2)} GB` : `${nf(b / 1e6, 1)} MB`;
TELAS.saude = async () => {
  if (!souDev()) return TELAS.resumo();
  const [s, publicada] = await Promise.all([chamar(() => rpc('dev_saude')),
    fetch(`../atualizacao/versao.json?t=${Date.now()}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)]);
  if (!s) return;
  const fila = s.comprovantes_na_fila, parado = s.fila_desde && Date.now() - new Date(s.fila_desde).getTime() > 30 * 60000;
  const v = publicada?.version;
  return `${cabeca('Saúde do sistema', 'Se o script do Google parou, se o espaço está acabando e se algum celular ficou numa versão antiga.',
      '<button class="btn small ghost" type="button" data-acao="recarregar">Atualizar</button>')}
    <section class="faixa" data-colunas="4">
      <div class="${parado ? 'precisa' : ''}"><small>Comprovantes indo para o Drive</small><b class="num">${esc(fila)}</b><em>${fila ? `o mais antigo desde ${quandoLocal(s.fila_desde)}` : 'nenhum esperando'}</em></div>
      <div><small>Último enviado ao Drive</small><b class="num">${s.ultimo_no_drive ? quandoLocal(s.ultimo_no_drive) : '—'}</b><em>relatórios esperando: ${esc(s.relatorios_esperando)}</em></div>
      <div><small>Banco de dados</small><b class="num">${tamanho(s.banco_bytes)}</b><em>de 500 MB no plano grátis</em></div>
      <div><small>Fotos no Supabase</small><b class="num">${tamanho(s.fotos_bytes)}</b><em>de 1 GB no plano grátis</em></div>
    </section>
    ${parado ? soComputador('Há comprovante esperando há mais de 30 minutos: o script do Google pode ter parado. Veja Execuções em script.google.com.') : ''}
    <section class="painel"><header><h2>Versão das telas em cada celular</h2><span>publicada agora: ${v ? esc(v.slice(0, 7)) : 'não consegui ler'}</span></header>
      <div class="tabela"><table><thead><tr><th>Conta</th><th>Versão</th><th>Última vez visto</th><th></th></tr></thead><tbody>
      ${s.aparelhos.map(a => `<tr><td>${esc(a.nome || a.conta)}<span class="sub">${esc(a.conta)}</span></td><td class="num">${esc(String(a.versao).slice(0, 7))}</td>
        <td>${quandoLocal(a.visto_em)}</td><td>${!v ? '' : a.versao === v ? '<span class="chip ok">em dia</span>' : '<span class="chip alerta">versão antiga: feche e abra o app</span>'}</td></tr>`).join('')
        || '<tr><td colspan="4" class="vazio">Nenhum celular avisou a versão ainda (aparece depois que o app novo abrir).</td></tr>'}
      </tbody></table></div></section>`;
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
// ---------- Cadastros › Caminhões de diesel (fornecedor) ----------
// O frentista cadastra na chegada; aqui o supervisor corrige, desativa ou exclui. O CPF não aparece inteiro.
TELAS.caminhoes = async () => {
  const lista = await carregar(() => consulta(supabase.from('caminhoes_diesel').select('*').order('ativo', { ascending: false }).order('placa_cavalo')), () => []);
  if (!lista) return;
  est.cad = { ...(est.cad || {}), caminhoes_diesel: lista };
  return `${cabeca('Caminhões de diesel', 'Os caminhões que trazem o diesel. Na chegada, o frentista digita o começo da placa do cavalo e o resto vem preenchido.')}
    <section class="painel"><header><h2>Cadastrar ou corrigir</h2><span>CPF em branco mantém o que já está no cadastro</span></header><div class="corpo">
      <form class="formulario" data-form="caminhoes_diesel">
        ${campo('Placa do cavalo', 'placa_cavalo', 'required maxlength="8" autocomplete="off"')}${campo('Placa da carreta', 'placa_carreta', 'maxlength="8" autocomplete="off"')}
        ${campo('Motorista', 'motorista', 'maxlength="120" autocomplete="off"')}${campo('CPF do motorista', 'cpf', 'class="num" inputmode="numeric" maxlength="14" autocomplete="off"')}
        ${simNao('Ativo', 'ativo')}<button class="btn small" type="submit">Salvar caminhão</button></form></div></section>
    <section class="painel"><header><h2>Cadastrados</h2><span>${lista.length} caminhão(ões)</span></header>
      ${lista.length ? `<div class="tabela"><table><thead><tr><th>Cavalo</th><th>Carreta</th><th>Motorista</th><th>CPF</th><th>Ativo</th><th></th></tr></thead><tbody>
      ${lista.map(c => `<tr><td>${placa(c.placa_cavalo)}<span class="sub">${esc(c.criado_por || 'Painel')}</span></td><td>${c.placa_carreta ? placa(c.placa_carreta) : '—'}</td>
        <td>${esc(c.motorista || '—')}</td><td>${c.cpf ? `***.***.***-${esc(c.cpf.slice(-2))}` : '<span class="chip alerta">sem CPF</span>'}</td><td>${c.ativo ? 'Sim' : 'Não'}</td>
        <td><div class="acoes">${botaoEditar('caminhoes_diesel', c.placa_cavalo)}${botaoExcluir('caminhoes_diesel', 'placa_cavalo', c.placa_cavalo)}</div></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="vazio">Nenhum caminhão ainda. O primeiro aparece quando o frentista registrar uma chegada de diesel com a placa do cavalo.</p>'}</section>`;
};

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
          ${campo('Placa', 'placa', 'required maxlength="8" autocomplete="off"')}${campo('Tanque do veículo (L)', 'capacidade_l', 'class="num" inputmode="decimal" required value="1100"')}
          ${campo('Último KM conhecido', 'km_inicial', 'class="num" inputmode="numeric"')}${simNao('Ativo', 'ativo')}
          <button class="btn small" type="submit">Salvar veículo</button></form></div>
        <div class="tabela"><table><thead><tr><th>Placa</th><th class="n">Tanque</th><th class="n">KM inicial</th><th>Ativo</th><th>Motoristas</th><th></th></tr></thead><tbody>
        ${c.veiculos.map(v => `<tr><td>${placa(v.placa)}<span class="sub">${esc(v.criado_por || 'Painel')}</span></td><td class="n">${v.capacidade_l == null ? '<span class="chip pend">a informar</span>' : nf(v.capacidade_l, 0)}</td><td class="n">${nf(v.km_inicial, 0)}</td><td>${v.ativo ? 'Sim' : 'Não'}</td>
          <td class="quebra">${(porPlaca[v.placa] || []).map(x => `<span class="vinculo">${esc(x.motoristas?.nome || '')}<button type="button" class="link" data-acao="desvincular"
            data-id="${esc(v.placa)}" data-motorista="${esc(x.motorista_id)}" aria-label="Tirar ${esc(x.motoristas?.nome || '')} da placa ${esc(v.placa)}">×</button></span>`).join(' ')}</td>
          <td><div class="acoes">${botaoEditar('veiculos', v.placa)}${botaoFotos('veiculo', v.placa, `Veículo ${v.placa}`, c.fv[v.placa])}
            <button class="btn small ghost" type="button" data-acao="foto-veiculo" data-id="${esc(v.placa)}">+ Foto</button>${botaoExcluir('veiculos', 'placa', v.placa)}</div></td></tr>`).join('')}</tbody></table></div>
        <div class="corpo"><p class="hint">Placa errada? Exclua e cadastre a certa. Os abastecimentos já lançados continuam no histórico com a placa que tinham.</p></div></section>
      <section class="painel"><header><h2>Motoristas</h2><span>${c.motoristas.length} cadastrado(s)</span></header>
        <div class="corpo"><form class="formulario" data-form="motoristas">
          ${campo('Nome completo', 'nome', 'required maxlength="120" autocomplete="off"')}${campo('CPF', 'cpf', 'class="num" inputmode="numeric" required maxlength="14" autocomplete="off"')}
          ${simNao('Ativo', 'ativo')}<button class="btn small" type="submit">Salvar motorista</button></form>
          <p class="hint">Ao editar um motorista, digite o CPF completo de novo (na lista ele aparece mascarado).</p></div>
        <div class="tabela"><table><thead><tr><th>Nome</th><th>CPF</th><th>Ativo</th><th></th></tr></thead><tbody>
        ${c.motoristas.map(m => `<tr><td>${esc(m.nome)}<span class="sub">${esc(m.criado_por || 'Painel')}</span></td><td class="num">${m.cpf ? mascaraCpf(m.cpf) : '<span class="chip pend">a informar</span>'}</td><td>${m.ativo ? 'Sim' : 'Não'}</td>
          <td><div class="acoes">${botaoEditar('motoristas', m.id)}${botaoExcluir('motoristas', 'id', m.id)}</div></td></tr>`).join('')}</tbody></table></div>
        <div class="corpo"><p class="hint">Excluir tira o motorista das listas do app; os abastecimentos dele continuam no histórico, com nome e CPF.</p></div></section>
    </div>`;
};

function editarCadastro(tabela, id) {
  const lista = est.cad?.[tabela];
  const chave = { veiculos: 'placa', motoristas: 'id', tanques: 'codigo', bombas: 'numero', caminhoes_diesel: 'placa_cavalo' }[tabela];
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
  if (!souAdmin()) return TELAS.resumo();   // contas: administrador para cima
  const lista = await carregar(() => consulta(supabase.from('acessos').select('*').order('papel').order('nome')), d => d.acessos);
  if (!lista) return;
  // Celular e supervisor: administrador ou desenvolvedor. Administrador: só o desenvolvedor. Desenvolvedor: só pelo SQL.
  const podeMexer = a => ['posto', 'supervisor'].includes(a.papel) ? souAdmin() : a.papel === 'administrador' && souDev();
  const acoes = a => {
    if (a.papel === 'desenvolvedor') return '<span class="hint">Só pelo Supabase</span>';
    if (!podeMexer(a)) return '<span class="hint">Só o desenvolvedor altera</span>';
    return `<div class="acoes">${botaoAtivo('acessos', 'email', a.email, 'ativo', a.ativo).replace('Desativar', 'Bloquear').replace('Reativar', 'Liberar')}
      <button class="btn small warn" type="button" data-acao="excluir" data-tabela="acessos" data-chave="email" data-id="${esc(a.email)}">Excluir</button></div>`;
  };
  return `${cabeca('Acessos', 'Só as contas Google desta lista usam o sistema. Qualquer outra conta que tentar entrar não vê nada.')}
    <section class="painel"><header><h2>Liberar uma conta Google</h2></header><div class="corpo">
      <form class="formulario" data-form="acessos">
        ${campo('E-mail da conta Google', 'email', 'type="email" required autocomplete="off"')}${campo('Nome', 'nome', 'required maxlength="120" placeholder="Ex.: Celular posto 1"')}
        ${rotulo('Tipo', `<select name="papel"><option value="posto">Celular do posto</option><option value="supervisor">Supervisor</option>${souDev() ? '<option value="administrador">Administrador</option>' : ''}</select>`)}
        ${simNao('Ativo', 'ativo')}<button class="btn small" type="submit">Salvar</button></form>
      <p class="hint">${souDev() ? 'Como desenvolvedor, você libera celulares do posto, supervisores e administradores.' : 'Você libera celulares do posto e supervisores. Administradores são liberados pelo desenvolvedor.'}
        Contas de desenvolvedor só são criadas pelo Supabase (arquivo supabase/uma-vez/virar-desenvolvedor.sql).</p></div></section>
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
    <p class="hint">Últimos 500 registros. O histórico não pode ser alterado nem apagado.${souAdmin() ? ' Supervisores não veem as ações de administradores e do desenvolvedor.' : ' Ações de administradores e do desenvolvedor não aparecem aqui.'}</p>`;
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
  return `${cabeca('Horário e regras', 'O horário do turno e as regras que a conferência usa no app e no banco.')}
    <section class="painel estreito-560"><header><h2>Turno do posto</h2><span>vale para todos os celulares</span></header><div class="corpo">
      <form class="formulario" data-turno>
        ${campo('Abertura', 'abertura', `type="time" required value="${esc(t.abertura)}"`)}
        ${campo('Fechamento', 'fechamento', `type="time" required value="${esc(t.fechamento)}"`)}
        <button class="btn small" type="submit">Salvar horário</button></form>
      <p class="hint">Depois que o turno do dia é fechado no app, nada mais entra com a data daquele dia. A mudança fica na auditoria.</p></div></section>
    ${blocoRegras()}`;
};

// Regras da conferência: o app e o banco usam os mesmos valores; a mudança vale na hora para os próximos lançamentos
function blocoRegras() {
  const g = est.regras || {};
  const num = (rot, nome, valor, extra, dica) => `${campo(rot, nome, `class="num" inputmode="decimal" required value="${esc(valor)}" ${extra}`)}`;
  return `<section class="painel estreito-560"><header><h2>Regras da conferência</h2><span>valem para o app e para o banco</span></header><div class="corpo">
      <form class="formulario" data-regras>
        ${num('Salto de KM suspeito (km)', 'km_salto', g.km_salto ?? 3000)}
        ${num('Folga do encerrante (L)', 'tol_encerrante', nf(g.tol_encerrante ?? 1, 2))}
        ${num('Folga da capacidade do tanque (%)', 'tol_capacidade', nf(((g.tol_capacidade ?? 1.05) - 1) * 100, 1))}
        ${num('Diferença da régua aceita (L)', 'tol_regua', nf(g.tol_regua ?? 20, 1))}
        ${num('Tolerância da aferição (mL)', 'tol_afericao', nf((g.tol_afericao ?? 0.1) * 1000, 0))}
        ${num('Tanque padrão do caminhão novo (L)', 'tanque_padrao', nf(g.tanque_padrao ?? 1100, 0))}
        <button class="btn small" type="submit">Salvar regras</button></form>
      <p class="hint">Salto de KM: rodou mais que isso desde o último abastecimento, vai para conferência. Folga do encerrante: quanto os litros do visor podem
        diferir do encerrante. Folga da capacidade: quanto acima do tanque do caminhão ainda é aceito. Régua: diferença aceita no fechamento e na chegada.
        A mudança fica na auditoria e vale para os próximos lançamentos.</p></div></section>`;
}

// ---------- Ações: formulários ----------
trabalho.addEventListener('submit', async e => {
  const f = e.target.closest('form');
  if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));

  if (f.dataset.decidir) return decidir(f, e.submitter?.dataset.decisao || 'revalidar');
  if (f.dataset.reabrir) {
    if ((d.motivo || '').trim().length < 5) { avisar('Escreva o motivo para reabrir o turno.', 'warn'); return; }
    const botao = f.querySelector('button[type="submit"]');
    if (f.dataset.confirmando !== '1') { f.dataset.confirmando = '1'; botao.textContent = 'Clique de novo para reabrir'; return; }
    const r = await agir(() => rpc('reabrir_turno', { p_data: f.dataset.reabrir, p_motivo: d.motivo.trim() }));
    if (r) { avisar(`Turno de ${dataBR(r.data)} reaberto. No app, o frentista toca em Atualizar e já pode lançar e fechar de novo.`); abrir('tanques', { semCarregando: true }); }
    return;
  }
  if (f.hasAttribute('data-filtros')) { est.filtros = { de: d.de, ate: d.ate, status: d.status, placa: d.placa.trim() }; return abrir('abastecimentos'); }
  if (f.hasAttribute('data-regras')) {
    const v = k => parseNum(d[k]);
    const regras = { km_salto: Math.round(v('km_salto')), tol_encerrante: v('tol_encerrante'), tol_capacidade: Math.round((1 + v('tol_capacidade') / 100) * 100) / 100,
      tol_regua: v('tol_regua'), tol_afericao: v('tol_afericao') / 1000, tanque_padrao: v('tanque_padrao') };
    if (Object.values(regras).some(x => Number.isNaN(x))) { avisar('Confira os números das regras.', 'warn'); return; }
    const r = await agir(() => consulta(supabase.from('configuracoes').update({ ...regras, atualizado_em: new Date().toISOString() }).eq('id', 1).select()));
    if (r?.length) { est.regras = r[0]; TOL_AFERICAO = Number(r[0].tol_afericao); TOL_REGUA = Number(r[0].tol_regua); avisar('Regras salvas. Valem para os próximos lançamentos.'); }
    else if (r) avisar('Só o administrador altera as regras.', 'warn');
    return;
  }
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
  if (!['veiculos', 'motoristas', 'tanques', 'bombas', 'acessos', 'caminhoes_diesel'].includes(tabela)) return;
  for (const k of ['capacidade_l', 'saldo_inicial', 'encerrante_inicial']) if (k in d) d[k] = d[k] === '' ? null : parseNum(d[k]);
  for (const k of ['numero', 'km_inicial']) if (k in d) d[k] = d[k] === '' ? null : Number(soDigitos(d[k]));
  for (const k of ['ativo', 'ativa']) if (k in d) d[k] = d[k] === 'true';
  if ('cpf' in d) d.cpf = soDigitos(d.cpf);
  if (tabela === 'motoristas') d.nome = d.nome.trim().toUpperCase();
  if (tabela === 'acessos') { d.email = d.email.trim().toLowerCase(); d.nome = d.nome.trim(); if (d.papel === 'administrador' && !souDev()) d.papel = 'supervisor'; }
  if (tabela === 'veiculos') d.placa = d.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (tabela === 'tanques') d.codigo = d.codigo.trim().toUpperCase();
  if (tabela === 'caminhoes_diesel') {
    for (const k of ['placa_cavalo', 'placa_carreta']) d[k] = d[k].toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
    d.motorista = d.motorista.trim().toUpperCase() || null;
    if (!d.cpf) delete d.cpf;   // em branco: mantém o CPF que já está no cadastro
  }
  for (const [k, v] of Object.entries(d)) if (typeof v === 'number' && Number.isNaN(v)) { avisar('Confira os números digitados.', 'warn'); return; }
  let r;
  if (tabela === 'motoristas' && f.dataset.editandoId) {
    r = await agir(() => consulta(supabase.from('motoristas').update(d).eq('id', f.dataset.editandoId).select()));
  } else {
    const conflito = { veiculos: 'placa', motoristas: 'nome', tanques: 'codigo', bombas: 'numero', acessos: 'email', caminhoes_diesel: 'placa_cavalo' }[tabela];
    r = await agir(() => consulta(supabase.from(tabela).upsert(d, { onConflict: conflito }).select()));
  }
  if (r?.length) { avisar('Salvo.'); abrir(est.tela, { semCarregando: true }); } else if (r) avisar('Nada foi salvo: sem permissão para esse registro.', 'warn');
});

// ---------- Ações: cliques ----------
document.addEventListener('click', async e => {
  const t = s => e.target.closest(s);
  if (t('[data-tema]')) { definirTema(t('[data-tema]').dataset.tema); return; }
  if (t('[data-demo-alternar]')) { if (!souDev()) return; alternarDemo(); montarMenu(); abrir(est.tela); return; }
  if (t('#sair')) { est.conta = null; await sair(); mostrarLogin('Você saiu.'); return; }
  const item = t('.item[data-tela]');
  if (item) { if (suprimirClique) return; fecharMenuSeEstreito(); abrir(item.dataset.tela); return; }
  if (!trabalho.contains(e.target)) return;
  if (t('[data-ir]')) { abrir(t('[data-ir]').dataset.ir); return; }
  if (t('[data-db-tabela]')) { est.banco.tabela = t('[data-db-tabela]').dataset.dbTabela; est.banco.busca = ''; abrir('banco'); return; }
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
    const r = await agir(() => rpc('gerar_lote', { p_dia: b.dataset.dia }));
    if (r) { avisar(`Planilha do turno de ${dataBR(r.dia).slice(0, 5)} gerada com ${r.quantidade} abastecimento(s). ${avisosLote(r.linhas).join(' ')}`); baixarLote(r.id, r.linhas, r.dia); abrir('turnos', { semCarregando: true }); }
  } else if (acao === 'baixar' || acao === 'conferencia') {
    const linhas = await chamar(() => rpc('linhas_lote', { p_lote: Number(lote) }));
    if (linhas) (acao === 'baixar' ? baixarLote(lote, linhas, b.dataset.dia) : baixarConferencia(lote, b.dataset.dia, linhas));
  } else if (acao === 'confirmar' || acao === 'desfazer') {
    if (!confirmarDuasVezes(acao === 'confirmar' ? 'Clique de novo: lançado no KMM' : 'Clique de novo para desfazer')) return;
    const r = await agir(() => rpc('fechar_lote', { p_lote: Number(lote), p_acao: acao }));
    if (r) { avisar(acao === 'confirmar' ? `Marcado como lançado no KMM (${r.registros} abastecimento(s)).` : `Desfeito: ${r.registros} abastecimento(s) voltaram para o próximo fechamento.`); abrir('turnos', { semCarregando: true }); }
  } else if (acao === 'db-nova') {
    const tb = est.banco.estrutura.find(x => x.tabela === est.banco.tabela);
    if (est.banco.novo) return;
    est.banco.novo = {};
    $('db-corpo').insertAdjacentHTML('afterbegin', `<tr data-db-linha="novo" class="nova">${tb.colunas.map(c => `<td class="${c.editavel ? 'ed' : ''}" data-db-col="${esc(c.nome)}"></td>`).join('')}<td><span class="hint">nova</span></td></tr>`);
    mostrarPendentes();
  } else if (acao === 'db-salvar') {
    await salvarBanco();
  } else if (acao === 'db-desfazer') {
    abrir('banco', { semCarregando: true });
  } else if (acao === 'db-apagar') {
    if (!confirmarDuasVezes('Toque de novo para apagar')) return;
    const r = await chamar(async () => { await rpc('dev_apagar', { p_tabela: est.banco.tabela, p_chave: JSON.parse(b.dataset.dbChave) }); return true; });
    if (r) { avisar('Linha apagada. Ficou no histórico.'); abrir('banco', { semCarregando: true }); }
  } else if (acao === 'exportar-consulta') {
    if (demo()) { avisar('Modo demonstração: as planilhas usam os dados reais; saia da demonstração para baixar.', 'info'); return; }
    await chamar(() => exportarConsulta(b.dataset.tipo));
  } else if (acao === 'erro') {
    const msg = trabalho.querySelector(`[data-erro="${CSS.escape(id)}"]`).value.trim();
    if (msg.length < 3) { avisar('Escreva a mensagem de erro do KMM.', 'warn'); return; }
    if (await agir(() => rpc('marcar_erro_kmm', { p_id: Number(id), p_mensagem: msg })) !== undefined) { avisar(`#${id} marcado com erro do KMM.`); abrir('turnos', { semCarregando: true }); }
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
    if (!['frentistas', 'acessos', 'veiculos', 'motoristas', 'tanques', 'bombas', 'caminhoes_diesel'].includes(tabela)) return;
    if (!confirmarDuasVezes(['veiculos', 'motoristas'].includes(tabela) ? 'Clique de novo (o histórico fica)' : 'Clique de novo para excluir')) return;
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
  // Coluna em branco não vai no registro: assim não apaga o que já está no banco (ex.: capacidade já informada pelo frentista)
  const registro = (tipo, l) => {
    const reg = {};
    if (tipo === 'veiculos') {
      const cap = coluna(l, 'capacidade_tanque_l', 'capacidade_l', 'capacidade', 'tanque_l', 'tanque'), km = coluna(l, 'km_inicial', 'ultimo_km', 'km');
      reg.placa = soPlaca(coluna(l, 'placa'));
      if (cap) reg.capacidade_l = parseNum(cap);
      if (km) reg.km_inicial = Number(soDigitos(km));
    } else {
      const cpf = soDigitos(coluna(l, 'cpf'));
      reg.nome = coluna(l, 'nome').toUpperCase();
      if (cpf) reg.cpf = cpf.padStart(11, '0');   // sem CPF: o frentista informa no primeiro abastecimento
    }
    const ativo = lerAtivo(coluna(l, 'ativo'));
    if (ativo !== undefined) reg.ativo = ativo;
    return reg;
  };
  const motivoErro = (tipo, msg) => /check constraint|invalid input/.test(msg) ? (tipo === 'veiculos' ? 'placa ou capacidade inválida' : 'CPF inválido')
    : /duplicate key|affect row a second time/.test(msg) ? 'repetido na planilha' : msg;
  // Ordem: veículos e motoristas antes dos vínculos, que dependem deles. Envia em blocos de linhas com as mesmas colunas
  // (o upsert em bloco atualiza todas as colunas enviadas); se um bloco falhar, refaz linha por linha para apontar qual foi.
  const TAMANHO_BLOCO = 200;
  for (const tipo of ['veiculos', 'motoristas']) {
    const conflito = tipo === 'veiculos' ? 'placa' : 'nome';
    const grupos = new Map();
    for (const item of abas[tipo]) {
      const reg = registro(tipo, item.l), chave = Object.keys(reg).sort().join(',');
      if (!grupos.has(chave)) grupos.set(chave, []);
      grupos.get(chave).push({ ...item, reg });
    }
    for (const grupo of grupos.values()) {
      for (let i = 0; i < grupo.length; i += TAMANHO_BLOCO) {
        const bloco = grupo.slice(i, i + TAMANHO_BLOCO);
        avisar(`Importando ${feitos + bloco.length} de ${total}…`, 'info');
        const r = await supabase.from(tipo).upsert(bloco.map(b => b.reg), { onConflict: conflito });
        if (!r.error) { resultado[tipo] += bloco.length; feitos += bloco.length; continue; }
        for (const { reg, linha, aba } of bloco) {
          avisar(`Conferindo linha a linha: ${++feitos} de ${total}…`, 'info');
          const r1 = await supabase.from(tipo).upsert(reg, { onConflict: conflito });
          if (r1.error) erros.push(`${aba} linha ${linha}: ${motivoErro(tipo, r1.error.message)}`); else resultado[tipo]++;
        }
      }
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
