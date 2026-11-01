# 開発環境のセットアップ

[compose.dev.yml](../compose.dev.yml) を使い、Hugo と Caddy だけを起動してブログの表示をローカルで確認します。下書きも表示され、Fediverse への投稿は行いません。

Hollo と GoatCounter は起動しないため、反応欄とフォロワー数は表示されず、閲覧数は `0!` と表示されます。連合を含めて確認する場合は、[ローカルの Misskey との連合確認](local-federation.md)を参照してください。

## 1. リポジトリを用意する

```sh
git clone --recurse-submodules https://github.com/jj1guj/blog.git
cd blog
cp .env.example .env
```

`.env` は編集不要です。

## 2. 起動する

```sh
docker compose -f compose.dev.yml up -d --no-deps hugo caddy
```

`http://127.0.0.1:28080/` を開きます。`content/` 以下のファイルを保存すると、自動で再ビルドされます。記事の作り方は[記事の作成](writing-posts.md)を参照してください。

## 3. 停止する

```sh
docker compose -f compose.dev.yml down
```
