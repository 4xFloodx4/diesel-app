// Atualização automática das telas do app, sem reinstalar o APK.
// O GitHub publica, junto com o painel, um pacote das telas (atualizacao/app-VERSAO.zip) e o arquivo versao.json.
// Ao abrir, o app confere; se houver versão nova, baixa em segundo plano e aplica na próxima abertura.
// Se a versão nova não conseguir abrir, o atualizador volta sozinho para a anterior.
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { nativo } from './supa.js';

export const VERSAO_WEB = __VERSAO_WEB__;
const URL_VERSAO = __URL_ATUALIZACAO__;

export async function prepararAtualizacao() {
  if (!nativo) return;
  // Avisa que esta versão abriu bem; sem isso, o atualizador desfaz a última atualização
  try { await CapacitorUpdater.notifyAppReady(); } catch { /* sem atualizador: versão de teste */ }
  if (!URL_VERSAO) return;
  try {
    const resp = await fetch(`${URL_VERSAO}?t=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) return;
    const info = await resp.json();
    if (!/^[\w.-]{1,40}$/.test(info.version) || !/^https:\/\//.test(info.url) || !/^[0-9a-f]{64}$/.test(info.checksum)) return;
    const atual = await CapacitorUpdater.current();
    const versaoAtual = atual?.bundle?.version && atual.bundle.version !== 'builtin' ? atual.bundle.version : VERSAO_WEB;
    if (info.version === versaoAtual) return;
    const pacote = await CapacitorUpdater.download({ url: info.url, version: info.version, checksum: info.checksum });
    await CapacitorUpdater.next({ id: pacote.id });
  } catch { /* sem internet ou servidor fora: tenta de novo na próxima abertura */ }
}
