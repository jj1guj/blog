# 記事の作成

記事は開発環境で作成して push し、本番環境では pull するだけで公開します。

## 1. 開発環境で記事を作る

[開発環境](development-setup.md)の Hugo を起動した状態で、リポジトリのルートから実行します。`<article-name>` は記事のスラッグに置き換えてください。

```sh
docker compose -f compose.dev.yml exec hugo hugo new content posts/<article-name>/index.md
```

`content/posts/<article-name>/index.md` が作成されます。

作成されたファイルの `title` を編集し、`+++` の下に Markdown で本文を書きます。開発環境では下書きも表示されるので、`http://127.0.0.1:28080/` で確認しながら書けます。

## 2. push する

書き終えたら `draft = false` にして、commit と push をします。`draft = true` のまま push した記事は、本番環境では公開されません。未来の日付の記事も公開されません。

## 3. 本番環境で pull する

```sh
git pull
```

Hugo が変更を検知してビルドし、記事が公開されます。

publisher が有効でアクセストークンが設定され、初回確認を終えていれば、新しい記事は Fediverse にも自動投稿されます。初回確認時に既にあった記事は、既定では投稿されません。

投稿済み記事の修正や削除は Fediverse の投稿に反映されません。詳しくは[記事の自動投稿](../publisher/README.md)を参照してください。
