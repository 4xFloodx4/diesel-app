// App do frentista. O celular fica logado com a conta Google do posto; em cada lançamento o frentista
// escolhe quem ele é. Funciona sem internet: os envios ficam numa fila no celular e vão quando a rede volta.
// O banco confere tudo de novo; o resultado que vale é o dele.
import { rpc, supabase, contaAtual, entrarComGoogle, aoVoltarDoLogin, sair } from '../comum/supa.js';
import { esc, nf, parseNum, hhmm, hojeISO, horaAgora, classeStatus, ler, gravar } from '../comum/util.js';

const LIM = { kmSalto: 3000, tolCap: 1.05, tolEnc: 1, tolTanque: 20 };
const $ = id => document.getElementById(id);
const conteudo = $('conteudo');

let conta = null;                          // e-mail da conta Google do celular
let estado = ler('estado', null);          // cadastros e situação do posto (cópia para trabalhar sem rede)
let fila = ler('fila', []);                // [{tipo, dados, localOk}] ainda não aceitos pelo banco
let frentistaId = ler('frentista', null);  // último frentista escolhido neste celular
let aba = 'abastecer';
let online = true, sincronizando = false, aviso = null, erroSync = null, semAcesso = false;
let form = null, chegada = null, medidos = {};

const frentistaValido = () => estado?.frentistas?.some(f => f.id === frentistaId);
const nomeFrentista = id => estado?.frentistas?.find(f => f.id === id)?.nome ?? '';
const novoForm = () => ({ bomba: estado?.bombas?.[0]?.numero ?? 1, placa: '', motorista: '', hora: horaAgora(), km: '', litros: '', enc: '', obs: '' });
const novaChegada = () => ({ tanque: estado?.tanques?.[0]?.tanque ?? '', hora: horaAgora(), nf: '', litros: '', valor: '', antes: '', depois: '',
  placa: '', carreta: '', motorista: '', cpf: '' });
const salvarFila = () => gravar('fila', fila);

// ---------- Estado derivado: banco + o que ainda está na fila ----------
function encAnterior(bomba) {
  const b = estado.bombas.find(x => x.numero === bomba);
  const naFila = fila.filter(f => f.tipo === 'abastecimento' && f.dados.bomba === bomba).map(f => f.dados.encerrante);
  return Math.max(Number(b?.encerrante_anterior ?? 0), ...naFila);
}
function kmAnterior(placa) {
  const v = estado.veiculos.find(x => x.placa === placa);
  const naFila = fila.filter(f => f.tipo === 'abastecimento' && f.dados.placa === placa && f.localOk).map(f => f.dados.km);
  const vals = [v?.km_anterior, ...naFila].filter(x => x != null).map(Number);
  return vals.length ? Math.max(...vals) : null;
}

function conferir(f) {
  const km = parseNum(f.km), lt = parseNum(f.litros), enc = parseNum(f.enc);
  const v = estado.veiculos.find(x => x.placa === f.placa);
  const bloqueios = [];
  if (!frentistaValido()) bloqueios.push('Escolha quem está lançando.');
  if (!f.placa) bloqueios.push('Escolha a placa.');
  if (!f.motorista) bloqueios.push('Escolha o motorista.');
  if (!/^\d{2}:\d{2}$/.test(f.hora)) bloqueios.push('Informe a hora.');
  if (!(km > 0) || km >= 1e7) bloqueios.push('Informe o KM do painel.');
  if (!(lt > 0) || lt >= 5000) bloqueios.push('Informe os litros do visor.');
  if (!(enc > 0)) bloqueios.push('Informe o encerrante final.');
  const regras = [];
  const ka = v ? kmAnterior(f.placa) : null;
  if (!v || !(km > 0)) regras.push({ e: null, t: 'KM maior que o último da placa.' });
  else if (ka != null && km <= ka) regras.push({ e: false, t: `KM ${nf(km, 0)} é menor ou igual ao último desta placa (${nf(ka, 0)}).` });
  else if (ka != null && km - ka > LIM.kmSalto) regras.push({ e: false, t: `Rodou ${nf(km - ka, 0)} km desde o último abastecimento. Confira o painel.` });
  else regras.push({ e: true, t: ka == null ? 'Primeiro abastecimento registrado desta placa.' : `KM coerente: +${nf(km - ka, 0)} km.` });
  if (!v || !(lt > 0)) regras.push({ e: null, t: 'Litros dentro da capacidade do tanque.' });
  else if (lt > v.capacidade_l * LIM.tolCap) regras.push({ e: false, t: `${nf(lt)} L passa da capacidade do tanque deste veículo (${nf(v.capacidade_l, 0)} L).` });
  else regras.push({ e: true, t: `Cabe no tanque do veículo (${nf(v.capacidade_l, 0)} L).` });
  const ea = encAnterior(f.bomba);
  if (!(enc > 0) || !(lt > 0)) regras.push({ e: null, t: 'Encerrante bate com os litros.' });
  else if (enc <= ea) regras.push({ e: false, t: `Encerrante ${nf(enc)} não é maior que o anterior da bomba ${f.bomba} (${nf(ea)}).` });
  else if (Math.abs(enc - ea - lt) > LIM.tolEnc) regras.push({ e: false, t: `Pelo encerrante saíram ${nf(enc - ea)} L, mas o visor diz ${nf(lt)} L.` });
  else regras.push({ e: true, t: `Encerrante bate com os litros (${nf(enc - ea)} L).` });
  const dh = `${hojeISO()}T${f.hora}`;
  const dup = lt > 0 && [
    ...estado.hoje.filter(r => r.status !== 'Cancelado').map(r => ({ placa: r.placa, dh: String(r.data_hora).slice(0, 16), lt: Number(r.litros) })),
    ...fila.filter(x => x.tipo === 'abastecimento').map(x => ({ placa: x.dados.placa, dh: x.dados.data_hora.slice(0, 16), lt: x.dados.litros })),
  ].some(r => r.placa === f.placa && r.dh === dh && Math.abs(r.lt - lt) < 0.005);
  regras.push(dup ? { e: false, t: 'Já existe um lançamento desta placa, nesta hora, com estes litros.' }
    : { e: f.placa && lt > 0 ? true : null, t: 'Sem lançamento repetido.' });
  return { bloqueios, regras, falhas: regras.filter(r => r.e === false) };
}

// ---------- Comunicação ----------
async function atualizarEstado() {
  estado = await rpc('estado_posto');
  gravar('estado', estado);
  semAcesso = false;
}

async function sincronizar() {
  if (sincronizando || !conta) return;
  sincronizando = true;
  try {
    const abs = fila.filter(f => f.tipo === 'abastecimento');
    const chs = fila.filter(f => f.tipo === 'chegada');
    const aceitos = new Set();
    if (abs.length) {
      const r = await rpc('registrar_abastecimentos', { p_registros: abs.map(f => f.dados) });
      r.forEach(x => aceitos.add(x.uuid));
      const exc = r.filter(x => x.status === 'Exceção').length;
      aviso = { tipo: exc ? 'warn' : 'ok', texto: `${r.length} abastecimento(s) recebido(s)` + (exc ? `, ${exc} foi(ram) para o supervisor.` : '.') };
    }
    if (chs.length) (await rpc('registrar_chegadas', { p_registros: chs.map(f => f.dados) })).forEach(x => aceitos.add(x.uuid));
    fila = fila.filter(f => !aceitos.has(f.dados.uuid));
    salvarFila();
    await atualizarEstado();
    online = true; erroSync = null;
  } catch (e) {
    if (e.semRede) online = false;
    else if (e.semAcesso) semAcesso = true;
    else erroSync = e.message;   // dado recusado pelo banco: fica na fila e aparece na barra
  } finally {
    sincronizando = false;
    render();
  }
}

// ---------- Telas ----------
function campoFrentista() {
  return `<div class="field quem"><label class="lbl" for="f-frentista">Quem está lançando?</label>
    <select id="f-frentista"><option value="">Escolha seu nome…</option>${estado.frentistas.map(f =>
      `<option value="${f.id}" ${f.id === frentistaId ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select></div>`;
}

function barraSync() {
  const el = $('sync');
  const n = fila.length;
  el.hidden = !conta || (online && !n && !erroSync);
  el.className = 'sync' + (online ? '' : ' offline');
  el.innerHTML = `<span>${!online ? 'Sem internet. ' : ''}${n ? `${n} registro(s) guardado(s) no celular.` : ''}${erroSync ? ` ${esc(erroSync)}` : ''}</span>
    ${n ? `<button class="btn small ghost" type="button" data-acao="sync">${sincronizando ? 'Enviando…' : 'Enviar agora'}</button>` : ''}`;
}

function telaLogin() {
  return `<div class="centro">
    <h1>Entrar</h1>
    <p class="hint">Entre uma vez com a conta Google do posto. O celular fica conectado; depois, a cada lançamento, cada frentista escolhe o próprio nome.</p>
    ${aviso ? `<div class="toast ${aviso.tipo}">${esc(aviso.texto)}</div>` : ''}
    <button class="btn" type="button" data-acao="google">Entrar com Google</button></div>`;
}

function telaSemAcesso() {
  return `<div class="centro">
    <h1>Conta sem acesso</h1>
    <p>A conta <b>${esc(conta)}</b> ainda não foi liberada.</p>
    <p class="hint">Peça ao supervisor para cadastrar este e-mail em "Acessos" no painel, como "Celular do posto". Depois toque em tentar de novo.</p>
    <button class="btn" type="button" data-acao="tentar">Tentar de novo</button>
    <button class="btn ghost" type="button" data-acao="trocar">Entrar com outra conta</button></div>`;
}

function telaAbastecer() {
  if (!estado.bombas.length || !estado.veiculos.length) return '<p class="hint">Cadastros ainda não carregados. Peça ao supervisor para cadastrar bombas e veículos.</p>';
  const c = conferir(form);
  const ea = encAnterior(form.bomba);
  const enc = parseNum(form.enc);
  const falha = c.falhas.length > 0;
  const pode = !c.bloqueios.length && (!falha || form.obs.trim().length >= 5);
  const v = estado.veiculos.find(x => x.placa === form.placa);
  return `
    ${aviso ? `<div class="toast ${aviso.tipo}" role="status">${esc(aviso.texto)}</div>` : ''}
    ${campoFrentista()}
    <div class="field"><span class="lbl">Bomba</span><div class="bombas">
      ${estado.bombas.map(b => `<button type="button" data-bomba="${b.numero}" aria-pressed="${b.numero === form.bomba}"><b>${b.numero}</b><small>${esc(b.tanque)}</small></button>`).join('')}
    </div></div>
    <div class="row2">
      <div class="field"><label class="lbl" for="f-placa">Placa</label>
        <select id="f-placa"><option value="">Escolha…</option>${estado.veiculos.map(x => `<option ${x.placa === form.placa ? 'selected' : ''}>${esc(x.placa)}</option>`).join('')}</select></div>
      <div class="field"><label class="lbl" for="f-hora">Hora</label><input id="f-hora" type="time" value="${esc(form.hora)}"></div>
    </div>
    <div class="field"><label class="lbl" for="f-motorista">Motorista</label>
      <select id="f-motorista"><option value="">Escolha…</option>${estado.motoristas.map(m => `<option ${m === form.motorista ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      ${v?.motorista_sugerido ? '<span class="hint">Sugerido: o último motorista que abasteceu esta placa.</span>' : ''}</div>
    <div class="field"><label class="lbl" for="f-km">KM do painel</label><input id="f-km" class="num" inputmode="numeric" value="${esc(form.km)}">
      ${v ? `<span class="hint">Último desta placa: ${kmAnterior(form.placa) == null ? 'sem registro' : nf(kmAnterior(form.placa), 0) + ' km'}</span>` : ''}</div>
    <div class="row2">
      <div class="field"><label class="lbl" for="f-litros">Litros (visor)</label><input id="f-litros" class="num" inputmode="decimal" value="${esc(form.litros)}"></div>
      <div class="field"><label class="lbl" for="f-enc">Encerrante final</label><input id="f-enc" class="num" inputmode="decimal" value="${esc(form.enc)}"></div>
    </div>
    <div class="medidor"><span>Encerrante anterior (bomba ${form.bomba})</span><span class="v">${nf(ea)}</span>
      <span>Saída pelo encerrante</span><span class="v grande">${enc > ea ? nf(enc - ea) + ' L' : '–'}</span></div>
    <ul class="checks">${c.regras.map(r => `<li class="${r.e === true ? 'ok' : r.e === false ? 'falha' : ''}">${esc(r.t)}</li>`).join('')}</ul>
    ${falha ? `<div class="field"><label class="lbl" for="f-obs">O que aconteceu? (vai para o supervisor)</label>
      <textarea id="f-obs" rows="2" maxlength="500">${esc(form.obs)}</textarea></div>` : ''}
    ${c.bloqueios.length ? `<p class="hint">${c.bloqueios.map(esc).join(' ')}</p>` : ''}
    <button class="btn ${falha ? 'warn' : ''}" type="button" data-acao="enviar" ${pode ? '' : 'disabled'}>${falha ? 'Enviar para o supervisor' : 'Enviar abastecimento'}</button>`;
}

function telaTurno() {
  const pend = fila.filter(f => f.tipo === 'abastecimento').map(f => ({ ...f.dados, status: 'Pendente', problemas: [], frentista: nomeFrentista(f.dados.frentista_id) }));
  const lista = [...pend, ...estado.hoje].sort((a, b) => String(b.data_hora).localeCompare(String(a.data_hora)));
  const n = s => estado.hoje.filter(r => s.includes(r.status)).length;
  return `
    <div class="resumo">
      <div><b>${n(['Lançado'])}</b><span>Lançados no KMM</span></div>
      <div><b>${n(['Pronto', 'Em lote']) + pend.length}</b><span>Aguardando</span></div>
      <div><b>${n(['Exceção', 'Erro'])}</b><span>Com o supervisor</span></div>
    </div>
    <div class="secao">Hoje</div>
    ${lista.length ? lista.map(r => `<div class="reg">
      <div class="linha1"><span class="placa">${esc(r.placa)}</span><span class="pill ${classeStatus(r.status)}">${r.status === 'Pendente' ? 'Guardado no celular' : esc(r.status)}</span></div>
      <div class="det">${hhmm(r.data_hora)} · ${esc(r.motorista)} · Bomba ${esc(r.bomba)}${r.id ? ` · #${r.id}` : ''}</div>
      <div class="det">${nf(r.litros)} L · ${nf(r.km, 0)} km · lançado por ${esc(r.frentista || '')}</div>
      ${r.problemas?.length ? `<ul>${r.problemas.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    </div>`).join('') : '<p class="hint">Nenhum abastecimento hoje.</p>'}
    <p class="hint">Atualizado às ${hhmm(estado.gerado_em)}. Conta: ${esc(conta)}</p>`;
}

function telaChegada() {
  const f = chegada, l = parseNum(f.litros), sub = parseNum(f.depois) - parseNum(f.antes);
  const okRegua = l > 0 && sub > 0 && Math.abs(sub - l) <= LIM.tolTanque;
  const pode = frentistaValido() && f.tanque && f.nf.trim() && l > 0 && /^\d{2}:\d{2}$/.test(f.hora);
  return `
    ${aviso ? `<div class="toast ${aviso.tipo}" role="status">${esc(aviso.texto)}</div>` : ''}
    ${campoFrentista()}
    <div class="row2">
      <div class="field"><label class="lbl" for="c-tanque">Tanque</label><select id="c-tanque">${estado.tanques.map(t => `<option ${t.tanque === f.tanque ? 'selected' : ''}>${esc(t.tanque)}</option>`).join('')}</select></div>
      <div class="field"><label class="lbl" for="c-hora">Hora</label><input id="c-hora" type="time" value="${esc(f.hora)}"></div>
    </div>
    <div class="row2">
      <div class="field"><label class="lbl" for="c-nf">Nota fiscal</label><input id="c-nf" class="num" inputmode="numeric" maxlength="20" value="${esc(f.nf)}"></div>
      <div class="field"><label class="lbl" for="c-litros">Litros da NF</label><input id="c-litros" class="num" inputmode="decimal" value="${esc(f.litros)}"></div>
    </div>
    <div class="field"><label class="lbl" for="c-valor">Valor total (R$)</label><input id="c-valor" class="num" inputmode="decimal" value="${esc(f.valor)}"></div>
    <div class="row2">
      <div class="field"><label class="lbl" for="c-antes">Régua antes</label><input id="c-antes" class="num" inputmode="decimal" value="${esc(f.antes)}"></div>
      <div class="field"><label class="lbl" for="c-depois">Régua depois</label><input id="c-depois" class="num" inputmode="decimal" value="${esc(f.depois)}"></div>
    </div>
    ${sub > 0 ? `<ul class="checks"><li class="${okRegua ? 'ok' : 'falha'}">A régua subiu ${nf(sub)} L; a NF diz ${nf(l)} L.</li></ul>` : ''}
    <div class="row2">
      <div class="field"><label class="lbl" for="c-placa">Placa caminhão</label><input id="c-placa" maxlength="8" value="${esc(f.placa)}"></div>
      <div class="field"><label class="lbl" for="c-carreta">Placa carreta</label><input id="c-carreta" maxlength="8" value="${esc(f.carreta)}"></div>
    </div>
    <div class="row2">
      <div class="field"><label class="lbl" for="c-motorista">Motorista</label><input id="c-motorista" maxlength="120" value="${esc(f.motorista)}"></div>
      <div class="field"><label class="lbl" for="c-cpf">CPF</label><input id="c-cpf" class="num" inputmode="numeric" maxlength="14" value="${esc(f.cpf)}"></div>
    </div>
    <button class="btn" type="button" data-acao="chegada" ${pode ? '' : 'disabled'}>Registrar chegada</button>`;
}

function telaFechar() {
  const pend = fila.length;
  if (estado.tanques.some(t => t.fechado)) {
    return `<div class="toast ok">O dia já foi fechado.</div>${estado.tanques.map(t => `<div class="tanque"><h3>${esc(t.tanque)}</h3>
      <div class="medidor"><span>Esperado</span><span class="v">${nf(t.fechado.saldo_calculado, 0)} L</span>
      <span>Medido</span><span class="v">${nf(t.fechado.saldo_medido, 0)} L</span>
      <span class="tot">Diferença</span><span class="v tot">${nf(t.fechado.diferenca, 0)} L</span></div></div>`).join('')}`;
  }
  const completos = estado.tanques.every(t => !Number.isNaN(parseNum(medidos[t.tanque])));
  return `
    ${aviso ? `<div class="toast ${aviso.tipo}" role="status">${esc(aviso.texto)}</div>` : ''}
    ${campoFrentista()}
    <p class="hint">Meça os tanques no fim do turno. O sistema compara com o que entrou e saiu pelas bombas.</p>
    ${pend ? `<div class="toast warn">Há ${pend} registro(s) guardado(s) no celular. Envie antes de fechar, senão a conta fica errada.</div>` : ''}
    ${!online ? '<div class="toast warn">Sem internet. O fechamento precisa de conexão.</div>' : ''}
    ${estado.tanques.map(t => {
      const m = parseNum(medidos[t.tanque]), dif = m - t.saldo_calculado;
      return `<div class="tanque"><h3>${esc(t.tanque)}</h3>
        <div class="medidor">
          <span>Saldo inicial</span><span class="v">${nf(t.saldo_inicial, 0)} L</span>
          <span>+ Chegadas</span><span class="v">${nf(t.chegadas, 0)} L</span>
          <span>− Saída pelas bombas</span><span class="v">${nf(t.saidas, 0)} L</span>
          <span class="tot">= Saldo esperado</span><span class="v tot">${nf(t.saldo_calculado, 0)} L</span>
        </div>
        <div class="field"><label class="lbl" for="m-${esc(t.tanque)}">Saldo medido (régua)</label>
          <input id="m-${esc(t.tanque)}" data-tanque="${esc(t.tanque)}" class="num" inputmode="decimal" value="${esc(medidos[t.tanque] ?? '')}"></div>
        ${!Number.isNaN(m) ? `<ul class="checks"><li class="${Math.abs(dif) <= LIM.tolTanque ? 'ok' : 'falha'}">${Math.abs(dif) <= LIM.tolTanque
          ? `Diferença de ${nf(dif, 0)} L, dentro da tolerância.` : `Diferença de ${nf(dif, 0)} L. O supervisor vai receber um alerta.`}</li></ul>` : ''}
      </div>`; }).join('')}
    <button class="btn" type="button" data-acao="fechar" ${completos && !pend && online && frentistaValido() ? '' : 'disabled'}>Fechar turno</button>`;
}

function render(manterFoco) {
  const foco = manterFoco && document.activeElement?.id;
  const pos = foco && document.activeElement.selectionStart;
  barraSync();
  const pronto = conta && estado && !semAcesso;
  $('abas').hidden = !pronto;
  $('sair').hidden = !conta;
  $('subtitulo').textContent = pronto && frentistaValido() ? nomeFrentista(frentistaId) : '';
  if (!conta) conteudo.innerHTML = telaLogin();
  else if (semAcesso) conteudo.innerHTML = telaSemAcesso();
  else if (!estado) conteudo.innerHTML = '<p class="hint">Sem dados do posto ainda. Conecte à internet uma vez para baixar os cadastros.</p>';
  else conteudo.innerHTML = { abastecer: telaAbastecer, turno: telaTurno, chegada: telaChegada, fechar: telaFechar }[aba]();
  document.querySelectorAll('#abas button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.aba === aba)));
  if (foco) { const el = $(foco); if (el) { el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch { /* campo sem seleção */ } } }
}

// ---------- Eventos ----------
const mapaForm = { 'f-placa': 'placa', 'f-motorista': 'motorista', 'f-hora': 'hora', 'f-km': 'km', 'f-litros': 'litros', 'f-enc': 'enc', 'f-obs': 'obs' };
const mapaChegada = { 'c-tanque': 'tanque', 'c-hora': 'hora', 'c-nf': 'nf', 'c-litros': 'litros', 'c-valor': 'valor', 'c-antes': 'antes',
  'c-depois': 'depois', 'c-placa': 'placa', 'c-carreta': 'carreta', 'c-motorista': 'motorista', 'c-cpf': 'cpf' };

conteudo.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'f-frentista') { frentistaId = e.target.value ? Number(e.target.value) : null; gravar('frentista', frentistaId); }
  else if (mapaForm[id]) {
    form[mapaForm[id]] = e.target.value;
    if (id === 'f-placa') form.motorista = estado.veiculos.find(v => v.placa === form.placa)?.motorista_sugerido || '';
    aviso = null;
  } else if (mapaChegada[id]) chegada[mapaChegada[id]] = e.target.value;
  else if (e.target.dataset.tanque) medidos[e.target.dataset.tanque] = e.target.value;
  else return;
  render(e.target.tagName !== 'SELECT');
});

conteudo.addEventListener('click', async e => {
  const bomba = e.target.closest('[data-bomba]');
  if (bomba) { form.bomba = Number(bomba.dataset.bomba); aviso = null; render(); return; }
  const acao = e.target.closest('[data-acao]')?.dataset.acao;
  if (acao === 'google') { try { await entrarComGoogle(); } catch (err) { aviso = { tipo: 'warn', texto: err.message }; render(); } }
  if (acao === 'tentar') await carregar();
  if (acao === 'trocar') { await sair(); conta = null; semAcesso = false; render(); }
  if (acao === 'enviar') enviarAbastecimento();
  if (acao === 'chegada') enviarChegada();
  if (acao === 'fechar') await fecharTurno();
});
$('sync').addEventListener('click', e => { if (e.target.closest('[data-acao="sync"]')) { render(); sincronizar(); } });
$('abas').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  aba = b.dataset.aba; aviso = null; render(); conteudo.scrollTop = 0;
  if (navigator.onLine) sincronizar();
});
$('sair').addEventListener('click', async () => {
  if (fila.length) { aviso = { tipo: 'warn', texto: 'Envie os registros guardados antes de sair da conta.' }; aba = 'turno'; render(); return; }
  await sair(); conta = null; estado = null; gravar('estado', null); render();
});

function enviarAbastecimento() {
  const c = conferir(form);
  if (c.bloqueios.length) return;
  const dados = {
    uuid: crypto.randomUUID(), data_hora: `${hojeISO()}T${form.hora}:00`, placa: form.placa, motorista: form.motorista,
    km: Math.round(parseNum(form.km)), litros: parseNum(form.litros), encerrante: parseNum(form.enc), bomba: form.bomba,
    frentista_id: frentistaId, obs: c.falhas.length ? form.obs.trim() : null,
  };
  fila.push({ tipo: 'abastecimento', dados, localOk: !c.falhas.length });
  salvarFila();
  aviso = c.falhas.length
    ? { tipo: 'warn', texto: `Guardado: ${dados.placa}, ${nf(dados.litros)} L. Vai para o supervisor.` }
    : { tipo: 'ok', texto: `Guardado: ${dados.placa}, ${nf(dados.litros)} L. Enviando…` };
  const b = form.bomba;
  form = novoForm(); form.bomba = b;
  render(); conteudo.scrollTop = 0;
  sincronizar();
}

function enviarChegada() {
  const f = chegada;
  const num = s => { const n = parseNum(s); return Number.isNaN(n) ? null : n; };
  fila.push({ tipo: 'chegada', dados: {
    uuid: crypto.randomUUID(), tanque: f.tanque, data_hora: `${hojeISO()}T${f.hora}:00`, nf: f.nf.trim(), litros: parseNum(f.litros),
    valor_total: num(f.valor), regua_antes: num(f.antes), regua_depois: num(f.depois), placa_caminhao: f.placa || null,
    placa_carreta: f.carreta || null, motorista: f.motorista || null, cpf: f.cpf || null, frentista_id: frentistaId } });
  salvarFila();
  aviso = { tipo: 'ok', texto: `Chegada da NF ${f.nf} guardada. Enviando…` };
  chegada = novaChegada();
  render(); conteudo.scrollTop = 0;
  sincronizar();
}

async function fecharTurno() {
  const valores = Object.fromEntries(estado.tanques.map(t => [t.tanque, parseNum(medidos[t.tanque])]));
  try {
    const r = await rpc('registrar_fechamento', { p_medidos: valores, p_frentista_id: frentistaId });
    const alertas = r.filter(t => t.alerta).length;
    aviso = { tipo: alertas ? 'warn' : 'ok', texto: alertas ? `Turno fechado. ${alertas} tanque(s) com diferença: o supervisor foi avisado.` : 'Turno fechado. Tudo bateu.' };
    medidos = {};
    await atualizarEstado();
  } catch (e) { aviso = { tipo: 'warn', texto: e.message }; }
  render();
}

// ---------- Início ----------
async function carregar() {
  conta = await contaAtual();
  if (conta) {
    try { await atualizarEstado(); online = true; }
    catch (e) { if (e.semAcesso) semAcesso = true; else if (e.semRede) online = false; else aviso = { tipo: 'warn', texto: e.message }; }
  }
  form = estado ? novoForm() : null;
  chegada = estado ? novaChegada() : null;
  render();
  if (conta && fila.length) sincronizar();
}

aoVoltarDoLogin(erro => { if (erro) aviso = { tipo: 'warn', texto: erro.message }; carregar(); });
supabase.auth.onAuthStateChange((evento) => { if (evento === 'SIGNED_IN' && !conta) carregar(); });
window.addEventListener('online', () => sincronizar());
setInterval(() => { if (conta && (fila.length || !online)) sincronizar(); }, 60_000);
carregar();
