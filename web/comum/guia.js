// Guia de uso: procedimentos para frentista e supervisor, e o que é cada coisa. Conteúdo fixo (não vem do banco).
import { esc } from './util.js';

// ---------- Guia de uso ----------
const IC = {
  entrar: '<path d="M6 3h6v10H6M9 8H2m3-3-3 3 3 3"/>', bomba: '<path d="M3 14V3h6v11M3 7h6M9 6h2l1.5 1.5V12a1 1 0 0 0 2 0V6L12 4"/>',
  alerta: '<path d="M8 2 14.5 13.5h-13zM8 6.5v3M8 11.5v.1"/>', caminhao: '<path d="M1.5 10.5V5h8v5.5M9.5 7h3l2 2v1.5h-5"/><circle cx="4.5" cy="11.5" r="1.5"/><circle cx="12" cy="11.5" r="1.5"/>',
  regua: '<path d="M3 2h4v12H3zM3 5h2M3 8h2M3 11h2M11 2v12M9 4l2-2 2 2M9 12l2 2 2-2"/>', relogio: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  lista: '<path d="M2 4h12M2 8h8M2 12h5"/>', kmm: '<path d="M3 3h10v3H3zM3 8h10v5H3z"/>', pessoa: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/>',
  cadeado: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  medida: '<path d="M4 3h8l-1 11H5zM4.4 7h7.2M6.5 10h3"/>',
};
const ic = k => `<span class="ic"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${IC[k]}</svg></span>`;
export const GUIA = {
  frentista: [
    ['entrar', 'Entrar no app', 'Seu nome e seu PIN', `<ol><li>Abra o app e toque no seu nome.</li><li>Digite seu PIN de 4 números.</li>
      <li>Você fica conectado até tocar em <b>Trocar frentista</b>. Ao sair do turno, toque nele para o próximo entrar com o nome dele.</li></ol>
      <div class="atencao"><b>Nunca passe seu PIN.</b> Tudo o que for lançado com ele fica no seu nome. Errou 5 vezes, o app bloqueia por 5 minutos; se esqueceu, peça um PIN novo ao supervisor.</div>`],
    ['bomba', 'Abastecer um caminhão', 'O procedimento de todo abastecimento', `<ol><li>Antes de abastecer, confira a placa e quem é o motorista.</li>
      <li>Abasteça. Anote ou memorize os <b>litros do visor</b> e o <b>encerrante</b> que a bomba mostra no final.</li>
      <li>No app: toque na <b>bomba em que abasteceu</b> (ela não vem marcada; cada bomba tem o próprio encerrante).</li>
      <li>Digite o <b>começo da placa</b> e toque nela na lista. Os motoristas daquela placa aparecem: toque no certo, ou digite o começo do nome (ex.: "jo si" acha JOÃO DA SILVA).</li>
      <li>Digite o <b>KM do painel</b> do caminhão, os litros e o encerrante final.</li>
      <li>Confira as bolinhas: verde é tudo certo. Vermelho quer dizer que algum número não bate.</li>
      <li>Toque em <b>Usar o preço atual</b> do diesel. Se o preço mudou, toque em <b>Atualizar</b> e digite o novo: vale para todos daqui em diante.</li>
      <li>Responda se o diesel foi <b>descontado do motorista</b>.</li><li>Toque em <b>Enviar abastecimento</b> e espere a mensagem de lançado.</li></ol>
      <div class="dica">Preencheu errado? <b>Limpar</b>, no alto do formulário, apaga tudo menos a bomba e a hora (ele pede confirmação).
      Ficou vermelho? Confira os números de novo antes de enviar. Se o app disser que o encerrante bate com a outra bomba, você marcou a bomba errada: toque em <b>Usar a bomba</b>. Se estiverem certos mesmo, escreva o que aconteceu: o lançamento vai para o supervisor conferir.</div>`],
    ['alerta', 'Diesel sem desconto do motorista', 'Precisa de autorização', `<ol><li>Marque <b>Não</b> em "O diesel foi descontado do motorista?".</li>
      <li>Explique por que não foi descontado (ex.: motorista agregado com acerto no fim do mês).</li><li>Toque em <b>Pedir autorização ao supervisor</b>.</li></ol>
      <div class="dica">O abastecimento fica parado em "Aguardando autorização" até o supervisor decidir. Você acompanha em <b>Turno</b>.</div>`],
    ['relogio', 'Fora do horário do turno', 'Das {FECHAMENTO} às {ABERTURA}', `<p>O turno vai das <b>{ABERTURA} às {FECHAMENTO}</b>. Lançamento fora desse horário só entra com justificativa e autorização do supervisor ou do administrador.</p>
      <div class="atencao"><b>Depois do fechamento do turno</b>, não dá para lançar mais nada com a data daquele dia.</div>`],
    ['caminhao', 'Placa ou motorista que não está na lista', 'Cadastro pelo app', `<ol><li>Se a busca não achar, toque em <b>+ Cadastrar</b>: o cadastro já vem com o que você digitou.</li>
      <li>Veículo: digite a placa, o tamanho do tanque e o KM, e <b>tire uma foto do caminhão mostrando a placa</b>.</li>
      <li>Motorista: nome completo e CPF (o KMM exige o CPF).</li>
      <li><b>Tanque ou KM do caminhão errado?</b> Depois de escolher a placa, toque em <b>Corrigir tanque ou KM deste caminhão</b>. Vale na hora e fica registrado com seu nome.</li></ol><div class="dica">Ao enviar o abastecimento, o motorista fica ligado àquela placa e aparece da próxima vez.
      Depois de cadastrado, só o supervisor pode alterar. Errou algo? Avise.</div>`],
    ['regua', 'Chegada de diesel e fechamento do turno', 'Régua, nota fiscal e fotos', `<ol><li><b>Chegada:</b> meça a régua antes da descarga, descarregue e meça de novo. Lance a NF, os litros, o valor e as duas medidas, e tire foto da nota.
      Se o preço por litro da NF for diferente do atual, o app pergunta se quer atualizar o preço do diesel.</li>
      <li><b>Fechamento (até as {FECHAMENTO}):</b> meça cada tanque com a régua, digite as medidas, tire foto da régua e toque em <b>Fechar turno</b>.</li></ol>
      <div class="dica">Se a medida ficar mais de 20 L longe do esperado, o supervisor é avisado. Meça com calma e com o caminhão já fora da bomba.</div>`],
    ['medida', 'Aferição da bomba', 'Uma vez por semana em cada bomba', `<ol><li>Encha a <b>medida padrão de 20 L</b> com a bomba.</li>
      <li>Anote quanto o <b>visor</b> marcou e tire a foto da medida cheia junto com o visor.</li>
      <li>No app, aba <b>Aferir</b>: toque na bomba, digite os litros do visor, anexe a foto e toque em <b>Registrar aferição</b>.</li>
      <li><b>Devolva o diesel para o tanque.</b> Ele não conta como saída, e o app já desconta do encerrante no próximo abastecimento.</li></ol>
      <div class="dica">Diferença de até 100 mL é normal. Acima disso, o supervisor é avisado. Quando passar de 7 dias, o app lembra na tela de abastecer.</div>`],
  ],
  supervisor: [
    ['lista', 'Decisões do dia', 'Autorizações e exceções', `<p>Tudo o que precisa de você aparece em <b>Decisões</b>, com a cor do tipo:</p>
      <ol><li><b>Sem desconto</b> (azul): o frentista lançou sem descontar do motorista. Autorize se houver motivo; recuse para cancelar.</li>
      <li><b>Fora do horário</b> (roxo): lançado entre {FECHAMENTO} e {ABERTURA}. Confira se o abastecimento aconteceu mesmo.</li>
      <li><b>Exceção</b> (vermelho): algum número não bateu. Corrija o que estiver errado e confira de novo, ou aprove com o motivo.</li></ol>
      <div class="atencao"><b>Toda decisão pede um motivo</b> e fica na auditoria com o seu nome.</div>`],
    ['kmm', 'Lançar no KMM', 'Do lote à confirmação', `<ol><li>Em <b>Lotes</b>, toque em <b>Gerar lote do KMM</b> (no computador). A planilha baixa sozinha.</li>
      <li>No KMM: <b>Importação de abastecimento &gt; Interno</b>, escolha a filial, o produto e o estoque e selecione a planilha.</li>
      <li>Confira o resultado no KMM. Se alguma linha deu erro, marque o erro nela no painel.</li><li>Toque em <b>Confirmar: importado no KMM</b>.</li></ol>
      <div class="dica">Não importou nada? Use <b>Desfazer</b>: os abastecimentos voltam para o próximo lote.</div>`],
    ['pessoa', 'Frentistas e PIN', 'Cadastro, PIN novo e desligamento', `<ol><li>Cadastre o frentista com nome e um PIN de 4 números. Passe o PIN só para ele.</li>
      <li>Esqueceu o PIN ou ficou bloqueado: defina um PIN novo. Ele sai de todos os celulares e entra de novo.</li>
      <li>Saiu da empresa: <b>desative</b>. Quem já tem lançamentos não pode ser excluído, para não perder o histórico.</li></ol>`],
    ['cadeado', 'Celulares e contas Google', 'Liberar, bloquear e celular perdido', `<ol><li>Em <b>Acessos</b>, libere o e-mail Google do celular do posto como "Celular do posto".</li>
      <li><b>Celular perdido ou roubado:</b> bloqueie na hora. Ele perde o acesso mesmo estando logado.</li></ol>
      <div class="dica">Supervisores são liberados pelo administrador.</div>`],
  ],
  glossario: [
    ['Encerrante', 'O contador total da bomba, que só aumenta. A diferença entre o encerrante final e o anterior é quanto saiu de verdade.'],
    ['Visor', 'O mostrador de litros do abastecimento atual, que zera a cada abastecimento.'],
    ['Régua', 'A medida do diesel dentro do tanque, feita no fechamento e na chegada de diesel.'],
    ['Aferição', 'Teste semanal de cada bomba: encher a medida padrão de 20 L e comparar com o visor. Tolerância de 100 mL (0,5%).'],
    ['Saldo esperado', 'Saldo inicial + chegadas − o que saiu pelos encerrantes. A régua do fechamento é comparada com ele.'],
    ['Exceção', 'Lançamento em que algum número não bateu (KM, capacidade, encerrante, repetição ou hora). Vai para o supervisor.'],
    ['Autorização', 'Lançamento que só entra com aprovação: sem desconto do motorista ou fora do horário do turno.'],
    ['Lote do KMM', 'O grupo de abastecimentos prontos que vira uma planilha para importar no KMM.'],
    ['Nº da requisição', 'O número do lançamento (#1040). É o mesmo número que vai para o KMM.'],
  ],
};
export function htmlGuia(publico, turno = { abertura: '05:00', fechamento: '23:00' }) {
  const h = txt => txt.replaceAll('{ABERTURA}', esc(turno.abertura)).replaceAll('{FECHAMENTO}', esc(turno.fechamento));
  if (publico === 'glossario') return `<div class="glossario">${GUIA.glossario.map(([nome, d]) => `<div><b>${nome}</b><p>${d}</p></div>`).join('')}</div>`;
  return `<div class="guia">${GUIA[publico].map(([k, ti, su, corpo], i) => `<details ${i === 0 ? 'open' : ''}><summary>${ic(k)}<span><b>${h(ti)}</b><small>${h(su)}</small></span></summary>
    <div class="passos">${h(corpo)}</div></details>`).join('')}</div>`;
}
export const htmlAbasGuia = (publico, abas = ['frentista', 'supervisor', 'glossario']) => `<div class="guia-abas">${[['frentista', 'Para o frentista'], ['supervisor', 'Para o supervisor'], ['glossario', 'O que é cada coisa']]
  .filter(([k]) => abas.includes(k)).map(([k, t]) => `<button type="button" data-guia="${k}" aria-pressed="${publico === k}">${t}</button>`).join('')}</div>`;
