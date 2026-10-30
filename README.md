# Fediverse 連携ブログ（Madblog + GoatCounter）

自宅サーバーで動く、次のようなブログの構成一式です。

- 記事は Markdown のファイルで書く。保存すると公開される
- ブログ自体が Fediverse のアカウント `@blog@blog.example.com` になり、記事はそのまま Fediverse に配信される
- いいね・ブースト・リプライの数と中身が、記事の下に表示される
- フォロワー数が表示される（メニュー内）
- 記事ごとの閲覧数が表示される

## 全体の構成

```
インターネット
   │  HTTPS
cloudflared(systemd)
   ├─ blog.example.com  → localhost:28080  madblog（ブログ ＋ Fediverse サーバー）
   └─ stats.example.com → localhost:28081  goatcounter（閲覧数）
```

| サービス | 役割 | イメージ |
|---|---|---|
| madblog | ブログの表示、Fediverse への配信、リアクションの受け取り | `quay.io/blacklight/madblog:latest` |
| goatcounter | 閲覧数の計測と表示 | `arp242/goatcounter:latest` |

| ファイル | 中身 |
|---|---|
| `docker-compose.yml` | 2つのサービスの定義と、閲覧数を表示するスクリプト |
| `config.yaml` | ブログのタイトル・著者名などの設定 |
| `.env.example` | ドメインやポートの設定のひな形 |
| `data/markdown/` | 記事（Markdown） |
| `data/img/` | 記事で使う画像（`/img/ファイル名` で参照） |
| `data/.madblog/` | Fediverse の鍵・フォロワー・受け取ったリアクション（起動すると作られる） |

## 必要なもの

- Docker と Docker Compose（`docker compose version` が v2.23 以上）
- Cloudflare で管理しているドメインと、systemd で動いている cloudflared

---

## 1. .env を作る

```sh
cd fedi-blog
cp .env.example .env
nano .env        # ドメインとアカウント名を書き換える
```

> ⚠️ `BLOG_DOMAIN` と `FEDI_USERNAME` は、公開してフォロワーがついたあとは変えないでください。
> 変えると別のアカウント扱いになり、フォロワーとの関係が切れます。

## 2. config.yml を作る

```sh
cp config.example.yml config.yml
nano config.yml        # サイト名と著者名を書き換える
```

ブログのタイトル、説明、著者名を書き換えます。
`author_photo` に画像の URL を書くと、Fediverse 上のアイコンにもなります。

## 3. 既存の Cloudflare Tunnel にホスト名を追加する

| ホスト名 | 転送先 |
|---|---|
| blog.example.com | `http://localhost:28080` |
| stats.example.com | `http://localhost:28081` |

- ダッシュボードで管理しているトンネル：「Zero Trust」→「Networks」→「Tunnels」→ 対象トンネルの「Public Hostnames」で追加
- 設定ファイルで管理しているトンネル：`config.yml` の `ingress` に追記し、`cloudflared tunnel route dns <トンネル名> <ホスト名>` で DNS を登録して、`sudo systemctl restart cloudflared`

あわせて **Bot Fight Mode をオフにしてください**（「Security」→「Bots」）。
オンのままだと、他の Fediverse サーバーからの通信がブロックされて連合がうまく動きません。

## 4. 起動する

```sh
docker compose up -d
docker compose logs -f madblog   # エラーが出ていないか確認。Ctrl+C で抜ける
```

## 5. 閲覧数（GoatCounter）を設定する

```sh
docker compose exec -it goatcounter goatcounter db create site \
  -vhost stats.example.com -user.email you@example.com
```

（`-vhost` は `.env` の `STATS_DOMAIN` と同じにします。パスワードは画面の入力欄で聞かれるので、コマンドには書きません）

1. `https://stats.example.com` にログイン
2. 「Settings」で **Allow adding visitor counts on your website** をオンにして保存
   （オフのままだと、記事の閲覧数が表示されません）

## 6. 動作確認

- `https://blog.example.com` でブログが表示される
- Mastodon などで `@blog@blog.example.com` を検索すると、アカウントが見つかってフォローできる
- 右上のメニューにフォロワー数が出る
- 記事の本文の下に 👁 と閲覧数が出る

---

## 記事を書いて公開する

`data/markdown/` に Markdown のファイルを置くと、**保存した時点で公開され、フォロワーのタイムラインにも配信されます**。
コマンドの実行は不要です。ファイル名がそのまま URL になります（`my-post.md` → `/article/my-post`）。

```markdown
[//]: # (title: 記事のタイトル)
[//]: # (description: 一覧に出る短い説明)
[//]: # (tags: #日記, #自宅サーバー)
[//]: # (published: 2026-11-01)
[//]: # (visibility: draft)

本文を Markdown で書きます。
```

- **書いている間は `visibility: draft` を入れておいてください。**
  下書きは一覧にも Fediverse にも出ません（ただし URL を知っていれば誰でも開けます）。
  書き終えたらその行を消して保存すると、公開されて Fediverse に配信されます。
- 公開後に本文を直して保存すると、Fediverse 側の投稿も更新されます。
- ファイルを消すと、Fediverse 側の投稿も削除されます。
- 同梱のサンプル記事（`hello-fediverse.md`）は、公開前に消すか書き換えてください。

### Fediverse からの反応に返信する

`data/replies/記事のファイル名/` に Markdown のファイルを置くと、リプライへの返信やいいねができます。
書き方は Madblog の README の「Author Replies」を参照してください。

---

## カスタマイズ

| やりたいこと | 方法 |
|---|---|
| タイトル・著者・アイコン | `config.yaml` |
| 見た目（CSS） | `data/css/` に Madblog の同名ファイルを置くと置き換わる |
| 閲覧数の表示位置や見た目 | `docker-compose.yml` の `configs:` にあるスクリプト |

設定項目の一覧は、Madblog の README（https://git.fabiomanganiello.com/madblog）の「Configuration」にあります。
`config.yaml` の項目は、`MADBLOG_` で始まる環境変数でも指定できます（環境変数が優先）。

## 運用メモ

- **バックアップ**: `data/` ディレクトリ（特に `data/.madblog/`。Fediverse の鍵とフォロワーが入っている）と、
  `gc_data` ボリューム（閲覧数）です。鍵をなくすと、同じアカウントを作り直せません。
- **更新**: バックアップしてから `docker compose pull && docker compose up -d`。
- **閲覧数**: 広告ブロッカーを使っている読者は計測されないことがあるため、実際より少なめに出ます。
  また、`localhost` からのアクセスは計測されません。
- **ローカルでの確認**: Cloudflare を通さずに `http://localhost:28080` でブログを開けます。
  別の PC から見るときは `ssh -L 28080:127.0.0.1:28080 ユーザー名@サーバー` で転送します。
  GoatCounter の管理画面はドメインで動くので、`https://stats.example.com` から開いてください。
  Fediverse との連携（フォローやリアクションの受け取り）は、外部から HTTPS で届く必要があるためローカルでは確認できません。

## うまくいかないとき

| 症状 | 確認すること |
|---|---|
| Mastodon から `@blog@blog.example.com` が見つからない | `https://blog.example.com/.well-known/webfinger?resource=acct:blog@blog.example.com` が応答するか。Bot Fight Mode がオフか |
| 閲覧数が 👁 0 のまま、または出ない | GoatCounter の「Allow adding visitor counts」がオンか。`-vhost` が `STATS_DOMAIN` と一致しているか |
| 記事を保存しても反映されない | `docker compose logs madblog` にエラーが出ていないか。メタデータの行（`[//]: # (...)`）の書式が正しいか |
