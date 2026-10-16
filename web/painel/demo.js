// Dados fictícios do modo demonstração (só para o administrador mostrar o sistema).
// Têm o mesmo formato das tabelas do banco, para as telas funcionarem igual. Nada daqui é gravado.
import { hojeISO } from '../comum/util.js';

const dia = (n = 0) => { const d = new Date(Date.now() - n * 86400000); return d.toLocaleDateString('sv-SE'); };
const quando = (n, hm) => new Date(`${dia(n)}T${hm}:00`).toISOString();

const FRENT = { 1: 'Ana Ribeiro', 2: 'Carlos Mendes', 3: 'Paulo Nunes' };
const POSTO = 'posto1@empresa-demo.com.br', SUP = 'marcos.lima@empresa-demo.com.br', ADM = 'admin@empresa-demo.com.br';

function abast(id, hm, placa, motorista, km, litros, bomba, frent, status, extra = {}) {
  const enc = 7071000 + id * 37;
  return { id, uuid: `demo-${id}`, data_hora: `${extra.dia ?? hojeISO()}T${hm}:00`, placa, motorista, cpf: null, km, litros, encerrante: enc + litros,
    encerrante_anterior: enc, bomba, tanque: 'TQ01', status, problemas: [], obs_frentista: null, obs_supervisor: null,
    frentista_id: frent, frentistas: { nome: FRENT[frent] }, conta: POSTO, recebido_em: quando(0, hm), lote_id: null, erro_kmm: null,
    desconto_confirmado: true, justificativa_desconto: null, autorizado_por: null, fora_horario: false, justificativa_horario: null, ...extra };
}

export function dadosDemo() {
  const abastecimentos = [
    abast(1046, '15:08', 'ABC1D23', 'JOAO DA SILVA', 150700, 210, 1, 1, 'Pronto'),
    abast(1045, '14:52', 'DEF4567', 'MARIA SOUZA', 98350, 380, 1, 1, 'Aguardando autorização',
      { desconto_confirmado: false, justificativa_desconto: 'Motorista agregado; o acerto do frete é feito só no fim do mês.' }),
    abast(1044, '14:20', 'MNO3P45', 'RAFAEL DIAS', 312040, 550, 2, 2, 'Pronto'),
    abast(1043, '11:41', 'QRS6T78', 'BRUNO ALVES', 87215, 460, 1, 2, 'Pronto'),
    abast(1042, '11:18', 'JKL2M34', 'CARLOS LIMA', 50000, 320, 2, 2, 'Exceção',
      { problemas: ['Pelo encerrante saíram 300 L, mas o visor diz 320 L.'], obs_frentista: 'Visor da bomba 2 apagou no meio.' }),
    abast(1041, '10:47', 'UVW9X01', 'DIEGO ROCHA', 201330, 590, 2, 1, 'Pronto'),
    abast(1040, '08:30', 'GHI8J90', 'PEDRO SANTOS', 224710, 410, 1, 1, 'Exceção',
      { problemas: ['Rodou 4.210 km desde o último abastecimento. Confira o painel do caminhão.'] }),
    abast(1039, '06:40', 'ABC1D23', 'JOAO DA SILVA', 150110, 640, 1, 3, 'Pronto'),
    abast(1038, '04:35', 'XYZ2A34', 'LUCAS PRADO', 64020, 300, 2, 3, 'Aguardando autorização',
      { fora_horario: true, justificativa_horario: 'Caminhão saiu para entrega urgente antes da abertura.' }),
    abast(1037, '21:50', 'MNO3P45', 'RAFAEL DIAS', 311400, 520, 2, 2, 'Lançado', { dia: dia(1), lote_id: 12 }),
    abast(1036, '16:12', 'QRS6T78', 'BRUNO ALVES', 86600, 410, 1, 1, 'Lançado', { dia: dia(1), lote_id: 12 }),
  ];
  const veiculos = [['ABC1D23', 600, 150000], ['DEF4567', 450, 98000], ['GHI8J90', 600, 220000], ['JKL2M34', 400, 49000], ['MNO3P45', 700, 310000],
    ['QRS6T78', 600, 86000], ['UVW9X01', 650, 200000], ['XYZ2A34', 400, 63000]]
    .map(([placa, capacidade_l, km_inicial], i) => ({ placa, capacidade_l, km_inicial, ativo: true, criado_por: i === 5 ? 'Frentista: Carlos Mendes' : null }));
  const motoristas = ['BRUNO ALVES', 'CARLOS LIMA', 'DIEGO ROCHA', 'JOAO DA SILVA', 'LUCAS PRADO', 'MARIA SOUZA', 'PEDRO SANTOS', 'RAFAEL DIAS']
    .map((nome, i) => ({ id: i + 1, nome, cpf: `5299822472${i % 10}`, ativo: true, criado_por: null }));
  // Posto com 1 tanque e 2 bombas
  const tanques = [{ codigo: 'TQ01', capacidade_l: 30000, saldo_inicial: 12000 }];
  const bombas = [{ numero: 1, tanque: 'TQ01', encerrante_inicial: 7070000, ativa: true }, { numero: 2, tanque: 'TQ01', encerrante_inicial: 512000, ativa: true }];
  const hoje = [
    { tanque: 'TQ01', capacidade_l: 30000, saldo_inicial: 20730, chegadas: 5000, saidas: 3800, saldo_calculado: 21930, fechado: null },
  ];
  const fechamentos = [
    { id: 1, data: dia(1), tanque: 'TQ01', saldo_inicial: 22100, chegadas: 0, saidas: 1360, saldo_calculado: 20740, saldo_medido: 20730, diferenca: -10, frentistas: { nome: 'Carlos Mendes' } },
  ];
  const chegadas = [{ id: 7, tanque: 'TQ01', data_hora: `${hojeISO()}T09:20:00`, nf: '45871', litros: 5000, valor_total: 29850, regua_antes: 6300, regua_depois: 11290,
    placa_caminhao: 'TNK1B22', placa_carreta: null, motorista: 'Fornecedor', frentistas: { nome: 'Ana Ribeiro' }, alerta: null }];
  // Quem dirige cada placa: sai dos próprios lançamentos, como no banco
  const vinculos = [...new Map(abastecimentos.map(a => {
    const m = motoristas.find(x => x.nome === a.motorista);
    return [`${a.placa}|${m.id}`, { placa: a.placa, motorista_id: m.id, motoristas: { nome: m.nome, cpf: m.cpf } }];
  })).values()];
  // Aferição semanal: a bomba 1 está em dia; a da bomba 2 venceu e a última deu diferença acima da tolerância
  const afericoes = [
    { id: 3, bomba: 1, data_hora: `${dia(2)}T07:10:00`, medida_l: 20, visor_l: 20.04, diferenca_l: 0.04, frentistas: { nome: 'Ana Ribeiro' } },
    { id: 2, bomba: 2, data_hora: `${dia(9)}T07:25:00`, medida_l: 20, visor_l: 20.15, diferenca_l: 0.15, frentistas: { nome: 'Carlos Mendes' } },
    { id: 1, bomba: 1, data_hora: `${dia(9)}T07:15:00`, medida_l: 20, visor_l: 19.98, diferenca_l: -0.02, frentistas: { nome: 'Carlos Mendes' } },
  ];
  const frentistas = [{ id: 1, nome: 'Ana Ribeiro', ativo: true }, { id: 2, nome: 'Carlos Mendes', ativo: true }, { id: 3, nome: 'Paulo Nunes', ativo: true },
    { id: 4, nome: 'Rogério Assis', ativo: false }];
  const acessos = [{ email: ADM, nome: 'Administrador (demo)', papel: 'administrador', ativo: true }, { email: SUP, nome: 'Marcos Lima', papel: 'supervisor', ativo: true },
    { email: POSTO, nome: 'Celular posto 1', papel: 'posto', ativo: true }, { email: 'posto2@empresa-demo.com.br', nome: 'Celular posto 2', papel: 'posto', ativo: false }];
  const lotes = [{ id: 13, criado_em: quando(0, '13:30'), quantidade: 0, litros: 0, situacao: 'Desfeito', criado_por: SUP },
    { id: 12, criado_em: quando(0, '08:55'), quantidade: 24, litros: 9870, situacao: 'Confirmado', criado_por: ADM, fechado_em: quando(0, '09:10'), fechado_por: ADM }];
  const auditoria = [
    { id: 20, quando: quando(0, '15:21'), conta: SUP, papel: 'supervisor', acao: 'autorizacao.aprovada', entidade: 'abastecimento', entidade_id: '1035', detalhes: { motivo: 'Desconto será feito no acerto do dia 30.' } },
    { id: 19, quando: quando(0, '15:08'), conta: POSTO, papel: 'posto', acao: 'abastecimento.recebido', entidade: 'abastecimento', entidade_id: '1046',
      detalhes: { placa: 'ABC1D23', litros: 210, bomba: 1, status: 'Pronto', frentista_id: 1, frentista: 'Ana Ribeiro', desconto: true, fora_horario: false } },
    { id: 18, quando: quando(0, '14:40'), conta: SUP, papel: 'supervisor', acao: 'abastecimento.revalidar', entidade: 'abastecimento', entidade_id: '1034',
      detalhes: { motivo: 'Visor da bomba 2 apagou no meio; vale o encerrante.', alterado: { litros: [320, 300], status: ['Exceção', 'Pronto'], problemas: [['Encerrante indica 300 L'], []] } } },
    { id: 17, quando: quando(0, '13:55'), conta: POSTO, papel: 'posto', acao: 'cadastro.veiculos.insert', entidade: 'veiculos', entidade_id: 'QRS6T78',
      detalhes: { antes: null, depois: { placa: 'QRS6T78', capacidade_l: 600, km_inicial: 86000, ativo: true, criado_por: 'Frentista: Carlos Mendes' } } },
    { id: 16, quando: quando(0, '11:02'), conta: SUP, papel: 'supervisor', acao: 'frentista.pin_definido', entidade: 'frentistas', entidade_id: '2', detalhes: null },
    { id: 15, quando: quando(0, '09:10'), conta: ADM, papel: 'administrador', acao: 'lote.confirmar', entidade: 'lote', entidade_id: '12', detalhes: { registros: 24 } },
    { id: 14, quando: quando(0, '06:58'), conta: POSTO, papel: 'posto', acao: 'frentista.pin_errado', entidade: 'frentistas', entidade_id: '2',
      detalhes: { tentativa: 2, no_dia: 2, frentista: 'Carlos Mendes' } },
    { id: 13, quando: quando(0, '05:03'), conta: POSTO, papel: 'posto', acao: 'frentista.entrou', entidade: 'frentistas', entidade_id: '1', detalhes: { frentista: 'Ana Ribeiro' } },
    { id: 12, quando: quando(1, '23:02'), conta: POSTO, papel: 'posto', acao: 'fechamento.registrado', entidade: 'fechamento', entidade_id: dia(1),
      detalhes: { medidos: { TQ01: 20730 }, frentista_id: 2, frentista: 'Carlos Mendes', fotos: 2 } },
    { id: 11, quando: quando(1, '17:45'), conta: SUP, papel: 'supervisor', acao: 'cadastro.acessos.update', entidade: 'acessos', entidade_id: 'posto2@empresa-demo.com.br',
      detalhes: { antes: { email: 'posto2@empresa-demo.com.br', nome: 'Celular posto 2', papel: 'posto', ativo: true }, depois: { email: 'posto2@empresa-demo.com.br', nome: 'Celular posto 2', papel: 'posto', ativo: false } } },
  ];
  const porStatus = abastecimentos.reduce((m, a) => ((m[a.status] = (m[a.status] || 0) + 1), m), {});
  return { abastecimentos, veiculos, motoristas, vinculos, tanques, bombas, hoje, fechamentos, chegadas, afericoes, frentistas, acessos, lotes, auditoria, porStatus,
    configuracoes: { abertura: '05:00', fechamento: '23:00' }, fotos: {} };
}
