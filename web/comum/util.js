// Formatação e pequenos utilitários usados pelo app e pelo painel.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const nf = (n, casas = 2) => n == null || n === '' || Number.isNaN(Number(n)) ? '–'
  : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: casas });

export const parseNum = s => {
  s = String(s ?? '').trim();
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  return Number(s);
};

export const hhmm = iso => String(iso || '').slice(11, 16);
export const dataBR = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
export const dataHora = iso => iso ? `${dataBR(iso)} ${hhmm(iso)}` : '';

const dois = n => String(n).padStart(2, '0');
export const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`; };
export const horaAgora = () => { const d = new Date(); return `${dois(d.getHours())}:${dois(d.getMinutes())}`; };
export const classeStatus = s => String(s || '').replace(/\s+/g, '-');

// localStorage pode falhar (modo privado, armazenamento cheio): o app continua funcionando sem ele
export const ler = (chave, padrao) => { try { const v = localStorage.getItem(chave); return v ? JSON.parse(v) : padrao; } catch { return padrao; } };
export const gravar = (chave, valor) => { try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* sem espaço */ } };
