+++
date = '2026-10-31T00:35:02Z'
draft = true
title = 'サンプル'
tags = ['てすと']
summary = 'Hugo と PaperMod で画像、コード、数式、リンクを記事に表示する方法を紹介します。'
+++

## これはサンプル記事です

Markdownで記事を書けます

### 画像

画像は以下のように挿入します

```md
{{</* figure src="test.jpeg" style="width: 50%; height: auto;" alt="画像の説明" caption="キャプション" align="center" */>}}
```

すると以下のように表示されます。
{{< figure src="test.jpeg" style="width: 50%; height: auto;" alt="画像の説明" caption="キャプション" align="center" >}}

### コード

コードも書けます。

Fortran
```f90
program main
    implicit none
    print*, "Hello World!"
end program main
```

C++
```cpp
#include <iostream>

int main() {
    std::cout << "Hello World!" << std::endl;
}
```

Bash
```bash
echo "Hello World!"
```

### 数式

数式を文中に埋め込む場合はこのように書きます。

```
三角形の辺の長さを$a$, $b$, $c$としたとき$a^2+b^2=c^2$が成立するならその三角形は直角三角形である
```

すると以下のように表示されます。

三角形の辺の長さを$a$, $b$, $c$としたとき$a^2+b^2=c^2$が成立するならその三角形は直角三角形である

数式を行として独立に書く場合はこのように書きます。

```
$$
\mathcal{F} \left[ f(t) \right] =\hat{f(\omega)}= \frac{1}{\sqrt{2\pi}}\int^{\infty}_{-\infty}  f(t) e^{-i\omega t} dt
$$
```

すると以下のように表示されます。

$$
\mathcal{F} \left[ f(t) \right] =\hat{f(\omega)}= \frac{1}{\sqrt{2\pi}}\int^{\infty}_{-\infty}  f(t) e^{-i\omega t} dt
$$

デフォルトで数式番号が自動で振られますが、数式番号が振られないようにするためにはこのように書きます。

```
$$
\mathcal{F} \left[ f(t) \right] =\hat{f(\omega)}= \frac{1}{\sqrt{2\pi}}\int^{\infty}_{-\infty}  f(t) e^{-i\omega t} dt \notag
$$
```

$$
\mathcal{F} \left[ f(t) \right] =\hat{f(\omega)}= \frac{1}{\sqrt{2\pi}}\int^{\infty}_{-\infty}  f(t) e^{-i\omega t} dt \notag
$$

### リンク

リンクを挿入します。

そのまま挿入するとURLプレビューが表示されます。

https://jiskey.dev

URLプレビューを表示したくない場合はこのように書きます。

```markdown
https://jiskey.dev
{.no-preview}
```

するとこのようになります。

https://jiskey.dev
{.no-preview}
