# 記事の自動投稿

Hugo のホーム RSS を30秒ごとに確認し、新しい記事を Hollo に投稿します。1記事を1投稿とし、記事 URL、タイトル、本文の順に全文を送信します。送信時の公開範囲は `public`、言語は `ja` です。

RSS の本文は Hugo が生成した HTML から Markdown に変換します。画像とリンクの相対 URL は記事 URL を基準に絶対 URL にします。コード、表、画像のキャプション、数式の TeX も本文に含めます。変換できない要素がある場合は投稿せず、エラーを出します。動画や iframe、見出し行のない表、セルを結合した表、セル内に段落や改行を含む表などが対象です。

画像は Markdown 内の画像リンクとして送信し、Hollo のメディア添付としてはアップロードしません。画像や数式を含む投稿の表示は、受信側のソフトウェアによって異なります。ブログ側の画像サイズやリンクプレビューの設定も投稿先には引き継がれません。

## 投稿の開始と更新

`.env` に OAuth で発行した `HOLLO_ACCESS_TOKEN` を設定します。通常構成では `PUBLISH_ENABLED=true` が既定です。開発用の `compose.dev.yml` では自動投稿は無効です。

`BLOG_URL` は Hugo、Caddy、publisher と Hollo のメディア URL で共通に使います。末尾の `/` は付けないでください。Caddy はこの URL の `http` または `https` を Hollo に伝えるため、公開環境ではブログの HTTPS URL を指定してください。空欄の場合、通常構成では `https://BLOG_DOMAIN`、開発用構成では `http://127.0.0.1:CADDY_PORT` を使います。

リポジトリのルートで `sh tests/caddy.sh` を実行すると、Docker 上の隔離された Caddy で転送先と URL のスキームを確認できます。稼働中のサービスにはアクセスしません。

初回起動時は、既に RSS にある記事を投稿せず記録します。初回から既存記事を投稿したい場合は、起動前に `PUBLISH_EXISTING_ON_FIRST_RUN=true` に設定してください。この設定は投稿対応表を初期化するときだけ使います。書きかけの記事は `draft: true` にしておいてください。公開状態の記事を保存すると、Hugo のビルド後に投稿対象になります。

投稿済み記事の修正や削除は Hollo に反映されません。同じパスの記事を再公開しても、自動では再投稿しません。

更新前に、Hollo のデータベースとメディア、投稿対応表などをバックアップしてください。投稿対応表には投稿済みの記事と投稿 ID が記録されています。保持したまま更新することで、記録済みの記事の重複投稿を防ぎます。稼働中の環境を更新する場合は、更新作業の前に `docker compose stop publisher` で自動投稿を停止してください。

変更を通常構成に反映する場合は、publisher のイメージをビルドし、Hollo と publisher を起動し直します。トークンが設定されている場合は、自動投稿が始まります。

```sh
docker compose build publisher
docker compose up -d hollo publisher
```

旧形式の RSS が残っている間は全文として扱わず、Hugo の再ビルドを待ちます。処理の状況は `docker compose logs -f hugo publisher` で確認できます。

## 投稿文字数

投稿前に Hollo の `/api/v2/instance` から公称上限を取得します。取得できない場合や値が不正な場合は投稿しません。文字数は、URL とタイトルを含む送信用 Markdown の Unicode コードポイント数で数えます。URL も実際の長さで数え、Hollo が返す `characters_reserved_per_url` に置き換える方式は使いません。Hollo の API や他のサーバーが使う文字数の数え方とは異なる場合があります。

上限を超えた記事は省略も分割もせず、エラーをログに出します。対応表には投稿済みとして記録しないため、次の確認時に再試行します。ほかの新しい記事は引き続き投稿します。

## Hollo の数式設定

`HOLLO_MARKDOWN_EXTENSIONS` の既定値は `math,tasklist` です。Hollo が対応している場合、`math` は数式、`tasklist` はチェックリストの Markdown 拡張を有効にします。この設定は自動投稿だけでなく、Hollo で書くほかの投稿にも適用されます。

Hollo の開発版にはこの設定がありますが、確認に使用した 0.9.25 イメージにはありません。対応していないバージョンでは投稿内の数式は描画されません。`latest` イメージが開発中のソースと同じ機能を持つとは限らないため、更新前にリリース内容を確認してください。

## localhost での全文投稿確認

この手順では Cloudflare Tunnel を使わず、Hollo への投稿を確認します。ローカルの Misskey との連合は、この手順の `localhost:28080` では確認できません。[ローカルの Misskey との連合確認](../docs/local-federation.md) を参照してください。DB のユーザー名とパスワードは変更不要です。以下の URL は `CADDY_PORT=28080` の例です。

### 設定とアカウント作成

`.env` に次を設定します。

```dotenv
BLOG_URL=http://localhost:28080
PUBLISH_ENABLED=false
PUBLISH_EXISTING_ON_FIRST_RUN=false
```

投稿確認では `compose.dev.yml` を指定しません。開発用構成は下書きも RSS に含め、自動投稿を無効にするためです。通常構成を使っても、`BLOG_URL` が HTTP の localhost ならローカルで確認できます。

```sh
docker compose -f compose.yml up -d --pull never hugo hollo caddy
```

`http://localhost:28080/setup` で管理者の初期設定を済ませ、`http://localhost:28080/accounts` でユーザー名 `blog` のアカウントを作成します。ブラウザーでも `127.0.0.1` ではなく `localhost` を使ってください。作成時のホスト名が保存され、ハンドルは `@blog@localhost:28080` になります。

この DB はローカル検証用です。後から `BLOG_URL` を変更するだけでは、保存済みのアカウントは本番ドメインに変わりません。本番は別の Compose プロジェクトとボリュームを使い、公開ドメインで新しいアカウントを作成してください。検証用ボリュームを削除する必要はありません。

### OAuth トークンの取得

以下の応答には秘密値が含まれます。端末で確認するだけにし、チャットに貼らないでください。Hollo のログにもアプリの秘密値が含まれることがあるため、ログ共有にも注意してください。

まずアプリを登録します。

```sh
curl --fail --silent --show-error \
  --data-urlencode 'client_name=Hugo Publisher' \
  --data-urlencode 'redirect_uris=urn:ietf:wg:oauth:2.0:oob' \
  --data-urlencode 'scopes=write:statuses' \
  http://localhost:28080/api/v1/apps
```

応答の `client_id` と `client_secret` を手元に控えます。次の URL の `CLIENT_ID` を取得した値に置き換え、ブラウザーで開きます。

```text
http://localhost:28080/oauth/authorize?response_type=code&client_id=CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=write:statuses
```

管理者としてログインし、対象の `blog` アカウントを選んで許可すると、認可コードが画面に表示されます。コードの有効期間は10分です。

次の `CLIENT_ID` と `AUTHORIZATION_CODE` を置き換えて実行します。`curl` のパスワード入力には `client_secret` を入力してください。秘密値をコマンド引数に直接書く必要はありません。

```sh
curl --fail --silent --show-error \
  --user 'CLIENT_ID' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode 'redirect_uri=urn:ietf:wg:oauth:2.0:oob' \
  --data-urlencode 'code=AUTHORIZATION_CODE' \
  http://localhost:28080/oauth/token
```

応答の `access_token` を `.env` の `HOLLO_ACCESS_TOKEN` に設定し、`PUBLISH_ENABLED=true` に変更します。

### 投稿の確認

```sh
docker compose -f compose.yml build publisher
docker compose -f compose.yml up -d --pull never --no-deps publisher
docker compose -f compose.yml logs -f publisher
```

初回の確認が終わるまで待ちます。別の端末で `curl --fail http://localhost:28080/fediverse/posts.json` を実行し、`"initialized": true` になっていることを確認してください。既存記事は投稿されません。

その後、まだ使っていないパスに記事を作成します。例えば `content/posts/local-fulltext-test/index.md` に次のように書きます。未来の日付は指定しないでください。

```markdown
---
title: "全文投稿の確認"
date: 2026-10-31T00:00:00+09:00
draft: false
---

確認開始。

ここに確認する本文を入れます。

確認終了。
```

3000文字超の本文を試す場合は、`node -e 'console.log("本文確認。".repeat(650))'` の出力を本文に貼り付けられます。保存後、通常は30秒程度で投稿されます。

`http://localhost:28080/@blog` と投稿対応表で投稿を確認します。記事 URL が先頭にあること、タイトルと本文が続くこと、末尾の「確認終了。」まであることを確認してください。

記事を削除しても Hollo の投稿は自動削除されません。確認が終わったら `docker compose -f compose.yml stop publisher` で投稿を停止できます。

## ローカルの Misskey との連合確認

`@blog@localhost:28080` のようなポート付きのハンドルは、Misskey（Jiskey で確認）が自サーバーと同じホストとして扱ってしまうため、照会できません。ポートのないテスト用ホスト名 `blog.local` とローカル専用プロキシを使う手順を [docs/local-federation.md](../docs/local-federation.md) にまとめています。

`compose.dev.yml` は本番では使わないでください。下書きを公開し、プライベートアドレスへの通信を許可するためです。
