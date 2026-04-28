import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { journalEntries } from '../drizzle/schema.js';
import { eq, desc } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: mysql.Pool | null = null;

type SettingsRecord = Record<string, string>;
type SettingsStorageInfo = {
  backend: 'mysql' | 'file' | 'unavailable';
  durable: boolean;
  detail: string;
  path?: string;
};

function getDatabaseUrl(): { url: string; source: string } | null {
  const url =
    process.env.DATABASE_URL ||
    process.env.MYSQL_URL ||
    process.env.MYSQL_PRIVATE_URL ||
    process.env.MYSQL_PUBLIC_URL;

  if (url) {
    return {
      url,
      source: process.env.DATABASE_URL ? 'DATABASE_URL' :
        process.env.MYSQL_URL ? 'MYSQL_URL' :
        process.env.MYSQL_PRIVATE_URL ? 'MYSQL_PRIVATE_URL' : 'MYSQL_PUBLIC_URL',
    };
  }

  const { MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE } = process.env;
  if (MYSQLHOST && MYSQLPORT && MYSQLUSER && MYSQLPASSWORD && MYSQLDATABASE) {
    return {
      url: `mysql://${encodeURIComponent(MYSQLUSER)}:${encodeURIComponent(MYSQLPASSWORD)}@${MYSQLHOST}:${MYSQLPORT}/${MYSQLDATABASE}`,
      source: 'MYSQLHOST/MYSQLPORT/MYSQLUSER/MYSQLPASSWORD/MYSQLDATABASE',
    };
  }

  return null;
}

function isRailwayRuntime() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
}

function getSettingsFilePath(): { filePath: string; durable: boolean; detail: string } | null {
  const configuredPath = process.env.SETTINGS_FILE || process.env.PRIORITY_PAIRS_STORE;
  if (configuredPath) {
    return { filePath: configuredPath, durable: true, detail: 'configured file path' };
  }

  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return {
      filePath: path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'settings.json'),
      durable: true,
      detail: `Railway volume ${process.env.RAILWAY_VOLUME_NAME || '(unnamed)'}`,
    };
  }

  if (isRailwayRuntime()) {
    return null;
  }

  return { filePath: '/tmp/erica-forex-settings.json', durable: false, detail: 'local development fallback' };
}

export async function getDb() {
  const dbConfig = getDatabaseUrl();
  if (!_db && dbConfig) {
    try {
      _pool = mysql.createPool({
        uri: dbConfig.url,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
      });
      _db = drizzle(_pool);
      await initSchema(_pool);
      console.log(`[Database] Connected using ${dbConfig.source}`);
    } catch (error) {
      console.warn('[Database] Failed to connect:', error);
      _db = null;
      _pool = null;
    }
  }
  return _db;
}


async function initSchema(pool: mysql.Pool) {
  // Key-value store for persistent app settings (e.g. priority pairs)
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      display_symbol VARCHAR(20) NOT NULL,
      direction ENUM('LONG','SHORT') NOT NULL,
      quality ENUM('PREMIUM','STRONG','DEVELOPING') NOT NULL,
      pattern VARCHAR(100) NOT NULL,
      timeframe VARCHAR(10) NOT NULL,
      entry DECIMAL(10,5) NOT NULL,
      stop_loss DECIMAL(10,5) NOT NULL,
      tp1 DECIMAL(10,5) NOT NULL,
      tp2 DECIMAL(10,5),
      tp3 DECIMAL(10,5),
      rr1 DECIMAL(4,1),
      rr2 DECIMAL(4,1),
      rr3 DECIMAL(4,1),
      outcome ENUM('WIN','LOSS','BREAKEVEN','PENDING') DEFAULT 'PENDING',
      pnl DECIMAL(10,2),
      notes TEXT,
      confluences TEXT,
      session VARCHAR(30),
      pushed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  // Ensure BREAKEVEN is in the enum (handles tables created before this value was added)
  await pool.execute(`
    ALTER TABLE journal_entries
    MODIFY COLUMN outcome ENUM('WIN','LOSS','BREAKEVEN','PENDING') DEFAULT 'PENDING'
  `);
  // Add news_risk column if it doesn't exist (IF NOT EXISTS not supported in all MySQL versions)
  const [colRows] = await pool.execute(`
    SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'journal_entries'
      AND COLUMN_NAME = 'news_risk'
  `) as any[];
  if (colRows[0].cnt === 0) {
    await pool.execute(`ALTER TABLE journal_entries ADD COLUMN news_risk BOOLEAN DEFAULT FALSE`);
    console.log('[Database] Added news_risk column');
  }
  // Add trade_type column if it doesn't exist
  const [ttRows] = await pool.execute(`
    SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'journal_entries'
      AND COLUMN_NAME = 'trade_type'
  `) as any[];
  if (ttRows[0].cnt === 0) {
    await pool.execute(`ALTER TABLE journal_entries ADD COLUMN trade_type VARCHAR(10) DEFAULT NULL`);
    console.log('[Database] Added trade_type column');
  }
  console.log('[Database] Schema ready');
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
  newsRisk?: boolean;
  notes?: string;
  tradeType?: string;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const result = await db.insert(journalEntries).values({
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
    newsRisk: data.newsRisk ?? false,
    notes: data.notes ?? null,
    tradeType: data.tradeType ?? null,
    outcome: 'PENDING',
  }).$returningId();
  return result[0].id;
}

export async function updateJournalEntry(id: number, data: {
  outcome?: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'PENDING';
  pnl?: number;
  notes?: string;
  tradeType?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.update(journalEntries).set({
    ...(data.outcome && { outcome: data.outcome }),
    ...(data.pnl !== undefined && { pnl: String(data.pnl) }),
    ...(data.notes !== undefined && { notes: data.notes }),
    ...(data.tradeType !== undefined && { tradeType: data.tradeType }),
  }).where(eq(journalEntries.id, id));
}

export async function deleteJournalEntry(id: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.delete(journalEntries).where(eq(journalEntries.id, id));
}

export async function clearAllJournalEntries() {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.delete(journalEntries);
}

// ── Settings (persistent key-value) ─────────────────────────────────────────

async function readFileSettings(): Promise<SettingsRecord> {
  const file = getSettingsFilePath();
  if (!file) return {};
  try {
    const raw = await fs.readFile(file.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SettingsRecord : {};
  } catch (e: any) {
    if (e?.code !== 'ENOENT') console.warn('[Settings] file read failed:', e);
    return {};
  }
}

async function writeFileSettings(settings: SettingsRecord): Promise<boolean> {
  const file = getSettingsFilePath();
  if (!file) {
    console.warn('[Settings] no durable file backend available: attach a Railway volume or configure MySQL');
    return false;
  }
  try {
    await fs.mkdir(path.dirname(file.filePath), { recursive: true });
    const tmp = `${file.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
    await fs.rename(tmp, file.filePath);
    return true;
  } catch (e) {
    console.warn('[Settings] file write failed:', e);
    return false;
  }
}

export async function getSetting(key: string): Promise<string | null> {
  await getDb(); // ensure pool is initialised
  if (_pool) {
    try {
      const [rows] = await _pool.execute('SELECT value FROM settings WHERE `key` = ?', [key]) as any[];
      return rows.length ? rows[0].value : null;
    } catch (e) {
      console.warn('[Settings] getSetting DB failed, falling back to file:', e);
    }
  }
  const settings = await readFileSettings();
  return settings[key] ?? null;
}

export async function setSetting(key: string, value: string): Promise<boolean> {
  await getDb();
  if (_pool) {
    try {
      await _pool.execute(
        'INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP',
        [key, value]
      );
      return true;
    } catch (e) {
      console.warn('[Settings] setSetting DB failed, falling back to file:', e);
    }
  }
  const settings = await readFileSettings();
  settings[key] = value;
  return writeFileSettings(settings);
}

export async function deleteSetting(key: string): Promise<boolean> {
  await getDb();
  if (_pool) {
    try {
      await _pool.execute('DELETE FROM settings WHERE `key` = ?', [key]);
      return true;
    } catch (e) {
      console.warn('[Settings] deleteSetting DB failed, falling back to file:', e);
    }
  }
  const settings = await readFileSettings();
  delete settings[key];
  return writeFileSettings(settings);
}

export async function getSettingsStorageInfo(): Promise<SettingsStorageInfo> {
  await getDb();
  if (_pool) {
    return { backend: 'mysql', durable: true, detail: 'settings table' };
  }

  const file = getSettingsFilePath();
  if (file) {
    return {
      backend: 'file',
      durable: file.durable,
      detail: file.detail,
      path: file.filePath,
    };
  }

  return {
    backend: 'unavailable',
    durable: false,
    detail: 'No MySQL config and no Railway volume mount path. Set DATABASE_URL/MYSQL_URL or attach a Railway volume.',
  };
}

// Returns win/loss counts keyed by "pattern|||timeframe" for journal-weighted scoring
export async function getPatternStats(): Promise<Record<string, { wins: number; losses: number }>> {
  const db = await getDb();
  if (!db) return {};
  try {
    const entries = await db.select().from(journalEntries);
    const stats: Record<string, { wins: number; losses: number }> = {};
    for (const e of entries) {
      if (e.outcome !== 'WIN' && e.outcome !== 'LOSS') continue;
      const key = `${e.pattern}|||${e.timeframe}`;
      if (!stats[key]) stats[key] = { wins: 0, losses: 0 };
      if (e.outcome === 'WIN') stats[key].wins++;
      else stats[key].losses++;
    }
    return stats;
  } catch (e) {
    console.warn('[Database] getPatternStats failed:', e);
    return {};
  }
}
