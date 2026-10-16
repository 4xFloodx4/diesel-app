// Gera o pacote de atualização das telas do app, publicado junto com o painel no GitHub Pages:
//   dist/atualizacao/app-VERSAO.zip  (conteúdo de dist-android/)
//   dist/atualizacao/versao.json     ({ version, url, checksum sha256 })
// O app baixa o zip, confere o checksum e aplica na próxima abertura. Usa "zip" (Linux) ou "tar" (Windows).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(RAIZ, 'config.publica.json'), 'utf8'));
const site = (process.env.SITE_URL || cfg.SITE_URL || '').replace(/\/*$/, '/');
const versao = process.env.VERSAO_WEB;
if (!/^https:\/\//.test(site) || !/^[\w.-]{1,40}$/.test(versao || '')) {
  console.error('Defina SITE_URL (config.publica.json) e VERSAO_WEB (a mesma usada no build).');
  process.exit(1);
}
const html = readFileSync(join(RAIZ, 'dist-android', 'index.html'), 'utf8');
if (!html.includes('app/app.js')) { console.error('dist-android/ não parece gerado. Rode o build antes.'); process.exit(1); }

const pasta = join(RAIZ, 'dist', 'atualizacao');
rmSync(pasta, { recursive: true, force: true });
mkdirSync(pasta, { recursive: true });
const nome = `app-${versao}.zip`;
if (process.platform === 'win32') {   // Windows 10+: o tar do sistema gera .zip
  execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', join(pasta, nome), '-C', join(RAIZ, 'dist-android'), '.']);
} else {
  execFileSync('zip', ['-r', '-X', '-q', join(pasta, nome), '.'], { cwd: join(RAIZ, 'dist-android') });
}
const checksum = createHash('sha256').update(readFileSync(join(pasta, nome))).digest('hex');
writeFileSync(join(pasta, 'versao.json'), JSON.stringify({ version: versao, url: `${site}atualizacao/${nome}`, checksum }, null, 2));
console.log(`Pacote de atualização ${versao}: ${nome} (sha256 ${checksum.slice(0, 12)}…)`);
