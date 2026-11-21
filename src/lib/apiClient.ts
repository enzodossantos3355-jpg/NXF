import { auth } from './firebase';

const RAW_API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '';

function normalizeApiBaseUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, '');
  if (!cleaned) return '';
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(cleaned);
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    cleaned.startsWith('http://') &&
    !isLocal
  ) {
    return `https://${cleaned.slice('http://'.length)}`;
  }
  return cleaned;
}

export const API_BASE_URL = normalizeApiBaseUrl(RAW_API_BASE);

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${cleanPath}`;
}

export async function apiFetch<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    requireAuth?: boolean;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const user = auth.currentUser;
  if (options.requireAuth !== false) {
    if (!user) {
      throw new Error('Sessão não autenticada para chamar o servidor.');
    }
    const idToken = await user.getIdToken();
    headers.Authorization = `Bearer ${idToken}`;
  } else if (user) {
    const idToken = await user.getIdToken();
    headers.Authorization = `Bearer ${idToken}`;
  }

  const res = await fetch(apiUrl(path), {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  } & T;

  if (!res.ok) {
    throw new Error(payload.error || `Erro HTTP ${res.status} na requisição ao servidor.`);
  }

  return payload;
}

export async function compressImageToDataUrl(
  file: File,
  maxDimension = 1600,
  maxBinaryBytes = 420 * 1024
): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Envie apenas imagens JPG, PNG ou WebP.');
  }

  // Se o arquivo já é pequeno, converte direto para preservar transparência/fidelidade
  if (file.size <= maxBinaryBytes) {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Falha ao ler arquivo de imagem.'));
      reader.readAsDataURL(file);
    });
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Não foi possível decodificar a imagem selecionada.'));
      el.src = objectUrl;
    });

    const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Contexto gráfico indisponível para otimização de imagem.');
    }
    ctx.drawImage(img, 0, 0, width, height);

    const targetMime = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
    let quality = 0.86;
    let dataUrl = canvas.toDataURL(targetMime, quality);

    while (dataUrl.length * 0.75 > maxBinaryBytes && quality > 0.4) {
      quality -= 0.12;
      dataUrl = canvas.toDataURL(targetMime, quality);
    }

    if (dataUrl.length * 0.75 > maxBinaryBytes) {
      throw new Error('A imagem é muito grande mesmo após otimização. Utilize uma imagem menor.');
    }

    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
