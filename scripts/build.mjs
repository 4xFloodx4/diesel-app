// Gera:
//   dist/          site do GitHub Pages (painel do supervisor e versão web do app)
//   dist-android/  telas que vão dentro do APK (tela do frentista e painel para celular)
//
// Configuração (variáveis do repositório no GitHub, ou config.local.json para testar no computador):
//   SUPABASE_URL       ex.: https://abcdefgh.supabase.co
//   SUPABASE_ANON_KEY  chave "anon public" do projeto (é pública por natureza; os dados são protegidos pelo RLS)
//   APP_ESQUEMA        endereço de volta do login no app (padrão br.com.ritmolog.diesel)
//   SITE_URL           endereço do GitHub Pages; o app procura atualizações em SITE_URL/atualizacao/versao.json
//   VERSAO_WEB         versão das telas (no GitHub Actions: o commit); igual no APK e no pacote de atualização
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(RAIZ, 'web');
const lerJson = nome => existsSync(join(RAIZ, nome)) ? JSON.parse(readFileSync(join(RAIZ, nome), 'utf8')) : {};
// Ordem: variáveis do GitHub, config.local.json (só no seu computador), config.publica.json (no repositório)
const local = { ...lerJson('config.publica.json'), ...lerJson('config.local.json') };
// Tolera os deslizes comuns ao colar: espaços, barra no final, letras maiúsculas no endereço
const limpar = v => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
const cfg = {
  url: limpar(process.env.SUPABASE_URL || local.SUPABASE_URL).replace(/\/+$/, '').toLowerCase(),
  chave: limpar(process.env.SUPABASE_ANON_KEY || local.SUPABASE_ANON_KEY),
  esquema: limpar(process.env.APP_ESQUEMA || local.APP_ESQUEMA) || 'br.com.ritmolog.diesel',
  site: limpar(process.env.SITE_URL || local.SITE_URL).replace(/\/*$/, '/'),
  versao: limpar(process.env.VERSAO_WEB) || (() => { try { return execSync('git rev-parse --short=10 HEAD', { cwd: RAIZ }).toString().trim(); } catch { return 'dev'; } })(),
};
if (cfg.site === '/') cfg.site = '';
const demo = process.argv.includes('--demo');
if (demo) Object.assign(cfg, { url: 'https://demonstracao.supabase.co', chave: 'demonstracao' });
const problemas = [];
if (!cfg.url) problemas.push('SUPABASE_URL está vazia. No GitHub ela deve estar em Settings > Secrets and variables > Actions > aba "Variables" (não em "Secrets").');
else if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.url)) problemas.push(`SUPABASE_URL deve ser como https://xxxx.supabase.co (recebido: "${cfg.url}").`);
if (!cfg.chave) problemas.push('SUPABASE_ANON_KEY está vazia. Mesma tela, aba "Variables".');
else if (!demo && !/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(cfg.chave) && !/^sb_publishable_[\w-]+$/.test(cfg.chave)) {
  problemas.push(`SUPABASE_ANON_KEY não parece a chave "anon public" (tem ${cfg.chave.length} caracteres; ela começa com "eyJ" ou "sb_publishable_").`);
}
if (!demo && /service_role/.test(Buffer.from(cfg.chave.split('.')[1] || '', 'base64').toString())) {
  problemas.push('A chave informada é a "service_role" (secreta). Troque pela "anon public" e, por segurança, gere uma nova service_role no Supabase.');
}
if (problemas.length) {
  console.error('Configuração incompleta:\n- ' + problemas.join('\n- ') + '\nVeja docs/CONFIGURAR.md, passo 4.');
  // No GitHub Actions, aparece como aviso no resumo da execução (sem expor a chave)
  if (process.env.GITHUB_ACTIONS) problemas.forEach(p => console.log(`::error title=Configuração::${p}`));
  process.exit(1);
}
if (!/^[a-z][a-z0-9.]+$/.test(cfg.esquema)) { console.error('APP_ESQUEMA inválido.'); process.exit(1); }
if (cfg.site && !/^https:\/\/[\w.-]+\/[\w./-]*$/.test(cfg.site)) { console.error('SITE_URL inválido.'); process.exit(1); }
if (!/^[\w.-]{1,40}$/.test(cfg.versao)) { console.error('VERSAO_WEB inválida.'); process.exit(1); }

// Política de conteúdo: só scripts e estilos do próprio app; rede só para o Supabase do projeto
// (fotos: imagens com link temporário do Storage do Supabase e miniaturas dos comprovantes no Google Drive;
// atualização: versao.json no próprio site)
const host = new URL(cfg.url).host;
const site = cfg.site ? new URL(cfg.site).origin : '';
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", `img-src 'self' data: blob: https://${host} https://drive.google.com https://*.googleusercontent.com`, "font-src 'self'",
  `connect-src 'self' https://${host} wss://${host} ${site}`.trim(), "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

// Fontes IBM Plex (licença OFL) copiadas do pacote para dentro do site e do APK: nada é carregado de fora
const FONTES = [['ibm-plex-sans', 'ibm-plex-sans', 'sans', [400, 500, 600]], ['ibm-plex-sans-condensed', 'ibm-plex-sans-condensed', 'cond', [500, 600, 700]],
  ['ibm-plex-mono', 'ibm-plex-mono', 'mono', [400, 500, 600]]];
function copiarFontes(destino) {
  mkdirSync(join(destino, 'comum', 'fontes'), { recursive: true });
  for (const [pacote, arquivo, nome, pesos] of FONTES) for (const peso of pesos) {
    cpSync(join(RAIZ, 'node_modules', '@fontsource', pacote, 'files', `${arquivo}-latin-${peso}-normal.woff2`), join(destino, 'comum', 'fontes', `${nome}-${peso}.woff2`));
  }
}

async function gerar(destino, paginas, alvo) {
  rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });
  await build({
    entryPoints: paginas.map(p => join(WEB, p.js)),
    // splitting: o que só é usado às vezes (o gerador de PDF da folha do turno) fica num arquivo à parte e só carrega quando pedido
    outdir: destino, outbase: WEB, bundle: true, format: 'esm', splitting: true, chunkNames: 'comum/[name]-[hash]', minify: true, sourcemap: false,
    target: ['es2020', 'chrome90'], platform: 'browser', legalComments: 'linked',
    define: {
      __SUPABASE_URL__: JSON.stringify(cfg.url),
      __SUPABASE_ANON_KEY__: JSON.stringify(cfg.chave),
      __APP_ESQUEMA__: JSON.stringify(cfg.esquema),
      __VERSAO_WEB__: JSON.stringify(cfg.versao),
      __URL_ATUALIZACAO__: JSON.stringify(cfg.site ? `${cfg.site}atualizacao/versao.json` : ''),
      __ALVO__: JSON.stringify(alvo),
    },
    logLevel: 'warning',
  });
  for (const f of ['base.css', 'pecas.css']) cpSync(join(WEB, 'comum', f), join(destino, 'comum', f));
  copiarFontes(destino);
  cpSync(join(WEB, 'comum', 'icone.svg'), join(destino, 'comum', 'icone.svg'));
  cpSync(join(WEB, 'comum', 'logo-ritmo.jpg'), join(destino, 'comum', 'logo-ritmo.jpg'));   // logo da Ritmo na folha do turno (PDF)
  for (const p of paginas) {
    cpSync(join(WEB, p.css), join(destino, p.css));
    const html = readFileSync(join(WEB, p.html), 'utf8').replaceAll('__CSP__', CSP).replaceAll('__RAIZ__', p.raiz);
    mkdirSync(dirname(join(destino, p.saida)), { recursive: true });
    writeFileSync(join(destino, p.saida), html);
  }
}

// Site (GitHub Pages)
const SITE = join(RAIZ, 'dist');
await gerar(SITE, [
  { js: 'painel/painel.js', css: 'painel/painel.css', html: 'painel/index.html', saida: 'painel/index.html', raiz: '../' },
  { js: 'app/app.js', css: 'app/app.css', html: 'app/index.html', saida: 'app/index.html', raiz: '../' },
], 'site');
writeFileSync(join(SITE, '.nojekyll'), '');
writeFileSync(join(SITE, 'index.html'), `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0; url=painel/">
<title>Diesel</title></head><body><p><a href="painel/">Abrir o painel do supervisor</a></p></body></html>`);

// APK: abre na tela do frentista; conta de supervisor ou administrador vai para o painel (versão de celular)
await gerar(join(RAIZ, 'dist-android'), [
  { js: 'app/app.js', css: 'app/app.css', html: 'app/index.html', saida: 'index.html', raiz: './' },
  { js: 'painel/painel.js', css: 'painel/painel.css', html: 'painel/index.html', saida: 'painel/index.html', raiz: '../' },
], 'android');

console.log(`Pronto: dist/ (site) e dist-android/ (APK). Supabase: ${host}${demo ? ' (demonstração)' : ''}. Versão das telas: ${cfg.versao}`);
