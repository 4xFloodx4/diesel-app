// Ajusta o projeto Android gerado pelo Capacitor (pasta android/). Rode depois de "npx cap add android".
//  * captura o endereço de volta do login Google (APP_ESQUEMA://login)
//  * bloqueia backup do app (a sessão e os registros guardados não saem do celular por backup)
//  * versão do app (VERSAO_CODIGO / VERSAO_NOME, preenchidas pelo GitHub Actions)
//  * ícone
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(RAIZ, 'android', 'app');
if (!existsSync(APP)) { console.error('Pasta android/ não encontrada. Rode antes: npx cap add android'); process.exit(1); }
const esquema = process.env.APP_ESQUEMA || 'br.com.ritmolog.diesel';

function alterar(arquivo, fn) {
  const antes = readFileSync(arquivo, 'utf8');
  const depois = fn(antes);
  if (depois === antes) return false;
  writeFileSync(arquivo, depois);
  return true;
}

// 1. Manifest
const manifest = join(APP, 'src', 'main', 'AndroidManifest.xml');
alterar(manifest, xml => {
  let x = xml.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
  if (!x.includes('android:allowBackup')) x = x.replace('<application', '<application android:allowBackup="false"');
  if (!x.includes(`android:scheme="${esquema}"`)) {
    const filtro = `
            <intent-filter android:autoVerify="false">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${esquema}" android:host="login" />
            </intent-filter>
`;
    const fim = x.indexOf('</activity>');
    if (fim < 0) throw new Error('MainActivity não encontrada no AndroidManifest.xml');
    x = x.slice(0, fim) + filtro + '        ' + x.slice(fim);
  }
  return x;
});

// 2. Versão
const gradle = join(APP, 'build.gradle');
const codigo = Number.parseInt(process.env.VERSAO_CODIGO || '1', 10);
const nome = (process.env.VERSAO_NOME || '1.0.0').replace(/^v/, '').replace(/[^0-9A-Za-z.\-]/g, '');
alterar(gradle, g => g.replace(/versionCode\s+\d+/, `versionCode ${codigo}`).replace(/versionName\s+"[^"]*"/, `versionName "${nome}"`));

// 3. Ícone: PNGs prontos em recursos/icone (sem ícone adaptativo)
const res = join(APP, 'src', 'main', 'res');
rmSync(join(res, 'mipmap-anydpi-v26'), { recursive: true, force: true });
for (const arq of readdirSync(join(RAIZ, 'recursos', 'icone')).filter(a => a.startsWith('mipmap-'))) {
  const [, densidade, ...resto] = arq.replace('.png', '').split('-');
  cpSync(join(RAIZ, 'recursos', 'icone', arq), join(res, `mipmap-${densidade}`, `${resto.join('-')}.png`));
}

const m = readFileSync(manifest, 'utf8');
if (!m.includes(`android:scheme="${esquema}"`) || !m.includes('android:allowBackup="false"')) throw new Error('Ajuste do manifest falhou.');
console.log(`Android ajustado: retorno do login ${esquema}://login, backup bloqueado, versão ${nome} (${codigo}).`);
