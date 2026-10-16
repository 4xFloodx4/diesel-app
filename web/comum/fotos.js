// Fotos: tirar (câmera do celular) ou escolher arquivo (painel), reduzir e enviar ao Storage do Supabase.
// No Storage cada foto fica em pasta/uuid.jpg; ninguém consegue trocar ou apagar uma foto já enviada.
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { supabase, nativo, ErroApi } from './supa.js';

const LADO_MAX = 1600;      // px; foto de placa e de régua continua legível e fica com ~200-400 KB
const QUALIDADE = 0.72;

function carregarImagem(src) {
  return new Promise((ok, falha) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => falha(new ErroApi('Não foi possível ler a foto.'));
    img.src = src;
  });
}

async function reduzir(src) {
  const img = await carregarImagem(src);
  const escala = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * escala);
  canvas.height = Math.round(img.height * escala);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(ok => canvas.toBlob(ok, 'image/jpeg', QUALIDADE));
  return { blob, previa: URL.createObjectURL(blob) };
}

function escolherArquivo() {
  return new Promise(ok => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.setAttribute('capture', 'environment');
    input.addEventListener('change', () => ok(input.files[0] || null));
    input.click();
  });
}

/** Abre a câmera (app) ou o seletor de arquivo (navegador). Devolve {blob, previa} ou null se cancelado. */
export async function tirarFoto() {
  if (nativo) {
    try {
      const f = await Camera.getPhoto({
        source: CameraSource.Camera, resultType: CameraResultType.DataUrl, quality: 85,
        width: LADO_MAX, correctOrientation: true, saveToGallery: false,
      });
      return reduzir(f.dataUrl);
    } catch (e) {
      if (/cancel/i.test(String(e?.message || e))) return null;
      throw new ErroApi('Não foi possível usar a câmera. Confira a permissão de câmera do app.');
    }
  }
  const arquivo = await escolherArquivo();
  if (!arquivo) return null;
  const url = URL.createObjectURL(arquivo);
  try { return await reduzir(url); } finally { URL.revokeObjectURL(url); }
}

/** Envia as fotos e devolve os caminhos no Storage (pasta: 'fechamento' | 'chegada' | 'veiculo'). */
export async function enviarFotos(pasta, fotos) {
  const caminhos = [];
  for (const f of fotos) {
    const caminho = `${pasta}/${crypto.randomUUID()}.jpg`;
    const { error } = await supabase.storage.from('fotos').upload(caminho, f.blob, { contentType: 'image/jpeg', upsert: false });
    if (error) throw new ErroApi(/fetch|network/i.test(error.message) ? 'Sem internet para enviar as fotos.' : `Falha ao enviar foto: ${error.message}`, /fetch|network/i.test(error.message));
    caminhos.push(caminho);
  }
  return caminhos;
}

/** Links temporários (10 minutos) para o painel mostrar as fotos de um registro. */
export async function linksDasFotos(caminhos) {
  if (!caminhos.length) return [];
  const { data, error } = await supabase.storage.from('fotos').createSignedUrls(caminhos, 600);
  if (error) throw new ErroApi(`Não foi possível abrir as fotos: ${error.message}`);
  return data.map(d => d.signedUrl).filter(Boolean);
}
