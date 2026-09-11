import { initializeDatabase } from './database';
import { SQLiteRucolaRepository } from './SQLiteRucolaRepository';

let repositoryPromise: Promise<SQLiteRucolaRepository> | null = null;

export function getRepository(): Promise<SQLiteRucolaRepository> {
  if (!repositoryPromise) {
    repositoryPromise = initializeDatabase()
      .then((db) => new SQLiteRucolaRepository(db))
      .catch((cause) => {
        repositoryPromise = null;
        throw cause;
      });
  }
  return repositoryPromise;
}
