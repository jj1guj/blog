# ローカルの Misskey との連合確認

Cloudflare Tunnel を使わずに、手元で動かしている Misskeyから次の操作を確認する手順です。

- ブログのアカウントの検索
- フォロー
- 記事の全文投稿の受信

ホストの80番ポートは使いません。Misskey のソースも変更しません。

## 仕組み

テスト用のハンドルは `@blog@blog.local` です。ポートを含まないホスト名を使う理由は次のとおりです。

- Misskey は `localhost:28080` のようなポート付きのホスト名を、自サーバー（`localhost:61812`）と同じホストとして扱います（Misskey の `UtilityService.toPuny()` で確認）。そのため `@blog@localhost:28080` は照会できません。
- `http://blog.local` は既定でポート80に接続しようとします。ホストの80番を開かないよう、ローカル専用のプロキシ [tools/local-fediverse-proxy.cjs](../tools/local-fediverse-proxy.cjs) を経由して Caddy の `28080` へ届けます。

```text
ブラウザー・Misskey ──→ プロキシ 127.0.0.1:28084 ──→ Caddy 127.0.0.1:28080
                                                        │
Hollo コンテナー ──→ blog.local（Docker ネットワーク内の別名）─┘
Hollo コンテナー ──→ localhost:61812（socat で中継）──→ ホストの Misskey
```

Hollo からの通信には、[compose.dev.yml](../compose.dev.yml) の次の設定を使います。

- `caddy` のネットワーク別名 `${BLOG_DOMAIN}`：Hollo が自分の Actor（`http://blog.local/@blog`）を取得できるようにします。
- `local-fediverse-relay`：Hollo コンテナー内の `localhost:61812` を、ホストの Misskey へ中継します。
- `ALLOW_PRIVATE_ADDRESS=true`：Hollo に localhost やプライベートアドレスとの通信を許可します。

Hollo はアカウント作成時のホスト名を DB に保存します。既存の環境のアカウントを残すため、Compose のプロジェクト名を `blog-fedi-test` に分け、別の DB とボリュームを使います。作業ディレクトリと `.env` は開発環境と同じものを使います。

## 前提

- [開発環境のセットアップ](development-setup.md)が済んでいること。
- Misskey がホストで `pnpm dev` によって動いており、URL が `http://localhost:61812` であること。ポートが異なる場合は、`.env` の `LOCAL_FEDIVERSE_PORT` を変更してください。
- Node.js 20.6 以降（プロキシの起動に `--env-file` を使います）。
- 以下のコマンドは、特に断りがなければリポジトリのルートで実行します。

## 1. 既存のブログを一時停止する

ホストの `28080` を空けるため、また既存の publisher がテスト記事を投稿しないよう、既存環境の一部を止めます。再開時のために、停止前の状態を控えておいてください。

```sh
docker compose -f compose.dev.yml ps -a
docker compose -f compose.dev.yml stop caddy goatcounter hugo publisher
```

既存の Hollo と PostgreSQL は動いたままでも問題ありません。

## 2. `.env` を変更する

変更前の値を控えてから、[.env](../.env) の該当項目を次のようにします。DB のユーザー名とパスワードは変更不要です。`LOCAL_PROXY_PORT` がなければ追加します。

```dotenv
BLOG_DOMAIN=blog.local
BLOG_URL=http://blog.local
CADDY_PORT=28080
LOCAL_FEDIVERSE_PORT=61812
LOCAL_PROXY_PORT=28084

HOLLO_ACCESS_TOKEN=
PUBLISH_ENABLED=false
PUBLISH_EXISTING_ON_FIRST_RUN=false
```

## 3. テスト用の環境を起動する

`blog-fedi-test` というプロジェクト名を以前に別の用途で使っていないか確認します。

```sh
docker volume ls --filter label=com.docker.compose.project=blog-fedi-test
```

起動します。Caddy が依存する Hugo と GoatCounter も起動します。

```sh
docker compose -p blog-fedi-test -f compose.dev.yml \
  up -d --pull never caddy hollo local-fediverse-relay
```

## 4. プロキシを起動する

別の端末を開き、リポジトリのルートで次を実行します。確認が終わるまで起動したままにします。

```sh
node --env-file=.env tools/local-fediverse-proxy.cjs
```

`Local proxy listening on 127.0.0.1:28084` と表示されれば成功です。

- 待ち受けるのは `127.0.0.1` だけです。
- `http://blog.local` 以外への接続は `403` で拒否します。
- シェルに `BLOG_DOMAIN` などを `export` している場合、`.env` よりそちらが優先されます。
- `.env` を変更したら、プロキシを起動し直してください。

## 5. ブラウザーのプロキシを設定する

### Safari・Chrome・Edge（macOS のシステム設定）

この設定は、システムのプロキシを使うほかのアプリにも影響します。

1. Apple メニュー →「システム設定」→「ネットワーク」を開きます。
2. 使用中の「Wi-Fi」または「Ethernet」の「詳細」→「プロキシ」を開きます。
3. 現在の設定を控えます。
4. 「Webプロキシ（HTTP）」をオンにし、サーバーに `127.0.0.1`、ポートに `28084` を入力します。認証はオフのままにします。HTTPS のプロキシは変更しません。
5. 「プロキシ設定を使用しないホストとドメイン」を次のようにします。`*.local` が残っていると `blog.local` がプロキシを通らないため、確認中は削除します。

   ```text
   localhost,127.0.0.1,169.254/16
   ```

6. 「OK」を押します。

### Firefox

1. 「設定」→「一般」→「ネットワーク設定」→「接続設定」を開きます。
2. 「手動でプロキシーを設定する」を選び、HTTP プロキシーに `127.0.0.1`、ポートに `28084` を入力します。
3. 「このプロキシーを HTTPS にも使用する」はオフにします。
4. 「プロキシーを使用しないアドレス」に `localhost, 127.0.0.1` を入れ、`*.local` などがあれば確認中は削除します。

## 6. Hollo の初期設定とアカウントを作る

1. ブラウザーで管理用ポートの `http://localhost:28082/setup` を開き、管理者を作成します。`/setup` は `http://blog.local` からは開けません。ポートを変更している場合は、`.env` の `HOLLO_ADMIN_PORT` に置き換えてください。
2. `http://localhost:28082/accounts/new` で、ユーザー名 `blog` のアカウントを作成します。管理用ポートは Hollo に `blog.local` として要求を渡すため、アカウントの URL は `http://blog.local/@blog` になります。

アカウントの URL を確認します。

```sh
curl --fail --silent --show-error \
  --noproxy '' --proxy http://127.0.0.1:28084 \
  -H 'Accept: application/activity+json' \
  http://blog.local/@blog | jq -r '.id'
```

`http://blog.local/@blog` と表示されれば成功です。

## 7. Misskey を設定する

Misskey の `.config/default.yml` を編集します。

```yaml
# Proxy for HTTP/HTTPS
proxy: http://127.0.0.1:28084

proxyBypassHosts:
  - api.deepl.com
  - api-free.deepl.com
  - www.recaptcha.net
  - hcaptcha.com
  - challenges.cloudflare.com
  - localhost
  - 127.0.0.1
```

- `#proxy:` の行は、先頭の `#` を外して有効にします。コメントのままだとプロキシは使われません。
- `proxyBypassHosts` には、既存の項目を残したまま `localhost` と `127.0.0.1` を追加します。`blog.local` は追加しません。
- このプロキシを設定している間、Misskey から `blog.local` 以外への外向き通信は失敗します。

Misskey を `Ctrl+C` で止め、WebFinger を HTTP で問い合わせる設定を付けて起動し直します。

```sh
cd /path/to/misskey
env MISSKEY_WEBFINGER_USE_HTTP=true pnpm dev
```

起動後、設定が反映されたか確認します。

```sh
cd /path/to/misskey
node -e 'const c=require("./built/.config.json");console.log(c.proxy)'
```

`http://127.0.0.1:28084` と表示されれば反映されています。`undefined` の場合は、`proxy:` の行がコメントのままになっています。

## 8. 検索・フォローする

Misskey（`http://localhost:61812`）で `@blog@blog.local` を検索し、フォローします。

Hollo 側のフォロワー数は次で確認できます。

```sh
curl --fail --silent --show-error \
  --noproxy '' --proxy http://127.0.0.1:28084 \
  --get --data-urlencode 'acct=blog' \
  http://blog.local/api/v1/accounts/lookup | jq '{acct, followers_count}'
```

## 9. アクセストークンを発行する

ここで扱う `client_secret`、認可コード、アクセストークンは秘密値です。チャットやログに貼らないでください。

### アプリを登録する

```sh
curl --fail --silent --show-error \
  --noproxy '' --proxy http://127.0.0.1:28084 \
  --data-urlencode 'client_name=Hugo Publisher' \
  --data-urlencode 'redirect_uris=urn:ietf:wg:oauth:2.0:oob' \
  --data-urlencode 'scopes=write:statuses' \
  http://blog.local/api/v1/apps
```

応答の `client_id` と `client_secret` を控えます。

### 認可コードを取得する

次の URL の `CLIENT_ID` を置き換え、プロキシを設定したブラウザーで開きます。管理者でログインし、`blog` アカウントを選んで許可します。

```text
http://blog.local/oauth/authorize?response_type=code&client_id=CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=write:statuses
```

**画面に表示されるのは認可コードで、アクセストークンではありません。** このまま `.env` に設定すると、投稿が `HTTP 401` になります。認可コードの有効期間は10分です。

### 認可コードをアクセストークンと交換する

表示された認可コードを使い、すぐに次を実行します。`CLIENT_ID` は置き換えます。

- 「認可コード:」と表示されたら、認可コードを貼り付けて Enter を押します。入力した文字は表示されません。
- パスワードを求められたら、`client_secret` を入力します。

fish の場合：

```fish
read --silent --prompt-str '認可コード: ' AUTHORIZATION_CODE
printf '%s' $AUTHORIZATION_CODE | curl --fail --show-error --silent \
  --noproxy '' --proxy http://127.0.0.1:28084 \
  --user 'CLIENT_ID' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode 'redirect_uri=urn:ietf:wg:oauth:2.0:oob' \
  --data-urlencode 'code@-' \
  http://blog.local/oauth/token
set -e AUTHORIZATION_CODE
```

bash・zsh の場合：

```sh
printf '認可コード: '; read -rs AUTHORIZATION_CODE; printf '\n'
printf '%s' "$AUTHORIZATION_CODE" | curl --fail --show-error --silent \
  --noproxy '' --proxy http://127.0.0.1:28084 \
  --user 'CLIENT_ID' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode 'redirect_uri=urn:ietf:wg:oauth:2.0:oob' \
  --data-urlencode 'code@-' \
  http://blog.local/oauth/token
unset AUTHORIZATION_CODE
```

応答は `{"access_token":"…","token_type":"Bearer",…}` の形です。

## 10. 全文投稿を確認する

### publisher を起動する

`.env` を次のように変更します。

```dotenv
HOLLO_ACCESS_TOKEN=取得したaccess_tokenの値
PUBLISH_ENABLED=true
PUBLISH_EXISTING_ON_FIRST_RUN=false
```

開発用構成の Hugo は下書きもビルドするため、そのまま publisher を動かすと下書きも投稿されます。Hugo と publisher だけを通常構成で起動し直します。Caddy と Hollo は開発用構成のまま残します。

```sh
docker compose -p blog-fedi-test -f compose.yml \
  up -d --pull never --no-deps hugo

docker compose -p blog-fedi-test -f compose.yml build publisher

docker compose -p blog-fedi-test -f compose.yml \
  up -d --pull never --no-deps publisher
```

トークンを変更したときも、`up -d` で publisher を作り直してください。`restart` では新しい環境変数が反映されません。

publisher の初回処理が終わるまで待ちます。

```sh
curl --fail --silent --show-error \
  --noproxy '' --proxy http://127.0.0.1:28084 \
  http://blog.local/fediverse/posts.json | jq '.initialized'
```

`true` になれば完了です。初回処理では、すでにある記事は投稿されません。

### テスト記事を作る

`true` になった後で、まだ使っていないパスに記事を作成します。例えば `content/posts/fediverse-fulltext-test/index.md` に次の内容を書きます。未来の日付は指定しないでください。

```markdown
---
title: "全文投稿の確認"
date: 2026-11-01T10:00:00+09:00
draft: false
---

確認開始。

ここに本文を貼り付けます。

確認終了。
```

3,000文字を超える本文を試す場合は、次の出力を本文に貼り付けます。

```sh
node -e 'console.log("本文確認。".repeat(650))'
```

保存すると、通常は30秒ほどで投稿されます。ログは次で確認できます。

```sh
docker compose -p blog-fedi-test -f compose.yml logs -f publisher
```

Misskey のタイムラインで、次の点を確認します。

- 記事の URL が先頭にあること
- タイトルと本文が続くこと
- 末尾の「確認終了。」まで届いていること

## 11. 閲覧数を表示する

表示を確認するだけなら、GoatCounterのサイト作成は不要です。閲覧数を取得できない場合は0を仮表示し、横に `!` を添えます。

実際の閲覧数を表示するには、GoatCounter のサイトを作成します。`blog-fedi-test` は既存環境と別の GoatCounter データを使います。すでに作成済みの場合は、設定画面の確認から進めてください。

1. 管理用ポートの `http://localhost:28083/` を開きます。ポートを変更している場合は、`.env` の `STATS_ADMIN_PORT` に置き換えてください。サイトの作成画面が表示されたら、ドメイン欄が `STATS_DOMAIN` の値になっていることを確かめ、メールアドレスとパスワードを入力して作成します。作成済みの場合は、`http://localhost:28083/user/new` でログインします。
2. 「Settings」→「Site settings」で「Allow adding visitor counts on your website」を有効にして保存します。
3. 記事ページを再読み込みします。記録がなければ閲覧数は0と表示されます。`localhost` で開いたページは、GoatCounter の既定の設定では計測されません。`blog.local` は既定の除外対象ではありません。

GoatCounter のサイトが未作成の場合、`/gc/counter/` への要求は `307` と `Location: /` を返します。設定を保存しても閲覧数が表示されない場合は、ブラウザーの開発者コンソールで `Failed to load GoatCounter pageview count` を確認してください。`403` の場合は、手順2の設定を確認します。

## 12. 終了後の片付け

1. テスト用の環境を停止します。ボリュームは削除されません。

   ```sh
   docker compose -p blog-fedi-test -f compose.dev.yml stop
   ```

2. プロキシを起動した端末で `Ctrl+C` を押して止めます。
3. ブラウザーのプロキシ設定と除外リスト（元は `*.local,169.254/16` など）を戻します。
4. Misskey の `proxy:` の行をコメントに戻し、追加した `localhost` と `127.0.0.1` を削除します。`MISSKEY_WEBFINGER_USE_HTTP` を付けずに `pnpm dev` で起動し直します。
5. `.env` を手順2で控えた値に戻します。
6. **既存の publisher を再開する前に、テスト記事を削除または移動します。** 残っていると、既存環境で新しい記事として投稿されます。記事を削除しても、テスト用 Hollo の投稿は自動では削除されません。
7. 手順1で止めたサービスのうち、止める前に動いていたものを再開します。

   ```sh
   docker compose -f compose.dev.yml start hugo goatcounter caddy
   docker compose -f compose.dev.yml start publisher
   ```

## うまくいかないとき

| 症状 | 原因と対処 |
| --- | --- |
| Misskey のログに `cacheableLookup ENOTFOUND blog.local` | Misskey がプロキシを使っていません。`default.yml` の `proxy:` が有効か、手順7の確認コマンドで確かめてください。 |
| 検索はできるがフォローできない。Hollo のログに `getaddrinfo EAI_AGAIN blog.local` | Hollo のコンテナーから `blog.local` に届いていません。`compose.dev.yml` の `caddy` にネットワーク別名 `${BLOG_DOMAIN}` があることを確認し、`compose.dev.yml` を付けて Caddy を作り直してください。 |
| publisher のログに `Failed to post to Hollo: HTTP 401` | `.env` に認可コードなど、アクセストークン以外の値が入っています。手順9でトークンと交換し、publisher を `up -d` で作り直してください。 |
| プロキシ経由のアクセスが `403` | `.env` の `BLOG_DOMAIN` と、アクセスしたホスト名が一致していません。`.env` を変えた後は、プロキシを起動し直してください。 |
| プロキシ経由のアクセスが `502` | Caddy が `CADDY_PORT` で動いていません。手順3を確認してください。 |

Hollo の初期設定で公式アカウント（`@hollo@hollo.social`）をフォローした場合、Hollo のログに `hollo.social` への送信失敗（`401`）が繰り返し出ます。`http://blog.local` は外部から取得できないためで、Misskey との確認には影響しません。気になる場合は、Hollo の画面でそのフォローを解除してください。

[compose.dev.yml](../compose.dev.yml) はローカル確認専用です。下書きを公開し、プライベートアドレスへの通信を許可するため、本番では使わないでください。
