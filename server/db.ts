import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { journalEntries } from '../drizzle/schema.js';
import { eq, desc } from 'drizzle-orm';

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const connection = await mysql.createConnection(process.env.DATABASE_URL);
      _db = drizzle(connection);
    } catch (error) {
      console.warn('[Database] Failed to connect:', error);
      _db = null;
    }
  }
  return _db;
}

export async function getJournalEntries() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(journalEntries).orderBy(desc(journalEntries.pushedAt));
}

export async function createJournalEntry(data: {
  symbol: string;
  displaySymbol: string;
  direction: 'LONG' | 'SHORT';
  quality: 'PREMIUM' | 'STRONG' | 'DEVELOPING';
  pattern: string;
  timeframe: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2?: number;
  tp3?: number;
  rr1?: number;
  rr2?: number;
  rr3?: number;
  confluences?: string[];
  session?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.insert(journalEntries).values({
    symbol: data.symbol,
    displaySymbol: data.displaySymbol,
    direction: data.direction,
    quality: data.quality,
    pattern: data.pattern,
    timeframe: data.timeframe,
    entry: String(data.entry),
    stopLoss: String(data.stopLoss),
    tp1: String(data.tp1),
    tp2: data.tp2 ? String(data.tp2) : null,
    tp3: data.tp3 ? String(data.tp3) : null,
    rr1: data.rr1 ? String(data.rr1) : null,
    rr2: data.rr2 ? String(data.rr2) : null,
    rr3: data.rr3 ? String(data.rr3) : null,
    confluences: data.confluences ? JSON.stringify(data.confluences) : null,
    session: data.session,
    outcome: 'PENDING',
  });
}

export async function updateJournalEntry(id: number, data: {
  outcome?: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'PENDING';
  pnl?: number;
  notes?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.update(journalEntries).set({
    ...(data.outcome && { outcome: data.outcome }),
    ...(data.pnl !== undefined && { pnl: String(data.pnl) }),
    ...(data.notes !== undefined && { notes: data.notes }),
  }).where(eq(journalEntries.id, id));
}

export async function deleteJournalEntry(id: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.delete(journalEntries).where(eq(journalEntries.id, id));
}
