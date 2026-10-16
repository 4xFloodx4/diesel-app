// Conexão com o Supabase e login com Google, no navegador e no app Android.
import { createClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';

// Preenchidos na hora do build (scripts/build.mjs) a partir das variáveis do repositório.
// A chave "anon" é pública por natureza: quem protege os dados são as regras RLS do banco.
const URL_SUPABASE = __SUPABASE_URL__;
const CHAVE_ANON = __SUPABASE_ANON_KEY__;
export const ESQUEMA_APP = __APP_ESQUEMA__;     // ex.: br.com.ritmolog.diesel
export const nativo = Capacitor.isNativePlatform();

export const supabase = createClient(URL_SUPABASE, CHAVE_ANON, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: !nativo },
});

export class ErroApi extends Error {
  constructor(mensagem, semRede = false, semAcesso = false) { super(mensagem); this.semRede = semRede; this.semAcesso = semAcesso; }
}

function traduzir(error) {
  const msg = error?.message || String(error);
  if (/Failed to fetch|NetworkError|Network request failed|Load failed|fetch failed/i.test(msg) || !navigator.onLine) {
    return new ErroApi('Sem conexão com a internet.', true);
  }
  // Regras de proteção (ex.: administrador) usam o mesmo código 42501, mas a mensagem é para mostrar ao usuário
  if (/Somente um administrador|único administrador/.test(msg)) return new ErroApi(msg);
  if (error?.code === '42501' || /Acesso negado|permission denied/i.test(msg)) {
    return new ErroApi('Esta conta não tem acesso. Peça ao supervisor para liberar.', false, true);
  }
  if (/JWT expired|invalid JWT|refresh_token/i.test(msg)) return new ErroApi('Sessão expirada. Entre de novo.', false, true);
  return new ErroApi(msg);
}

export async function rpc(funcao, args) {
  let r;
  try { r = await supabase.rpc(funcao, args); } catch (e) { throw traduzir(e); }
  if (r.error) throw traduzir(r.error);
  return r.data;
}

export async function consulta(promessa) {
  let r;
  try { r = await promessa; } catch (e) { throw traduzir(e); }
  if (r.error) throw traduzir(r.error);
  return r.data;
}

export async function contaAtual() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.email ?? null;
}

// No app Android o Google não aceita login dentro do app: abre o navegador do sistema e volta pelo
// endereço br.com.ritmolog.diesel://login, que o app captura e troca pela sessão.
export async function entrarComGoogle() {
  if (nativo) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${ESQUEMA_APP}://login`, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
    });
    if (error) throw traduzir(error);
    await Browser.open({ url: data.url, windowName: '_self' });
  } else {
    const volta = location.origin + location.pathname;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google', options: { redirectTo: volta, queryParams: { prompt: 'select_account' } },
    });
    if (error) throw traduzir(error);
  }
}

export function aoVoltarDoLogin(callback) {
  if (!nativo) return;
  App.addListener('appUrlOpen', async ({ url }) => {
    if (!url.startsWith(`${ESQUEMA_APP}://`)) return;
    const params = new URL(url).searchParams;
    const code = params.get('code');
    try { await Browser.close(); } catch { /* já fechado */ }
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      callback(error ? traduzir(error) : null);
    } else {
      callback(new ErroApi(params.get('error_description') || 'Login cancelado.'));
    }
  });
}

export async function sair() {
  await supabase.auth.signOut({ scope: 'local' });
}
