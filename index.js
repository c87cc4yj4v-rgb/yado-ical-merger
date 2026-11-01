// yado-ical-merger: サイトコントローラー中継マージャー (JavaScript版)
// v1.1 (2026-09): 予約サイトからの取得に失敗したとき、前回成功した分（KV: ICAL_CACHE）を使うようにしました。
// v1.1.1 (2026-09-26): 取得失敗時のログに iCal URL を丸ごと出さないようにしました（伏せ字）。
// v1.2 (2026-09-26): 前回と同じ内容なら保管庫（KV）に書き込まないようにしました（KV無料枠の書き込み回数の節約）。
//   6時間に1回は同じ内容でも書き直して「最後に取得できた時刻」を新しくします。
// v1.3 (2026-09-26): 各サイトの取得状況を、配信する yado.ics の先頭にも X-MERGER-SOURCES 行として書くようにしました（メモ帳で開くだけで確認できる。読み方は X-MERGER-NOTE 行）。
// v1.5 (2026-11): 予約サイトごとに中身を分けるようにしました（送り返しの穴をふさぐ）。
//   全サイトに同じ中身を返すと、Booking.com で手で止めた日や予約が Booking.com 自身に戻り、Booking.com はそれを
//   「よその止め」に置き換えてエクスポートから外します → 手で止めた日がその後に開き、予約は他のサイトに届かなくなります。
//   /booking.ics・/airbnb.ics・/agoda.ics は、そのサイト自身の分を抜いた中身を返します。
//   /（ほかの道も）は従来どおり全部入り（Googleカレンダーで一覧を見る用）。
//   あわせて、各サイトから取ったものを10分取っておきます（KV: sources:v1）。どの道で何度開いても、取りに行くのは10分に1回まで。
//   長さは環境変数 MERGED_CACHE_SECONDS で変えられます（0で取っておかない・上限3600秒）。どこから返したかは X-Merger-Cache に出ます。
// 結合ロジック・4つのカレンダーURL（シークレット）は v1.0 と同じです。
// KV が未設定でも動きます（その場合は「失敗したサイトは空扱い」・10分の取り置きはこの Worker の手元だけ）。

const CACHE_PREFIX = "ical:";
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7日より古い前回分は「stale」と記録（それでも使う）
const REWRITE_AFTER_MS = 6 * 60 * 60 * 1000; // 内容が同じでも、前回の保存から6時間たっていたら書き直す（fetchedAt を新しくするため）
const SOURCES_KEY = "sources:v1"; // v1.5: 各サイトから取ったものを10分取っておく
const DEFAULT_MERGED_TTL_MS = 10 * 60 * 1000; // 取ったものを取っておく長さ（10分）
const VERSION = "1.5";
let sourcesMemo = null; // { at, results }（同じ Worker が続けて呼ばれた時だけ効く手元の控え）

// v1.5: 道の名前から「どの予約サイト向けか」を読む。/booking.ics → "booking"。知らない道は null（全部を返す）
function targetFromPath(pathname, names) {
  const m = /^\/([a-z]+)\.ics$/i.exec(pathname || "");
  if (!m) return null;
  const name = m[1].toLowerCase();
  return names.includes(name) ? name : null;
}

function mergedTtlMs(env) {
  const v = env.MERGED_CACHE_SECONDS;
  if (v === undefined || v === null || v === "") return DEFAULT_MERGED_TTL_MS;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MERGED_TTL_MS;
  return Math.min(n, 3600) * 1000;
}

function icsResponse(ics, sources, cacheLabel, target) {
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${target ? `yado-for-${target}` : "yado"}.ics"`,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "X-Merger-Sources": sources,
      "X-Merger-Cache": cacheLabel,
      "X-Merger-For": target || "all",
    },
  });
}

// v1.5: 取ったものから、向け先のサイト自身の分を抜いてまとめる
function buildFor(results, target) {
  const blockedDates = new Set();
  for (const r of results) {
    if (!r.text || r.name === target) continue;
    parseAndExtractBlockedDates(r.text, blockedDates);
  }
  const blocks = generateMergedBlocks(blockedDates);
  const sourcesHeader = results.map((r) => `${r.name}=${r.name === target ? "excluded" : r.status}`).join(", ");
  return { ics: buildIcsFile(blocks, sourcesHeader, target), sources: sourcesHeader };
}

// ログに iCal URL を丸ごと出さない（URLは「宿の鍵」）。ホスト名と末尾4文字だけ残す。
function maskUrl(url) {
  try {
    const u = new URL(String(url));
    const tail = u.pathname.length + u.search.length > 4 ? String(u.pathname + u.search).slice(-4) : "";
    return `${u.origin}/…${tail}`;
  } catch {
    return "(invalid url)";
  }
}

export default {
  async fetch(request, env, ctx) {
    const sources = [
      { name: "airbnb", url: env.AIRBNB_ICAL_URL },
      { name: "booking", url: env.BOOKING_ICAL_URL },
      { name: "agoda", url: env.AGODA_ICAL_URL },
      { name: "google", url: env.GOOGLE_ICAL_URL },
    ].filter((s) => typeof s.url === "string" && s.url.length > 0);

    if (sources.length === 0) {
      return new Response("設定エラー: カレンダーURLが登録されていません。Cloudflareの環境変数(Variables)を設定してください。", { status: 400 });
    }

    // v1.5: どの予約サイト向けか（そのサイト自身の分は返さない）
    const target = targetFromPath(new URL(request.url).pathname, sources.map((s) => s.name));

    const ttl = mergedTtlMs(env);
    const kv = env.ICAL_CACHE;
    if (ttl > 0) {
      // v1.5: 10分以内に取ったものがあれば、各サイトへ取りに行かずにそれでまとめる
      const now = Date.now();
      if (sourcesMemo && now - sourcesMemo.at < ttl) {
        const out = buildFor(sourcesMemo.results, target);
        return icsResponse(out.ics, out.sources, `memory(${formatAge(now - sourcesMemo.at)})`, target);
      }
      if (kv) {
        try {
          const raw = await kv.get(SOURCES_KEY);
          if (raw) {
            const rec = JSON.parse(raw);
            if (rec && Array.isArray(rec.results) && now - (rec.at || 0) < ttl) {
              sourcesMemo = rec;
              const out = buildFor(rec.results, target);
              return icsResponse(out.ics, out.sources, `kv(${formatAge(now - rec.at)})`, target);
            }
          }
        } catch (e) {
          console.error("[sources] KV get failed:", e); // 読めなければ、従来どおり各サイトへ取りに行く
        }
      }
    }

    try {
      const results = await Promise.all(sources.map((s) => fetchWithFallback(s, env, ctx)));

      if (ttl > 0) {
        const rec = { at: Date.now(), results };
        sourcesMemo = rec;
        if (kv) {
          // KV の書き込みは10分に1回まで（1日最大144回・無料枠1,000回の内）
          const save = kv.put(SOURCES_KEY, JSON.stringify(rec)).catch((e) => console.error("[sources] KV put failed:", e));
          if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(save); else await save;
        }
      }
      const out = buildFor(results, target); // v1.3: 取得状況を .ics の先頭にも書く
      return icsResponse(out.ics, out.sources, "fresh", target);
    } catch (e) {
      return new Response(`サーバー内部エラー: ${e instanceof Error ? e.message : e}`, { status: 500 });
    }
  },
};

/**
 * 1社分を取得する。成功したらKVに保存し、失敗したらKVの前回成功分を返す。
 * 戻り値: { name, text, status }
 *   status: "live" | "cached(<age>)" | "stale(<age>)" | "missing"
 */
async function fetchWithFallback(source, env, ctx) {
  const { name, url } = source;
  const kv = env.ICAL_CACHE; // 未バインド時は従来どおり（保存も復元もしない）
  const key = CACHE_PREFIX + name;

  let liveText = null;
  let failReason = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": `Yado-Cal-Merger/${VERSION}` } });
    if (!res.ok) {
      failReason = `HTTP ${res.status} ${res.statusText}`;
    } else {
      const text = await res.text();
      if (isValidIcs(text)) {
        liveText = text;
      } else {
        failReason = "response is not an iCalendar (no BEGIN:VCALENDAR)";
      }
    }
  } catch (e) {
    failReason = e instanceof Error ? e.message : String(e);
  }

  if (liveText !== null) {
    if (kv) {
      // v1.2: 前回と同じ内容なら書き込まない（KV の無料枠は書き込みが1日1,000回。読み取りは10万回なので、読んで比べる分は問題にならない）。
      // ただし前回の保存から REWRITE_AFTER_MS 以上たっていたら、同じ内容でも書き直して fetchedAt を新しくする
      // （失敗時に出す cached(<age>) / stale(<age>) の年齢が、実際の「最後に取得できた時刻」から大きくずれないように）。
      const save = (async () => {
        let prevText = null, prevAt = 0;
        try {
          const prev = await kv.get(key);
          if (prev) {
            const rec = JSON.parse(prev);
            prevText = rec && typeof rec.text === "string" ? rec.text : null;
            prevAt = (rec && rec.fetchedAt) || 0;
          }
        } catch (e) {
          // 前回分が読めなくても、保存はする
        }
        if (prevText === liveText && Date.now() - prevAt < REWRITE_AFTER_MS) return; // 同じ内容・保存も新しい → 書かない
        await kv.put(key, JSON.stringify({ fetchedAt: Date.now(), text: liveText }));
      })().catch((e) => console.error(`[${name}] KV put failed:`, e));
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(save); else await save;
    }
    return { name, text: liveText, status: "live" };
  }

  // 取得失敗 → 前回成功分を探す
  console.error(`[${name}] fetch failed (${failReason}) for ${maskUrl(url)}`);
  if (!kv) {
    console.error(`[${name}] no cache binding; treating as empty (previous behaviour)`);
    return { name, text: "", status: "missing" };
  }
  try {
    const raw = await kv.get(key);
    if (raw) {
      const rec = JSON.parse(raw);
      const ageMs = Date.now() - (rec.fetchedAt || 0);
      const age = formatAge(ageMs);
      const stale = ageMs > STALE_AFTER_MS;
      console.error(`[${name}] using previous successful copy from ${age} ago${stale ? " (STALE: older than 7 days)" : ""}`);
      return { name, text: rec.text || "", status: `${stale ? "stale" : "cached"}(${age})` };
    }
  } catch (e) {
    console.error(`[${name}] KV get failed:`, e);
  }
  console.error(`[${name}] no previous copy available; treating as empty`);
  return { name, text: "", status: "missing" };
}

function isValidIcs(text) {
  return typeof text === "string" && text.toUpperCase().includes("BEGIN:VCALENDAR");
}

function formatAge(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ---- 以下は従来のロジックそのまま（変更なし） ----

function parseIcalDate(dateStr) {
  const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  const [_, y, m, d] = match;
  return new Date(Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(d)));
}

function parseFormattedDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

function extractDaysBetween(startStr, endStr, set) {
  const start = parseIcalDate(startStr);
  const end = parseIcalDate(endStr);
  if (!start || !end) return;
  const current = new Date(start.getTime());
  while (current < end) {
    set.add(formatDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

function parseAndExtractBlockedDates(icsText, set) {
  const lines = icsText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const unfoldedLines = [];
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (unfoldedLines.length > 0) {
        unfoldedLines[unfoldedLines.length - 1] += line.slice(1);
      }
    } else {
      unfoldedLines.push(line);
    }
  }
  let inEvent = false;
  let dtstart = "";
  let dtend = "";
  for (const line of unfoldedLines) {
    const upperLine = line.toUpperCase();
    if (upperLine.startsWith("BEGIN:VEVENT")) {
      inEvent = true;
      dtstart = "";
      dtend = "";
    } else if (upperLine.startsWith("END:VEVENT")) {
      if (inEvent && dtstart && dtend) {
        extractDaysBetween(dtstart, dtend, set);
      }
      inEvent = false;
    } else if (inEvent) {
      if (upperLine.startsWith("DTSTART")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) dtstart = line.substring(colonIdx + 1).trim();
      } else if (upperLine.startsWith("DTEND")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) dtend = line.substring(colonIdx + 1).trim();
      }
    }
  }
}

function generateMergedBlocks(datesSet) {
  const sortedDates = Array.from(datesSet).sort();
  if (sortedDates.length === 0) return [];
  const blocks = [];
  let blockStart = parseFormattedDate(sortedDates[0]);
  let currentBlockEnd = parseFormattedDate(sortedDates[0]);
  for (let i = 1; i < sortedDates.length; i++) {
    const nextDate = parseFormattedDate(sortedDates[i]);
    const expectedNext = new Date(currentBlockEnd.getTime());
    expectedNext.setUTCDate(expectedNext.getUTCDate() + 1);
    if (formatDate(nextDate) === formatDate(expectedNext)) {
      currentBlockEnd = nextDate;
    } else {
      const checkoutDate2 = new Date(currentBlockEnd.getTime());
      checkoutDate2.setUTCDate(checkoutDate2.getUTCDate() + 1);
      blocks.push({
        start: formatDate(blockStart).replace(/-/g, ""),
        end: formatDate(checkoutDate2).replace(/-/g, ""),
      });
      blockStart = nextDate;
      currentBlockEnd = nextDate;
    }
  }
  const checkoutDate = new Date(currentBlockEnd.getTime());
  checkoutDate.setUTCDate(checkoutDate.getUTCDate() + 1);
  blocks.push({
    start: formatDate(blockStart).replace(/-/g, ""),
    end: formatDate(checkoutDate).replace(/-/g, ""),
  });
  return blocks;
}

// iCalendar の1行は75オクテット以内という決まりなので、長い行は「改行＋先頭スペース」で折り返す
// （読む側は折り返しを元に戻して読む）。日本語の文字の途中で切らない。
function foldLine(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // 折り返し行は先頭スペース1つぶん短い
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur.length) out.push(cur);
  return out.map((s, i) => (i === 0 ? s : " " + s));
}

function buildIcsFile(blocks, sourcesHeader, target) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Yado//Site Controller Merger//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  // v1.3: 各サイトの取得状況を .ics の先頭にも書く（メモ帳で開くだけで確認できる）。
  // 「X-」で始まる行は iCalendar の独自項目で、予約サイトやカレンダーアプリは読み飛ばす決まり。
  lines.push(`X-MERGER-VERSION:${VERSION}`);
  lines.push(`X-MERGER-FOR:${target || "all"}`); // v1.5: どの予約サイト向けか（all=全部・見る用）
  lines.push(...foldLine(`X-MERGER-SOURCES:${sourcesHeader || ""}`));
  lines.push(...foldLine("X-MERGER-NOTE:各サイトの取得状況です。live=いま取得できた／cached(3h)=3時間前の前回分を使用中（そのサイトが一時的に返事をしていない）／stale(9d)=9日前の前回分を使用中（7日以上取れていない。URLが古くなったかも）／missing=前回分もない／excluded=この予約サイト向けなので、その社自身の分は入れていない"));
  const nowStr = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  blocks.forEach((block, index) => {
    lines.push("BEGIN:VEVENT");
    lines.push(`DTSTAMP:${nowStr}`);
    lines.push(`UID:yado-block-${block.start}-${block.end}-${index}@yado.site`);
    lines.push(`DTSTART;VALUE=DATE:${block.start}`);
    lines.push(`DTEND;VALUE=DATE:${block.end}`);
    lines.push("SUMMARY:Reserved (Yado Hub)");
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
