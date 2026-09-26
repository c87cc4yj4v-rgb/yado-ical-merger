// yado-ical-merger: サイトコントローラー中継マージャー (JavaScript版)
// v1.1 (2026-09): 予約サイトからの取得に失敗したとき、前回成功した分（KV: ICAL_CACHE）を使うようにしました。
// v1.1.1 (2026-09-26): 取得失敗時のログに iCal URL を丸ごと出さないようにしました（伏せ字）。
// v1.2 (2026-09-26): 前回と同じ内容なら保管庫（KV）に書き込まないようにしました（KV無料枠の書き込み回数の節約）。
// v1.3 (2026-09-26): 各サイトの取得状況を、配信する yado.ics の先頭にも X-MERGER-SOURCES 行として書くようにしました（メモ帳で開くだけで確認できる。読み方は X-MERGER-NOTE 行）。
//   6時間に1回は同じ内容でも書き直して「最後に取得できた時刻」を新しくします。
// 結合ロジック・出力形式・4つのカレンダーURL（シークレット）は v1.0 と同じです。
// KV が未設定でも動きます（その場合は v1.0 と同じ「失敗したサイトは空扱い」）。

const CACHE_PREFIX = "ical:";
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7日より古い前回分は「stale」と記録（それでも使う）
const REWRITE_AFTER_MS = 6 * 60 * 60 * 1000; // v1.2: 内容が同じでも、前回の保存から6時間たっていたら書き直す（fetchedAt を新しくするため）

// v1.1.1 (2026-09-26): ログに iCal URL を丸ごと出さない。URL は「宿の鍵」なので、
// ログのスクショをAIに貼っても鍵が渡らないよう、ホスト名と末尾4文字だけ残して伏せ字にする。
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

    try {
      const results = await Promise.all(sources.map((s) => fetchWithFallback(s, env, ctx)));

      const blockedDates = new Set();
      for (const r of results) {
        if (!r.text) continue;
        parseAndExtractBlockedDates(r.text, blockedDates);
      }

      const blocks = generateMergedBlocks(blockedDates);
      const sourcesHeader = results.map((r) => `${r.name}=${r.status}`).join(", ");
      const responseIcs = buildIcsFile(blocks, sourcesHeader); // v1.3: 取得状況を .ics の先頭にも書く

      return new Response(responseIcs, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'attachment; filename="yado.ics"',
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "X-Merger-Sources": sourcesHeader, // 各サイトの取得状況（live / cached / stale / missing）
        },
      });
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
    const res = await fetch(url, { headers: { "User-Agent": "Yado-Cal-Merger/1.3" } });
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

function buildIcsFile(blocks, sourcesHeader) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Yado//Site Controller Merger//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  // v1.3: 各サイトの取得状況を .ics の先頭にも書く（メモ帳で開くだけで確認できる）。
  // 「X-」で始まる行は iCalendar の独自項目で、予約サイトやカレンダーアプリは読み飛ばす決まり。
  lines.push("X-MERGER-VERSION:1.3");
  lines.push(...foldLine(`X-MERGER-SOURCES:${sourcesHeader || ""}`));
  lines.push(...foldLine("X-MERGER-NOTE:各サイトの取得状況です。live=いま取得できた／cached(3h)=3時間前の前回分を使用中（そのサイトが一時的に返事をしていない）／stale(9d)=9日前の前回分を使用中（7日以上取れていない。URLが古くなったかも）／missing=前回分もない"));
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
