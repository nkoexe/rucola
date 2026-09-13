import type { SQLiteDatabase } from 'expo-sqlite';
import { CREATE_SCHEMA, DATABASE_NAME, DATABASE_VERSION } from './schema';

export async function openRucolaDatabase(): Promise<SQLiteDatabase> {
  const db = await import('expo-sqlite').then(({ openDatabaseAsync }) =>
    openDatabaseAsync(DATABASE_NAME),
  );

  await db.execAsync('PRAGMA foreign_keys = ON;');
  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION};`);

  for (const statement of CREATE_SCHEMA) {
    await db.execAsync(statement);
  }

  return db;
}
