import * as FileSystem from 'expo-file-system/legacy';
import { deleteOwnedMedia, persistPickedMedia, reconcileOwnedMedia } from './media';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

export async function runMediaRobustnessIntegrationTests(): Promise<void> {
  const documentDirectory = FileSystem.documentDirectory;
  assert(documentDirectory, 'Document storage should be available for media robustness tests');

  const mediaDirectory = `${documentDirectory}media/`;
  const source = `${documentDirectory}rucola-media-robustness-${Date.now()}.txt`;
  const created: string[] = [];
  let emptyDirectory: string | null = null;

  const persist = async (asset: Record<string, unknown>): Promise<string> => {
    const uri = await persistPickedMedia(asset as Parameters<typeof persistPickedMedia>[0]);
    created.push(uri);
    return uri;
  };

  try {
    await FileSystem.writeAsStringAsync(source, 'media robustness test');

    await assertRejects(
      () => persistPickedMedia({ uri: `${documentDirectory}does-not-exist-${Date.now()}.bin`, type: 'image' } as Parameters<typeof persistPickedMedia>[0]),
      'Missing source media should reject',
    );

    const mimeWins = await persist({
      uri: source,
      fileName: 'misleading.jpg',
      mimeType: 'image/png',
      type: 'image',
    });
    assert(mimeWins.endsWith('.png'), 'MIME type should win over a misleading filename extension');

    const mimeOnly = await persist({
      uri: source,
      mimeType: 'image/webp',
      type: 'image',
    });
    assert(mimeOnly.endsWith('.webp'), 'MIME type should determine extension when filename is absent');

    const videoTypeOnly = await persist({
      uri: source,
      type: 'video',
    });
    assert(videoTypeOnly.endsWith('.mp4'), 'Video type should fall back to mp4 when metadata is incomplete');

    const firstUnique = await persist({ uri: source, type: 'image' });
    const secondUnique = await persist({ uri: source, type: 'image' });
    assert(firstUnique !== secondUnique, 'Persisted media filenames must be unique');
    assert(firstUnique.startsWith(mediaDirectory), 'Generated media URI must stay inside the owned directory');
    assert(secondUnique.startsWith(mediaDirectory), 'Generated media URI must stay inside the owned directory');

    const orphanA = `${mediaDirectory}rucola-orphan-a-${Date.now()}.jpg`;
    const orphanB = `${mediaDirectory}rucola-orphan-b-${Date.now()}.jpg`;
    await FileSystem.makeDirectoryAsync(mediaDirectory, { intermediates: true });
    await FileSystem.writeAsStringAsync(orphanA, 'orphan a');
    await FileSystem.writeAsStringAsync(orphanB, 'orphan b');
    created.push(orphanA, orphanB);

    emptyDirectory = `${mediaDirectory}rucola-empty-${Date.now()}/`;
    await FileSystem.makeDirectoryAsync(emptyDirectory, { intermediates: true });
    await reconcileOwnedMedia([mimeWins, mimeOnly, videoTypeOnly, firstUnique, secondUnique]);

    for (const uri of [mimeWins, mimeOnly, videoTypeOnly, firstUnique, secondUnique]) {
      assert(await FileSystem.getInfoAsync(uri).then((info) => info.exists), 'Referenced media must survive reconciliation');
    }
    assert(!(await FileSystem.getInfoAsync(orphanA)).exists, 'First orphan should be removed');
    assert(!(await FileSystem.getInfoAsync(orphanB)).exists, 'Second orphan should be removed');
    assert(await FileSystem.getInfoAsync(emptyDirectory).then((info) => info.exists && info.isDirectory), 'Unexpected directories must not be deleted during reconciliation');

    await deleteOwnedMedia(`${mediaDirectory}missing-${Date.now()}.jpg`);
    await deleteOwnedMedia(`${mediaDirectory}../outside.jpg`);
    await deleteOwnedMedia(`${mediaDirectory}..\\outside.jpg`);
    assert(await FileSystem.getInfoAsync(emptyDirectory).then((info) => info.exists), 'Traversal attempts must not remove owned directories');

    await deleteOwnedMedia(emptyDirectory);
    assert(await FileSystem.getInfoAsync(emptyDirectory).then((info) => info.exists), 'Owned directories must not be deleted as media files');

    await reconcileOwnedMedia([]);
    for (const uri of [mimeWins, mimeOnly, videoTypeOnly, firstUnique, secondUnique]) {
      assert(!(await FileSystem.getInfoAsync(uri)).exists, 'Unreferenced media should be removed by reconciliation');
    }
  } finally {
    for (const uri of created) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    }
    if (emptyDirectory) {
      await FileSystem.deleteAsync(emptyDirectory, { idempotent: true }).catch(() => undefined);
    }
    await FileSystem.deleteAsync(source, { idempotent: true }).catch(() => undefined);
  }
}
