"use strict";

// ---------- Tiny helpers ----------

const $app = document.getElementById("app");

// h("div.card", {onclick}, child, child...) builds an element.
function h(tag, props, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else if (k === "html") el.innerHTML = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};
const icon = (name) => h("span", { html: ICONS[name], style: "display:contents" });

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {}, credentials: "same-origin" };
  if (opts.body instanceof Blob) {
    init.body = opts.body;
    init.headers["content-type"] = opts.body.type;
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers["content-type"] = "application/json";
  }
  const res = await fetch(path, init);
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : {};
  if (res.status === 401 && path !== "/api/login") {
    state.me = null;
    render();
    throw new Error(data.error || "Please log in.");
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    prompt("Copy this:", text);
  }
}

const initials = (name) => (name || "?").trim().charAt(0).toUpperCase();

// ---------- State ----------

const state = {
  me: undefined, // undefined = still checking, null = logged out
  boards: [],
  items: [],
  board: localStorage.getItem("stash.board") || "all",
  q: "",
  showSearch: false,
  loaded: false,
};
let pollTimer;

async function loadMe() {
  try {
    state.me = await api("/api/me");
  } catch {
    state.me = null;
  }
}

async function loadBoards() {
  state.boards = (await api("/api/boards")).boards;
  if (state.board !== "all" && !state.boards.some((b) => String(b.id) === state.board)) state.board = "all";
}

async function loadItems() {
  const params = new URLSearchParams();
  if (state.board !== "all") params.set("board", state.board);
  if (state.q) params.set("q", state.q);
  state.items = (await api("/api/items?" + params)).items;
  state.loaded = true;
  // Pictures and titles fill in a few seconds after saving; check back for them.
  clearTimeout(pollTimer);
  if (state.items.some((i) => i.status === "pending")) pollTimer = setTimeout(refresh, 2000);
}

async function refresh() {
  try {
    await Promise.all([loadBoards(), loadItems()]);
    renderMain();
  } catch (e) {
    if (state.me) toast(e.message);
  }
}

function selectBoard(id) {
  state.board = String(id);
  try { localStorage.setItem("stash.board", state.board); } catch {}
  state.loaded = false;
  renderMain();
  refresh();
}

const boardById = (id) => state.boards.find((b) => b.id === Number(id));
const isMine = (b) => b && b.owner_id === state.me.user.id;

// ---------- Rendering ----------

function render() {
  if (state.me === undefined) return;
  if (!state.me) return renderAuth();
  renderMain();
}

function renderAuth(mode = "login") {
  const err = h("div.error");
  const fields = {
    name: h("input", { type: "text", autocomplete: "given-name", placeholder: "First name" }),
    email: h("input", { type: "email", autocomplete: "email", placeholder: "you@example.com", autocapitalize: "off" }),
    password: h("input", { type: "password", autocomplete: mode === "login" ? "current-password" : "new-password", placeholder: "At least 8 characters" }),
    invite: h("input", { type: "text", autocapitalize: "characters", autocomplete: "off", placeholder: "Leave blank if you're the first one" }),
  };
  const submit = h("button.btn.primary.block", { type: "submit" }, mode === "login" ? "Log in" : "Create account");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        err.textContent = "";
        try {
          const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
          await api(mode === "login" ? "/api/login" : "/api/register", { method: "POST", body });
          await loadMe();
          state.loaded = false;
          render();
          refresh();
        } catch (ex) {
          err.textContent = ex.message;
          submit.disabled = false;
        }
      },
    },
    mode === "signup" && h("label.field", {}, h("span", {}, "Your name"), fields.name),
    h("label.field", {}, h("span", {}, "Email"), fields.email),
    h("label.field", {}, h("span", {}, "Password"), fields.password),
    mode === "signup" && h("label.field", {}, h("span", {}, "Invite code"), fields.invite),
    err,
    submit,
  );
  $app.replaceChildren(
    h(
      "div.auth",
      {},
      h(
        "div.auth-card",
        {},
        h("img.logo", { src: "/icon.svg", alt: "" }),
        h("h1", {}, "Stash"),
        h("p.lead", {}, "Everything you find online, saved in one place."),
        form,
        h(
          "div.switch",
          {},
          mode === "login" ? "New here? " : "Already have an account? ",
          h("button", { type: "button", onclick: () => renderAuth(mode === "login" ? "signup" : "login") }, mode === "login" ? "Create an account" : "Log in"),
        ),
      ),
    ),
  );
}

let searchTimer;
function renderMain() {
  const searchInput = h("input", {
    type: "search",
    placeholder: "Search everything",
    value: state.q,
    oninput: (e) => {
      state.q = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refresh, 250);
    },
  });

  const top = h(
    "header.top",
    {},
    h(
      "div.top-row",
      {},
      h("h1.wordmark", {}, "Stash"),
      h("button.icon-btn", {
        "aria-label": "Search",
        onclick: () => {
          state.showSearch = !state.showSearch;
          if (!state.showSearch && state.q) {
            state.q = "";
            refresh();
          }
          renderMain();
          if (state.showSearch) document.querySelector(".search input")?.focus();
        },
      }, icon("search")),
      h("button.icon-btn", { "aria-label": "Settings", onclick: openSettings }, icon("gear")),
    ),
    state.showSearch && h("div.search", {}, searchInput),
    h(
      "nav.chips",
      {},
      h("button.chip", { "aria-pressed": String(state.board === "all"), onclick: () => selectBoard("all") }, "All"),
      state.boards.map((b) =>
        h("button.chip", { "aria-pressed": String(state.board === String(b.id)), onclick: () => selectBoard(b.id) }, `${b.emoji} ${b.name}`),
      ),
      h("button.chip.add", { onclick: () => openBoardEditor() }, "+ New board"),
    ),
  );

  const board = state.board === "all" ? null : boardById(state.board);
  const head = board
    ? h(
        "div.board-head",
        {},
        h(
          "div.grow",
          {},
          h("h2", {}, `${board.emoji} ${board.name}`),
          h(
            "div.meta",
            {},
            board.shared ? h("span.pill", {}, "Shared") : h("span.pill", {}, "🔒 Just me"),
            ` · ${board.item_count} ${board.item_count === 1 ? "thing" : "things"}`,
          ),
        ),
        isMine(board) && h("button.icon-btn", { "aria-label": "Edit board", onclick: () => openBoardEditor(board) }, icon("dots")),
      )
    : null;

  const main = h("main", {}, head, renderGrid());
  const fab = h("button.fab", { "aria-label": "Save something", onclick: openAdd }, icon("plus"));

  // Keep keyboard focus in the search box while results update.
  const hadFocus = document.activeElement?.type === "search";
  const scroll = window.scrollY;
  $app.replaceChildren(top, main, fab);
  window.scrollTo(0, scroll);
  if (hadFocus) {
    const s = document.querySelector(".search input");
    s?.focus();
    s?.setSelectionRange(s.value.length, s.value.length);
  }
}

function renderGrid() {
  if (!state.loaded) return h("div.empty", {}, h("p", {}, "Loading…"));
  if (!state.items.length) {
    if (state.q) return h("div.empty", {}, h("div.big", {}, "🔍"), h("h3", {}, "Nothing matches"), h("p", {}, `No saves match “${state.q}”.`));
    return h(
      "div.empty",
      {},
      h("div.big", {}, "🧺"),
      h("h3", {}, "Nothing saved here yet"),
      h("p", {}, "Tap Share in any app and choose Stash, or tap + to paste a link."),
      h("button.btn", { onclick: openSettings }, "Set up the Share button"),
    );
  }
  const showWho = (state.me.people || []).length > 1;
  return h(
    "div.grid",
    {},
    state.items.map((item) => {
      const b = boardById(item.board_id);
      const byOther = showWho && b?.shared && item.user_id !== state.me.user.id;
      return h(
        "button.card" + (item.done ? ".done" : ""),
        { onclick: () => openItem(item) },
        h(
          "div.img",
          {},
          item.image
            ? h("img", { src: item.image, alt: "", loading: "lazy" })
            : h("div.placeholder", {}, initials(item.site || item.title)),
          !!item.done && h("span.badge", {}, "✓ Got it"),
          byOther && h("span.who", { title: `Saved by ${item.added_by}` }, item.added_by),
        ),
        item.status === "pending" && h("div.loading-bar"),
        h(
          "div.body",
          {},
          h("p.title", {}, item.title || (item.status === "pending" ? "Getting details…" : item.url || "Untitled")),
          h(
            "div.sub",
            {},
            h("span.site", {}, state.board === "all" && b ? `${b.emoji} ${item.site || ""}` : item.site || ""),
            item.price && h("span.price", {}, item.price),
          ),
          item.note && h("div.note", {}, item.note),
        ),
      );
    }),
  );
}

// ---------- Sheets ----------

function openSheet(title, ...content) {
  const close = () => {
    backdrop.remove();
    document.body.style.overflow = "";
  };
  const sheet = h(
    "div.sheet",
    { role: "dialog", "aria-modal": "true" },
    h("div.grabber"),
    h("div.sheet-head", {}, h("h3", {}, title), h("button.icon-btn", { "aria-label": "Close", onclick: () => close() }, icon("close"))),
    ...content,
  );
  const backdrop = h("div.backdrop", { onclick: (e) => e.target === backdrop && close() }, sheet);
  document.body.append(backdrop);
  document.body.style.overflow = "hidden";
  return { close, sheet };
}

function boardSelect(selected) {
  return h(
    "select",
    {},
    state.boards.map((b) =>
      h("option", { value: b.id, selected: String(b.id) === String(selected) }, `${b.emoji} ${b.name}${b.shared ? "" : " (just me)"}`),
    ),
  );
}

function openAdd() {
  if (!state.boards.length) return openBoardEditor();
  const input = h("textarea", { placeholder: "Paste a link (or type a note)", rows: 3 });
  const select = boardSelect(state.board !== "all" ? state.board : state.boards[0].id);
  const note = h("input", { type: "text", placeholder: "Optional — size, why you liked it…" });
  const err = h("div.error");
  const save = h("button.btn.primary.block", { type: "submit" }, "Save");
  const { close } = openSheet(
    "Save something",
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          save.disabled = true;
          try {
            await api("/api/items", { method: "POST", body: { input: input.value, board_id: Number(select.value), note: note.value } });
            close();
            toast("Saved");
            refresh();
          } catch (ex) {
            err.textContent = ex.message;
            save.disabled = false;
          }
        },
      },
      h("label.field", {}, h("span", {}, "Link"), input),
      h("label.field", {}, h("span", {}, "Board"), select),
      h("label.field", {}, h("span", {}, "Note"), note),
      err,
      save,
    ),
  );
  setTimeout(() => input.focus(), 50);
}

function openItem(item) {
  const title = h("textarea.title-input", { rows: 1, value: item.title || "" });
  const note = h("textarea", { placeholder: "Add a note — size, color, who it's for…", value: item.note || "" });
  const select = boardSelect(item.board_id);
  const done = h("input", { type: "checkbox", checked: !!item.done });
  const fileInput = h("input", { type: "file", accept: "image/*", hidden: true });

  const patch = async (body, msg) => {
    try {
      await api(`/api/items/${item.id}`, { method: "PATCH", body });
      Object.assign(item, body);
      if (msg) toast(msg);
      refresh();
    } catch (ex) {
      toast(ex.message);
    }
  };
  title.addEventListener("change", () => patch({ title: title.value }));
  note.addEventListener("change", () => patch({ note: note.value }, "Note saved"));
  select.addEventListener("change", () => patch({ board_id: Number(select.value) }, "Moved"));
  done.addEventListener("change", () => patch({ done: done.checked }));
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      toast("Uploading…");
      await api(`/api/items/${item.id}/image`, { method: "PUT", body: await shrinkImage(file) });
      close();
      toast("Picture added");
      refresh();
    } catch (ex) {
      toast(ex.message);
    }
  });

  const when = new Date(item.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const { close } = openSheet(
    "",
    item.image && h("div.hero", {}, h("img", { src: item.image, alt: "" })),
    title,
    h(
      "div.meta-line",
      {},
      [item.site, item.price && h("span.price", {}, item.price), `Saved ${when}${item.added_by ? " by " + item.added_by : ""}`]
        .filter(Boolean)
        .flatMap((x, i) => (i ? [" · ", x] : [x])),
    ),
    item.description && h("p.muted.small", {}, item.description),
    h(
      "div.stack",
      { style: "margin-bottom:16px" },
      item.url && /^https?:/i.test(item.url) && h("a.btn.primary.block", { href: item.url, target: "_blank", rel: "noopener" }, item.site && item.site.length <= 22 ? `Open on ${item.site}` : "Open website"),
    ),
    h("label.toggle", {}, h("span.grow", {}, h("b", {}, "Got it"), h("div.muted.small", {}, "Bought it, made it, been there")), done),
    h("label.field", {}, h("span", {}, "Note"), note),
    h("label.field", {}, h("span", {}, "Board"), select),
    h(
      "div.row",
      { style: "margin-bottom:6px" },
      h("button.btn", { onclick: () => fileInput.click() }, item.image ? "Change picture" : "Add picture"),
      item.url &&
        h("button.btn", {
          onclick: async () => {
            await api(`/api/items/${item.id}/refresh`, { method: "POST" });
            close();
            toast("Refreshing…");
            refresh();
          },
        }, "Refresh details"),
    ),
    fileInput,
    h("button.btn.danger.block", {
      onclick: async () => {
        if (!confirm("Delete this save?")) return;
        await api(`/api/items/${item.id}`, { method: "DELETE" });
        close();
        toast("Deleted");
        refresh();
      },
    }, "Delete"),
  );
  // Grow the title box to fit its text.
  requestAnimationFrame(() => {
    title.style.height = "auto";
    title.style.height = title.scrollHeight + "px";
  });
}

// Phone photos are big; scale them down before uploading.
async function shrinkImage(file, max = 1200) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  } catch {
    return file;
  }
}

const EMOJIS = ["🛍️", "🍳", "✈️", "🏡", "🎁", "👗", "💄", "📚", "🎬", "🎵", "🌱", "🐶", "👶", "🏋️", "🍷", "💡", "📌", "🔒"];

function openBoardEditor(board) {
  const name = h("input", { type: "text", placeholder: "e.g. Gift ideas", value: board?.name || "" });
  let emoji = board?.emoji || "📌";
  const emojiRow = h(
    "div.emoji-row",
    {},
    EMOJIS.map((e) =>
      h("button", {
        type: "button",
        "aria-pressed": String(e === emoji),
        onclick: (ev) => {
          emoji = e;
          emojiRow.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === ev.currentTarget)));
        },
      }, e),
    ),
  );
  const shared = h("input", { type: "checkbox", checked: board ? !!board.shared : true });
  const err = h("div.error");
  const { close } = openSheet(
    board ? "Edit board" : "New board",
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const body = { name: name.value, emoji, shared: shared.checked };
            if (board) await api(`/api/boards/${board.id}`, { method: "PATCH", body });
            else {
              const res = await api("/api/boards", { method: "POST", body });
              state.board = String(res.board.id);
            }
            close();
            refresh();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("label.field", {}, h("span", {}, "Name"), name),
      h("label.field", {}, h("span", {}, "Icon")),
      emojiRow,
      h("label.toggle", {}, h("span.grow", {}, h("b", {}, "Shared"), h("div.muted.small", {}, "Everyone in your Stash can see and add to it. Turn off to keep it just for you.")), shared),
      err,
      h("button.btn.primary.block", { type: "submit" }, board ? "Save changes" : "Create board"),
      board &&
        h("button.btn.danger.block", {
          type: "button",
          style: "margin-top:8px",
          onclick: async () => {
            const n = board.item_count;
            if (!confirm(`Delete “${board.name}”${n ? ` and the ${n} ${n === 1 ? "thing" : "things"} saved in it` : ""}?`)) return;
            await api(`/api/boards/${board.id}`, { method: "DELETE" });
            close();
            selectBoard("all");
          },
        }, "Delete board"),
    ),
  );
  if (!board) setTimeout(() => name.focus(), 50);
}

function openSettings() {
  const me = state.me;
  const link = h("code", {}, me.save_link);
  const boardsLink = h("code", {}, me.save_link + "/boards");
  const saveLink = h("code", {}, me.save_link + "/save");
  const copyLine = (el) => h("div.copy-line", {}, el, h("button.btn", { type: "button", onclick: () => copy(el.textContent) }, "Copy"));
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;

  openSheet(
    "Settings",
    h(
      "div.section",
      {},
      h("h4", {}, "Add Stash to your Share button"),
      h("p.muted.small", {}, "Do this once on each iPhone, about 3 minutes. Each person uses their own links."),
      h(
        "ol.steps.small",
        {},
        h("li", {}, "Open the ", h("b", {}, "Shortcuts"), " app, tap ", h("b", {}, "+"), ", and name the shortcut ", h("b", {}, "Stash"), "."),
        h("li", {}, "Tap the ", h("b", {}, "ⓘ"), " button at the bottom and turn on ", h("b", {}, "Show in Share Sheet"), "."),
        h("li", {}, "Add the action ", h("b", {}, "Get Contents of URL"), " and paste this as its URL:", copyLine(boardsLink)),
        h("li", {}, "Add ", h("b", {}, "Choose from List"), ". It picks up the list of boards automatically. Set its prompt to “Save to…”."),
        h(
          "li",
          {},
          "Add a second ",
          h("b", {}, "Get Contents of URL"),
          " and paste this URL:",
          copyLine(saveLink),
          "Tap ",
          h("b", {}, "›"),
          " to expand it. Set ",
          h("b", {}, "Method"),
          " to POST and ",
          h("b", {}, "Request Body"),
          " to JSON. Add two Text fields: ",
          h("b", {}, "input"),
          " → choose the ",
          h("b", {}, "Shortcut Input"),
          " variable, and ",
          h("b", {}, "board"),
          " → choose ",
          h("b", {}, "Chosen Item"),
          ".",
        ),
        h("li", {}, "Add ", h("b", {}, "Show Notification"), " and set its text to the ", h("b", {}, "Contents of URL"), " variable, so you see “Saved to …”."),
        h("li", {}, "Try it: in Safari, TikTok or Instagram tap ", h("b", {}, "Share"), " → ", h("b", {}, "Stash"), ". If Stash isn't in the top row, scroll the bottom list or tap ", h("b", {}, "Edit Actions"), " to make it a favorite."),
      ),
    ),
    !standalone &&
      h(
        "div.section",
        {},
        h("h4", {}, "Put Stash on your Home Screen"),
        h("p.muted.small", {}, "In Safari, tap the Share button, then ", h("b", {}, "Add to Home Screen"), ". It'll open like a normal app."),
      ),
    me.invite_code &&
      h(
        "div.section",
        {},
        h("h4", {}, "Invite someone"),
        h("p.muted.small", {}, "Send them this website's address and this code. They tap “Create an account” and enter the code."),
        h("div.copy-line", {}, h("span.code", { style: "flex:1" }, me.invite_code), h("button.btn", { type: "button", onclick: () => copy(`Join me on Stash: ${location.origin}\nInvite code: ${me.invite_code}`) }, "Copy")),
        (me.people || []).length > 1 && h("p.muted.small", {}, "In your Stash: " + me.people.map((p) => p.name).join(", ")),
      ),
    h(
      "div.section",
      {},
      h("h4", {}, "Your secret save link"),
      h("p.muted.small", {}, "This link lets the Shortcut save to your account without a password, so keep it private. If it leaks, make a new one. You'll then need to paste the new links into your Shortcut again."),
      copyLine(link),
      h("button.btn", {
        type: "button",
        onclick: async () => {
          if (!confirm("Make a new link? Your current Shortcut will stop working until you update it.")) return;
          const res = await api("/api/me/new-save-link", { method: "POST" });
          me.save_link = res.save_link;
          link.textContent = res.save_link;
          boardsLink.textContent = res.save_link + "/boards";
          saveLink.textContent = res.save_link + "/save";
          toast("New link made");
        },
      }, "Make a new link"),
    ),
    h(
      "div.section",
      {},
      h("h4", {}, me.user.name),
      h("p.muted.small", { style: "margin-top:0" }, me.user.email),
      h("button.btn", {
        type: "button",
        onclick: async () => {
          await api("/api/logout", { method: "POST" });
          location.reload();
        },
      }, "Log out"),
    ),
  );
}

// ---------- Start ----------

(async () => {
  await loadMe();
  render();
  if (state.me) refresh();
})();

// Coming back to the app (e.g. after sharing from another app) shows new saves.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.me) refresh();
});
