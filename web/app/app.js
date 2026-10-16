// App do frentista. O celular fica logado com a conta Google do posto; cada frentista entra com nome + PIN
// e continua logado até tocar em "Trocar". Precisa de internet para lançar: nada fica guardado só no celular.
// O banco confere tudo de novo; o resultado que vale é o dele.
import { rpc, supabase, contaAtual, entrarComGoogle, aoVoltarDoLogin, sair } from '../comum/supa.js';
import { esc, nf, parseNum, hhmm, hojeISO, horaAgora, classeStatus, ler, gravar } from '../comum/util.js';
import { tirarFoto, enviarFotos } from '../comum/fotos.js';
import { prepararAtualizacao, confirmarAbertura } from '../comum/atualizacao.js';
import { aplicarTema, htmlTema, definirTema, protegerContraMoldura } from '../comum/tema.js';
import { htmlGuia, htmlAbasGuia } from '../comum/guia.js';

protegerContraMoldura();
aplicarTema();
// Conta de supervisor ou administrador usa o painel (versão de celular); no APK ele fica em painel/, no site em ../painel/
const URL_PAINEL = __ALVO__ === 'android' ? 'painel/index.html' : '../painel/';

const LIM = { kmSalto: 3000, tolCap: 1.05, tolEnc: 1, tolTanque: 20, tolAfericao: 0.1 };   // aferição: 0,5% de 20 L
const MAX_FOTOS = 6;
const $ = id => document.getElementById(id);
const conteudo = $('conteudo');

let conta = null;                        // conta Google do celular
let estado = null;                       // cadastros e situação do posto, sempre do banco
let login = ler('frentistaLogin', null); // {sessao, id, nome}
let aba = 'abastecer';
let tela = null;                         // subtela: 'veiculo' | 'motorista' | null
let aviso = null, enviando = false, semAcesso = false, semRede = false;
let form = null, chegada = null, medidos = {}, fotosChegada = [], fotosFechamento = [];
let afericao = { bomba: null, visor: '' }, fotosAfericao = [];
let novoVeiculo = null, novoMotorista = null, correcao = null;   // correcao: {placa, capacidade, km} do caminhão já cadastrado
let escolhido = null, pin = '';          // tela de login do frentista
let pinEstado = '';                      // '' | 'erro' (pontos tremem) | 'certo' (pontos verdes)
let boasVindas = false, timerBoasVindas = null;   // tela de boas-vindas logo depois do PIN
let ultimaChave = null;                  // última tela mostrada, para a transição entre telas
let confirmaLimpar = false, editPreco = null, sugestaoPreco = null;   // limpar o formulário; atualizar o preço do diesel
let guia = 'frentista';

// Inicial do nome num círculo colorido (a cor sai do nome, então é sempre a mesma para a mesma pessoa)
const CORES_AVATAR = ['#b86a07', '#3b5f8a', '#2f7a4f', '#6b4fa0', '#a8442a', '#2c6f73', '#7a5a12'];
const corAvatar = nome => CORES_AVATAR[[...String(nome)].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7) % CORES_AVATAR.length];
const iniciais = nome => String(nome || '').trim().split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const avatar = (nome, grande = false) => `<span class="avatar${grande ? ' grande' : ''}" style="--cor:${corAvatar(nome)}" aria-hidden="true">${esc(iniciais(nome))}</span>`;
const reais = n => `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
const dataHoraCurta = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '') : '';

// A bomba não vem marcada: o frentista escolhe a cada lançamento (só vem marcada se o posto tiver uma bomba só)
// placa/motorista: o que foi escolhido da lista; placaTxt/motoristaTxt: o que o frentista está digitando
// capacidade/cpf: só quando a placa ou o motorista ainda não têm isso no cadastro
const novoForm = () => ({ bomba: estado?.bombas?.length === 1 ? estado.bombas[0].numero : null, placa: '', motorista: '', placaTxt: '', motoristaTxt: '',
  capacidade: '', cpf: '',
  hora: horaAgora(), km: '', litros: '', enc: '', obs: '', desconto: null, justificativa: '', justHorario: '' });

// ---------- Busca de placa e motorista (o frentista digita o começo e toca na sugestão) ----------
const MAX_SUGESTOES = 6;
const soPlaca = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
// "jo si" acha "JOÃO DA SILVA": cada pedaço digitado é o começo de alguma palavra do nome
const bateNome = (nome, busca) => { const palavras = semAcento(nome).split(' '); return semAcento(busca).split(' ').every(p => palavras.some(w => w.startsWith(p))); };
const vinculados = placa => estado.veiculos.find(v => v.placa === placa)?.motoristas || [];
// Placa ou motorista vindos da planilha só com placa + nome: o app pede o que falta no primeiro abastecimento
const precisaCapacidade = f => { const v = estado.veiculos.find(x => x.placa === f.placa); return !!v && v.capacidade_l == null; };
const precisaCpf = f => !!f.motorista && (estado.motoristas_sem_cpf || []).includes(f.motorista);
function cpfValido(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    if ((s * 10) % 11 % 10 !== Number(d[n])) return false;
  }
  return true;
}
function sugestoesPlaca(txt) {
  const q = soPlaca(txt);
  if (!q) return [];
  return estado.veiculos.filter(v => v.placa.includes(q))
    .sort((a, b) => b.placa.startsWith(q) - a.placa.startsWith(q) || a.placa.localeCompare(b.placa)).slice(0, MAX_SUGESTOES);
}
function sugestoesMotorista(txt, placa) {
  if (!semAcento(txt)) return [];
  const vinc = vinculados(placa);
  return estado.motoristas.filter(m => bateNome(m, txt)).sort((a, b) => vinc.includes(b) - vinc.includes(a) || a.localeCompare(b)).slice(0, MAX_SUGESTOES);
}
// Ao escolher a placa, puxa o motorista: o único vinculado, ou o último que usou a placa (se for vinculado)
function escolherPlaca(placa) {
  form.placa = placa;
  if (!placa) return;
  form.placaTxt = placa;
  const vinc = vinculados(placa), ultimo = estado.veiculos.find(v => v.placa === placa)?.motorista_sugerido;
  if (vinc.length && !vinc.includes(form.motorista)) {
    form.motorista = vinc.length === 1 ? vinc[0] : vinc.includes(ultimo) ? ultimo : '';
    form.motoristaTxt = form.motorista;
  }
}

// Turno (horário definido pelo administrador). Aceita turno que vira a meia-noite.
const minutos = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
function foraDoTurno(hm) {
  if (!estado?.turno || !/^\d{2}:\d{2}$/.test(hm)) return false;
  const t = minutos(hm), ab = minutos(estado.turno.abertura), fe = minutos(estado.turno.fechamento);
  return ab < fe ? t < ab || t >= fe : t < ab && t >= fe;
}
function avisoFechamento() {
  if (!estado?.turno || estado.fechado_hoje) return '';
  const falta = minutos(estado.turno.fechamento) - minutos(horaAgora());
  return falta > 0 && falta <= 30
    ? `<div class="toast info" role="status">Faltam ${falta} min para o fechamento do turno (${esc(estado.turno.fechamento)}). Não esqueça de medir os tanques e fechar o turno.</div>` : '';
}
// Aferição é semanal em cada bomba: lembra na tela de abastecer quando alguma passou de 7 dias
function avisoAfericao() {
  const vencidas = (estado?.bombas || []).filter(b => b.afericao_vencida).map(b => b.numero);
  return vencidas.length ? `<div class="toast info" role="status">Aferição da${vencidas.length > 1 ? 's bombas' : ' bomba'} ${vencidas.join(' e ')} vencida (é semanal).
    Faça na aba <b>Aferir</b>.</div>` : '';
}
const diasDesde = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const situacaoAfericao = b => !b.ultima_afericao ? 'nunca feita' : b.afericao_vencida ? 'vencida'
  : diasDesde(b.ultima_afericao) === 0 ? 'feita hoje' : `há ${diasDesde(b.ultima_afericao)} dia(s)`;
const diaFechado = () => `<div class="aviso-grande"><b>O turno de hoje já foi fechado.</b>
  <p>Depois do fechamento, nada mais entra com a data de hoje. Se faltou algum lançamento, fale com o supervisor.</p></div>`;
const novaChegada = () => ({ tanque: estado?.tanques?.[0]?.tanque ?? '', hora: horaAgora(), nf: '', litros: '', valor: '', antes: '', depois: '',
  placa: '', carreta: '', motorista: '', cpf: '' });

// ---------- Conferência na hora (o banco confere de novo) ----------
function conferir(f) {
  const km = parseNum(f.km), lt = parseNum(f.litros), enc = parseNum(f.enc);
  const v = estado.veiculos.find(x => x.placa === f.placa);
  const bloqueios = [];
  if (f.bomba == null) bloqueios.push('Escolha a bomba.');
  if (!f.placa) bloqueios.push('Escolha a placa na lista (ou cadastre).');
  if (!f.motorista) bloqueios.push('Escolha o motorista na lista (ou cadastre).');
  if (!/^\d{2}:\d{2}$/.test(f.hora)) bloqueios.push('Informe a hora.');
  if (!(km > 0) || km >= 1e7) bloqueios.push('Informe o KM do painel.');
  if (!(lt > 0) || lt >= 5000) bloqueios.push('Informe os litros do visor.');
  if (!(enc > 0)) bloqueios.push('Informe o encerrante final.');
  if (f.desconto === null) bloqueios.push('Diga se o diesel foi descontado do motorista.');
  if (f.desconto === false && f.justificativa.trim().length < 5) bloqueios.push('Escreva a justificativa para o supervisor.');
  if (foraDoTurno(f.hora) && f.justHorario.trim().length < 5) bloqueios.push('Fora do horário do turno: escreva a justificativa.');
  if (precisaCapacidade(f) && !(parseNum(f.capacidade) > 0 && parseNum(f.capacidade) < 5000)) bloqueios.push('Informe o tamanho do tanque do veículo.');
  if (precisaCpf(f) && !cpfValido(f.cpf)) bloqueios.push('Informe o CPF do motorista.');
  const cap = v?.capacidade_l ?? (parseNum(f.capacidade) > 0 ? parseNum(f.capacidade) : null);
  const regras = [];
  // Igual ao banco: maior que o último lançado (desde a última correção de KM); igual ao KM do cadastro vale
  const ka = v?.km_anterior == null ? null : Number(v.km_anterior);
  const kUlt = v?.km_ultimo == null ? null : Number(v.km_ultimo), kCad = v?.km_cadastro == null ? null : Number(v.km_cadastro);
  if (!v || !(km > 0)) regras.push({ e: null, t: 'KM maior que o último da placa.' });
  else if (kUlt != null && km <= kUlt) regras.push({ e: false, t: `KM ${nf(km, 0)} é menor ou igual ao último desta placa (${nf(kUlt, 0)}).`, corrigir: true });
  else if (kCad != null && km < kCad) regras.push({ e: false, t: `KM ${nf(km, 0)} é menor que o KM do cadastro desta placa (${nf(kCad, 0)}).`, corrigir: true });
  else if (ka != null && km - ka > LIM.kmSalto) regras.push({ e: false, t: `Rodou ${nf(km - ka, 0)} km desde o último abastecimento. Confira o painel.`, corrigir: true });
  else regras.push({ e: true, t: ka == null ? 'Primeiro abastecimento registrado desta placa.' : `KM coerente: +${nf(km - ka, 0)} km.` });
  if (!v || !(lt > 0) || cap == null) regras.push({ e: null, t: 'Litros dentro da capacidade do tanque.' });
  else if (lt > cap * LIM.tolCap) regras.push({ e: false, t: `${nf(lt)} L passa da capacidade do tanque deste veículo (${nf(cap, 0)} L).`, corrigir: true });
  else regras.push({ e: true, t: `Cabe no tanque do veículo (${nf(cap, 0)} L).` });
  const ea = encAnterior(f.bomba);
  const bate = anterior => Math.abs(enc - anterior - lt) <= LIM.tolEnc;
  if (f.bomba == null || !(enc > 0) || !(lt > 0)) regras.push({ e: null, t: 'Encerrante bate com os litros.' });
  else if (enc <= ea) regras.push({ e: false, t: `Encerrante ${nf(enc)} não é maior que o anterior da bomba ${f.bomba} (${nf(ea)}).` });
  else if (!bate(ea)) regras.push({ e: false, t: `Pelo encerrante saíram ${nf(enc - ea)} L, mas o visor diz ${nf(lt)} L.` });
  else regras.push({ e: true, t: `Encerrante bate com os litros (${nf(enc - ea)} L).` });
  // Encerrante que não bate com a bomba escolhida, mas bate com outra: bomba trocada
  const outra = f.bomba != null && enc > 0 && lt > 0 && !bate(ea)
    ? estado.bombas.find(b => b.numero !== f.bomba && bate(Number(b.encerrante_anterior ?? 0))) : null;
  if (outra) regras.push({ e: false, t: `Esse encerrante bate com a bomba ${outra.numero}. Confira se escolheu a bomba certa.`, bomba: outra.numero });
  return { bloqueios, regras, falhas: regras.filter(r => r.e === false) };
}
const encAnterior = bomba => Number(estado.bombas.find(x => x.numero === bomba)?.encerrante_anterior ?? 0);

// ---------- Comunicação ----------
async function atualizarEstado() {
  estado = await rpc('estado_posto');
  semAcesso = false; semRede = false;
  if (estado.papel !== 'posto') { location.replace(URL_PAINEL); throw new Error('Abrindo o painel…'); }
}

function tratarErro(e) {
  if (e.frentistaSaiu) { login = null; gravar('frentistaLogin', null); aviso = { tipo: 'warn', texto: e.message }; }
  else if (e.semAcesso) semAcesso = true;
  else aviso = { tipo: 'warn', texto: e.semRede ? 'Sem internet. Nada foi enviado: confira a conexão e tente de novo.' : e.message };
}

async function executar(acao) {
  if (enviando) return;
  if (!navigator.onLine) { aviso = { tipo: 'warn', texto: 'Sem internet. Conecte e tente de novo.' }; render(); return; }
  enviando = true; render();
  try { await acao(); } catch (e) { tratarErro(e); } finally { enviando = false; render(); conteudo.scrollTop = 0; }
}

// ---------- Telas ----------
const avisoHtml = () => aviso ? `<div class="toast ${aviso.tipo}" role="status">${esc(aviso.texto)}</div>` : '';
const botaoEnviar = (acao, texto, pode, classe = '') =>
  `<button class="btn ${classe}" type="button" data-acao="${acao}" ${pode && !enviando ? '' : 'disabled'}>${enviando ? 'Enviando…' : texto}</button>`;

function blocoFotos(lista, dono, minimo = 0, maximo = MAX_FOTOS) {
  return `<div class="field"><span class="lbl">${maximo === 1 ? 'Foto' : 'Fotos'}${minimo ? ' (obrigatória)' : ' (opcional)'}</span>
    <div class="fotos">${lista.map((f, i) => `<figure><img src="${f.previa}" alt="Foto ${i + 1}"><button type="button" class="tirar" data-tirar="${dono}" data-i="${i}" aria-label="Remover foto">×</button></figure>`).join('')}
      ${lista.length < maximo ? `<button type="button" class="nova-foto" data-foto="${dono}">+ Tirar foto</button>` : ''}</div></div>`;
}

const MARCA = `<svg class="marca" viewBox="0 0 72 72" aria-hidden="true"><rect width="72" height="72" rx="18" fill="#b86a07"/>
  <rect x="19" y="15" width="25" height="41" rx="4" fill="#fff"/><rect x="23.5" y="20" width="16" height="10.5" rx="2" fill="#b86a07"/>
  <path d="M44 42h8V24" stroke="#fff" stroke-width="3.6" fill="none" stroke-linecap="round"/><path class="gota" d="M52 24c0 0-3 3.5-3 5.5a3 3 0 0 0 6 0C55 27.5 52 24 52 24z" fill="#f6e6cc"/>
  <rect x="15" y="54" width="32" height="4.5" rx="2.2" fill="#fff"/></svg>`;
const G = `<svg class="g" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z"/><path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8z"/><path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.5 1.4l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"/></svg>`;

function telaGoogle() {
  return `<div class="centro abertura cascata">
    <span style="--i:0">${MARCA}</span>
    <h1 style="--i:1">Celular do posto</h1>
    <p class="hint" style="--i:2">Entre uma vez com a conta Google do posto. Depois, cada frentista entra com o próprio nome e PIN.</p>
    <div style="--i:3">${avisoHtml()}</div>
    <button class="btn google" type="button" data-acao="google" style="--i:4">${G}Entrar com Google</button></div>`;
}

function telaSemAcesso() {
  return `<div class="centro">
    <h1>Conta sem acesso</h1>
    <p>A conta <b>${esc(conta)}</b> ainda não foi liberada.</p>
    <p class="hint">Peça ao supervisor para cadastrar este e-mail em "Acessos" no painel, como "Celular do posto".</p>
    <button class="btn" type="button" data-acao="tentar">Tentar de novo</button>
    <button class="btn ghost" type="button" data-acao="trocar-google">Entrar com outra conta</button></div>`;
}

function telaSemRede() {
  return `<div class="centro"><h1>Sem internet</h1><p>O app precisa de internet para funcionar.</p>
    <button class="btn" type="button" data-acao="tentar">Tentar de novo</button></div>`;
}

function telaLoginFrentista() {
  const lista = estado.frentistas;
  if (!escolhido) {
    // quem entrou por último neste celular vem primeiro e destacado
    const ultimo = ler('ultimoFrentista', null);
    const ordem = [...lista].sort((a, b) => (b.id === ultimo) - (a.id === ultimo));
    return `<div class="centro login cascata">
      <h1 style="--i:0">Quem está no posto?</h1>
      <p class="hint" style="--i:1">Toque no seu nome.</p>
      <div style="--i:1">${avisoHtml()}</div>
      <div class="nomes">${ordem.length ? ordem.map((f, i) => `<button type="button" class="${f.id === ultimo && f.tem_pin ? 'ultimo' : ''}" data-frentista="${f.id}" style="--i:${i + 2}" ${f.tem_pin ? '' : 'disabled'}>
        ${avatar(f.nome)}<span class="quem"><b>${esc(f.nome)}</b><small>${!f.tem_pin ? 'sem PIN: peça ao supervisor' : f.id === ultimo ? 'último a entrar neste celular' : 'frentista'}</small></span>
        <span class="seta" aria-hidden="true">›</span></button>`).join('')
        : '<p class="hint">Nenhum frentista cadastrado. O supervisor cadastra no painel.</p>'}</div>
      <button class="link" type="button" data-acao="trocar-google" style="--i:${ordem.length + 2}">Sair da conta Google do celular</button></div>`;
  }
  const f = lista.find(x => x.id === escolhido);
  return `<div class="centro login pin-tela">
    <div class="quem-pin">${avatar(f?.nome || '', true)}<h1>${esc(f?.nome || '')}</h1><p class="hint">Digite seu PIN de 4 números.</p></div>
    <div class="pin ${pinEstado}" aria-label="PIN digitado">${[0, 1, 2, 3].map(i => `<span class="${i < pin.length ? 'cheio' : ''}${i === pin.length - 1 && !pinEstado ? ' novo' : ''}"></span>`).join('')}</div>
    <div class="msg-pin" role="status">${aviso ? esc(aviso.texto) : enviando ? 'Conferindo…' : ''}</div>
    <div class="teclado">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" data-tecla="${n}">${n}</button>`).join('')}
      <button type="button" class="mudo" data-tecla="voltar" aria-label="Voltar para a lista de nomes">‹ Voltar</button><button type="button" data-tecla="0">0</button>
      <button type="button" class="mudo" data-tecla="apagar" aria-label="Apagar">⌫</button></div></div>`;
}

// Logo depois do PIN: confirmação e um resumo do turno; abre a tela de abastecer sozinha
function telaBoasVindas() {
  const h = new Date().getHours(), oi = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const vencidas = estado.bombas.filter(b => b.afericao_vencida).map(b => b.numero);
  const p = estado.preco_diesel;
  const linhas = [
    ['Turno', `${esc(estado.turno?.abertura || '')} – ${esc(estado.turno?.fechamento || '')}`],
    ...estado.bombas.map(b => [`Bomba ${b.numero} · encerrante`, nf(b.encerrante_anterior, 0)]),
    p ? ['Preço do diesel', `${reais(p.preco)}/L`] : null,
  ].filter(Boolean);
  return `<div class="centro ola cascata">
    <svg class="check" viewBox="0 0 76 76" aria-hidden="true" style="--i:0"><circle cx="38" cy="38" r="38"/><path d="M24 39l9 9 19-20"/></svg>
    <h1 style="--i:1">${oi}, ${esc(String(login.nome).split(' ')[0])}</h1>
    <div class="resumo-turno">${linhas.map(([a, b], i) => `<div style="--i:${i + 2}"><span>${esc(a)}</span><b>${b}</b></div>`).join('')}
      ${estado.fechado_hoje ? `<div class="lembrete" style="--i:${linhas.length + 2}"><span>O turno de hoje já foi fechado</span></div>` : ''}
      ${vencidas.length ? `<div class="lembrete" style="--i:${linhas.length + 2}"><span>Aferição da${vencidas.length > 1 ? 's bombas' : ' bomba'} ${vencidas.join(' e ')} vencida</span><span>aba Aferir</span></div>` : ''}</div>
    <div class="barra" style="--i:${linhas.length + 3}"><i></i></div>
    <button class="link" type="button" data-acao="abrir-app" style="--i:${linhas.length + 4}">Abrir agora</button></div>`;
}
function fecharBoasVindas() { clearTimeout(timerBoasVindas); if (!boasVindas) return; boasVindas = false; render(); }

const SEM_TECLADO_ESPERTO = 'autocomplete="off" autocorrect="off" spellcheck="false"';
function campoPlaca(v) {
  const txt = soPlaca(form.placaTxt), lista = form.placa ? [] : sugestoesPlaca(form.placaTxt);
  return `<div class="field"><label class="lbl" for="f-placa">Placa</label>
    <input id="f-placa" class="busca" maxlength="8" autocapitalize="characters" ${SEM_TECLADO_ESPERTO} placeholder="Digite o começo da placa" value="${esc(form.placaTxt)}">
    ${form.placa ? `<span class="escolhido">✓ ${esc(form.placa)}${v.capacidade_l == null ? '' : ` · tanque de ${nf(v.capacidade_l, 0)} L`}</span>` : ''}
    ${form.placa && !precisaCapacidade(form) ? '<button class="link esq" type="button" data-acao="corrigir-veiculo">Corrigir tanque ou KM deste caminhão</button>' : ''}
    ${precisaCapacidade(form) ? `<div class="primeira-vez"><label class="lbl" for="f-cap">Primeiro abastecimento desta placa: tamanho do tanque do veículo (L)</label>
      <input id="f-cap" class="num" inputmode="decimal" value="${esc(form.capacidade)}"></div>` : ''}
    ${lista.length ? `<div class="sugestoes">${lista.map(x => `<button type="button" data-sug-placa="${esc(x.placa)}"><b>${esc(x.placa)}</b>
      <small>${esc(vinculados(x.placa).slice(0, 2).join(', '))}${vinculados(x.placa).length > 2 ? '…' : ''}</small></button>`).join('')}</div>` : ''}
    ${form.placa ? '' : txt && !lista.length
      ? `<p class="hint">Nenhuma placa cadastrada com "${esc(txt)}".</p><button class="btn ghost small" type="button" data-acao="novo-veiculo">+ Cadastrar a placa ${esc(txt)}</button>`
      : '<button class="link esq" type="button" data-acao="novo-veiculo">+ Placa não está na lista</button>'}</div>`;
}
function campoMotorista() {
  const vinc = vinculados(form.placa), lista = form.motorista ? [] : sugestoesMotorista(form.motoristaTxt, form.placa);
  const nome = form.motoristaTxt.trim();
  return `<div class="field"><label class="lbl" for="f-motorista">Motorista</label>
    ${vinc.length && !form.motorista ? `<span class="hint">Motoristas desta placa:</span><div class="vinculados">${vinc.map(m =>
      `<button type="button" data-sug-motorista="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}
    <input id="f-motorista" class="busca" maxlength="120" autocapitalize="characters" ${SEM_TECLADO_ESPERTO} placeholder="${vinc.length ? 'Ou digite o nome' : 'Digite o nome'}" value="${esc(form.motoristaTxt)}">
    ${form.motorista ? `<span class="escolhido">✓ ${esc(form.motorista)}${form.placa && !vinc.includes(form.motorista) ? ' · fica vinculado a esta placa ao enviar' : ''}</span>` : ''}
    ${precisaCpf(form) ? `<div class="primeira-vez"><label class="lbl" for="f-cpf">Primeiro abastecimento deste motorista: CPF (o KMM exige)</label>
      <input id="f-cpf" class="num" inputmode="numeric" maxlength="14" ${SEM_TECLADO_ESPERTO} value="${esc(form.cpf)}">
      ${form.cpf.replace(/\D/g, '').length === 11 && !cpfValido(form.cpf) ? '<span class="hint">CPF inválido: confira os números.</span>' : ''}</div>` : ''}
    ${lista.length ? `<div class="sugestoes">${lista.map(m => `<button type="button" data-sug-motorista="${esc(m)}"><b>${esc(m)}</b>
      ${vinc.includes(m) ? '<small>desta placa</small>' : ''}</button>`).join('')}</div>` : ''}
    ${form.motorista ? '' : nome && !lista.length
      ? `<p class="hint">Nenhum motorista cadastrado com "${esc(nome)}".</p><button class="btn ghost small" type="button" data-acao="novo-motorista">+ Cadastrar o motorista</button>`
      : '<button class="link esq" type="button" data-acao="novo-motorista">+ Motorista não está na lista</button>'}</div>`;
}

// Botão Limpar (só aparece quando há algo preenchido) e a confirmação na própria tela
const temAlgoPreenchido = () => [form.placaTxt, form.motoristaTxt, form.km, form.litros, form.enc, form.obs, form.justificativa, form.justHorario, form.capacidade, form.cpf]
  .some(x => String(x || '').trim()) || form.desconto !== null || !!form.usarPreco;
function blocoLimpar() {
  if (confirmaLimpar) {
    return `<div class="confirma" role="alertdialog" aria-label="Confirmar limpeza">Apagar placa, motorista, KM, litros, encerrante e o resto do que foi preenchido? A bomba e a hora ficam.
      <div class="acoes"><button class="btn ghost small" type="button" data-acao="limpar-nao">Cancelar</button><button class="btn warn small" type="button" data-acao="limpar-sim">Limpar</button></div></div>`;
  }
  return `<div class="form-cab"><span class="secao">Novo abastecimento</span>${temAlgoPreenchido() ? '<button class="btn ghost small" type="button" data-acao="limpar">Limpar</button>' : ''}</div>`;
}
// Preço do litro: tocar para usar o atual; "atualizar" muda o preço do posto (vale para todos, fica com o nome do frentista)
function blocoPreco() {
  const p = estado.preco_diesel, lt = parseNum(form.litros);
  const novo = editPreco ? parseNum(editPreco.valor) : NaN, novoOk = novo >= 0.5 && novo < 100;
  return `<div class="field preco"><span class="lbl">Preço do litro</span>
    ${p ? `<button type="button" class="usar-preco" data-acao="usar-preco" aria-pressed="${!!form.usarPreco}">
        <span>${form.usarPreco ? '✓ Usando o preço atual' : 'Usar o preço atual'}</span><b>${reais(p.preco)}/L</b></button>
      <span class="hint">Atualizado em ${esc(dataHoraCurta(p.em))}${p.por ? ` por ${esc(p.por)}` : ''}${p.origem === 'chegada' ? ' (pela NF da chegada)' : ''}.</span>`
      : '<span class="hint">O preço do diesel ainda não foi informado.</span>'}
    ${editPreco ? `<div class="linha-preco"><input id="f-preco-novo" class="num" inputmode="decimal" placeholder="Ex.: 6,19" aria-label="Novo preço do litro" value="${esc(editPreco.valor)}">
        <button class="btn small" type="button" data-acao="salvar-preco" ${novoOk && !enviando ? '' : 'disabled'}>Salvar</button>
        <button class="btn ghost small" type="button" data-acao="cancelar-preco">Cancelar</button></div>
      <span class="hint">O preço novo vale para os próximos lançamentos de todos os frentistas e fica registrado com o seu nome.</span>`
      : `<button class="link esq" type="button" data-acao="alterar-preco">${p ? 'O preço mudou? Atualizar' : 'Informar o preço'}</button>`}
    ${form.usarPreco && p && lt > 0 ? `<div class="total"><span class="lbl">Valor total</span><b class="num">${reais(Math.round(lt * p.preco * 100) / 100)}</b></div>` : ''}</div>`;
}

function telaAbastecer() {
  if (estado.fechado_hoje) return avisoHtml() + diaFechado();
  if (!estado.bombas.length) return '<p class="hint">Nenhuma bomba cadastrada. Peça ao supervisor.</p>';
  const c = conferir(form);
  const ea = encAnterior(form.bomba);
  const enc = parseNum(form.enc);
  const falha = c.falhas.length > 0;
  const semDesconto = form.desconto === false;
  const fora = foraDoTurno(form.hora);
  const pode = !c.bloqueios.length && (!falha || form.obs.trim().length >= 5);
  const v = estado.veiculos.find(x => x.placa === form.placa);
  const variosTanques = new Set(estado.bombas.map(b => b.tanque)).size > 1;
  return `
    ${avisoHtml()}${avisoFechamento()}${avisoAfericao()}
    ${blocoLimpar()}
    <div class="field"><span class="lbl">Em qual bomba foi o abastecimento?</span><div class="bombas">
      ${estado.bombas.map(b => `<button type="button" data-bomba="${b.numero}" aria-pressed="${b.numero === form.bomba}"><b>${b.numero}</b>
        <small>${variosTanques ? `${esc(b.tanque)} · ` : ''}enc. ${nf(b.encerrante_anterior)}</small></button>`).join('')}
    </div></div>
    ${campoPlaca(v)}
    ${campoMotorista()}
    <div class="row2">
      <div class="field"><label class="lbl" for="f-km">KM do painel</label><input id="f-km" class="num" inputmode="numeric" value="${esc(form.km)}">
        ${v ? `<span class="hint">Último: ${v.km_anterior == null ? 'sem registro' : nf(v.km_anterior, 0) + ' km'}</span>` : ''}</div>
      <div class="field"><label class="lbl" for="f-hora">Hora</label><input id="f-hora" type="time" value="${esc(form.hora)}"></div>
    </div>
    ${fora ? `<div class="field fora"><span class="chip hora">Fora do horário do turno (${esc(estado.turno.abertura)}–${esc(estado.turno.fechamento)})</span>
      <label class="lbl" for="f-just-h">Por que foi abastecido fora do horário? (o supervisor precisa autorizar)</label>
      <textarea id="f-just-h" rows="2" maxlength="500">${esc(form.justHorario)}</textarea></div>` : ''}
    <div class="row2">
      <div class="field"><label class="lbl" for="f-litros">Litros (visor)</label><input id="f-litros" class="num" inputmode="decimal" value="${esc(form.litros)}"></div>
      <div class="field"><label class="lbl" for="f-enc">Encerrante final</label><input id="f-enc" class="num" inputmode="decimal" value="${esc(form.enc)}"></div>
    </div>
    ${blocoPreco()}
    ${form.bomba == null ? '<div class="medidor"><span>Encerrante anterior</span><span class="v">escolha a bomba</span></div>'
      : `<div class="medidor"><span>Encerrante anterior (bomba ${form.bomba})</span><span class="v">${nf(ea)}</span>
      <span>Saída pelo encerrante</span><span class="v grande">${enc > ea ? nf(enc - ea) + ' L' : '–'}</span></div>`}
    <ul class="checks">${c.regras.map(r => `<li class="${r.e === true ? 'ok' : r.e === false ? 'falha' : ''}">${esc(r.t)}${r.bomba
      ? ` <button class="link" type="button" data-bomba="${r.bomba}">Usar a bomba ${r.bomba}</button>` : ''}${r.corrigir
      ? ' <button class="link" type="button" data-acao="corrigir-veiculo">Corrigir tanque ou KM do caminhão</button>' : ''}</li>`).join('')}</ul>
    ${falha ? `<div class="field"><label class="lbl" for="f-obs">O que aconteceu? (vai para o supervisor)</label>
      <textarea id="f-obs" rows="2" maxlength="500">${esc(form.obs)}</textarea></div>` : ''}
    <div class="field desconto"><span class="lbl">O diesel foi descontado do motorista?</span>
      <div class="opcoes">
        <button type="button" data-desconto="sim" aria-pressed="${form.desconto === true}">Sim, descontado</button>
        <button type="button" data-desconto="nao" aria-pressed="${semDesconto}">Não</button>
      </div>
      ${semDesconto ? `<label class="lbl" for="f-just">Por que não foi descontado? (o supervisor precisa autorizar)</label>
        <textarea id="f-just" rows="2" maxlength="500">${esc(form.justificativa)}</textarea>` : ''}</div>
    ${c.bloqueios.length ? `<p class="hint">${c.bloqueios.map(esc).join(' ')}</p>` : ''}
    ${botaoEnviar('enviar', semDesconto || fora ? 'Pedir autorização ao supervisor' : falha ? 'Enviar para o supervisor' : 'Enviar abastecimento', pode,
      semDesconto || fora || falha ? 'warn' : '')}`;
}

function telaNovoVeiculo() {
  const f = novoVeiculo;
  const pode = /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(f.placa.toUpperCase().replace(/[^A-Z0-9]/g, '')) && parseNum(f.capacidade) > 0 && f.fotos.length === 1;
  return `<h2>Cadastrar veículo</h2>
    <p class="hint">Só para placa que ainda não existe. Depois de cadastrado, só o supervisor altera.</p>
    ${avisoHtml()}
    <div class="field"><label class="lbl" for="v-placa">Placa</label><input id="v-placa" maxlength="8" autocapitalize="characters" value="${esc(f.placa)}"></div>
    <div class="row2">
      <div class="field"><label class="lbl" for="v-cap">Tanque do veículo (L)</label><input id="v-cap" class="num" inputmode="decimal" value="${esc(f.capacidade)}"></div>
      <div class="field"><label class="lbl" for="v-km">KM atual</label><input id="v-km" class="num" inputmode="numeric" value="${esc(f.km)}"></div>
    </div>
    ${f.fotos.length ? '' : '<p class="hint">Tire uma foto do caminhão mostrando a placa.</p>'}
    ${blocoFotos(f.fotos, 'veiculo', 1, 1)}
    ${botaoEnviar('salvar-veiculo', 'Cadastrar veículo', pode)}
    <button class="btn ghost" type="button" data-acao="voltar">Voltar</button>`;
}

function telaCorrigirVeiculo() {
  const f = correcao, v = estado.veiculos.find(x => x.placa === f.placa);
  const cap = parseNum(f.capacidade), km = parseNum(f.km);
  const capMudou = cap > 0 && cap < 5000 && cap !== Number(v?.capacidade_l), kmOk = f.km.trim() !== '' && km > 0 && km < 1e7;
  const capErrada = f.capacidade.trim() !== '' && !(cap > 0 && cap < 5000), kmErrado = f.km.trim() !== '' && !kmOk;
  return `<h2>Corrigir o caminhão ${esc(f.placa)}</h2>
    <p class="hint">Mude só o que está errado. A correção vale na hora e fica registrada com o seu nome.</p>
    ${avisoHtml()}
    <div class="field"><label class="lbl" for="cv-cap">Tamanho do tanque do caminhão (L)</label>
      <input id="cv-cap" class="num" inputmode="decimal" value="${esc(f.capacidade)}">
      ${capErrada ? '<span class="hint">Confira: deve ficar entre 1 e 4.999 L.</span>' : ''}</div>
    <div class="field"><label class="lbl" for="cv-km">KM atual do painel do caminhão (deixe em branco se o KM está certo)</label>
      <input id="cv-km" class="num" inputmode="numeric" value="${esc(f.km)}">
      <span class="hint">Último KM conhecido: ${v?.km_anterior == null ? 'sem registro' : `${nf(v.km_anterior, 0)} km`}.
        O KM informado aqui passa a ser o ponto de partida: os próximos abastecimentos são conferidos a partir dele.</span>
      ${kmErrado ? '<span class="hint">KM inválido.</span>' : ''}</div>
    ${botaoEnviar('salvar-correcao', 'Salvar correção', (capMudou || kmOk) && !capErrada && !kmErrado)}
    <button class="btn ghost" type="button" data-acao="voltar">Voltar</button>`;
}

function telaNovoMotorista() {
  const f = novoMotorista;
  const cpf = f.cpf.replace(/\D/g, '');
  const pode = f.nome.trim().split(/\s+/).length >= 2 && cpf.length === 11;
  return `<h2>Cadastrar motorista</h2>
    <p class="hint">Só para motorista que ainda não existe. Depois de cadastrado, só o supervisor altera.</p>
    ${avisoHtml()}
    <div class="field"><label class="lbl" for="m-nome">Nome completo</label><input id="m-nome" maxlength="120" autocapitalize="characters" value="${esc(f.nome)}"></div>
    <div class="field"><label class="lbl" for="m-cpf">CPF</label><input id="m-cpf" class="num" inputmode="numeric" maxlength="14" value="${esc(f.cpf)}"></div>
    ${botaoEnviar('salvar-motorista', 'Cadastrar motorista', pode)}
    <button class="btn ghost" type="button" data-acao="voltar">Voltar</button>`;
}

function telaTurno() {
  const lista = [...estado.hoje].sort((a, b) => String(b.data_hora).localeCompare(String(a.data_hora)));
  const n = s => estado.hoje.filter(r => s.includes(r.status)).length;
  return `${avisoHtml()}${avisoFechamento()}
    <div class="resumo">
      <div><b>${n(['Lançado'])}</b><span>Lançados no KMM</span></div>
      <div><b>${n(['Pronto', 'Em lote'])}</b><span>Aguardando o KMM</span></div>
      <div><b>${n(['Exceção', 'Erro', 'Aguardando autorização'])}</b><span>Com o supervisor</span></div>
    </div>
    <div class="secao">Hoje</div>
    ${lista.length ? lista.map(r => `<div class="reg">
      <div class="linha1"><span class="placa">${esc(r.placa)}</span><span class="pill ${classeStatus(r.status)}">${esc(r.status)}</span></div>
      <div class="det">${hhmm(r.data_hora)} · ${esc(r.motorista)} · Bomba ${esc(r.bomba)} · #${r.id}</div>
      <div class="det">${nf(r.litros)} L · ${nf(r.km, 0)} km · ${esc(r.frentista || '')}${r.desconto_confirmado ? '' : ' · sem desconto'}</div>
      ${r.problemas?.length ? `<ul>${r.problemas.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    </div>`).join('') : '<p class="hint">Nenhum abastecimento hoje.</p>'}
    <button class="btn ghost" type="button" data-acao="atualizar">Atualizar</button>
    <p class="hint">Atualizado às ${hhmm(estado.gerado_em)} · turno das ${esc(estado.turno?.abertura)} às ${esc(estado.turno?.fechamento)}.</p>`;
}

function telaChegada() {
  if (estado.fechado_hoje) return avisoHtml() + diaFechado();
  const f = chegada, l = parseNum(f.litros), sub = parseNum(f.depois) - parseNum(f.antes);
  const okRegua = l > 0 && sub > 0 && Math.abs(sub - l) <= LIM.tolTanque;
  const pode = f.tanque && f.nf.trim() && l > 0 && /^\d{2}:\d{2}$/.test(f.hora);
  const s = sugestaoPreco, atual = estado.preco_diesel;
  return `
    ${avisoHtml()}
    ${s ? `<div class="sugestao-preco">A NF ${esc(s.nf)} dá <b>${reais(s.preco)}</b> por litro${atual ? `; o preço atual é ${reais(atual.preco)}` : ''}. Atualizar o preço do diesel?
      <div class="acoes"><button class="btn ghost small" type="button" data-acao="ignorar-preco">Agora não</button>
        <button class="btn small" type="button" data-acao="preco-da-nf" ${enviando ? 'disabled' : ''}>Atualizar para ${reais(s.preco)}</button></div></div>` : ''}
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
    ${blocoFotos(fotosChegada, 'chegada')}
    ${botaoEnviar('chegada', 'Registrar chegada', pode)}`;
}

// Últimas aferições, com quem fez (acima de 100 mL fica vermelho)
function historicoAfericoes() {
  const lista = estado.afericoes_recentes || [];
  if (!lista.length) return '<div class="secao">Últimas aferições</div><p class="hint">Nenhuma aferição registrada ainda.</p>';
  return `<div class="secao">Últimas aferições</div><div class="historico">${lista.map(a => {
    const dif = Number(a.diferenca_l);
    return `<div class="af"><span><b>Bomba ${esc(a.bomba)}</b> · visor ${nf(a.visor_l, 3)} L</span>
      <span class="dif ${Math.abs(dif) > LIM.tolAfericao ? 'alerta' : 'ok'}">${dif > 0 ? '+' : ''}${nf(dif * 1000, 0)} mL</span>
      <span class="quem">${avatar(a.frentista)}${esc(a.frentista)}</span><span class="quando">${esc(dataHoraCurta(a.data_hora))}</span></div>`;
  }).join('')}</div>`;
}

function telaAfericao() {
  if (estado.fechado_hoje) return avisoHtml() + diaFechado() + historicoAfericoes();
  if (!estado.bombas.length) return '<p class="hint">Nenhuma bomba cadastrada. Peça ao supervisor.</p>';
  const f = afericao, v = parseNum(f.visor), dif = v - 20;
  const pode = f.bomba != null && v >= 15 && v <= 25 && fotosAfericao.length > 0;
  const ml = x => `${x > 0 ? '+' : ''}${nf(x * 1000, 0)} mL`;
  return `${avisoHtml()}
    <p class="hint">Uma vez por semana em cada bomba: encha a medida padrão de 20 L, anote quanto o visor marcou e tire a foto.
      Depois devolva o diesel para o tanque.</p>
    <div class="field"><span class="lbl">Qual bomba você aferiu?</span><div class="bombas">
      ${estado.bombas.map(b => `<button type="button" data-afericao-bomba="${b.numero}" aria-pressed="${b.numero === f.bomba}"><b>${b.numero}</b>
        <small>${esc(situacaoAfericao(b))}</small></button>`).join('')}
    </div></div>
    <div class="field"><label class="lbl" for="a-visor">Litros no visor (medida de 20 L)</label>
      <input id="a-visor" class="num" inputmode="decimal" value="${esc(f.visor)}"></div>
    ${v > 0 ? `<ul class="checks"><li class="${v < 15 || v > 25 ? 'falha' : Math.abs(dif) <= LIM.tolAfericao ? 'ok' : 'falha'}">${v < 15 || v > 25
      ? 'Confira o número: deve ficar perto de 20 L.' : Math.abs(dif) <= LIM.tolAfericao
      ? `Diferença de ${ml(dif)}: dentro da tolerância (até 100 mL).` : `Diferença de ${ml(dif)}: acima da tolerância. O supervisor vai receber um alerta.`}</li></ul>` : ''}
    ${fotosAfericao.length ? '' : '<p class="hint">Tire a foto da medida cheia junto com o visor da bomba.</p>'}
    ${blocoFotos(fotosAfericao, 'afericao', 1, 3)}
    ${botaoEnviar('aferir', 'Registrar aferição', pode)}
    ${historicoAfericoes()}`;
}

function telaFechar() {
  if (estado.tanques.some(t => t.fechado)) {
    return `${avisoHtml()}<div class="toast ok">O turno de hoje já foi fechado.</div>${estado.tanques.map(t => `<div class="tanque"><h3>${esc(t.tanque)}</h3>
      <div class="medidor"><span>Esperado</span><span class="v">${nf(t.fechado.saldo_calculado, 0)} L</span>
      <span>Medido (régua)</span><span class="v">${nf(t.fechado.saldo_medido, 0)} L</span>
      <span class="tot">Diferença</span><span class="v tot">${nf(t.fechado.diferenca, 0)} L</span></div></div>`).join('')}`;
  }
  const completos = estado.tanques.length && estado.tanques.every(t => !Number.isNaN(parseNum(medidos[t.tanque])));
  return `
    ${avisoHtml()}
    <p class="hint">Meça os tanques no fim do turno. O sistema compara com o que entrou e saiu pelas bombas.</p>
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
    ${blocoFotos(fotosFechamento, 'fechamento')}
    ${botaoEnviar('fechar', 'Fechar turno', completos)}`;
}

function telaAjuda() {
  return `<div class="field"><span class="lbl">Tema da tela</span>${htmlTema()}</div>
    ${htmlAbasGuia(guia, ['frentista', 'glossario'])}${htmlGuia(guia, estado.turno)}
    <p class="hint">Conta do celular: ${esc(conta)}</p>`;
}

// Transição entre telas: só quando a tela muda (digitar não repete a animação). Avançar desliza da direita,
// voltar da esquerda; trocar de aba só esmaece.
const NIVEL_TELA = ['google', 'semacesso', 'carregando', 'semrede', 'nomes', 'pin', 'ola'];
const nivelTela = k => (k.startsWith('aba:') ? 7 : k.startsWith('sub:') ? 8 : NIVEL_TELA.indexOf(k));
function animarTroca(chave) {
  conteudo.classList.remove('animar', 'entra-frente', 'entra-tras', 'entra-suave');
  if (chave === ultimaChave) return;
  const tipo = !ultimaChave || (chave.startsWith('aba:') && ultimaChave.startsWith('aba:')) ? 'entra-suave'
    : nivelTela(chave) >= nivelTela(ultimaChave) ? 'entra-frente' : 'entra-tras';
  void conteudo.offsetWidth;   // reinicia a animação
  conteudo.classList.add('animar', tipo);
  conteudo.scrollTop = 0;
  ultimaChave = chave;
}

function render(manterFoco) {
  const foco = manterFoco && document.activeElement?.id;
  const pos = foco && document.activeElement.selectionStart;
  const logado = conta && estado && !semAcesso && login;
  const abas = $('abas'), abasEscondidas = !logado || !!tela || boasVindas;
  if (abas.hidden && !abasEscondidas) { abas.classList.remove('sobe'); void abas.offsetWidth; abas.classList.add('sobe'); }
  abas.hidden = abasEscondidas;
  $('sair').hidden = !logado || boasVindas;
  $('subtitulo').textContent = logado ? login.nome : conta && estado && !semAcesso ? 'Celular do posto' : '';
  let html, chave;
  if (!conta) { html = telaGoogle(); chave = 'google'; }
  else if (semAcesso) { html = telaSemAcesso(); chave = 'semacesso'; }
  else if (!estado) { html = semRede ? telaSemRede() : '<p class="hint">Carregando…</p>'; chave = semRede ? 'semrede' : 'carregando'; }
  else if (!login) { html = telaLoginFrentista(); chave = escolhido ? 'pin' : 'nomes'; }
  else if (boasVindas) { html = telaBoasVindas(); chave = 'ola'; }
  else if (tela === 'veiculo') { html = telaNovoVeiculo(); chave = 'sub:veiculo'; }
  else if (tela === 'motorista') { html = telaNovoMotorista(); chave = 'sub:motorista'; }
  else if (tela === 'corrigir') { html = telaCorrigirVeiculo(); chave = 'sub:corrigir'; }
  else { html = { abastecer: telaAbastecer, turno: telaTurno, chegada: telaChegada, aferir: telaAfericao, fechar: telaFechar, ajuda: telaAjuda }[aba](); chave = `aba:${aba}`; }
  conteudo.innerHTML = html;
  animarTroca(chave);
  document.querySelectorAll('#abas button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.aba === aba)));
  if (foco) { const el = $(foco); if (el) { el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch { /* campo sem seleção */ } } }
}

// ---------- Eventos ----------
const mapaForm = { 'f-cap': 'capacidade', 'f-cpf': 'cpf', 'f-hora': 'hora', 'f-km': 'km', 'f-litros': 'litros', 'f-enc': 'enc',
  'f-obs': 'obs', 'f-just': 'justificativa', 'f-just-h': 'justHorario' };
const mapaChegada = { 'c-tanque': 'tanque', 'c-hora': 'hora', 'c-nf': 'nf', 'c-litros': 'litros', 'c-valor': 'valor', 'c-antes': 'antes',
  'c-depois': 'depois', 'c-placa': 'placa', 'c-carreta': 'carreta', 'c-motorista': 'motorista', 'c-cpf': 'cpf' };
const mapaVeiculo = { 'v-placa': 'placa', 'v-cap': 'capacidade', 'v-km': 'km' };
const mapaMotorista = { 'm-nome': 'nome', 'm-cpf': 'cpf' };

conteudo.addEventListener('input', e => {
  const id = e.target.id;
  if (mapaForm[id]) {
    form[mapaForm[id]] = e.target.value;
    aviso = null;
  } else if (id === 'f-placa') {
    // digitou a placa inteira e ela existe: já fica escolhida; senão mostra as sugestões
    form.placaTxt = e.target.value;
    escolherPlaca(estado.veiculos.find(v => v.placa === soPlaca(e.target.value))?.placa || '');
    form.placaTxt = e.target.value;
    aviso = null;
  } else if (id === 'f-motorista') {
    form.motoristaTxt = e.target.value;
    form.motorista = estado.motoristas.find(m => semAcento(m) === semAcento(e.target.value)) || '';
    aviso = null;
  } else if (mapaChegada[id]) chegada[mapaChegada[id]] = e.target.value;
  else if (mapaVeiculo[id]) novoVeiculo[mapaVeiculo[id]] = e.target.value;
  else if (mapaMotorista[id]) novoMotorista[mapaMotorista[id]] = e.target.value;
  else if (id === 'cv-cap' || id === 'cv-km') correcao[id === 'cv-cap' ? 'capacidade' : 'km'] = e.target.value;
  else if (id === 'a-visor') afericao.visor = e.target.value;
  else if (id === 'f-preco-novo') editPreco.valor = e.target.value;
  else if (e.target.dataset.tanque) medidos[e.target.dataset.tanque] = e.target.value;
  else return;
  render(e.target.tagName !== 'SELECT');
});

conteudo.addEventListener('click', async e => {
  const alvo = sel => e.target.closest(sel);
  if (alvo('[data-tema]')) { definirTema(alvo('[data-tema]').dataset.tema); return; }
  if (alvo('[data-guia]')) { guia = alvo('[data-guia]').dataset.guia; return render(); }
  if (alvo('[data-bomba]')) { form.bomba = Number(alvo('[data-bomba]').dataset.bomba); aviso = null; return render(); }
  if (alvo('[data-sug-placa]')) {
    escolherPlaca(alvo('[data-sug-placa]').dataset.sugPlaca); aviso = null; render();
    return $(form.motorista ? 'f-km' : 'f-motorista')?.focus();
  }
  if (alvo('[data-sug-motorista]')) {
    form.motorista = form.motoristaTxt = alvo('[data-sug-motorista]').dataset.sugMotorista; aviso = null; render();
    return $('f-km')?.focus();
  }
  if (alvo('[data-afericao-bomba]')) { afericao.bomba = Number(alvo('[data-afericao-bomba]').dataset.afericaoBomba); aviso = null; return render(); }
  if (alvo('[data-desconto]')) { form.desconto = alvo('[data-desconto]').dataset.desconto === 'sim'; return render(); }
  if (alvo('[data-frentista]')) { escolhido = Number(alvo('[data-frentista]').dataset.frentista); pin = ''; aviso = null; return render(); }
  if (alvo('[data-tecla]')) return teclarPin(alvo('[data-tecla]').dataset.tecla);
  if (alvo('[data-foto]')) return adicionarFoto(alvo('[data-foto]').dataset.foto);
  if (alvo('[data-tirar]')) {
    const b = alvo('[data-tirar]'); const lista = listaDeFotos(b.dataset.tirar);
    URL.revokeObjectURL(lista[Number(b.dataset.i)]?.previa); lista.splice(Number(b.dataset.i), 1); return render();
  }
  const acao = alvo('[data-acao]')?.dataset.acao;
  if (acao === 'google') { try { await entrarComGoogle(); } catch (err) { aviso = { tipo: 'warn', texto: err.message }; render(); } }
  if (acao === 'tentar') await carregar();
  if (acao === 'trocar-google') { await sair(); conta = null; estado = null; semAcesso = false; login = null; gravar('frentistaLogin', null); render(); }
  // o cadastro já vem com o que o frentista digitou na busca
  if (acao === 'novo-veiculo') { tela = 'veiculo'; novoVeiculo = { placa: soPlaca(form.placaTxt), capacidade: '', km: '', fotos: [] }; aviso = null; render(); }
  if (acao === 'novo-motorista') { tela = 'motorista'; novoMotorista = { nome: form.motoristaTxt.trim().toUpperCase(), cpf: '' }; aviso = null; render(); }
  if (acao === 'voltar') { tela = null; aviso = null; render(); }
  if (acao === 'atualizar') await executar(atualizarEstado);
  if (acao === 'enviar') await executar(enviarAbastecimento);
  if (acao === 'chegada') await executar(enviarChegada);
  if (acao === 'fechar') await executar(fecharTurno);
  if (acao === 'aferir') await executar(enviarAfericao);
  if (acao === 'salvar-veiculo') await executar(salvarVeiculo);
  if (acao === 'salvar-motorista') await executar(salvarMotorista);
  if (acao === 'corrigir-veiculo' && form.placa) {
    const v = estado.veiculos.find(x => x.placa === form.placa);
    correcao = { placa: form.placa, capacidade: v?.capacidade_l == null ? '' : String(Number(v.capacidade_l)).replace('.', ','), km: '' };
    tela = 'corrigir'; aviso = null; render();
  }
  if (acao === 'salvar-correcao') await executar(salvarCorrecao);
  if (acao === 'abrir-app') fecharBoasVindas();
  // Limpar o formulário de abastecer: pede confirmação na própria tela; a bomba e a hora ficam
  if (acao === 'limpar') { confirmaLimpar = true; render(); }
  if (acao === 'limpar-nao') { confirmaLimpar = false; render(); }
  if (acao === 'limpar-sim') {
    const { bomba, hora } = form;
    form = { ...novoForm(), bomba, hora }; confirmaLimpar = false; editPreco = null;
    aviso = { tipo: 'info', texto: 'Formulário limpo. A bomba e a hora ficaram.' }; render();
  }
  // Preço do diesel: usar o atual no lançamento, ou atualizar (vale para todos e fica com o nome do frentista)
  if (acao === 'usar-preco') { form.usarPreco = !form.usarPreco; render(); }
  if (acao === 'alterar-preco') { editPreco = { valor: '' }; render(); $('f-preco-novo')?.focus(); }
  if (acao === 'cancelar-preco') { editPreco = null; render(); }
  if (acao === 'salvar-preco') await executar(() => salvarPreco(parseNum(editPreco.valor), 'app'));
  if (acao === 'preco-da-nf') await executar(() => salvarPreco(sugestaoPreco.preco, 'chegada'));
  if (acao === 'ignorar-preco') { sugestaoPreco = null; render(); }
});

$('abas').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  aba = b.dataset.aba; aviso = null; render(); conteudo.scrollTop = 0;
  try { await atualizarEstado(); } catch (err) { tratarErro(err); }
  render();
});

$('sair').addEventListener('click', async () => {
  try { if (login) await rpc('sair_frentista', { p_sessao: login.sessao }); } catch { /* sai mesmo sem rede */ }
  login = null; gravar('frentistaLogin', null); escolhido = null; pin = ''; aviso = null; tela = null;
  clearTimeout(timerBoasVindas); boasVindas = false; confirmaLimpar = false; editPreco = null; sugestaoPreco = null;
  render();
});

const listaDeFotos = dono => ({ chegada: fotosChegada, fechamento: fotosFechamento, afericao: fotosAfericao, veiculo: novoVeiculo?.fotos }[dono]);

async function adicionarFoto(dono) {
  try {
    const f = await tirarFoto();
    if (f) { const lista = listaDeFotos(dono); if (dono === 'veiculo') lista.length = 0; lista.push(f); }
  } catch (err) { aviso = { tipo: 'warn', texto: err.message }; }
  render();
}

const espera = ms => new Promise(ok => setTimeout(ok, ms));
async function teclarPin(tecla) {
  if (enviando || pinEstado) return;
  if (tecla === 'voltar') { escolhido = null; pin = ''; aviso = null; return render(); }
  if (tecla === 'apagar') { pin = pin.slice(0, -1); return render(); }
  if (pin.length >= 4) return;
  pin += tecla; aviso = null; render();
  if (pin.length < 4) return;
  await executar(async () => {
    let r;
    try { r = await rpc('entrar_frentista', { p_frentista_id: escolhido, p_pin: pin }); } catch (e) { pin = ''; throw e; }
    if (!r.ok) {   // PIN errado: os pontos tremem e ficam vermelhos, depois limpam
      aviso = { tipo: 'warn', texto: r.erro }; pinEstado = 'erro';
      setTimeout(() => { pin = ''; pinEstado = ''; render(); }, 650);
      return;
    }
    pinEstado = 'certo'; render();
    await espera(320);
    pin = ''; pinEstado = '';
    login = { sessao: r.sessao, id: r.frentista.id, nome: r.frentista.nome };
    gravar('frentistaLogin', login);
    gravar('ultimoFrentista', r.frentista.id);
    escolhido = null; aba = 'abastecer'; tela = null; form = novoForm(); chegada = novaChegada(); aviso = null;
    boasVindas = true; clearTimeout(timerBoasVindas); timerBoasVindas = setTimeout(fecharBoasVindas, 2400);
  });
}

async function enviarAbastecimento() {
  const c = conferir(form);
  if (c.bloqueios.length) return;
  const dados = {
    uuid: form.uuid || (form.uuid = crypto.randomUUID()), data_hora: `${hojeISO()}T${form.hora}:00`, placa: form.placa, motorista: form.motorista,
    km: Math.round(parseNum(form.km)), litros: parseNum(form.litros), encerrante: parseNum(form.enc), bomba: form.bomba,
    obs: c.falhas.length ? form.obs.trim() : null, desconto: form.desconto, justificativa_desconto: form.desconto ? null : form.justificativa.trim(),
    justificativa_horario: foraDoTurno(form.hora) ? form.justHorario.trim() : null,
    capacidade: precisaCapacidade(form) ? parseNum(form.capacidade) : null, cpf: precisaCpf(form) ? form.cpf.replace(/\D/g, '') : null,
    preco: form.usarPreco && estado.preco_diesel ? Number(estado.preco_diesel.preco) : null,
  };
  const r = await rpc('registrar_abastecimento', { p_sessao: login.sessao, p_dados: dados });
  aviso = r.status === 'Aguardando autorização' ? { tipo: 'warn', texto: `#${r.id} ${dados.placa}, ${nf(dados.litros)} L: aguardando autorização do supervisor.` }
    : r.status === 'Exceção' ? { tipo: 'warn', texto: `#${r.id} ${dados.placa}, ${nf(dados.litros)} L: foi para o supervisor conferir.` }
    : { tipo: 'ok', texto: `#${r.id} ${dados.placa}, ${nf(dados.litros)} L: lançado.` };
  await atualizarEstado();
  form = novoForm();   // próxima vez, o frentista escolhe a bomba de novo
  confirmaLimpar = false; editPreco = null;
}

async function salvarPreco(preco, origem) {
  if (!(preco >= 0.5 && preco < 100)) { aviso = { tipo: 'warn', texto: 'Confira o preço: por exemplo 6,19.' }; return; }
  const r = await rpc('definir_preco_diesel', { p_sessao: login.sessao, p_preco: preco, p_origem: origem });
  await atualizarEstado();
  editPreco = null; sugestaoPreco = null;
  if (form) form.usarPreco = true;
  aviso = { tipo: 'ok', texto: `Preço do diesel atualizado para ${reais(r.preco)}/L. Vale para os próximos lançamentos.` };
}

async function enviarChegada() {
  const f = chegada;
  const num = s => { const n = parseNum(s); return Number.isNaN(n) ? null : n; };
  const caminhos = await enviarFotos('chegada', fotosChegada);
  await rpc('registrar_chegada', { p_sessao: login.sessao, p_fotos: caminhos, p_dados: {
    uuid: f.uuid || (f.uuid = crypto.randomUUID()), tanque: f.tanque, data_hora: `${hojeISO()}T${f.hora}:00`, nf: f.nf.trim(), litros: parseNum(f.litros),
    valor_total: num(f.valor), regua_antes: num(f.antes), regua_depois: num(f.depois), placa_caminhao: f.placa || null,
    placa_carreta: f.carreta || null, motorista: f.motorista || null, cpf: f.cpf || null } });
  aviso = { tipo: 'ok', texto: `Chegada da NF ${f.nf} registrada${caminhos.length ? ` com ${caminhos.length} foto(s)` : ''}.` };
  fotosChegada.forEach(x => URL.revokeObjectURL(x.previa)); fotosChegada = [];
  chegada = novaChegada();
  await atualizarEstado();
  // NF com valor e litros: sugere atualizar o preço do diesel (se mudou)
  const porLitro = Math.round((num(f.valor) / parseNum(f.litros)) * 1000) / 1000;
  const valido = porLitro >= 0.5 && porLitro < 100, atual = estado.preco_diesel ? Number(estado.preco_diesel.preco) : null;
  sugestaoPreco = valido && (atual == null || Math.abs(porLitro - atual) >= 0.005) ? { preco: porLitro, nf: f.nf.trim() } : null;
}

async function enviarAfericao() {
  const f = afericao;
  const caminhos = await enviarFotos('afericao', fotosAfericao);
  const r = await rpc('registrar_afericao', { p_sessao: login.sessao, p_fotos: caminhos, p_dados: {
    uuid: f.uuid || (f.uuid = crypto.randomUUID()), bomba: f.bomba, data_hora: `${hojeISO()}T${horaAgora()}:00`, visor: parseNum(f.visor) } });
  aviso = r.alerta ? { tipo: 'warn', texto: `Aferição da bomba ${f.bomba} registrada com diferença acima da tolerância: o supervisor foi avisado.` }
    : { tipo: 'ok', texto: `Aferição da bomba ${f.bomba} registrada. Dentro da tolerância.` };
  fotosAfericao.forEach(x => URL.revokeObjectURL(x.previa)); fotosAfericao = [];
  afericao = { bomba: null, visor: '' };
  await atualizarEstado();
}

async function fecharTurno() {
  const valores = Object.fromEntries(estado.tanques.map(t => [t.tanque, parseNum(medidos[t.tanque])]));
  const caminhos = await enviarFotos('fechamento', fotosFechamento);
  const r = await rpc('registrar_fechamento', { p_sessao: login.sessao, p_medidos: valores, p_fotos: caminhos });
  const alertas = r.filter(t => t.alerta).length;
  aviso = { tipo: alertas ? 'warn' : 'ok', texto: alertas ? `Turno fechado. ${alertas} tanque(s) com diferença: o supervisor foi avisado.` : 'Turno fechado. Tudo bateu.' };
  medidos = {}; fotosFechamento.forEach(x => URL.revokeObjectURL(x.previa)); fotosFechamento = [];
  await atualizarEstado();
}

async function salvarVeiculo() {
  const f = novoVeiculo;
  const [caminho] = await enviarFotos('veiculo', f.fotos);
  const r = await rpc('cadastrar_veiculo_app', { p_sessao: login.sessao, p_placa: f.placa, p_capacidade: parseNum(f.capacidade),
    p_km: f.km ? Math.round(parseNum(f.km)) : null, p_foto: caminho });
  await atualizarEstado();
  escolherPlaca(r.placa); tela = null;
  aviso = { tipo: 'ok', texto: `Veículo ${r.placa} cadastrado.` };
}

async function salvarCorrecao() {
  const f = correcao, v = estado.veiculos.find(x => x.placa === f.placa);
  const cap = parseNum(f.capacidade), km = f.km.trim() ? Math.round(parseNum(f.km)) : null;
  const r = await rpc('corrigir_veiculo_app', { p_sessao: login.sessao, p_placa: f.placa,
    p_capacidade: cap > 0 && cap !== Number(v?.capacidade_l) ? cap : null, p_km: km });
  await atualizarEstado();
  tela = null; correcao = null;
  aviso = { tipo: 'ok', texto: `Caminhão ${r.placa} corrigido: tanque de ${nf(r.capacidade_l, 0)} L${km != null ? `, KM ${nf(km, 0)}` : ''}. Ficou registrado com seu nome.` };
}

async function salvarMotorista() {
  const f = novoMotorista;
  const r = await rpc('cadastrar_motorista_app', { p_sessao: login.sessao, p_nome: f.nome, p_cpf: f.cpf });
  await atualizarEstado();
  form.motorista = form.motoristaTxt = r.nome; tela = null;
  aviso = { tipo: 'ok', texto: `Motorista ${r.nome} cadastrado.` };
}

// ---------- Início ----------
async function carregar() {
  conta = await contaAtual();
  aviso = null;
  if (conta) {
    try { await atualizarEstado(); }
    catch (e) { if (e.semAcesso) semAcesso = true; else if (e.semRede) semRede = true; else aviso = { tipo: 'warn', texto: e.message }; }
    if (estado && estado.papel !== 'posto') return;   // indo para o painel (ele procura atualização)
    if (login && estado && !estado.frentistas.some(f => f.id === login.id)) { login = null; gravar('frentistaLogin', null); }
  }
  form = estado ? novoForm() : null;
  chegada = estado ? novaChegada() : null;
  render();
  if (!atualizacaoVista) { atualizacaoVista = true; prepararAtualizacao(); }
}
let atualizacaoVista = false;

aoVoltarDoLogin(erro => { if (erro) aviso = { tipo: 'warn', texto: erro.message }; carregar(); });
supabase.auth.onAuthStateChange(evento => { if (evento === 'SIGNED_IN' && !conta) carregar(); });
window.addEventListener('online', () => { if (semRede) carregar(); });
confirmarAbertura();
carregar();
// Lembrete do fechamento e mudança de dia: confere a cada minuto sem atrapalhar quem está digitando
setInterval(() => {
  if (!login || !estado || tela || enviando || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (estado.dia !== hojeISO()) { atualizarEstado().then(() => render(), () => {}); return; }
  if (['abastecer', 'turno'].includes(aba)) render();
}, 60000);
