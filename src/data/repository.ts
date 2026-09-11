import { initializeDatabase } from './database';
import { reconcileOwnedMedia } from './media';
import { SQLiteRucolaRepository } from './SQLiteRucolaRepository';

let repositoryPromise: Promise<SQLiteRucolaRepository> | null = null;

export function getRepository(): Promise<SQLiteRucolaRepository> {
  if (!repositoryPromise) {
    repositoryPromise = initializeDatabase()
      .then(async (db) => {
        const repository = new SQLiteRucolaRepository(db);
        const messages = await repository.getMessages();
        await reconcileOwnedMedia(messages.flatMap((message) => message.mediaReference ? [message.mediaReference] : []));
        return repository;
      })
      .catch((cause) => {
        repositoryPromise = null;
        throw cause;
      });
  }
  return repositoryPromise;
}
