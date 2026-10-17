// Auditoria em linguagem simples: transforma cada registro técnico do banco numa frase,
// e guarda o detalhe técnico (ação, conta, antes e depois de cada campo) para quem abrir "Ver detalhes técnicos".
import { esc, nf } from './util.js';

const CAMPOS = {
  data_hora: 'Data e hora', placa: 'Placa', motorista: 'Motorista', km: 'KM', litros: 'Litros', encerrante: 'Encerrante',
  encerrante_anterior: 'Encerrante anterior', bomba: 'Bomba', tanque: 'Tanque', status: 'Situação', problemas: 'Problemas',
  obs_supervisor: 'Obs. do supervisor', obs_frentista: 'Obs. do frentista', lote_id: 'Lote', erro_kmm: 'Erro do KMM',
  autorizado_por: 'Autorizado por', autorizado_em: 'Autorizado em', ativo: 'Ativo', ativa: 'Ativa', capacidade_l: 'Capacidade (L)',
  km_inicial: 'KM inicial', nome: 'Nome', cpf: 'CPF', papel: 'Tipo de acesso', email: 'E-mail', saldo_inicial: 'Saldo inicial',
  encerrante_inicial: 'Encerrante inicial', abertura: 'Abertura do turno', fechamento: 'Fechamento do turno', criado_por: 'Cadastrado por',
  numero: 'Número', codigo: 'Código', desconto_confirmado: 'Desconto do motorista', justificativa_desconto: 'Justificativa (desconto)',
  fora_horario: 'Fora do horário', justificativa_horario: 'Justificativa (horário)', cpf_final: 'CPF (final)', desconto: 'Desconto do motorista',
  medidos: 'Medidas da régua', fotos: 'Fotos', nf: 'Nota fiscal', mensagem: 'Mensagem', registros: 'Registros', quantidade: 'Quantidade',
  tentativa: 'Tentativa', no_dia: 'Erros no dia', caminho: 'Arquivo', enviada_em: 'Enviada em', enviada_por: 'Enviada por',
  km_salto: 'Salto de KM suspeito', tol_encerrante: 'Folga do encerrante (L)', tol_capacidade: 'Folga da capacidade do tanque',
  tol_regua: 'Diferença da régua aceita (L)', tol_afericao: 'Tolerância da aferição (L)', tanque_padrao: 'Tanque padrão (L)',
  placa_cavalo: 'Placa do cavalo', placa_carreta: 'Placa da carreta', atualizado_em: 'Atualizado em',
};
const IGNORAR = new Set(['atualizado_em', 'criado_em', 'id', 'alterado_em']);
const PAPEL = { posto: 'Celular do posto', supervisor: 'Supervisor', administrador: 'Administrador', desenvolvedor: 'Desenvolvedor' };
const NOME_TIPO = { lancamento: 'Lançamento', decisao: 'Decisão', cadastro: 'Cadastro', acesso: 'Acesso', lote: 'KMM', entrada: 'Entrada no app', outro: 'Outro' };

export function valorSimples(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (typeof v === 'number') return nf(v, 3);
  if (Array.isArray(v)) return v.length ? v.join('; ') : '(nenhum)';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return nf(Number(s), 3);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `${s.slice(8, 10)}/${s.slice(5, 7)} ${s.slice(11, 16)}`;
  return s;
}

function mudancasDe(d) {
  if (!d) return [];
  if (d.alterado) return Object.entries(d.alterado).filter(([k]) => !IGNORAR.has(k)).map(([k, [a, b]]) => [CAMPOS[k] || k, valorSimples(a), valorSimples(b)]);
  if (d.antes || d.depois) {
    const chaves = [...new Set([...Object.keys(d.antes || {}), ...Object.keys(d.depois || {})])].filter(k => !IGNORAR.has(k));
    return chaves.filter(k => JSON.stringify(d.antes?.[k]) !== JSON.stringify(d.depois?.[k]))
      .map(k => [CAMPOS[k] || k, valorSimples(d.antes?.[k]), valorSimples(d.depois?.[k])]);
  }
  return Object.entries(d).filter(([k]) => !['motivo', 'frentista', 'frentista_id'].includes(k))
    .map(([k, v]) => [CAMPOS[k] || k, '—', valorSimples(v)]);
}

const placa = p => `<span class="placa">${esc(p)}</span>`;
const resumoMudancas = (lista, max = 3) => {
  const partes = lista.filter(([c]) => !['Problemas', 'Encerrante anterior', 'Situação', 'Obs. do supervisor'].includes(c)).slice(0, max)
    .map(([c, a, b]) => `${esc(c.toLowerCase())} de <b>${esc(a)}</b> para <b>${esc(b)}</b>`);
  return partes.join(', ');
};

/** Descreve um evento da auditoria. ctx: { contas: {email: nome}, frentistas: {id: nome} } */
export function descrever(e, ctx = {}) {
  const d = e.detalhes || {};
  const [grupo, , op] = String(e.acao).split('.');
  const nomeConta = (ctx.contas || {})[e.conta];
  const porFrentista = String(d.depois?.criado_por || '').replace(/^Frentista: /, '');
  const quem = e.papel === 'posto' ? (d.frentista || (porFrentista && porFrentista !== d.depois?.criado_por ? porFrentista : '') || nomeConta || `Celular ${e.conta || ''}`.trim())
    : (nomeConta || e.conta || 'Dono do sistema');
  const mud = mudancasDe(d);
  let tipo = 'outro', frase;
  const id = esc(e.entidade_id);
  switch (e.acao) {
    case 'abastecimento.recebido': {
      tipo = 'lancamento';
      const extra = d.status === 'Pronto' ? ' Conferências OK.' : d.status === 'Exceção' ? ' Foi para conferência do supervisor.'
        : d.status === 'Aguardando autorização' ? ` Pediu autorização${d.desconto === false ? ' (sem desconto do motorista)' : ''}${d.fora_horario ? ' (fora do horário)' : ''}.` : '';
      frase = `lançou <b>${esc(valorSimples(d.litros))} L</b> para ${placa(d.placa || '')}${d.bomba ? ` na bomba ${esc(d.bomba)}` : ''} (<b>#${id}</b>).${extra}`;
      break;
    }
    case 'abastecimento.revalidar': {
      tipo = 'decisao';
      const st = d.alterado?.status?.[1];
      const r = resumoMudancas(mud);
      frase = `corrigiu o abastecimento <b>#${id}</b>${r ? `: ${r}` : ''}${st ? `. Depois disso ficou <b>${esc(st)}</b>` : ''}.`;
      break;
    }
    case 'abastecimento.aprovar': tipo = 'decisao'; frase = `aprovou o abastecimento <b>#${id}</b> mesmo com problemas na conferência.`; break;
    case 'abastecimento.cancelar': tipo = 'decisao'; frase = `cancelou o abastecimento <b>#${id}</b>.`; break;
    case 'autorizacao.aprovada': tipo = 'decisao'; frase = `autorizou o abastecimento <b>#${id}</b>.`; break;
    case 'autorizacao.recusada': tipo = 'decisao'; frase = `recusou o abastecimento <b>#${id}</b>, que foi cancelado.`; break;
    case 'abastecimento.erro_kmm': tipo = 'lote'; frase = `marcou o abastecimento <b>#${id}</b> com erro do KMM: “${esc(d.mensagem)}”.`; break;
    case 'chegada.recebida':
      tipo = 'lancamento';
      frase = `registrou a chegada da NF <b>${esc(d.nf)}</b>: ${esc(valorSimples(d.litros))} L${d.tanque ? ` no ${esc(d.tanque)}` : ''}${d.fotos ? `, com ${esc(d.fotos)} foto(s)` : ''}.`;
      break;
    case 'afericao.registrada': {
      tipo = 'lancamento';
      const dif = Number(d.diferenca);
      frase = `aferiu a <b>bomba ${esc(d.bomba)}</b>: o visor marcou ${esc(valorSimples(d.visor))} L na medida de 20 L
        (${dif > 0 ? '+' : ''}${esc(valorSimples(Math.round(dif * 1000)))} mL${Math.abs(dif) > 0.1 ? ', acima da tolerância' : ''})${d.fotos ? `, com ${esc(d.fotos)} foto(s)` : ''}.`;
      break;
    }
    case 'fechamento.registrado': {
      tipo = 'lancamento';
      const med = Object.entries(d.medidos || {}).map(([t, v]) => `${esc(t)} ${esc(valorSimples(v))} L`).join(', ');
      frase = `fechou o turno de <b>${esc(valorSimples(e.entidade_id + 'T00:00').slice(0, 5))}</b>${med ? `: ${med}` : ''}${d.fotos ? ` (${esc(d.fotos)} foto(s) da régua)` : ''}.`;
      break;
    }
    case 'turno.reaberto':
      tipo = 'decisao';
      frase = `reabriu o turno de <b>${esc(valorSimples(e.entidade_id + 'T00:00').slice(0, 5))}</b>, que tinha sido fechado: “${esc(d.motivo)}”.`;
      break;
    case 'lote.gerado': tipo = 'lote'; frase = `gerou o <b>lote ${id}</b> do KMM (${esc(d.quantidade)} abastecimentos, ${esc(valorSimples(d.litros))} L).`; break;
    case 'lote.confirmar': tipo = 'lote'; frase = `confirmou que o <b>lote ${id}</b> foi importado no KMM (${esc(d.registros)} abastecimentos).`; break;
    case 'lote.desfazer': tipo = 'lote'; frase = `desfez o <b>lote ${id}</b>: ${esc(d.registros)} abastecimentos voltaram para o próximo lote.`; break;
    case 'frentista.entrou': tipo = 'entrada'; frase = 'entrou no app.'; break;
    case 'frentista.pin_errado': tipo = 'entrada'; frase = `errou o PIN (<b>tentativa ${esc(d.tentativa)} de 5</b>${d.no_dia ? `, ${esc(d.no_dia)}ª do dia` : ''}).`; break;
    case 'frentista.pin_definido':
      tipo = 'cadastro'; frase = `definiu um <b>PIN novo</b> para <b>${esc((ctx.frentistas || {})[e.entidade_id] || `frentista ${e.entidade_id}`)}</b>.`; break;
    case 'foto.excluida': tipo = 'cadastro'; frase = `excluiu uma foto (${esc(e.entidade)} ${id}).`; break;
    case 'preco.alterado':
      tipo = 'cadastro';
      frase = `atualizou o preço do diesel${d.antes != null ? ` de <b>R$ ${esc(valorSimples(d.antes))}</b>` : ''} para <b>R$ ${esc(valorSimples(d.depois))}</b> por litro${d.origem === 'chegada' ? ' (pela NF da chegada)' : ''}.`;
      break;
    case 'veiculo.corrigido': {
      tipo = 'cadastro';
      const partes = [d.capacidade && `tanque de <b>${esc(valorSimples(d.capacidade[0]))}</b> para <b>${esc(valorSimples(d.capacidade[1]))} L</b>`,
        d.km && `KM de <b>${esc(valorSimples(d.km[0]))}</b> para <b>${esc(valorSimples(d.km[1]))}</b>`].filter(Boolean);
      frase = `corrigiu o caminhão ${placa(e.entidade_id)}${partes.length ? `: ${partes.join(', ')}` : ''}.`;
      break;
    }
    case 'dev.alterou': case 'dev.incluiu': case 'dev.apagou': {
      tipo = 'cadastro';
      const verbo = { 'dev.alterou': 'alterou', 'dev.incluiu': 'incluiu', 'dev.apagou': 'apagou' }[e.acao];
      const r = resumoMudancas(mud);
      frase = `${verbo} direto no banco a linha <b>${id}</b> de <b>${esc(e.entidade)}</b>${r && e.acao === 'dev.alterou' ? `: ${r}` : ''}.`;
      break;
    }
    case 'veiculo.foto_anexada': tipo = 'cadastro'; frase = `anexou uma foto ao veículo ${placa(e.entidade_id)}.`; break;
    default:
      if (grupo === 'cadastro') {
        const tabela = e.acao.split('.')[1];
        const reg = d.depois || d.antes || {};
        const coisa = {
          veiculos: `o veículo ${placa(reg.placa || e.entidade_id)}`, motoristas: `o motorista <b>${esc(reg.nome)}</b>`,
          veiculo_motoristas: `o motorista <b>${esc(reg.motorista || '')}</b> na placa ${placa(reg.placa || e.entidade_id)}`,
          frentistas: `o frentista <b>${esc(reg.nome)}</b>`, tanques: `o tanque <b>${esc(reg.codigo)}</b>`, bombas: `a bomba <b>${esc(reg.numero)}</b>`,
          acessos: `o acesso de <b>${esc(reg.nome)}</b> (${esc(reg.email)})`, configuracoes: 'o horário e as regras da conferência',
          caminhoes_diesel: `o caminhão de diesel ${placa(reg.placa_cavalo || e.entidade_id)}`,
        }[tabela] || `${esc(tabela)} ${id}`;
        tipo = tabela === 'acessos' ? 'acesso' : 'cadastro';
        const verbo = op === 'insert' ? 'cadastrou' : op === 'delete' ? 'excluiu' : 'alterou';
        const ativou = d.antes && d.depois && 'ativo' in d.depois && d.antes.ativo !== d.depois.ativo;
        if (ativou && tabela === 'acessos') frase = `${d.depois.ativo ? 'liberou de novo' : 'bloqueou'} ${coisa}.`;
        else if (ativou) frase = `${d.depois.ativo ? 'reativou' : 'desativou'} ${coisa}.`;
        else if (op === 'update') { const r = resumoMudancas(mud); frase = `alterou ${coisa}${r ? `: ${r}` : ''}.`; }
        else frase = `${verbo} ${coisa}.`;
      } else {
        frase = `fez <b>${esc(e.acao)}</b>${e.entidade ? ` em ${esc(e.entidade)} ${id}` : ''}.`;
      }
  }
  return { quem, papel: PAPEL[e.papel] || (e.conta ? '' : 'Feito direto no banco'), tipo, frase, motivo: d.motivo, mud };
}

const iniciais = n => String(n).replace(/[^A-Za-zÀ-ú ]/g, ' ').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase() || '?';
const horaLocal = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataLocal = iso => new Date(iso).toLocaleString('sv-SE').slice(0, 19);
function rotuloDia(iso) {
  const d = new Date(iso); const hoje = new Date(); const ontem = new Date(Date.now() - 86400000);
  const igual = (a, b) => a.toDateString() === b.toDateString();
  return igual(d, hoje) ? 'Hoje' : igual(d, ontem) ? 'Ontem' : d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
}

export function htmlAuditoria(eventos, ctx, filtro = 'todos', busca = '') {
  const termo = busca.trim().toLowerCase();
  const itens = eventos.map(e => ({ e, x: descrever(e, ctx) }))
    .filter(({ x }) => filtro === 'todos' || x.tipo === filtro)
    .filter(({ e, x }) => !termo || `${x.quem} ${x.frase} ${x.motivo || ''} ${e.conta || ''}`.toLowerCase().includes(termo));
  if (!itens.length) return '<p class="sem-dados">Nada encontrado com esse filtro.</p>';
  const grupos = [];
  for (const it of itens) {
    const dia = rotuloDia(it.e.quando);
    if (!grupos.length || grupos[grupos.length - 1].dia !== dia) grupos.push({ dia, itens: [] });
    grupos[grupos.length - 1].itens.push(it);
  }
  return grupos.map(g => `<div class="aud-dia">${esc(g.dia)}</div><ul class="aud-lista">${g.itens.map(({ e, x }) => `<li class="aud">
    <span class="h">${horaLocal(e.quando)}</span>
    <span class="av ${['administrador', 'desenvolvedor'].includes(e.papel) ? 'admin' : ''}" aria-hidden="true">${esc(iniciais(x.quem))}</span>
    <div><div class="frase"><span class="tag">${NOME_TIPO[x.tipo]}</span><b>${esc(x.quem)}</b> ${x.frase}</div>
      <div class="quem"><span class="h-curta">${horaLocal(e.quando)} · </span>${esc(x.papel)}</div>
      ${x.motivo ? `<div class="motivo">Motivo: ${esc(x.motivo)}</div>` : ''}
      <details><summary>Ver detalhes técnicos</summary><div class="tecnico">
        <dl><dt>Ação</dt><dd>${esc(e.acao)}</dd><dt>Registro</dt><dd>${esc([e.entidade, e.entidade_id].filter(Boolean).join(' ')) || '—'}</dd>
          <dt>Conta</dt><dd>${esc(e.conta || '—')}</dd><dt>Papel</dt><dd>${esc(e.papel || '—')}</dd><dt>Data e hora</dt><dd>${esc(dataLocal(e.quando))}</dd></dl>
        ${x.mud.length ? `<div class="dif"><table><thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead><tbody>
          ${x.mud.map(([c, a, b]) => `<tr><td>${esc(c)}</td><td class="${a === '—' || a === b ? '' : 'antes'}">${esc(a)}</td><td class="depois">${esc(b)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div><div class="rotulo-tec">Registro original</div><pre>${esc(JSON.stringify(e.detalhes ?? null, null, 2))}</pre></div>
      </div></details></div></li>`).join('')}</ul>`).join('');
}

export const htmlFiltroAud = (filtro, busca) => `<div class="filtro-aud">${[['todos', 'Tudo'], ['lancamento', 'Lançamentos'], ['decisao', 'Decisões'],
  ['cadastro', 'Cadastros'], ['acesso', 'Acessos'], ['lote', 'KMM'], ['entrada', 'Entradas no app']]
  .map(([k, t]) => `<button type="button" data-aud-filtro="${k}" aria-pressed="${filtro === k}">${t}</button>`).join('')}
  <input type="search" id="aud-busca" placeholder="Buscar placa, pessoa ou motivo" value="${esc(busca)}" autocomplete="off"></div>`;
