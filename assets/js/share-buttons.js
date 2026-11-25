// 記事の共有ボタンのうち、Mastodon・Misskey・タイトルとリンクのコピーを動かす。
// Mastodon と Misskey はサーバーごとに共有画面が違うため、読者にサーバー名を入力してもらう。
// 入力したサーバー名はブラウザーに保存し、次からは入力を省く。

// ページ内のほかのスクリプト（コードのコピーなど）と名前がぶつからないよう、全体を関数の中に閉じる。
(() => {
  // URL はどのサービスでもタイトルの次の行に来るよう、改行を挟んで1つのテキストにする。
  const shareText = (title, url) => `${title}\n${url}`;

  const fediverse = {
    mastodon: {
      label: "Mastodon のサーバー",
      placeholder: "mastodon.social",
      shareUrl: (host, title, url) => {
        const share = new URL(`https://${host}/share`);
        share.searchParams.set("text", shareText(title, url));
        return share;
      },
    },
    misskey: {
      label: "Misskey のサーバー",
      placeholder: "misskey.io",
      shareUrl: (host, title, url) => {
        const share = new URL(`https://${host}/share`);
        share.searchParams.set("text", shareText(title, url));
        return share;
      },
    },
  };

  const storageKey = (type) => `share-server-${type}`;

  // プライベートブラウズなどで保存できない環境でも、共有自体はできるようにする。
  function loadServer(type) {
    try {
      return localStorage.getItem(storageKey(type));
    } catch {
      return null;
    }
  }

  function saveServer(type, host) {
    try {
      localStorage.setItem(storageKey(type), host);
    } catch {
      // 保存できなくても共有は続ける。
    }
  }

  // 「https://mastodon.social/」や「@user@mastodon.social」のような入力からホスト名だけを取り出す。
  function normalizeServer(input) {
    let value = input.trim().toLowerCase();
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    value = value.split(/[/?#]/)[0];
    value = value.slice(value.lastIndexOf("@") + 1);
    if (!/^[^\s.:]+(\.[^\s.:]+)+(:\d+)?$/.test(value)) return null;
    try {
      return new URL(`https://${value}`).host;
    } catch {
      return null;
    }
  }

  async function copyText(text) {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    try {
      textarea.select();
      if (!document.execCommand("copy")) throw new Error("The browser rejected the copy command");
    } finally {
      textarea.remove();
    }
  }

  document.querySelectorAll("[data-share]").forEach((container) => {
    const { shareTitle: title, shareUrl: url } = container.dataset;
    const form = container.querySelector("[data-share-form]");
    const input = form.querySelector("input");
    const formLabel = form.querySelector("[data-share-form-label]");
    const error = form.querySelector("[data-share-error]");
    const status = container.querySelector("[data-share-status]");
    let currentType = null;
    let statusTimer;

    const showStatus = (content) => {
      clearTimeout(statusTimer);
      status.replaceChildren(...[content].flat());
    };

    const closeForm = () => {
      form.hidden = true;
      error.hidden = true;
      container.querySelectorAll("[data-share-fedi]").forEach((button) => button.setAttribute("aria-expanded", "false"));
      currentType = null;
    };

    const openForm = (type) => {
      const service = fediverse[type];
      currentType = type;
      formLabel.textContent = service.label;
      input.placeholder = service.placeholder;
      input.value = loadServer(type) ?? "";
      error.hidden = true;
      form.hidden = false;
      container.querySelectorAll("[data-share-fedi]").forEach((button) => {
        button.setAttribute("aria-expanded", String(button.dataset.shareFedi === type));
      });
      input.focus();
    };

    const share = (type, host) => {
      window.open(fediverse[type].shareUrl(host, title, url), "_blank", "noopener");
      const change = document.createElement("button");
      change.type = "button";
      change.className = "share-change";
      change.textContent = "サーバーを変更";
      change.addEventListener("click", () => openForm(type));
      showStatus([`${host} で共有画面を開きました · `, change]);
    };

    container.querySelectorAll("[hidden][data-share-fedi], [hidden][data-share-copy]").forEach((button) => {
      button.hidden = false;
    });

    container.querySelectorAll("[data-share-fedi]").forEach((button) => {
      const type = button.dataset.shareFedi;
      button.addEventListener("click", () => {
        if (currentType === type) {
          closeForm();
          return;
        }
        const saved = loadServer(type);
        if (saved) {
          closeForm();
          share(type, saved);
        } else {
          openForm(type);
        }
      });
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const host = normalizeServer(input.value);
      if (!host) {
        error.hidden = false;
        input.focus();
        return;
      }
      const type = currentType;
      saveServer(type, host);
      closeForm();
      share(type, host);
    });

    form.querySelector("[data-share-cancel]").addEventListener("click", closeForm);

    const copyButton = container.querySelector("[data-share-copy]");
    copyButton.addEventListener("click", async () => {
      const [copyIcon, checkIcon] = copyButton.querySelectorAll("svg");
      try {
        // ほかの共有ボタンと同じ文面（タイトルの次の行に URL）をコピーする。
        await copyText(shareText(title, url));
        // SVG 要素には hidden プロパティがないので、属性を直接切り替える。
        copyIcon.toggleAttribute("hidden", true);
        checkIcon.toggleAttribute("hidden", false);
        showStatus("タイトルとリンクをコピーしました");
      } catch (copyError) {
        console.error("Failed to copy the article URL", copyError);
        showStatus("コピーできませんでした");
      }
      statusTimer = setTimeout(() => {
        copyIcon.toggleAttribute("hidden", false);
        checkIcon.toggleAttribute("hidden", true);
        status.replaceChildren();
      }, 1600);
    });
  });
})();
