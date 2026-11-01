# yado-ical-merger（宿・iCal中継サイトコントローラー）

個人宿・ゲストハウス向けの、完全無料で運用できる自作サイトコントローラー（iCal中継マージャー）です。
Airbnb・Booking.com・Agoda・Googleカレンダー（手動ブロック用）の空室状況を、Cloudflare Workers上の中継サーバーで1本にマージして同期します。

本リポジトリは、Brain教材 **『無料サイトコントローラー構築ガイド』** のコード配布用です。
構築手順・仕組みの解説・トラブルシューティングは教材本編をご覧ください。

## 🚀 ワンクリックでデプロイ（教材のルートA）

下のボタンを押すと、あなたのCloudflareアカウントにこのプログラムが自動でデプロイされます。
コードのコピー＆ペーストは不要です。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/c87cc4yj4v-rgb/yado-ical-merger)

※デプロイ後、カレンダーURL（4つ）をシークレットとして登録する必要があります。手順は教材本編の「A-3」を参照してください。

## 🤖 AIエージェントでデプロイ（教材のルートB）

Cline・Claude Code・CursorなどのAIエージェントに、このリポジトリのURLを渡してデプロイを依頼してください。プロンプト例は教材本編の「B-2〜B-4」にあります。

## 構成

- `index.js` — 中継マージャー本体（各カレンダーを取得→宿泊日をマージ→iCalとして配信）
- `wrangler.toml` — Cloudflare Workersの設定ファイル

## 予約サイトに登録するURL（v1.5〜）

| 登録先 | URL |
|---|---|
| Airbnb | `https://あなたのWorker名.あなたのサブドメイン.workers.dev/airbnb.ics` |
| Booking.com | `https://あなたのWorker名.あなたのサブドメイン.workers.dev/booking.ics` |
| Agoda | `https://あなたのWorker名.あなたのサブドメイン.workers.dev/agoda.ics` |
| Googleカレンダーなどで一覧を見る | `https://あなたのWorker名.あなたのサブドメイン.workers.dev`（末尾なし＝全部入り） |

末尾に名前を付けると、そのサイト自身の分を抜いた中身を返します。**Booking.com に末尾なしのURLを登録しないでください**（Booking.com で手で止めた日や予約が自分に戻り、止めが外れることがあります。教材本編 第5章「あるある⑥」）。

## 更新履歴

- v1.5 (2026-11): 予約サイトごとに中身を分けるようにしました。`/booking.ics`・`/airbnb.ics`・`/agoda.ics` は、そのサイト自身の分を抜いた中身を返します（`X-MERGER-SOURCES` に `booking=excluded` などと出ます）。末尾なしのURLは従来どおり全部入りです。あわせて、各サイトから取った中身を10分取っておき（KV: `sources:v1`）、何度開かれても予約サイトに取りに行くのは10分に1回までにしました（環境変数 `MERGED_CACHE_SECONDS` で変更可・0で取っておかない）。v1.4 は作者の宿だけで使った版のため、配布は v1.3 から v1.5 に進みます。すでにお使いの方の更新手順は教材本編の第5章「すでにお使いの方へ」をご覧ください
- v1.3 (2026-09-26): 各サイトの取得状況（live / cached / stale / missing）を、配信する yado.ics の先頭にも `X-MERGER-SOURCES` 行として書くようにしました。ダウンロードした yado.ics をメモ帳で開くだけで確認できます（読み方は `X-MERGER-NOTE` 行）
- v1.2 (2026-09-26): 前回と同じ内容なら保管庫（KV）に書き込まないようにしました（無料枠の書き込み回数の節約。6時間に1回は同じ内容でも書き直します）
- v1.1.1 (2026-09-26): 取得に失敗したときのログに、カレンダーURLを丸ごと出さないようにしました（ホスト名と末尾4文字だけ）
- v1.1 (2026-09): 予約サイトからの取得に失敗したとき、前回成功した分（KV: `ICAL_CACHE`）を使うようにしました。応答ヘッダー `X-Merger-Sources` で各サイトの状態（live / cached / stale / missing）が見えます。KVが未設定でも v1.0 と同じ動きで動きます。すでにお使いの方の更新手順は教材本編の第5章をご覧ください

## 免責事項

本コードの利用により生じたいかなる損害（同期遅延・ダブルブッキング等を含む）についても、作者は責任を負いません。自己責任でご利用ください。個別サポートは行っていません。
