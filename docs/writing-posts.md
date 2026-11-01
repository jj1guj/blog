# 記事の作成

Hugo コンテナーが起動している状態で、リポジトリのルートから実行します。`<article-name>` は記事のスラッグに置き換えてください。

```sh
docker compose exec hugo hugo new content posts/<article-name>/index.md
```

`content/posts/<article-name>/index.md` が作成されます。

作成されたファイルの `title` を編集し、`+++` の下に Markdown で本文を書きます。記事の作成中は `draft = true` のままにしてください。通常構成では下書きは公開されませんが、`compose.dev.yml` を使うローカル環境では表示されます。

公開するには `draft = false` にして保存します。通常構成で Hugo が稼働していれば、変更を検知してビルドします。未来の日付の記事は通常のビルドでは公開されません。

publisher が有効でアクセストークンが設定され、初回確認を終えていれば、新しい記事は Fediverse にも自動投稿されます。初回確認時に既にあった記事は、既定では投稿されません。

投稿済み記事の修正や削除は Fediverse の投稿に反映されません。詳しくは[記事の自動投稿](../publisher/README.md)を参照してください。
