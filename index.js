// yado-ical-merger: サイトコントローラー中継マージャー (JavaScript版)

export default {
  async fetch(request, env, ctx) {
    // 登録された環境変数（URL）を取得して、空でないものをフィルタリング
    const urls = [
      env.AIRBNB_ICAL_URL,
      env.BOOKING_ICAL_URL,
      env.AGODA_ICAL_URL,
      env.GOOGLE_ICAL_URL,
    ].filter((url) => typeof url === 'string' && url.trim().length > 0);

    // URLが1つも設定されていない場合はエラーを返す
    if (urls.length === 0) {
      return new Response("設定エラー: カレンダーURLが登録されていません。Cloudflareの環境変数(Variables)を設定してください。", { status: 400 });
    }

    try {
      // すべてのカレンダーURLから非同期で予約データを取得
      const icsTexts = await Promise.all(
        urls.map(async (url) => {
          try {
            const res = await fetch(url, {
              headers: { "User-Agent": "Yado-Cal-Merger/1.0" },
            });
            if (!res.ok) {
              console.error(`フェッチ失敗 ${url}: ${res.statusText}`);
              return "";
            }
            return await res.text();
          } catch (e) {
            console.error(`フェッチエラー ${url}:`, e);
            return "";
          }
        })
      );

      // ブロックすべき宿泊日のセット（重複を排除するための自動整理）
      const blockedDates = new Set();

      for (const icsText of icsTexts) {
        if (!icsText) continue;
        parseAndExtractBlockedDates(icsText, blockedDates);
      }

      // 連続する日程をきれいに合体（マージ）
      const blocks = generateMergedBlocks(blockedDates);

      // 配信用の新しいカレンダーファイル(ICS形式)を組み立て
      const responseIcs = buildIcsFile(blocks);

      return new Response(responseIcs, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'attachment; filename="yado.ics"',
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        },
      });
    } catch (e) {
      return new Response(`サーバー内部エラー: ${e instanceof Error ? e.message : e}`, { status: 500 });
    }
  },
};

// YYYYMMDD または YYYYMMDDTHHMMSSZ を日付オブジェクトにするヘルパー
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
  return date.toISOString().split('T')[0];
}

// チェックイン日からチェックアウト日の前日までの各「宿泊日」をセットに登録
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

// ICSテキストをパースして宿泊日を取り出す処理
function parseAndExtractBlockedDates(icsText, set) {
  const lines = icsText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  
  // 折り返し行の結合
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
        if (colonIdx !== -1) {
          dtstart = line.substring(colonIdx + 1).trim();
        }
      } else if (upperLine.startsWith("DTEND")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) {
          dtend = line.substring(colonIdx + 1).trim();
        }
      }
    }
  }
}

// 連続した宿泊日を統合してカレンダーブロックを再生成する
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
      const checkoutDate = new Date(currentBlockEnd.getTime());
      checkoutDate.setUTCDate(checkoutDate.getUTCDate() + 1);

      blocks.push({
        start: formatDate(blockStart).replace(/-/g, ""),
        end: formatDate(checkoutDate).replace(/-/g, ""),
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

// ICSファイルのテキスト組み立て
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
