import * as ImagePicker from 'expo-image-picker';

import type { RucolaRepository } from '../domain/repository';
import { SendMessage } from '../domain/useCases';
import { deleteOwnedMedia, persistPickedMedia } from './media';

export async function recoverPendingPickerResult(repository: RucolaRepository): Promise<boolean> {
  const result = await ImagePicker.getPendingResultAsync();

  if (!result || !('canceled' in result)) {
    if (result) {
      throw new Error(result.message || 'The pending media picker request failed.');
    }
    return false;
  }

  if (result.canceled || !result.assets[0]) return false;

  const mediaReference = await persistPickedMedia(result.assets[0]);

  try {
    await new SendMessage(repository).execute({
      type: 'PHOTO_VIDEO',
      body: '',
      mediaReference,
    });
  } catch (cause) {
    await deleteOwnedMedia(mediaReference);
    throw cause;
  }

  return true;
}
