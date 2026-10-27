// Turns a link into a title, picture, site name and (for shops) a price, by
// reading the page's "Open Graph" tags — the same info Messages uses for its
// link bubbles.

export type Preview = {
  title?: string;
  description?: string;
  site?: string;
  price?: string;
  image?: string;
};

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
// Many sites (Instagram especially) only hand link-preview tags to known
// link-preview bots.
const PREVIEW_BOT_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

const MAX_HTML_BYTES = 1_500_000;
export const MAX_IMAGE_BYTES = 1_500_000;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const SITE_NAMES: Record<string, string> = {
  "tiktok.com": "TikTok",
  "instagram.com": "Instagram",
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "pinterest.com": "Pinterest",
  "amazon.com": "Amazon",
  "etsy.com": "Etsy",
  "facebook.com": "Facebook",
};

export function friendlySite(url: string): string {
  const host = hostOf(url);
  for (const [domain, name] of Object.entries(SITE_NAMES)) {
    if (host === domain || host.endsWith("." + domain)) return name;
  }
  return host;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function clean(s: string | undefined, max = 300): string | undefined {
  if (!s) return undefined;
  const out = decodeEntities(s).replace(/\s+/g, " ").trim();
  if (!out) return undefined;
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

function formatPrice(amount?: string, currency?: string): string | undefined {
  if (!amount) return undefined;
  const n = Number(amount.replace(/[^0-9.]/g, ""));
  if (!isFinite(n) || n <= 0) return undefined;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: n % 1 === 0 ? 0 : 2,
    }).format(n);
  } catch {
    return `$${n}`;
  }
}

async function tiktok(url: string): Promise<Preview | null> {
  const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
    headers: { "user-agent": BROWSER_UA },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
  return {
    title: clean(data.title) || (data.author_name ? `TikTok by ${data.author_name}` : undefined),
    description: data.author_name ? `@${data.author_name}` : undefined,
    site: "TikTok",
    image: data.thumbnail_url,
  };
}

async function readMeta(url: string, userAgent: string): Promise<{ preview: Preview; finalUrl: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  const meta: Record<string, string> = {};
  let title = "";
  let inTitle = false;
  const type = res.headers.get("content-type") || "";
  if (res.ok && type.includes("html")) {
    // Only read the first chunk of the page; the tags live in <head>.
    const limited = new Response(truncate(res.body, MAX_HTML_BYTES), { headers: res.headers });
    await new HTMLRewriter()
      .on("meta", {
        element(el) {
          const key = (el.getAttribute("property") || el.getAttribute("name") || el.getAttribute("itemprop") || "")
            .toLowerCase()
            .trim();
          const content = el.getAttribute("content");
          if (key && content && !(key in meta)) meta[key] = content;
        },
      })
      .on("title", {
        element() {
          inTitle = true;
        },
        text(t) {
          if (inTitle) title += t.text;
          if (t.lastInTextNode) inTitle = false;
        },
      })
      .transform(limited)
      .arrayBuffer();
  } else {
    await res.body?.cancel();
  }

  const finalUrl = res.url || url;
  const rawImage = meta["og:image:secure_url"] || meta["og:image"] || meta["og:image:url"] || meta["twitter:image"] || meta["twitter:image:src"] || meta["image"];
  let image: string | undefined;
  if (rawImage) {
    try {
      image = new URL(decodeEntities(rawImage), finalUrl).toString();
    } catch {}
  }
  return {
    finalUrl,
    preview: {
      title: clean(meta["og:title"] || meta["twitter:title"] || title, 200),
      description: clean(meta["og:description"] || meta["twitter:description"] || meta["description"]),
      site: clean(meta["og:site_name"], 60),
      price: formatPrice(
        meta["product:price:amount"] || meta["og:price:amount"] || meta["price"],
        meta["product:price:currency"] || meta["og:price:currency"] || meta["pricecurrency"],
      ),
      image,
    },
  };
}

function truncate(body: ReadableStream<Uint8Array> | null, max: number): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  let seen = 0;
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done || seen >= max) {
        controller.close();
        if (!done) reader.cancel();
        return;
      }
      seen += value.byteLength;
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });
}

export async function fetchPreview(url: string): Promise<Preview> {
  const host = hostOf(url);
  if (host.endsWith("tiktok.com")) {
    try {
      const p = await tiktok(url);
      if (p?.image || p?.title) return p;
    } catch {}
  }
  const botFirst = host.endsWith("instagram.com") || host.endsWith("facebook.com");
  const agents = botFirst ? [PREVIEW_BOT_UA, BROWSER_UA] : [BROWSER_UA, PREVIEW_BOT_UA];
  let best: Preview = {};
  for (const ua of agents) {
    try {
      const { preview } = await readMeta(url, ua);
      if (preview.image || (!best.title && preview.title)) best = { ...best, ...stripEmpty(preview) };
      if (best.image && best.title) break;
    } catch {}
  }
  best.site = best.site || friendlySite(url);
  return best;
}

function stripEmpty(p: Preview): Preview {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v)) as Preview;
}

// Download the picture so it keeps working even after sites like TikTok and
// Instagram expire their image links.
export async function downloadImage(url: string): Promise<{ type: string; data: ArrayBuffer } | null> {
  const res = await fetch(url, { headers: { "user-agent": BROWSER_UA, accept: "image/*" } });
  if (!res.ok) return null;
  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  if (!type.startsWith("image/")) return null;
  const length = Number(res.headers.get("content-length") || 0);
  if (length > MAX_IMAGE_BYTES) {
    await res.body?.cancel();
    return null;
  }
  const data = await res.arrayBuffer();
  if (data.byteLength > MAX_IMAGE_BYTES) return null;
  return { type, data };
}

// Shared text often wraps the link in words ("Check this out! https://…").
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  return m[0].replace(/[).,!?]+$/, "");
}
