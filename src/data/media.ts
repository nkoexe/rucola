import * as FileSystem from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import type { ImagePickerAsset } from 'expo-image-picker';

const MEDIA_DIRECTORY = 'media/';

function ownedMediaDirectory(): string | null {
  const documentDirectory = FileSystem.documentDirectory;
  return documentDirectory ? `${documentDirectory}${MEDIA_DIRECTORY}` : null;
}

export function isOwnedMediaUri(uri: string): boolean {
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

export async function persistPickedMedia(asset: ImagePickerAsset): Promise<string> {
  if (!asset.uri?.trim()) throw new Error('The selected media has no usable URI.');

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

export async function deleteOwnedMedia(uri: string): Promise<void> {
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
  return /\.(mp4|mov|m4v|webm|avi)$/i.test(uri.split(/[?#]/, 1)[0] ?? uri);
}
