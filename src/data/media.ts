import * as FileSystem from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import type { ImagePickerAsset } from 'expo-image-picker';
import { Platform } from 'react-native';

const MEDIA_DIRECTORY = 'media/';
const WEB_MEDIA_PREFIX = 'rucola-web-media:';
const WEB_MEDIA_DATABASE = 'rucola-media-v1';
const WEB_MEDIA_STORE = 'blobs';

type WebMediaRecord = {
  id: string;
  blob: Blob;
};

function ownedMediaDirectory(): string | null {
  const documentDirectory = FileSystem.documentDirectory;
  return documentDirectory ? `${documentDirectory}${MEDIA_DIRECTORY}` : null;
}

function isWebMediaUri(uri: string): boolean {
  return /^rucola-web-media:[A-Za-z0-9-]{36}\\.[a-z0-9]+$/i.test(uri);
}

function webMediaId(uri: string): string | null {
  if (!isWebMediaUri(uri)) return null;
  return uri.slice(WEB_MEDIA_PREFIX.length).split('.', 1)[0] ?? null;
}

function openWebMediaDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('Browser media storage is unavailable.');
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WEB_MEDIA_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WEB_MEDIA_STORE)) {
        request.result.createObjectStore(WEB_MEDIA_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open browser media storage.'));
  });
}

async function putWebMedia(record: WebMediaRecord): Promise<void> {
  const database = await openWebMediaDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(WEB_MEDIA_STORE, 'readwrite');
      transaction.objectStore(WEB_MEDIA_STORE).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not store browser media.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not store browser media.'));
    });
  } finally {
    database.close();
  }
}

async function getWebMedia(id: string): Promise<Blob | null> {
  const database = await openWebMediaDatabase();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const transaction = database.transaction(WEB_MEDIA_STORE, 'readonly');
      const request = transaction.objectStore(WEB_MEDIA_STORE).get(id);
      request.onsuccess = () => {
        const record = request.result as WebMediaRecord | undefined;
        resolve(record?.blob ?? null);
      };
      request.onerror = () => reject(request.error ?? new Error('Could not read browser media.'));
    });
  } finally {
    database.close();
  }
}

async function deleteWebMedia(id: string): Promise<void> {
  const database = await openWebMediaDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(WEB_MEDIA_STORE, 'readwrite');
      transaction.objectStore(WEB_MEDIA_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete browser media.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not delete browser media.'));
    });
  } finally {
    database.close();
  }
}

async function reconcileWebMedia(mediaReferences: readonly string[]): Promise<void> {
  const database = await openWebMediaDatabase();
  try {
    const referenced = new Set(
      mediaReferences
        .map(webMediaId)
        .filter((value): value is string => value !== null),
    );

    const records = await new Promise<WebMediaRecord[]>((resolve, reject) => {
      const transaction = database.transaction(WEB_MEDIA_STORE, 'readonly');
      const request = transaction.objectStore(WEB_MEDIA_STORE).getAll();
      request.onsuccess = () => resolve(request.result as WebMediaRecord[]);
      request.onerror = () => reject(request.error ?? new Error('Could not enumerate browser media.'));
    });

    const orphaned = records.filter((record) => !referenced.has(record.id));
    if (orphaned.length === 0) return;

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(WEB_MEDIA_STORE, 'readwrite');
      const store = transaction.objectStore(WEB_MEDIA_STORE);
      for (const record of orphaned) store.delete(record.id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not reconcile browser media.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not reconcile browser media.'));
    });
  } finally {
    database.close();
  }
}

export function isOwnedMediaUri(uri: string): boolean {
  if (Platform.OS === 'web') return isWebMediaUri(uri);

  const ownedPrefix = ownedMediaDirectory();
  if (!ownedPrefix || !uri.startsWith(ownedPrefix)) return false;

  const relativePath = uri.slice(ownedPrefix.length);
  return Boolean(relativePath)
    && !relativePath.includes('..')
    && !relativePath.includes('/')
    && !relativePath.includes('\\');
}

function extensionForAsset(asset: ImagePickerAsset): string {
  const mimeType = asset.mimeType?.toLowerCase();
  if (mimeType?.includes('png')) return 'png';
  if (mimeType?.includes('webp')) return 'webp';
  if (mimeType?.includes('heic')) return 'heic';
  if (mimeType?.includes('quicktime')) return 'mov';
  if (mimeType?.includes('mp4')) return 'mp4';
  if (mimeType?.startsWith('video/')) return 'mp4';
  if (mimeType?.startsWith('image/')) {
    const imageExtension = mimeType.split('/')[1];
    if (imageExtension && /^[a-z0-9]+$/.test(imageExtension)) return imageExtension;
    return 'jpg';
  }

  if (asset.type === 'video') return 'mp4';

  const fileName = asset.fileName?.trim();
  if (fileName) {
    const extension = fileName.split('.').pop()?.toLowerCase();
    if (extension && /^[a-z0-9]+$/.test(extension)) return extension;
  }

  return 'jpg';
}

async function persistPickedMediaOnWeb(asset: ImagePickerAsset): Promise<string> {
  const file = asset.file;
  if (!file) {
    throw new Error('The browser did not provide the selected media file.');
  }

  const extension = extensionForAsset(asset);
  const id = randomUUID();
  const uri = `${WEB_MEDIA_PREFIX}${id}.${extension}`;
  await putWebMedia({ id, blob: file });
  return uri;
}

export async function persistPickedMedia(asset: ImagePickerAsset): Promise<string> {
  if (!asset.uri?.trim()) throw new Error('The selected media has no usable URI.');
  if (Platform.OS === 'web') return persistPickedMediaOnWeb(asset);

  const directory = ownedMediaDirectory();
  if (!directory) throw new Error('Local document storage is unavailable.');

  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });

  const extension = extensionForAsset(asset);
  const destination = `${directory}${randomUUID()}.${extension}`;
  try {
    await FileSystem.copyAsync({ from: asset.uri, to: destination });
    return destination;
  } catch (cause) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
    throw cause;
  }
}

export async function resolveMediaUri(uri: string): Promise<string | null> {
  if (Platform.OS !== 'web' || !isWebMediaUri(uri)) return uri;

  const id = webMediaId(uri);
  if (!id) return null;

  try {
    const blob = await getWebMedia(id);
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

export async function deleteOwnedMedia(uri: string): Promise<void> {
  if (Platform.OS === 'web') {
    const id = webMediaId(uri);
    if (!id) return;
    try {
      await deleteWebMedia(id);
    } catch {
      // Database reset must not fail because already-missing browser media could not be removed.
    }
    return;
  }

  if (!isOwnedMediaUri(uri)) return;

  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || info.isDirectory) return;
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Database reset must not fail because an already-missing media file could not be removed.
  }
}

/**
 * Removes app-owned media files that are no longer referenced by the database.
 * This closes the unavoidable crash window between copying a picked asset and
 * committing the corresponding SQLite message row.
 */
export async function reconcileOwnedMedia(mediaReferences: readonly string[]): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      await reconcileWebMedia(mediaReferences);
    } catch {
      // Media reconciliation is recovery hygiene, not a reason to block app startup.
    }
    return;
  }

  const directory = ownedMediaDirectory();
  if (!directory) return;

  try {
    const entries = await FileSystem.readDirectoryAsync(directory);
    const referenced = new Set(mediaReferences.filter(isOwnedMediaUri));

    await Promise.all(
      entries.map(async (entry) => {
        const uri = `${directory}${entry}`;
        if (!referenced.has(uri)) await deleteOwnedMedia(uri);
      }),
    );
  } catch {
    // Media reconciliation is recovery hygiene, not a reason to block app startup.
  }
}

export function isVideoMedia(uri: string): boolean {
  return /\\.(mp4|mov|m4v|webm|avi)$/i.test(uri.split(/[?#]/, 1)[0] ?? uri);
}
