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

- `src/index.js` — 中継マージャー本体（各カレンダーを取得→宿泊日をマージ→1本のiCalとして配信）
- `wrangler.toml` — Cloudflare Workersの設定ファイル

## 免責事項

本コードの利用により生じたいかなる損害（同期遅延・ダブルブッキング等を含む）についても、作者は責任を負いません。自己責任でご利用ください。個別サポートは行っていません。
