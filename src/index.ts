import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { hashPassword, inviteCode, randomToken, verifyPassword } from "./auth";
import { ensureSchema, visibleBoard, visibleItem, VISIBLE_BOARD, type Board, type Item } from "./db";
import { downloadImage, extractUrl, fetchPreview, friendlySite, MAX_IMAGE_BYTES } from "./preview";

type Env = { DB: D1Database; ASSETS: Fetcher };
type User = { id: number; name: string; email: string; save_token: string };
type App = { Bindings: Env; Variables: { user: User } };
type Ctx = Context<App>;

const SESSION_COOKIE = "stash_session";
const SESSION_DAYS = 365;

const app = new Hono<App>();

app.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

function bad(c: Ctx, message: string, status: 400 | 401 | 403 | 404 = 400) {
  return c.json({ error: message }, status);
}

// ---------- Accounts ----------

async function startSession(c: Ctx, userId: number) {
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  await c.env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, expires)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

const DEFAULT_SHARED_BOARDS: [string, string][] = [
  ["Shopping", "🛍️"],
  ["Recipes", "🍳"],
  ["Travel", "✈️"],
  ["Home", "🏡"],
];

app.post("/api/register", async (c) => {
  const body = await c.req.json<{ name?: string; email?: string; password?: string; invite?: string }>();
  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password || "";
  if (!name || !email || !email.includes("@")) return bad(c, "Please enter your name and email.");
  if (password.length < 8) return bad(c, "Password needs at least 8 characters.");

  const db = c.env.DB;
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n;
  // The very first person can sign up freely; everyone after needs their invite code.
  if (count > 0) {
    const code = await db.prepare("SELECT value FROM settings WHERE key = 'invite_code'").first<{ value: string }>();
    if (!code || (body.invite || "").trim().toUpperCase() !== code.value) {
      return bad(c, "That invite code doesn't match. Ask for the code shown in Settings.");
    }
  }
  if (await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first()) {
    return bad(c, "There's already an account with that email.");
  }

  const now = Date.now();
  const user = (await db
    .prepare("INSERT INTO users (name, email, pw_hash, save_token, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(name, email, await hashPassword(password), randomToken(), now)
    .first<{ id: number }>())!;

  const setup = [db.prepare("INSERT INTO boards (owner_id, name, emoji, shared, created_at) VALUES (?, 'Just me', '🔒', 0, ?)").bind(user.id, now)];
  if (count === 0) {
    setup.push(db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('invite_code', ?)").bind(inviteCode()));
    DEFAULT_SHARED_BOARDS.forEach(([n, e], i) =>
      setup.push(
        db.prepare("INSERT INTO boards (owner_id, name, emoji, shared, created_at) VALUES (?, ?, ?, 1, ?)").bind(user.id, n, e, now + i + 1),
      ),
    );
  }
  await db.batch(setup);
  await startSession(c, user.id);
  return c.json({ ok: true });
});

app.post("/api/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase() || "";
  const row = await c.env.DB.prepare("SELECT id, pw_hash FROM users WHERE email = ?").bind(email).first<{ id: number; pw_hash: string }>();
  if (!row || !(await verifyPassword(body.password || "", row.pw_hash))) {
    return bad(c, "Email or password is incorrect.", 401);
  }
  await startSession(c, row.id);
  return c.json({ ok: true });
});

app.post("/api/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// Everything below /api (except the routes above) requires being logged in.
app.use("/api/*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token
    ? await c.env.DB.prepare(
        `SELECT u.id, u.name, u.email, u.save_token FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
        .bind(token, Date.now())
        .first<User>()
    : null;
  if (!user) return bad(c, "Please log in.", 401);
  c.set("user", user);
  await next();
});

function saveLink(c: Ctx, user: User) {
  return `${new URL(c.req.url).origin}/s/${user.save_token}`;
}

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const code = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'invite_code'").first<{ value: string }>();
  const people = await c.env.DB.prepare("SELECT id, name FROM users ORDER BY id").all<{ id: number; name: string }>();
  return c.json({
    user: { id: user.id, name: user.name, email: user.email },
    save_link: saveLink(c, user),
    invite_code: code?.value ?? null,
    people: people.results,
  });
});

app.post("/api/me/new-save-link", async (c) => {
  const user = c.get("user");
  user.save_token = randomToken();
  await c.env.DB.prepare("UPDATE users SET save_token = ? WHERE id = ?").bind(user.save_token, user.id).run();
  return c.json({ save_link: saveLink(c, user) });
});

// ---------- Boards ----------

app.get("/api/boards", async (c) => {
  const me = c.get("user").id;
  const rows = await c.env.DB.prepare(
    `SELECT b.*, u.name AS owner_name,
       (SELECT COUNT(*) FROM items i WHERE i.board_id = b.id) AS item_count,
       (SELECT i.id FROM items i WHERE i.board_id = b.id AND i.has_image = 1 ORDER BY i.created_at DESC LIMIT 1) AS cover_item
     FROM boards b JOIN users u ON u.id = b.owner_id
     WHERE ${VISIBLE_BOARD}
     ORDER BY b.shared DESC, b.created_at`,
  )
    .bind(me)
    .all();
  return c.json({ boards: rows.results });
});

function cleanEmoji(e: unknown) {
  const s = typeof e === "string" ? e.trim() : "";
  return s ? [...s].slice(0, 4).join("") : "📌";
}

app.post("/api/boards", async (c) => {
  const me = c.get("user").id;
  const body = await c.req.json<{ name?: string; emoji?: string; shared?: boolean }>();
  const name = body.name?.trim().slice(0, 60);
  if (!name) return bad(c, "Give the board a name.");
  const board = await c.env.DB.prepare(
    "INSERT INTO boards (owner_id, name, emoji, shared, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
  )
    .bind(me, name, cleanEmoji(body.emoji), body.shared ? 1 : 0, Date.now())
    .first<Board>();
  return c.json({ board });
});

app.patch("/api/boards/:id", async (c) => {
  const me = c.get("user").id;
  const board = await visibleBoard(c.env.DB, me, Number(c.req.param("id")));
  if (!board) return bad(c, "Board not found.", 404);
  if (board.owner_id !== me) return bad(c, "Only the person who made this board can change it.", 403);
  const body = await c.req.json<{ name?: string; emoji?: string; shared?: boolean }>();
  const name = body.name?.trim().slice(0, 60) || board.name;
  const emoji = body.emoji !== undefined ? cleanEmoji(body.emoji) : board.emoji;
  const shared = body.shared !== undefined ? (body.shared ? 1 : 0) : board.shared;
  await c.env.DB.prepare("UPDATE boards SET name = ?, emoji = ?, shared = ? WHERE id = ?").bind(name, emoji, shared, board.id).run();
  return c.json({ ok: true });
});

app.delete("/api/boards/:id", async (c) => {
  const me = c.get("user").id;
  const db = c.env.DB;
  const board = await visibleBoard(db, me, Number(c.req.param("id")));
  if (!board) return bad(c, "Board not found.", 404);
  if (board.owner_id !== me) return bad(c, "Only the person who made this board can delete it.", 403);
  await db.batch([
    db.prepare("DELETE FROM images WHERE item_id IN (SELECT id FROM items WHERE board_id = ?)").bind(board.id),
    db.prepare("DELETE FROM items WHERE board_id = ?").bind(board.id),
    db.prepare("DELETE FROM boards WHERE id = ?").bind(board.id),
  ]);
  return c.json({ ok: true });
});

// ---------- Items ----------

function itemJson(i: Item & { added_by?: string }) {
  return {
    ...i,
    image: i.has_image ? `/api/items/${i.id}/image?v=${i.has_image}` : null,
  };
}

app.get("/api/items", async (c) => {
  const me = c.get("user").id;
  const board = c.req.query("board");
  const q = c.req.query("q")?.trim();
  let sql = `SELECT i.*, u.name AS added_by FROM items i
             JOIN boards b ON b.id = i.board_id JOIN users u ON u.id = i.user_id
             WHERE ${VISIBLE_BOARD}`;
  const args: (string | number)[] = [me];
  if (board) {
    sql += " AND i.board_id = ?";
    args.push(Number(board));
  }
  if (q) {
    sql += " AND (i.title LIKE ? OR i.note LIKE ? OR i.site LIKE ? OR i.description LIKE ? OR i.url LIKE ?)";
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  sql += " ORDER BY i.created_at DESC LIMIT 500";
  const rows = await c.env.DB.prepare(sql).bind(...args).all<Item & { added_by: string }>();
  return c.json({ items: rows.results.map(itemJson) });
});

// Saves a link (or plain text) to a board and fills in the preview in the background.
async function createItem(c: Ctx, userId: number, boardId: number, input: string, note?: string) {
  const url = extractUrl(input);
  const text = url ? input.replace(url, "").trim() : input.trim();
  const noteText = note?.trim() || null;
  const item = (await c.env.DB.prepare(
    `INSERT INTO items (board_id, user_id, url, title, site, note, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(
      boardId,
      userId,
      url,
      url ? null : text.slice(0, 200) || "Note",
      url ? friendlySite(url) : null,
      noteText,
      url ? "pending" : "ready",
      Date.now(),
    )
    .first<Item>())!;
  if (url) c.executionCtx.waitUntil(fillPreview(c.env.DB, item.id, url));
  return item;
}

async function fillPreview(db: D1Database, itemId: number, url: string) {
  try {
    const p = await fetchPreview(url);
    await db
      .prepare(
        `UPDATE items SET title = COALESCE(?, title), description = ?, site = COALESCE(?, site),
           price = ?, image_url = ? WHERE id = ?`,
      )
      .bind(p.title ?? null, p.description ?? null, p.site ?? null, p.price ?? null, p.image ?? null, itemId)
      .run();
    if (p.image) {
      const img = await downloadImage(p.image).catch(() => null);
      if (img) await storeImage(db, itemId, img.type, img.data);
    }
  } catch (err) {
    console.error("preview failed", url, err);
  }
  await db.prepare("UPDATE items SET status = 'ready' WHERE id = ?").bind(itemId).run();
}

async function storeImage(db: D1Database, itemId: number, type: string, data: ArrayBuffer) {
  // has_image doubles as a version number so phones fetch the new picture.
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO images (item_id, content_type, data) VALUES (?, ?, ?)").bind(itemId, type, data),
    db.prepare("UPDATE items SET has_image = has_image + 1 WHERE id = ?").bind(itemId),
  ]);
}

app.post("/api/items", async (c) => {
  const me = c.get("user").id;
  const body = await c.req.json<{ input?: string; board_id?: number; note?: string }>();
  if (!body.input?.trim()) return bad(c, "Paste a link or type something to save.");
  const board = await visibleBoard(c.env.DB, me, Number(body.board_id));
  if (!board) return bad(c, "Pick a board.");
  const item = await createItem(c, me, board.id, body.input, body.note);
  return c.json({ item: itemJson(item) });
});

app.patch("/api/items/:id", async (c) => {
  const me = c.get("user").id;
  const db = c.env.DB;
  const item = await visibleItem(db, me, Number(c.req.param("id")));
  if (!item) return bad(c, "Item not found.", 404);
  const body = await c.req.json<{ title?: string; note?: string; done?: boolean; board_id?: number }>();
  let boardId = item.board_id;
  if (body.board_id !== undefined) {
    const target = await visibleBoard(db, me, Number(body.board_id));
    if (!target) return bad(c, "Board not found.", 404);
    boardId = target.id;
  }
  await db
    .prepare("UPDATE items SET title = ?, note = ?, done = ?, board_id = ? WHERE id = ?")
    .bind(
      body.title !== undefined ? body.title.trim().slice(0, 200) || item.title : item.title,
      body.note !== undefined ? body.note.trim() || null : item.note,
      body.done !== undefined ? (body.done ? 1 : 0) : item.done,
      boardId,
      item.id,
    )
    .run();
  return c.json({ ok: true });
});

app.delete("/api/items/:id", async (c) => {
  const db = c.env.DB;
  const item = await visibleItem(db, c.get("user").id, Number(c.req.param("id")));
  if (!item) return bad(c, "Item not found.", 404);
  await db.batch([
    db.prepare("DELETE FROM images WHERE item_id = ?").bind(item.id),
    db.prepare("DELETE FROM items WHERE id = ?").bind(item.id),
  ]);
  return c.json({ ok: true });
});

app.post("/api/items/:id/refresh", async (c) => {
  const db = c.env.DB;
  const item = await visibleItem(db, c.get("user").id, Number(c.req.param("id")));
  if (!item?.url) return bad(c, "Item not found.", 404);
  await db.prepare("UPDATE items SET status = 'pending' WHERE id = ?").bind(item.id).run();
  c.executionCtx.waitUntil(fillPreview(db, item.id, item.url));
  return c.json({ ok: true });
});

// Lets you add your own photo (e.g. a screenshot) when a site hides its picture.
app.put("/api/items/:id/image", async (c) => {
  const db = c.env.DB;
  const item = await visibleItem(db, c.get("user").id, Number(c.req.param("id")));
  if (!item) return bad(c, "Item not found.", 404);
  const type = (c.req.header("content-type") || "").split(";")[0];
  if (!type.startsWith("image/")) return bad(c, "That file isn't a picture.");
  const data = await c.req.arrayBuffer();
  if (data.byteLength > MAX_IMAGE_BYTES) return bad(c, "That picture is too big.");
  await storeImage(db, item.id, type, data);
  return c.json({ ok: true });
});

app.get("/api/items/:id/image", async (c) => {
  const db = c.env.DB;
  const item = await visibleItem(db, c.get("user").id, Number(c.req.param("id")));
  if (!item) return c.notFound();
  const img = await db.prepare("SELECT content_type, data FROM images WHERE item_id = ?").bind(item.id).first<{ content_type: string; data: ArrayBuffer }>();
  if (!img) return c.notFound();
  return new Response(new Uint8Array(img.data), {
    headers: { "content-type": img.content_type, "cache-control": "private, max-age=31536000, immutable" },
  });
});

// ---------- iPhone Shortcut ----------
// The Shortcut uses a personal secret link instead of a login:
//   GET  /s/<token>/boards  -> list of board names to choose from
//   POST /s/<token>/save    -> { "input": <shared link or text>, "board": <chosen name> }

async function tokenUser(c: Ctx) {
  return c.env.DB.prepare("SELECT id, name, email, save_token FROM users WHERE save_token = ?")
    .bind(c.req.param("token"))
    .first<User>();
}

function boardLabel(b: Board) {
  return `${b.emoji} ${b.name}${b.shared ? "" : " (just me)"}`;
}

async function boardsFor(db: D1Database, userId: number) {
  const rows = await db.prepare(`SELECT b.* FROM boards b WHERE ${VISIBLE_BOARD} ORDER BY b.shared DESC, b.created_at`).bind(userId).all<Board>();
  return rows.results;
}

app.get("/s/:token/boards", async (c) => {
  const user = await tokenUser(c);
  if (!user) return c.text("This save link is out of date. Copy a fresh one from Stash → Settings.", 404);
  return c.json((await boardsFor(c.env.DB, user.id)).map(boardLabel));
});

app.post("/s/:token/save", async (c) => {
  const user = await tokenUser(c);
  if (!user) return c.text("This save link is out of date. Copy a fresh one from Stash → Settings.", 404);
  const type = c.req.header("content-type") || "";
  let body: Record<string, unknown> = {};
  if (type.includes("json")) body = await c.req.json();
  else if (type.includes("form")) body = Object.fromEntries((await c.req.formData()).entries());
  const input = String(body.input ?? body.url ?? c.req.query("input") ?? "").trim();
  const chosen = String(body.board ?? c.req.query("board") ?? "").trim();
  if (!input) return c.text("Nothing was shared — try again from the Share button.", 400);

  const boards = await boardsFor(c.env.DB, user.id);
  const board =
    boards.find((b) => boardLabel(b) === chosen) ||
    boards.find((b) => b.name.toLowerCase() === chosen.toLowerCase()) ||
    boards[0];
  if (!board) return c.text("You don't have any boards yet. Open Stash and make one.", 400);
  await createItem(c, user.id, board.id, input, typeof body.note === "string" ? body.note : undefined);
  return c.text(`Saved to ${board.emoji} ${board.name}`);
});

export default app;
