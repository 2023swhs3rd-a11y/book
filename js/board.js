// 학생용 게시판 화면
(function () {
  const { cfg, COLORS, isConfigured, rpc, timeAgo, fmtDate, h, toast } = window.Board;
  const REFRESH_MS = 20000;

  const $ = (sel) => document.querySelector(sel);
  const boardEl = $("#board");
  const statusEl = $("#status");
  const searchEl = $("#search");
  const postDialog = $("#postDialog");
  const addDialog = $("#addDialog");
  const postForm = $("#postForm");
  const addForm = $("#addForm");

  let posts = [];
  let addTargetId = null;

  if (cfg.TITLE) {
    $("#boardTitle").textContent = cfg.TITLE;
    document.title = cfg.TITLE + " · 독서 현황판";
  }
  $("#boardSubtitle").textContent = cfg.SUBTITLE || "";

  // ---------- 그리기 ----------
  function bookLine(e) {
    return h("div", { class: "book" },
      h("span", { class: "book-title" }, "『" + e.book_title + "』"),
      h("span", { class: "book-author" }, e.book_author));
  }

  function renderPost(p) {
    const entries = p.entries || [];
    const first = entries[0];
    const more = entries.slice(1);
    const initial = (p.display_name || "?").trim().charAt(0);

    return h("article", {
        class: "post c-" + p.color + (more.length ? " has-more" : ""),
        dataset: { id: p.id },
      },
      h("div", { class: "bubble main" },
        more.length ? h("span", { class: "badge" }, "📖 " + more.length + "번 이어 씀") : null,
        bookLine(first),
        h("p", { class: "quote" }, first.quote)),
      more.length
        ? h("ol", { class: "thread" },
            more.map((e, i) => {
              const sameBook = e.book_title === entries[i].book_title && e.book_author === entries[i].book_author;
              return h("li", { class: "bubble more" },
                h("span", { class: "more-label" }, "+ 이어서 · " + timeAgo(e.created_at)),
                sameBook ? null : bookLine(e),
                h("p", { class: "quote" }, e.quote));
            }))
        : null,
      h("footer", { class: "who" },
        h("span", { class: "avatar", "aria-hidden": "true" }, initial),
        h("span", { class: "name" }, p.display_name),
        h("time", { datetime: p.created_at, title: fmtDate(p.created_at, true) }, timeAgo(p.updated_at)),
        h("button", { class: "link-btn", type: "button", onclick: () => openAdd(p.id) }, "＋ 이어 쓰기")));
  }

  function render() {
    const q = searchEl.value.trim().toLowerCase();
    const shown = q
      ? posts.filter((p) =>
          [p.display_name, ...(p.entries || []).flatMap((e) => [e.book_title, e.book_author, e.quote])]
            .join(" ").toLowerCase().includes(q))
      : posts;

    layout(shown.map(renderPost));
    if (!posts.length) statusEl.textContent = "아직 게시물이 없어요. 첫 번째로 읽고 있는 책을 소개해 보세요!";
    else if (!shown.length) statusEl.textContent = "‘" + searchEl.value.trim() + "’ 검색 결과가 없어요.";
    else statusEl.textContent = q ? shown.length + "개를 찾았어요." : "";
    statusEl.hidden = !statusEl.textContent;
  }

  // 최신 글이 왼쪽 위부터 가로로 놓이도록, 가장 짧은 열에 차례로 쌓습니다.
  let lastCards = [];
  function layout(cards) {
    lastCards = cards;
    const n = Math.max(1, Math.floor((boardEl.clientWidth + 24) / 324));
    const cols = Array.from({ length: n }, () => h("div", { class: "col" }));
    boardEl.replaceChildren(...cols);
    for (const card of cards) {
      let target = cols[0];
      for (const c of cols) if (c.offsetHeight < target.offsetHeight) target = c;
      target.append(card);
    }
  }
  let lastWidth = 0;
  window.addEventListener("resize", () => {
    if (boardEl.clientWidth === lastWidth) return;
    lastWidth = boardEl.clientWidth;
    layout(lastCards);
  });

  async function load(quiet) {
    if (!isConfigured()) {
      statusEl.textContent = "js/config.js 에 Supabase 주소와 키를 넣어 주세요. (README 참고)";
      return;
    }
    try {
      posts = await rpc("get_board");
      render();
    } catch (e) {
      if (!quiet) statusEl.textContent = "게시판을 불러오지 못했어요: " + e.message;
    }
  }

  // ---------- 폼 공통 ----------
  function setupCounter(form) {
    const ta = form.querySelector("textarea");
    const count = form.querySelector("[data-count]");
    const update = () => (count.textContent = ta.value.length);
    ta.addEventListener("input", update);
    return update;
  }
  const updatePostCount = setupCounter(postForm);
  const updateAddCount = setupCounter(addForm);

  for (const dlg of [postDialog, addDialog]) {
    dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }

  // 숫자만 입력되도록
  document.querySelectorAll('input[name="pin"]').forEach((el) =>
    el.addEventListener("input", () => (el.value = el.value.replace(/\D/g, "").slice(0, 4))));

  function formError(form, msg) {
    form.querySelector(".form-error").textContent = msg || "";
  }

  function validate(form) {
    for (const el of form.querySelectorAll("[required]")) {
      if (!el.value.trim()) {
        el.focus();
        return (el.closest("label").firstChild.textContent.trim() || "필수 항목") + " 칸을 채워 주세요.";
      }
    }
    if (!/^\d{4}$/.test(form.pin.value)) {
      form.pin.focus();
      return "비밀번호는 숫자 4자리로 입력해 주세요.";
    }
    return null;
  }

  async function submitWith(form, fn) {
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  // ---------- 새 글 ----------
  const swatches = $("#swatches");
  COLORS.forEach((c, i) => {
    swatches.append(h("label", { class: "swatch c-" + c.key, title: c.label },
      h("input", { type: "radio", name: "color", value: c.key, checked: i === 0 }),
      h("span", { class: "sr-only" }, c.label)));
  });

  function openPost() {
    formError(postForm, "");
    postDialog.showModal();
    updatePostCount();
    if (!postForm.student_no.value) postForm.student_no.focus();
  }
  $("#newBtn").addEventListener("click", openPost);
  $("#fab").addEventListener("click", openPost);

  postForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const err = validate(postForm);
    if (err) return formError(postForm, err);
    formError(postForm, "");
    const f = postForm;
    submitWith(f, async () => {
      try {
        await rpc("create_post", {
          p_student_no: f.student_no.value.trim(),
          p_name: f.author_name.value.trim(),
          p_nickname: f.nickname.value.trim() || null,
          p_pin: f.pin.value,
          p_color: f.color.value,
          p_quote: f.quote.value.trim(),
          p_book_title: f.book_title.value.trim(),
          p_book_author: f.book_author.value.trim(),
        });
        postDialog.close();
        f.reset();
        toast("게시했어요! 🎉");
        await load();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (ex) {
        formError(f, ex.message);
      }
    });
  });

  // ---------- 이어 쓰기 ----------
  function openAdd(id) {
    const p = posts.find((x) => x.id === id);
    if (!p) return;
    addTargetId = id;
    const last = p.entries[p.entries.length - 1];
    addForm.reset();
    formError(addForm, "");
    $("#addTarget").textContent = p.display_name + " 님의 『" + last.book_title + "』 말풍선에 이어 씁니다.";
    addForm.book_title.value = last.book_title;
    addForm.book_author.value = last.book_author;
    addDialog.className = "sheet c-" + p.color;
    addDialog.showModal();
    updateAddCount();
    addForm.pin.focus();
  }

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const err = validate(addForm);
    if (err) return formError(addForm, err);
    formError(addForm, "");
    const f = addForm;
    submitWith(f, async () => {
      try {
        const result = await rpc("add_entry", {
          p_post_id: addTargetId,
          p_pin: f.pin.value,
          p_quote: f.quote.value.trim(),
          p_book_title: f.book_title.value.trim(),
          p_book_author: f.book_author.value.trim(),
        });
        if (result !== "OK") throw new Error(window.Board.ERROR_TEXT[result] || result);
        addDialog.close();
        toast("이어 썼어요! ✍️");
        await load();
        const el = boardEl.querySelector('[data-id="' + addTargetId + '"]');
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (ex) {
        formError(f, ex.message);
        if (/비밀번호/.test(ex.message)) { f.pin.select(); }
      }
    });
  });

  // ---------- 시작 ----------
  let searchTimer;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150);
  });

  load();
  setInterval(() => {
    if (document.visibilityState === "visible" && !postDialog.open && !addDialog.open) load(true);
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load(true);
  });
})();
