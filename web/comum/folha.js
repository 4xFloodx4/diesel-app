// Folha do fechamento do turno (modelo "RELATÓRIO DIÁRIO DE ABASTECIMENTO - VERSÃO ONLINE" da Ritmo) em PDF, montada
// aqui mesmo, no painel ou no app, com os dados de folha_do_dia(). Mais de 35 abastecimentos ou mais de uma chegada de
// diesel no dia: a folha continua numa segunda página igual. A assinatura fica em branco (o analista carimba e assina).
// No navegador o PDF baixa; no app do celular abre a tela de compartilhar (salvar, WhatsApp, Drive...).
import { nativo, ErroApi } from './supa.js';

const LINHAS = 35;
const num = (x, casas = 0) => x == null || x === '' ? '' : Number(x).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: Math.max(casas, 3) });
const cpfFmt = c => /^\d{11}$/.test(c || '') ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : (c || '');
const dataBR = iso => { const [a, m, d] = String(iso).split('-'); return `${d}/${m}/${a}`; };

async function logoDataUrl(url) {
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise((ok, falha) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = falha; r.readAsDataURL(blob); });
  } catch { return null; }   // sem o logo a folha sai do mesmo jeito
}

/** Monta o PDF. `logo`: endereço do logo-ritmo.jpg. Devolve o documento do jsPDF. */
export async function montarFolha(f, logo) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const img = logo ? await logoDataUrl(logo) : null;
  const M = 12, L = 210 - 2 * M, H = 5.6;   // margem, largura útil, altura de uma linha
  const folhas = Math.max(1, Math.ceil(f.abastecimentos.length / LINHAS), f.chegadas.length);
  // Texto numa célula: diminui a letra até caber (até 6,5 pt); se ainda não couber, corta com "…". Nunca passa para a linha de baixo.
  const caixa = (x, y, w, txt, op = {}) => {
    doc.rect(x, y, w, H);
    if (!txt) return;
    const tamanho = doc.getFontSize(), cabe = w - 3;
    let t = String(txt), fs = tamanho;
    while (doc.getStringUnitWidth(t) * fs / doc.internal.scaleFactor > cabe && fs > 6.5) fs -= 0.25;
    doc.setFontSize(fs);
    while (t.length > 1 && doc.getTextWidth(t) > cabe) t = `${t.slice(0, -2)}…`;
    doc.text(t, op.centro ? x + w / 2 : op.dir ? x + w - 1.5 : x + 1.5, y + H - 1.7, { align: op.centro ? 'center' : op.dir ? 'right' : 'left' });
    doc.setFontSize(tamanho);
  };
  for (let k = 0; k < folhas; k++) {
    if (k) doc.addPage();
    doc.setDrawColor(30); doc.setLineWidth(0.25); doc.setTextColor(17);
    let y = M;
    if (img) doc.addImage(img, 'JPEG', M, y, 30, 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
    doc.text('RELATÓRIO DIÁRIO DE ABASTECIMENTO - VERSÃO ONLINE', 105 + 12, y + 7.5, { align: 'center' });
    y += 18;
    doc.setFontSize(8.5);
    doc.text(`DATA: ${dataBR(f.data)}${folhas > 1 ? `   (folha ${k + 1} de ${folhas})` : ''}`, M, y);
    doc.text(`HORA: ${f.hora || ''}`, M + L * 0.6, y);
    y += 5;
    const t = f.tanques || [];
    doc.text(`SALDO INICIAL (TQ) 01: ${t[0] ? `${num(t[0].saldo_inicial)} L` : ''}`, M, y);
    doc.text(`SALDO INICIAL (TQ) 02: ${t[1] ? `${num(t[1].saldo_inicial)} L` : ''}`, M + L * 0.6, y);
    y += 2.5;
    const b = f.bombas || [];
    for (let i = 0; i < 4; i++) caixa(M + i * L / 4, y, L / 4, `BOMBA (0${i + 1}): ${b[i] ? num(b[i].encerrante_inicial) : ''}`);
    y += H;
    caixa(M, y, L, 'ABASTECIMENTOS INTERNO', { centro: true });
    y += H;
    const col = [0.14, 0.18, 0.09, 0.13, 0.11, 0.20, 0.15].map(p => p * L);
    const xs = col.reduce((a, w, i) => (a.push(i ? a[i - 1] + col[i - 1] : M), a), []);
    doc.setFontSize(7.5);
    ['PLACA', 'MOTORISTA', 'HORA', 'KM', 'LITROS', 'VALOR FINAL DA BOMBA', 'BOMBA'].forEach((h, i) => caixa(xs[i], y, col[i], h, { centro: true }));
    y += H;
    doc.setFontSize(8.5);
    const pedaco = f.abastecimentos.slice(k * LINHAS, (k + 1) * LINHAS);
    for (let r = 0; r < LINHAS; r++) {
      const a = pedaco[r];
      const v = a ? [a.placa, a.motorista, a.hora, num(a.km), num(a.litros, 0), num(a.encerrante), String(a.bomba)] : ['', '', ':', '', '', '', ''];
      v.forEach((txt, i) => caixa(xs[i], y, col[i], txt, { centro: i === 2 || i === 6, dir: i === 3 || i === 4 || i === 5 }));
      y += H;
    }
    // Recebimento de diesel (uma chegada por folha)
    const c = f.chegadas[k] || {};
    caixa(M, y, L, 'RECEBIMENTO DE DIESEL', { centro: true }); y += H;
    const linha = partes => { let x = M; for (const [p, txt] of partes) { caixa(x, y, p * L, txt); x += p * L; } y += H; };
    linha([[0.22, `DATA: ${c.data || ''}`], [0.2, `HORA: ${c.hora || ''}`], [0.58, 'ASSINATURA:']]);
    linha([[0.34, `LITRAGEM: ${c.litros != null ? `${num(c.litros)} L` : ''}`], [0.2, `NF: ${c.nf || ''}`],
      [0.46, `VALOR TOTAL: ${c.valor_total != null ? `R$ ${num(c.valor_total, 2)}` : ''}`]]);
    linha([[0.34, `TQ1 (INICIAL): ${c.regua_antes != null ? `${num(c.regua_antes)} L` : ''}`], [0.66, `TQ1 (FINAL): ${c.regua_depois != null ? `${num(c.regua_depois)} L` : ''}`]]);
    linha([[0.34, `PLACA DO CAVALO: ${c.placa_caminhao || ''}`], [0.66, `PLACA DA CARRETA: ${c.placa_carreta || ''}`]]);
    linha([[0.34, `MOTORISTA: ${c.motorista || ''}`], [0.66, `CPF: ${cpfFmt(c.cpf)}`]]);
  }
  return doc;
}

/** Salva o PDF: no navegador baixa o arquivo; no app abre a tela de compartilhar do Android. */
export async function salvarPdf(doc, nome) {
  if (!nativo) { doc.save(nome); return; }
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const arq = await Filesystem.writeFile({ path: nome, data: doc.output('datauristring').split(',')[1], directory: Directory.Cache });
    await Share.share({ title: nome, url: arq.uri, dialogTitle: 'Salvar ou enviar a folha do turno' });
  } catch (e) {
    if (/cancel/i.test(String(e?.message || e))) return;
    throw new ErroApi(/not implemented|não implementad/i.test(String(e?.message || e))
      ? 'Para baixar a folha no celular, instale a versão nova do app (APK). No computador, baixe pelo painel.'
      : `Não foi possível salvar a folha: ${e?.message || e}`);
  }
}

export const nomeFolha = dia => `Folha-do-turno-${dia.slice(8, 10)}-${dia.slice(5, 7)}-${dia.slice(0, 4)}.pdf`;
