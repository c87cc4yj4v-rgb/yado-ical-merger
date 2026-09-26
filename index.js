// yado-ical-merger: サイトコントローラー中継マージャー (JavaScript版)
// v1.1 (2026-09): 予約サイトからの取得に失敗したとき、前回成功した分（KV: ICAL_CACHE）を使うようにしました。
// v1.1.1 (2026-09-26): 取得失敗時のログに iCal URL を丸ごと出さないようにしました（伏せ字）。
// 結合ロジック・出力形式・4つのカレンダーURL（シークレット）は v1.0 と同じです。
// KV が未設定でも動きます（その場合は v1.0 と同じ「失敗したサイトは空扱い」）。

const CACHE_PREFIX = "ical:";
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7日より古い前回分は「stale」と記録（それでも使う）

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
      const responseIcs = buildIcsFile(blocks);
      const sourcesHeader = results.map((r) => `${r.name}=${r.status}`).join(", ");

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
    const res = await fetch(url, { headers: { "User-Agent": "Yado-Cal-Merger/1.1" } });
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
      const record = JSON.stringify({ fetchedAt: Date.now(), text: liveText });
      const put = kv.put(key, record).catch((e) => console.error(`[${name}] KV put failed:`, e));
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put); else await put;
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

function buildIcsFile(blocks) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Yado//Site Controller Merger//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
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
