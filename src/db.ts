// Database schema. Tables are created on first use, so a fresh deploy needs no
// separate migration step.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL,
    save_token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '📌',
    shared INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    url TEXT,
    title TEXT,
    description TEXT,
    site TEXT,
    price TEXT,
    image_url TEXT,
    has_image INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS images (
    item_id INTEGER PRIMARY KEY,
    content_type TEXT NOT NULL,
    data BLOB NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS items_board ON items(board_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
];

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = db
      .batch(SCHEMA.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

export type Board = {
  id: number;
  owner_id: number;
  name: string;
  emoji: string;
  shared: number;
  created_at: number;
};

export type Item = {
  id: number;
  board_id: number;
  user_id: number;
  url: string | null;
  title: string | null;
  description: string | null;
  site: string | null;
  price: string | null;
  image_url: string | null;
  has_image: number;
  note: string | null;
  done: number;
  status: string;
  created_at: number;
};

// A board is visible to its owner, and to everyone if it is shared.
export const VISIBLE_BOARD = `(b.shared = 1 OR b.owner_id = ?)`;

export async function visibleBoard(db: D1Database, userId: number, boardId: number) {
  return db
    .prepare(`SELECT b.* FROM boards b WHERE b.id = ? AND ${VISIBLE_BOARD}`)
    .bind(boardId, userId)
    .first<Board>();
}

export async function visibleItem(db: D1Database, userId: number, itemId: number) {
  return db
    .prepare(
      `SELECT i.* FROM items i JOIN boards b ON b.id = i.board_id
       WHERE i.id = ? AND ${VISIBLE_BOARD}`,
    )
    .bind(itemId, userId)
    .first<Item>();
}
