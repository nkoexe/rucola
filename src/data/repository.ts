import { initializeDatabase } from './database';
import { SQLiteRucolaRepository } from './SQLiteRucolaRepository';

let repositoryPromise: Promise<SQLiteRucolaRepository> | null = null;

export function getRepository(): Promise<SQLiteRucolaRepository> {
  repositoryPromise ??= initializeDatabase().then((db) => new SQLiteRucolaRepository(db));
  return repositoryPromise;
}
