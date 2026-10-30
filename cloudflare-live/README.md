# boat-check-live（LIVE配信Worker・未配置）

`upload_live.py` が毎回の収集後に送る公開ビュー（`home-live.json`／`settlements.json`／`venue/NN.json`／`venue-live/NN.json`）をWorkers KVに保存し、ブラウザへ配信します。
ブラウザは `live-config.js` の `BOAT_CHECK_LIVE_BASE` が設定されているときだけこのWorkerを読みます。失敗した場合は、コミット済みの静的ファイルに戻ります（app.js `requestLiveJson`）。

- 受け付けるのは上記の公開ビューだけです。`today.json`などは受け付けず、配信もしません。
- 次のものは拒否します：トークンの不一致、24場の一覧がない、場データの日付がhomeと違う、5分以上未来の時刻。
- 同じ時刻か古いデータは保存しません（`skipped: older version`）。
- 内容が変わっていないファイルは書き込みません（KVの書き込み回数を節約するため）。
- CORSは `https://boatcheck.jp` と `https://www.boatcheck.jp` だけを許可します。

テスト：`node scripts/test_worker.mjs`（既存）、`node cloudflare-live/test.mjs`（実データの26ファイル・約12MBで検証）

## 配置手順（オーナー作業。Cloudflareアカウントが必要）
1. `cd cloudflare-live && npx wrangler kv namespace create LIVE` を実行し、表示されたidを `wrangler.jsonc` に記入する。
2. `npx wrangler secret put INGEST_TOKEN` を実行する（推測されにくい長いランダム文字列）。
3. `npx wrangler deploy` を実行し、表示されたURL（例：`https://boat-check-live.<subdomain>.workers.dev`）を控える。
4. GitHubの Settings → Secrets and variables → Actions で、次を登録する。
   - Variables：`CF_LIVE_URL` = 手順3のURL
   - Secrets：`CF_LIVE_TOKEN` = 手順2と同じ文字列
5. 次のLIVE実行のログに `[edge] upload accepted` が出ることを確認する。続けて `curl <URL>/home-live.json` で `updatedAt` を確認する。
6. `live-config.js` の `window.BOAT_CHECK_LIVE_BASE` に手順3のURLを設定してコミットする（ここで初めて利用者にWorkerの配信が届く）。
7. 手順6の後、Actions variablesに `LIVE_GIT_EVERY_MINUTES` = `60` を設定する。KVへの配信が成功した回は、gitへのコミットが60分に1回になる。配信に失敗した回は、従来どおりgitにコミットされる。
8. 最後に、`cloudflare-dispatch/` のCronトリガーを有効にする（README参照。最初は `EVERY_MINUTES=15` を推奨）。

## 費用・上限（設定前に確認）
- Workers KVの無料プランは書き込みが1日1,000回までです（料金ページで最新の値を確認してください）。15分間隔なら1日約55回の実行で、変更のあったファイルだけを書いても数百〜千回程度になります。**Workers Paidプラン（月5ドル〜）を推奨**します。
- 1回に送る量は約12MB です（`upload_live.py` の上限は24MB）。
- KVは書き込みが全拠点に反映されるまで最大60秒ほどかかることがあります。

止めるとき：`live-config.js` を空に戻せば、利用者側は即座に静的ファイルの配信へ戻ります。`LIVE_GIT_EVERY_MINUTES` を空にすれば、毎回gitにコミットする動作に戻ります。
