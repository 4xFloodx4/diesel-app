// Tema: o app e o painel são sempre claros, no visual da Ritmo (o tema escuro saiu).
// Modo demonstração do administrador: fica guardado só neste aparelho.
import { ler, gravar } from './util.js';

export function aplicarTema() { document.documentElement.setAttribute('data-theme', 'light'); }
export function definirTema() { aplicarTema(); }
export const htmlTema = () => '';

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
