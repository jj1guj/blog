# 本番運用の開始手順

Hollo の管理者・アカウントの作成と GoatCounter のサイト作成は、Cloudflare Tunnel を通さない管理用ポートからブラウザーで行います。

## 公開側と管理用ポート

Hollo は管理者が 1 人もいない間、`/setup` を開いた人に管理者の作成を許します。GoatCounter もサイトが 1 件もない間は、どのパスでもサイトと管理者の作成画面を返します。そのため Caddy は、Cloudflare Tunnel の転送先になる公開側で、次の要求を常に `404` にします。

| 公開側の入口 | 塞ぐ要求 |
| --- | --- |
| ブログ（`CADDY_PORT`） | Hollo の `/setup`、`/gc/` のうち計測用（`/gc/count`、`/gc/count.js`、`/gc/counter/*`）以外 |
| GoatCounter（`STATS_PORT`） | サイト作成フォームの送信先（`POST /`） |

塞ぐのは初回設定にしか使わない入口なので、設定後もこのままで問題ありません。そのため、Cloudflare Tunnel を先に設定していても、第三者に管理者を作られることはありません。

初回設定には、`127.0.0.1` だけで待ち受ける次の管理用ポートを使います。この 2 つは Cloudflare Tunnel に登録しないでください。

| 管理用ポート | 既定値 | 内容 |
| --- | --- | --- |
| `HOLLO_ADMIN_PORT` | `28082` | Hollo の画面すべて（`/setup` を含む） |
| `STATS_ADMIN_PORT` | `28083` | GoatCounter の画面すべて |

管理用ポートは、Hollo には `BLOG_URL` のホスト名、GoatCounter には `STATS_DOMAIN` への要求として渡します。そのため、管理用ポートで作ったアカウントの URL も `https://<BLOG_DOMAIN>/@blog` になります。

## 1. リポジトリと `.env` を用意する

テーマはサブモジュールなので、`--recurse-submodules` を付けて取得します。

```sh
git clone --recurse-submodules https://github.com/jj1guj/blog.git
cd blog
cp .env.example .env
```

付けずに取得済みの場合は、`git submodule update --init` を実行してください。テーマがないと Hugo のビルドが失敗し、ブログのページの代わりに Hollo の画面が表示されます。

`.env` の次の項目を変更します。

```dotenv
BLOG_DOMAIN=blog.jj1guj.net
STATS_DOMAIN=blog-stats.jj1guj.net
BLOG_URL=
POSTGRES_PASSWORD=（英数字の長いランダムな値）
HOLLO_SECRET_KEY=（44 文字以上のランダムな値）
```

ランダムな値は、たとえば `openssl rand -hex 32` で作れます。`BLOG_URL` は空欄のままにすると `https://BLOG_DOMAIN` になります。

## 2. 起動する

```sh
docker compose up -d
```

## 3. 管理用ポートに接続する

サーバーの上のブラウザーで開く場合は、そのまま `http://localhost:28082` などを開きます。

別の PC のブラウザーから設定する場合は、SSH のポート転送を使います。`user@server` は実際のログイン先に置き換えてください。

```sh
ssh -L 28082:127.0.0.1:28082 -L 28083:127.0.0.1:28083 user@server
```

接続している間は、手元の PC で `http://localhost:28082` と `http://localhost:28083` を開けます。

アドレスは `127.0.0.1` ではなく `localhost` を使ってください。Hollo のログイン Cookie には、公開側に合わせて `Secure` 属性が付きます。ブラウザーは `localhost` の場合だけ、HTTP でもこの Cookie を受け取ります。Chrome で動作を確認しています。

## 4. Hollo の管理者とアカウントを作る

1. `http://localhost:28082/setup` を開き、管理者のメールアドレスとパスワードを登録します。
2. ログイン画面が表示されたら、登録したメールアドレスとパスワードでログインします。
3. `http://localhost:28082/accounts/new` で、ユーザー名 `blog` のアカウントを作成します。

## 5. GoatCounter のサイトを作る

1. `http://localhost:28083/` を開きます。
2. サイトの作成画面で、ドメイン欄が `STATS_DOMAIN` の値（`blog-stats.jj1guj.net`）になっていることを確かめます。メールアドレスとパスワードを入力して作成します。
3. 「Settings」→「Site settings」で「Allow adding visitor counts on your website」を有効にして保存します。

後からログインし直す場合は、`http://localhost:28083/user/new` を開きます。

## 6. Cloudflare Tunnel を設定する

cloudflared はホストの systemd で動かします。Compose には含めません。転送先は次の 2 つだけです。

| 公開ホスト名 | 転送先 |
| --- | --- |
| `blog.jj1guj.net` | `http://localhost:28080` |
| `blog-stats.jj1guj.net` | `http://localhost:28081` |

管理用ポート（`28082`、`28083`）は登録しないでください。Cloudflare の「Bot Fight Mode」はオフにします。オンのままだと、ほかの Fediverse サーバーからの要求が止められ、連合できません。

設定後、別の端末から次を実行し、`https://blog.jj1guj.net/@blog` と表示されることを確認します。

```sh
curl --fail --silent --show-error \
  -H 'Accept: application/activity+json' \
  https://blog.jj1guj.net/@blog | jq -r '.id'
```

## 7. 自動投稿のアクセストークンを発行する

[記事の自動投稿](../publisher/README.md#oauth-トークンの取得) の手順に従います。URL の `http://localhost:28080` は、管理用ポートの `http://localhost:28082` に置き換えてください。発行したトークンは `.env` の `HOLLO_ACCESS_TOKEN` に設定し、`docker compose up -d publisher` で publisher を作り直します。
