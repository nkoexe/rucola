import * as FileSystem from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import type { ImagePickerAsset } from 'expo-image-picker';

const MEDIA_DIRECTORY = 'media/';

function extensionForAsset(asset: ImagePickerAsset): string {
  const fileName = asset.fileName?.trim();
  if (fileName) {
    const extension = fileName.split('.').pop()?.toLowerCase();
    if (extension && /^[a-z0-9]+$/.test(extension)) return extension;
  }

  const mimeType = asset.mimeType?.toLowerCase();
  if (mimeType?.includes('png')) return 'png';
  if (mimeType?.includes('webp')) return 'webp';
  if (mimeType?.includes('heic')) return 'heic';
  if (mimeType?.includes('quicktime')) return 'mov';
  if (mimeType?.includes('mp4')) return 'mp4';
  if (asset.type === 'video') return 'mp4';
  return 'jpg';
}

export async function persistPickedMedia(asset: ImagePickerAsset): Promise<string> {
  const documentDirectory = FileSystem.documentDirectory;
  if (!documentDirectory) throw new Error('Local document storage is unavailable.');

  await FileSystem.makeDirectoryAsync(`${documentDirectory}${MEDIA_DIRECTORY}`, { intermediates: true });

  const extension = extensionForAsset(asset);
  const destination = `${documentDirectory}${MEDIA_DIRECTORY}${randomUUID()}.${extension}`;
  await FileSystem.copyAsync({ from: asset.uri, to: destination });
  return destination;
}

export function isVideoMedia(uri: string): boolean {
  return /\.(mp4|mov|m4v|webm|avi)$/i.test(uri.split('?')[0] ?? uri);
}
