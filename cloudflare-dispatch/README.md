# boat-check-dispatch（LIVE更新の外部トリガー・未配置）

## 目的
`update-data.yml` は `*/5` の設定ですが、GitHubのスケジュール起動は実際には2〜6時間おきになっています（2026-10-23〜30の実行履歴で確認）。
このWorkerはCloudflareのCronから `workflow_dispatch` を呼び出し、既存のLIVE workflowを日本時間の開催時間帯だけ一定の間隔で起動します。
データの取得・加工・公開JSONには触れません。

## 有効化の前に必要な判断（重要）
現在のLIVE処理は、1回ごとに `data/today.json`（約31MB）と分割JSONをmainへコミットします。直近300コミットでリポジトリは約277MBあり、1コミットあたり平均約0.9MBです。

| 起動間隔 | 1日あたりのコミット数（08:00〜21:45） | 増加量の目安 |
|---|---|---|
| 現状（2〜6時間おき） | 約2〜5 | 数MB |
| 15分 | 約55 | 約50MB/日 |
| 5分 | 約165 | 約150MB/日 |

5〜15分間隔で長期運用すると、clone・checkout（`fetch-depth: 0`）が遅くなり、GitHubの推奨サイズも超えます。Cloudflare側がpushごとに自動ビルドする設定なら、ビルド回数も増えます。
そのため、**`cloudflare-live/` のKV配信Workerと `LIVE_GIT_EVERY_MINUTES`（gitへのコミットを間引く設定）を先に有効にし、そのあとでこのトリガーを有効にしてください**（手順は `cloudflare-live/README.md`）。
短期間だけ試す場合は `EVERY_MINUTES` を `30` 程度にして、容量の増え方を確認してください。

## 配置手順（オーナー承認後）
1. GitHubでfine-grained tokenを作成する（対象リポジトリ：`golfclubnavi/boat-check` のみ。権限：Actions = Read and write のみ）。
2. `cd cloudflare-dispatch && npx wrangler secret put GITHUB_TOKEN`
3. `wrangler.jsonc` の `ENABLED` を `"true"` に変更し、`EVERY_MINUTES` を決めて `npx wrangler deploy` を実行する。
4. Actionsの実行履歴で `workflow_dispatch` の起動間隔と処理時間を確認する。
5. 停止するときは `ENABLED` を `"false"` にして再度deployする（またはCron Triggerを削除する）。

テスト：`node cloudflare-dispatch/test.mjs`（ネットワーク不要、fetchは模擬）
