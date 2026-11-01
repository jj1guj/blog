# 記事の自動投稿

Hugo のホーム RSS を30秒ごとに確認し、新しい記事を Hollo に投稿します。1記事を1投稿とし、記事 URL、タイトル、本文の順に全文を送信します。送信時の公開範囲は `public`、言語は `ja` です。

RSS の本文は Hugo が生成した HTML から Markdown に変換します。画像とリンクの相対 URL は記事 URL を基準に絶対 URL にします。コード、表、画像のキャプション、数式の TeX も本文に含めます。変換できない要素がある場合は投稿せず、エラーを出します。動画や iframe、見出し行のない表、セルを結合した表、セル内に段落や改行を含む表などが対象です。

画像は Markdown 内の画像リンクとして送信し、Hollo のメディア添付としてはアップロードしません。画像や数式を含む投稿の表示は、受信側のソフトウェアによって異なります。ブログ側の画像サイズやリンクプレビューの設定も投稿先には引き継がれません。

## 投稿の開始と更新

`.env` に OAuth で発行した `HOLLO_ACCESS_TOKEN` を設定します。通常構成では `PUBLISH_ENABLED=true` が既定です。開発用の `compose.dev.yml` では自動投稿は無効です。

`BLOG_URL` は Hugo、Caddy、publisher と Hollo のメディア URL で共通に使います。末尾の `/` は付けないでください。Caddy はこの URL の `http` または `https` を Hollo に伝えるため、公開環境ではブログの HTTPS URL を指定してください。空欄の場合、通常構成では `https://BLOG_DOMAIN`、開発用構成では `http://127.0.0.1:CADDY_PORT` を使います。

初回起動時は、既に RSS にある記事を投稿せず記録します。初回から既存記事を投稿したい場合は、起動前に `PUBLISH_EXISTING_ON_FIRST_RUN=true` に設定してください。この設定は投稿対応表を初期化するときだけ使います。書きかけの記事は `draft: true` にしておいてください。公開状態の記事を保存すると、Hugo のビルド後に投稿対象になります。

投稿済み記事の修正や削除は Hollo に反映されません。同じパスの記事を再公開しても、自動では再投稿しません。

更新前に、Hollo のデータベースとメディア、投稿対応表などをバックアップしてください。投稿対応表には投稿済みの記事と投稿 ID が記録されています。保持したまま更新することで、記録済みの記事の重複投稿を防ぎます。稼働中の環境を更新する場合は、更新作業の前に `docker compose stop publisher` で自動投稿を停止してください。

変更を通常構成に反映する場合は、publisher のイメージをビルドし、Hollo と publisher を起動し直します。トークンが設定されている場合は、自動投稿が始まります。

```sh
docker compose build publisher
docker compose up -d hollo publisher
```

旧形式の RSS が残っている間は全文として扱わず、Hugo の再ビルドを待ちます。処理の状況は `docker compose logs -f hugo publisher` で確認できます。

## 閲覧数とFediverseの反応

タイトル下の日付のすぐ下に、GoatCounterの閲覧数を表示します。閲覧数はブログ記事へのアクセスのみで、Fediverse上のタイムラインの閲覧は含みません。投稿対応表に記事の記録がある場合は、同じ位置にHolloのいいね、ブースト、絵文字リアクションもアイコン付きで表示します。ヘッダーにはブログのハンドルとフォロワー数を表示します。下書きに反応欄は表示されません。

記事末尾のフッターには、コメント数とコメント一覧だけを配置します。返信、返信への返信、引用投稿は分けず、同じコメント欄にまとめて表示します。同じ投稿が返信と引用の両方に該当する場合は重複させず、表示した投稿の数をコメント数とします。各コメントには投稿者、本文、日時、元の投稿へのリンクが付きます。取得できるのはHolloが受信した公開・未収載の投稿で、引用はHolloが承認したものに限ります。

この構成ではHolloの安定版 `latest` を使います。Hollo 0.9.25では、Holloの投稿をMisskeyの別アカウントから引用すると、Holloがその引用を未承認とみなし、引用一覧に返しません。開発版には、この形式の引用を公開設定に応じて受け入れる変更があります。対応を含む安定版に更新するまでは、Misskeyからの引用は表示されません。

GoatCounterの計測スクリプトと閲覧数の取得は、同じオリジンの `/gc/` 経由で行います。実際の閲覧数を表示するには、GoatCounter側でサイトを作成し、「Allow adding visitor counts on your website」を有効にしてください。本番での手順は[本番運用の開始手順](../docs/production-setup.md#5-goatcounter-のサイトを作る)、ローカル連合確認用の別プロジェクトでの設定手順は、[ローカルの Misskey との連合確認](../docs/local-federation.md#11-閲覧数を表示する)に記載しています。

記録のないページは閲覧数0と表示します。`localhost` やプライベートIPアドレスからのアクセスは、GoatCounterの既定の設定では計測されません。`blog.local` は既定の除外対象ではありません。閲覧数はキャッシュされるため、新しいアクセスがすぐに表示に反映されない場合があります。GoatCounterから閲覧数を取得できない場合も0を表示し、実際の数が不明であることを示す `!` を添えます。開発者コンソールには英語でエラーを出します。

カスタム絵文字とコメント投稿者のアイコンは、`.env` の `MEDIA_PROXY_URL` に指定したHTTPSメディアプロキシ経由で読み込みます。`.env.example` の既定値は `https://media-proxy.jiskey.dev` です。既存の `.env` にこの変数がない場合は追加してください。空欄にすると元のサーバーから直接読み込みます。設定を変更した場合は `docker compose up -d hugo` でHugoコンテナーを作り直してください。ローカルサーバー上の画像は外部メディアプロキシから取得できないため、ローカル連合確認では画像が表示されない場合があります。Unicode絵文字や数値表示には影響しません。

Hollo APIからデータを取得できない場合、該当する表示欄を隠し、開発者コンソールに英語でエラーを出します。返信または引用の取得に失敗した場合、コメント数と一覧は表示されません。コメント本文は許可したHTML要素だけに絞って表示します。

表示処理の自動テストは、Node.js 24以上でリポジトリのルートから実行します。

```sh
npm ci --prefix publisher
node --test tests/fediverse-display.test.mjs
```

## 「リモートで表示」の移動先

Misskey の「リモートで表示」などで、ブラウザーから Hollo の投稿ページ（`/@blog/<投稿ID>`）を開くと、対応する記事へ移動します。publisher は投稿対応表と同じボリュームの `remote-view/` に、投稿ごとの移動用ページを書き出します。Caddy は、ブラウザーからの要求（`Accept` に `text/html` を含み、`application/activity+json` と `application/ld+json` を含まないもの）で、移動用ページがある場合だけこのページを返します。プロフィール（`/@blog`）をブラウザーで開いた場合は、ブログのトップページへ移動します。

Fediverse のサーバーによる ActivityPub の取得は、これまでどおり Hollo が応答するため、連合には影響しません。投稿対応表にない投稿（Hollo のクライアントから直接投稿したものなど）は、Hollo の投稿ページを表示します。移動用ページは publisher の起動時と30秒ごとの確認時に対応表から作り直すため、既存の投稿にも使えます。

反映するには、publisher のイメージをビルドし、Caddy と publisher を起動し直します。

```sh
docker compose build publisher
docker compose up -d --force-recreate caddy publisher
```

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

投稿確認では `compose.dev.yml` を指定しません。開発用構成は下書きも RSS に含め、自動投稿を無効にするためです。代わりに、通常構成に管理用ポートを加えた `compose.admin.yml` を使います。`BLOG_URL` が HTTP の localhost ならローカルで確認できます。

```sh
docker compose -f compose.admin.yml up -d --pull never hugo hollo caddy
```

管理用ポートの `http://localhost:28082/setup` で管理者の初期設定を済ませ、`http://localhost:28082/accounts` でユーザー名 `blog` のアカウントを作成します。`/setup` は公開側のポート（28080）では開けません。管理用ポートは Hollo に `BLOG_URL` のホスト名を伝えるため、ハンドルは `@blog@localhost:28080` になります。ブラウザーでも `127.0.0.1` ではなく `localhost` を使ってください。

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

`@blog@localhost:28080` のようなポート付きのハンドルは、Misskeyが自サーバーと同じホストとして扱ってしまうため、照会できません。ポートのないテスト用ホスト名 `blog.local` とローカル専用プロキシを使う手順を [docs/local-federation.md](../docs/local-federation.md) にまとめています。

`compose.dev.yml` は本番では使わないでください。下書きを公開し、プライベートアドレスへの通信を許可するためです。
