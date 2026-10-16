// Atualização automática das telas do app, sem reinstalar o APK.
// O GitHub publica, junto com o painel, um pacote das telas (atualizacao/app-VERSAO.zip) e o arquivo versao.json
// (com a frase do que mudou). Se a versão nova não conseguir abrir, o atualizador volta sozinho para a anterior.
//  * App do frentista (vigiarAtualizacoes): confere ao abrir, a cada 5 minutos e quando o celular volta para o app.
//    Baixa em segundo plano e aplica na hora, com a tela "Atualizando o app…", mas só quando ninguém está no meio
//    de um lançamento: o app diz quando está livre. Ocupado, espera; se o app fechar antes, entra na próxima abertura.
//  * Painel no celular (prepararAtualizacao): baixa e aplica na próxima abertura.
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { App } from '@capacitor/app';
import { nativo } from './supa.js';
import { ler, gravar } from './util.js';

export const VERSAO_WEB = __VERSAO_WEB__;
const URL_VERSAO = __URL_ATUALIZACAO__;

// Avisa que esta versão abriu bem; sem isso, o atualizador desfaz a última atualização
export async function confirmarAbertura() {
  if (!nativo) return;
  try { await CapacitorUpdater.notifyAppReady(); } catch { /* sem atualizador: versão de teste */ }
}

async function versaoPublicada() {
  const resp = await fetch(`${URL_VERSAO}?t=${Date.now()}`, { cache: 'no-store' });
  if (!resp.ok) return null;
  const info = await resp.json();
  if (!/^[\w.-]{1,40}$/.test(info.version) || !/^https:\/\//.test(info.url) || !/^[0-9a-f]{64}$/.test(info.checksum)) return null;
  info.notas = typeof info.notas === 'string' ? info.notas.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return info;
}
async function versaoInstalada() {
  const atual = await CapacitorUpdater.current();
  return atual?.bundle?.version && atual.bundle.version !== 'builtin' ? atual.bundle.version : VERSAO_WEB;
}
// Pacote já baixado antes (o app fechou sem aplicar) é reaproveitado; um que falhou é apagado e baixado de novo
async function baixar(info, aoComecar) {
  const { bundles } = await CapacitorUpdater.list();
  const mesmo = bundles.filter(b => b.version === info.version);
  const bom = mesmo.find(b => b.status === 'pending' || b.status === 'success');
  if (bom) return bom;
  for (const b of mesmo) { try { await CapacitorUpdater.delete({ id: b.id }); } catch { /* em uso ou já apagado */ } }
  aoComecar();
  return CapacitorUpdater.download({ url: info.url, version: info.version, checksum: info.checksum });
}

export async function prepararAtualizacao() {
  if (!nativo) return;
  await confirmarAbertura();
  if (!URL_VERSAO) return;
  try {
    const info = await versaoPublicada();
    if (!info || info.version === await versaoInstalada()) return;
    const pacote = await baixar(info, () => {});
    await CapacitorUpdater.next({ id: pacote.id });
  } catch { /* sem internet ou servidor fora: tenta de novo na próxima abertura */ }
}

// ---------- App do frentista: atualiza na hora ----------
let fase = null, pct = 0, pronto = null, procurando = false;   // fase: null | 'baixando' | 'pronta' | 'aplicando'
let livre = () => true, mudou = () => {};
export const situacaoAtualizacao = () => ({ fase, pct });
const aviso = () => { try { mudou(); } catch { /* a tela se redesenha na próxima vez */ } };

export function vigiarAtualizacoes(opcoes) {
  if (!nativo || !URL_VERSAO) return;
  ({ livre, mudou } = opcoes);
  CapacitorUpdater.addListener('download', e => { if (fase === 'baixando') { pct = Math.round(e.percent || 0); aviso(); } });
  App.addListener('resume', procurar);
  setInterval(procurar, 5 * 60000);
  setInterval(tentarAplicar, 5000);
  procurar();
}

async function procurar() {
  if (procurando || pronto) return;
  procurando = true;
  try {
    const info = await versaoPublicada();
    if (!info || info.version === await versaoInstalada()) return;
    const pacote = await baixar(info, () => { fase = 'baixando'; pct = 0; aviso(); });
    await CapacitorUpdater.next({ id: pacote.id });   // se nunca ficar livre, entra na próxima abertura
    pronto = { id: pacote.id, version: info.version, notas: info.notas };
    fase = 'pronta'; aviso();
    tentarAplicar();
  } catch {
    if (fase === 'baixando') { fase = null; aviso(); }   // sem internet: tenta de novo daqui a 5 minutos
  } finally { procurando = false; }
}

async function tentarAplicar() {
  if (!pronto || fase === 'aplicando' || !livre()) return;
  fase = 'aplicando'; aviso();
  gravar('atualizacaoAplicada', { version: pronto.version, notas: pronto.notas });
  await new Promise(ok => setTimeout(ok, 1200));   // a tela "Atualizando" aparece antes de recarregar
  try { await CapacitorUpdater.set({ id: pronto.id }); }   // recarrega o app já na versão nova
  catch { gravar('atualizacaoAplicada', null); fase = 'pronta'; aviso(); }
}

/** Logo depois de abrir: se acabou de atualizar, devolve {notas} uma vez. */
export async function novidadeAplicada() {
  const a = ler('atualizacaoAplicada', null);
  if (!a || !nativo) return null;
  gravar('atualizacaoAplicada', null);
  try { return a.version === await versaoInstalada() ? a : null; }   // diferente: a versão nova não abriu e voltou
  catch { return null; }
}
