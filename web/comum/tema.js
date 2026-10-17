// Tema escolhido pela pessoa (claro, escuro ou automático) e modo demonstração do administrador.
// Os dois ficam guardados só neste aparelho.
import { ler, gravar } from './util.js';

export const temaAtual = () => ler('diesel-tema', 'claro');

export function aplicarTema(t = temaAtual()) {
  if (t === 'claro') document.documentElement.setAttribute('data-theme', 'light');
  else if (t === 'escuro') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll('[data-tema]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tema === t)));
}

export function definirTema(t) {
  if (!['claro', 'escuro', 'auto'].includes(t)) return;
  gravar('diesel-tema', t);
  aplicarTema(t);
}

export const htmlTema = () => `<div class="tema" role="group" aria-label="Tema">${[['claro', 'Claro'], ['escuro', 'Escuro'], ['auto', 'Automático']]
  .map(([k, t]) => `<button type="button" data-tema="${k}" aria-pressed="${temaAtual() === k}">${t}</button>`).join('')}</div>`;

// Modo demonstração: só muda o que a tela mostra; nenhuma ação é enviada ao banco enquanto estiver ligado
export const demoLigado = () => ler('diesel-demo', false) === true;
export const alternarDemo = () => gravar('diesel-demo', !demoLigado());

export const htmlChaveDemo = () => `<button type="button" class="chave" role="switch" aria-checked="${demoLigado()}" data-demo-alternar>
  <span>Modo demonstração<small>Dados fictícios; nada é gravado</small></span><span class="trilho"></span></button>`;

export const htmlFaixaDemo = compacto => !demoLigado() ? '' : compacto
  ? `<div class="faixa-demo" role="status"><b>Demonstração</b> Dados fictícios; nada é gravado. <button type="button" data-demo-alternar>Sair</button></div>`
  : `<div class="faixa-demo" role="status"><b>Modo demonstração</b> Dados fictícios. Nada do que você fizer aqui é gravado ou vai para o KMM.
    <button type="button" data-demo-alternar>Sair da demonstração</button></div>`;

// Impede que o painel ou o app sejam abertos escondidos dentro de outro site (clickjacking)
export function protegerContraMoldura() {
  if (window.top !== window.self) {
    document.documentElement.innerHTML = '';
    try { window.top.location = window.self.location.href; } catch { /* navegador bloqueou: a página já ficou vazia */ }
  }
}
