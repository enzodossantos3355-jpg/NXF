import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { isValidId } from './permissions.ts';

export const MAX_IMAGE_BINARY_BYTES = 450 * 1024; // 450 KB raw (~600 KB base64, safe inside Firestore 1 MiB limit)
export const MAX_MEDIA_BLOB_DOCS = 1500; // ~675 MB worst-case cap inside Firestore Spark 1 GiB limit

const MEMORY_CACHE_MAX_ITEMS = 64;
const MEMORY_CACHE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB bounded LRU cache for Render Starter RAM
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface CachedMediaEntry {
  mimeType: string;
  buffer: Buffer;
}

const mediaMemoryCache = new Map<string, CachedMediaEntry>();
let mediaCacheTotalBytes = 0;

function cacheSet(id: string, entry: CachedMediaEntry): void {
  if (entry.buffer.length > 1024 * 1024) return;

  const existing = mediaMemoryCache.get(id);
  if (existing) {
    mediaCacheTotalBytes -= existing.buffer.length;
    mediaMemoryCache.delete(id);
  }

  while (
    mediaMemoryCache.size >= MEMORY_CACHE_MAX_ITEMS ||
    mediaCacheTotalBytes + entry.buffer.length > MEMORY_CACHE_MAX_BYTES
  ) {
    const oldestKey = mediaMemoryCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = mediaMemoryCache.get(oldestKey);
    if (oldest) mediaCacheTotalBytes -= oldest.buffer.length;
    mediaMemoryCache.delete(oldestKey);
  }

  mediaMemoryCache.set(id, entry);
  mediaCacheTotalBytes += entry.buffer.length;
}

function cacheGet(id: string): CachedMediaEntry | null {
  const found = mediaMemoryCache.get(id);
  if (!found) return null;
  // Refresh LRU recency
  mediaMemoryCache.delete(id);
  mediaMemoryCache.set(id, found);
  return found;
}

function cacheDelete(id: string): void {
  const existing = mediaMemoryCache.get(id);
  if (existing) {
    mediaCacheTotalBytes -= existing.buffer.length;
    mediaMemoryCache.delete(id);
  }
}

export function clearMediaCache(): void {
  mediaMemoryCache.clear();
  mediaCacheTotalBytes = 0;
}

export interface ParsedImageUpload {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  buffer: Buffer;
  base64Data: string;
}

export function extractMediaIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const match = /\/api\/media\/([a-zA-Z0-9_-]{3,128})(?:[?#].*)?$/.exec(url.trim());
  return match && isValidId(match[1]) ? match[1] : null;
}

export function detectImageMimeFromMagicBytes(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: RIFF....WEBP
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

export function parseAndValidateImageDataUrl(dataUrl: unknown): ParsedImageUpload {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('Formato de imagem inválido. Envie JPG, PNG ou WebP.');
  }

  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    throw new Error('Payload de imagem malformado.');
  }

  const header = dataUrl.slice(0, commaIdx);
  const base64Part = dataUrl.slice(commaIdx + 1).trim();
  const mimeMatch = /^data:(image\/(?:jpeg|png|webp));base64$/i.exec(header);
  if (!mimeMatch || !ALLOWED_MIME_TYPES.has(mimeMatch[1].toLowerCase())) {
    throw new Error('Tipo de mídia não permitido. Utilize apenas JPG, PNG ou WebP.');
  }

  const buffer = Buffer.from(base64Part, 'base64');
  if (buffer.length === 0) {
    throw new Error('Arquivo de imagem vazio.');
  }
  if (buffer.length > MAX_IMAGE_BINARY_BYTES) {
    throw new Error(
      `A imagem excede o limite de ${Math.round(MAX_IMAGE_BINARY_BYTES / 1024)} KB após compressão.`
    );
  }

  const detectedMime = detectImageMimeFromMagicBytes(buffer);
  if (!detectedMime || detectedMime !== mimeMatch[1].toLowerCase()) {
    throw new Error('Conteúdo binário não corresponde a uma imagem JPG, PNG ou WebP válida.');
  }

  return {
    mimeType: detectedMime,
    buffer,
    base64Data: buffer.toString('base64'),
  };
}

export async function saveMediaBlob(
  db: Firestore,
  params: {
    scope: 'profile' | 'cms';
    folder: string;
    fileName: string;
    uploadedBy: string;
    parsed: ParsedImageUpload;
  }
): Promise<{ id: string; storagePath: string; sizeBytes: number; mimeType: string }> {
  const uploadDir = process.env.UPLOAD_DIR?.trim();

  // Safety quota check for Firestore Spark storage sustainability (skipped when external persistent disk is used)
  if (!uploadDir) {
    const existingCountSnap = await db.collection('mediaBlobs').select('sizeBytes').limit(MAX_MEDIA_BLOB_DOCS + 1).get();
    if (existingCountSnap.size >= MAX_MEDIA_BLOB_DOCS) {
      throw new Error(
        `Limite de segurança de ${MAX_MEDIA_BLOB_DOCS} mídias em Firestore atingido para proteger a cota gratuita Spark. Remova mídias antigas antes de enviar novas.`
      );
    }
  }

  const id = `m_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const cleanFolder = params.folder.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'geral';
  const cleanFileName = params.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'imagem';

  if (uploadDir) {
    const targetDir = path.resolve(uploadDir, params.scope, cleanFolder);
    await fs.mkdir(targetDir, { recursive: true });
    const ext = params.parsed.mimeType === 'image/png' ? 'png' : params.parsed.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const diskPath = path.join(targetDir, `${id}.${ext}`);
    await fs.writeFile(diskPath, params.parsed.buffer);

    await db.doc(`mediaBlobs/${id}`).set({
      id,
      scope: params.scope,
      folder: cleanFolder,
      fileName: cleanFileName,
      mimeType: params.parsed.mimeType,
      sizeBytes: params.parsed.buffer.length,
      diskFilePath: diskPath,
      uploadedBy: params.uploadedBy,
      createdAt: FieldValue.serverTimestamp(),
    });

    cacheSet(id, { mimeType: params.parsed.mimeType, buffer: params.parsed.buffer });
    return {
      id,
      storagePath: `disk://${params.scope}/${cleanFolder}/${id}.${ext}`,
      sizeBytes: params.parsed.buffer.length,
      mimeType: params.parsed.mimeType,
    };
  }

  await db.doc(`mediaBlobs/${id}`).set({
    id,
    scope: params.scope,
    folder: cleanFolder,
    fileName: cleanFileName,
    mimeType: params.parsed.mimeType,
    sizeBytes: params.parsed.buffer.length,
    base64Data: params.parsed.base64Data,
    uploadedBy: params.uploadedBy,
    createdAt: FieldValue.serverTimestamp(),
  });

  cacheSet(id, { mimeType: params.parsed.mimeType, buffer: params.parsed.buffer });
  return {
    id,
    storagePath: `firestore://mediaBlobs/${id}`,
    sizeBytes: params.parsed.buffer.length,
    mimeType: params.parsed.mimeType,
  };
}

export async function loadMediaBlob(
  db: Firestore,
  id: string
): Promise<{ mimeType: string; buffer: Buffer } | null> {
  if (!isValidId(id)) return null;

  const cached = cacheGet(id);
  if (cached) return cached;

  const snap = await db.doc(`mediaBlobs/${id}`).get();
  if (!snap.exists) return null;

  const data = snap.data() || {};
  const mimeType = String(data.mimeType || '');
  if (!ALLOWED_MIME_TYPES.has(mimeType)) return null;

  if (typeof data.diskFilePath === 'string' && data.diskFilePath) {
    try {
      const buffer = await fs.readFile(data.diskFilePath);
      const entry = { mimeType, buffer };
      cacheSet(id, entry);
      return entry;
    } catch {
      return null;
    }
  }

  if (typeof data.base64Data === 'string' && data.base64Data) {
    const entry = {
      mimeType,
      buffer: Buffer.from(data.base64Data, 'base64'),
    };
    cacheSet(id, entry);
    return entry;
  }

  return null;
}

export async function deleteMediaBlobIfAuthorized(
  db: Firestore,
  mediaId: string,
  requester: { uid: string; allowAny?: boolean }
): Promise<{ ok: boolean; status: 200 | 400 | 403 | 404 }> {
  if (!isValidId(mediaId)) return { ok: false, status: 400 };
  const ref = db.doc(`mediaBlobs/${mediaId}`);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, status: 404 };

  const data = snap.data() || {};
  if (!requester.allowAny && data.uploadedBy !== requester.uid) {
    return { ok: false, status: 403 };
  }

  if (typeof data.diskFilePath === 'string' && data.diskFilePath) {
    await fs.unlink(data.diskFilePath).catch(() => {});
  }
  await ref.delete();
  cacheDelete(mediaId);
  return { ok: true, status: 200 };
}
