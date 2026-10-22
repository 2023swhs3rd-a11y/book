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
  const editDialog = $("#editDialog");
  const editForm = $("#editForm");

  let posts = [];
  let addTargetId = null;
  const openComments = new Set();   // 댓글 창을 열어 둔 말풍선
  const commentCache = {};          // 말풍선 번호 → 댓글 목록
  const expanded = new Set();       // '더 읽기'로 펼친 글
  let flashId = null;               // 방금 쓴 말풍선

  // 같은 기기에서는 학번·이름을 기억해 다음에 자동으로 채웁니다.
  const ME_KEY = "reading-board-me";
  function loadMe() { try { return JSON.parse(localStorage.getItem(ME_KEY)) || {}; } catch (e) { return {}; } }
  function saveMe(patch) { try { localStorage.setItem(ME_KEY, JSON.stringify(Object.assign(loadMe(), patch))); } catch (e) {} }

  if (cfg.TITLE) {
    $("#boardTitle").textContent = cfg.TITLE;
    document.title = cfg.TITLE;
  }
  $("#boardSubtitle").textContent = cfg.SUBTITLE || "";

  // ---------- 그리기 ----------
  function bookLine(e) {
    return h("div", { class: "book" },
      h("span", { class: "book-title" }, "『" + e.book_title + "』"),
      h("span", { class: "book-author" }, e.book_author));
  }

  // 말풍선 아래 작성자 표시: 학번(교사는 부서) 이름 (닉네임)
  function identity(p) {
    const teacher = p.role === "teacher";
    return h("div", { class: "ident" },
      h("div", { class: "ident-line" },
        teacher ? h("span", { class: "role-chip" }, "선생님") : null,
        p.student_no ? h("span", { class: "sno" }, p.student_no) : null,
        h("span", { class: "name" }, p.author_name || p.display_name),
        p.nickname ? h("span", { class: "nick" }, "(" + p.nickname + ")") : null),
      h("time", { datetime: p.created_at, title: fmtDate(p.created_at, true) }, timeAgo(p.updated_at)));
  }

  function renderPost(p, opts) {
    const example = opts && opts.example;
    const teacher = p.role === "teacher";
    const entries = p.entries || [];
    const first = entries[0];
    const more = entries.slice(1);
    const initial = teacher ? "🍎" : (p.author_name || p.display_name || "?").trim().charAt(0);

    return h("article", {
        class: "post c-" + p.color + (teacher ? " teacher" : "") + (more.length ? " has-more" : "") + (example ? " example" : ""),
        dataset: { id: p.id },
      },
      h("div", { class: "bubble main" },
        example ? h("span", { class: "example-tag" }, "✨ 예시") : null,
        teacher ? h("span", { class: "teacher-tag" }, "🍎 선생님의 책") : null,
        more.length ? h("span", { class: "badge" }, "📖 " + more.length + "번 이어 씀") : null,
        bookLine(first),
        quote(first)),
      more.length
        ? h("ol", { class: "thread" },
            more.map((e, i) => {
              const sameBook = e.book_title === entries[i].book_title && e.book_author === entries[i].book_author;
              return h("li", { class: "bubble more" },
                h("span", { class: "more-label" }, "+ 이어서 · " + timeAgo(e.created_at)),
                sameBook ? null : bookLine(e),
                quote(e));
            }))
        : null,
      h("footer", { class: "who" },
        h("span", { class: "avatar", "aria-hidden": "true" }, initial),
        identity(p),
        h("div", { class: "who-actions" },
          h("button", { class: "link-btn", type: "button",
            onclick: () => (demo || example ? toast("예시 말풍선이에요. [글쓰기]로 직접 남겨 보세요!") : openAdd(p.id)) },
            "＋ 이어 쓰기"),
          h("button", { class: "mini-btn", type: "button", title: "내 글 고치기·지우기",
            onclick: () => (demo || example ? toast("예시 말풍선이에요.") : openEdit(p.id)) },
            "✎ 수정"))),
      commentSection(p, demo || example));
  }

  // 6줄이 넘는 글은 접어 두고 '더 읽기'로 펼칩니다. (넘치는지는 화면에 놓인 뒤 clampCheck 에서 확인)
  function quote(e) {
    return h("p", { class: "quote" + (expanded.has(String(e.id)) ? "" : " clamp"), dataset: { eid: e.id } }, e.quote);
  }
  function clampCheck() {
    boardEl.querySelectorAll(".quote.clamp").forEach((q) => {
      if (q.scrollHeight <= q.clientHeight + 2 || q.nextElementSibling?.classList.contains("more-read")) return;
      q.after(h("button", { class: "more-read", type: "button", onclick: (ev) => {
        expanded.add(q.dataset.eid);
        q.classList.remove("clamp");
        ev.currentTarget.remove();
      } }, "더 읽기 ▾"));
    });
  }

  // ---------- 댓글 ----------
  function commentSection(p, readOnly) {
    const count = readOnly && p.comments ? p.comments.length : (p.comment_count || 0);
    const open = openComments.has(p.id);
    const wrap = h("section", { class: "comments-wrap" + (open ? " open" : "") });
    const toggle = h("button", { class: "comment-toggle", type: "button", "aria-expanded": String(open),
      onclick: () => {
        if (openComments.has(p.id)) openComments.delete(p.id); else openComments.add(p.id);
        wrap.replaceWith(commentSection(p, readOnly));
        if (!readOnly && openComments.has(p.id)) fetchComments(p.id);
      } },
      "💬 댓글 ", h("b", null, count), open ? " ▴" : " ▾");
    wrap.append(toggle);
    if (!open) return wrap;

    const list = h("ul", { class: "comment-list", dataset: { post: p.id } });
    const items = readOnly ? (p.comments || []) : commentCache[p.id];
    fillComments(list, items, readOnly);
    wrap.append(list, commentForm(p, readOnly));
    return wrap;
  }

  function fillComments(list, items, readOnly) {
    if (!items) return list.replaceChildren(h("li", { class: "comment-empty" }, "불러오는 중…"));
    if (!items.length) return list.replaceChildren(h("li", { class: "comment-empty" }, "첫 댓글을 남겨 보세요."));
    list.replaceChildren(...items.map((c) => h("li", { class: "comment" },
      h("div", { class: "comment-meta" },
        h("b", null, c.student_no), " ", h("b", null, c.author_name),
        h("time", { datetime: c.created_at, title: fmtDate(c.created_at, true) }, timeAgo(c.created_at)),
        readOnly ? null : h("button", { class: "mini-btn", type: "button", onclick: () => removeComment(c) }, "삭제")),
      h("p", null, c.body))));
  }

  async function fetchComments(postId) {
    try {
      const items = await rpc("get_comments", { p_post_id: postId });
      commentCache[postId] = items;
      const post = posts.find((x) => x.id === postId);
      if (post) post.comment_count = items.length;
      const list = boardEl.querySelector('.comment-list[data-post="' + postId + '"]');
      if (list) {
        fillComments(list, items, false);
        const b = list.parentElement.querySelector(".comment-toggle b");
        if (b) b.textContent = items.length;
      }
    } catch (e) { toast(e.message, true); }
  }

  function commentForm(p, readOnly) {
    const me = loadMe();
    const f = h("form", { class: "comment-form", novalidate: true },
      h("div", { class: "comment-fields" },
        h("input", { name: "student_no", maxlength: 20, placeholder: "학번/부서", "aria-label": "학번 또는 부서", value: me.student_no || "" }),
        h("input", { name: "author_name", maxlength: 20, placeholder: "이름", "aria-label": "이름", value: me.author_name || "" }),
        h("input", { name: "pin", type: "password", inputmode: "numeric", maxlength: 4, placeholder: "비번 4자리", "aria-label": "비밀번호 4자리", autocomplete: "off" })),
      h("div", { class: "comment-row" },
        h("textarea", { name: "body", maxlength: 200, rows: 2, placeholder: "댓글을 남겨 주세요 (200자)", "aria-label": "댓글 내용" }),
        h("button", { class: "btn primary small", type: "submit" }, "등록")),
      h("p", { class: "form-error", role: "alert" }));
    f.pin.addEventListener("input", () => (f.pin.value = f.pin.value.replace(/\D/g, "").slice(0, 4)));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (readOnly) return toast("예시 말풍선이에요. 실제 게시판에서 댓글을 남겨 보세요!");
      const err = !f.student_no.value.trim() ? "학번(교사는 부서)을 입력해 주세요."
        : !f.author_name.value.trim() ? "이름을 입력해 주세요."
        : !/^\d{4}$/.test(f.pin.value) ? "비밀번호는 숫자 4자리로 입력해 주세요."
        : !f.body.value.trim() ? "댓글 내용을 입력해 주세요." : null;
      if (err) return formError(f, err);
      formError(f, "");
      await submitWith(f, async () => {
        try {
          await rpc("add_comment", {
            p_post_id: p.id, p_student_no: f.student_no.value.trim(), p_name: f.author_name.value.trim(),
            p_pin: f.pin.value, p_body: f.body.value.trim(),
          });
          saveMe({ student_no: f.student_no.value.trim(), author_name: f.author_name.value.trim() });
          f.body.value = "";
          toast("댓글을 남겼어요 💬");
          await fetchComments(p.id);
        } catch (ex) { formError(f, ex.message); }
      });
    });
    return f;
  }

  async function removeComment(c) {
    const pin = prompt("댓글을 쓸 때 정한 비밀번호 4자리를 입력해 주세요.");
    if (pin == null) return;
    try {
      const result = await rpc("delete_comment", { p_comment_id: c.id, p_pin: pin.trim() });
      if (result !== "OK") throw new Error(window.Board.ERROR_TEXT[result] || result);
      toast("댓글을 지웠어요.");
      const postId = Object.keys(commentCache).find((k) => (commentCache[k] || []).some((x) => x.id === c.id));
      if (postId) await fetchComments(Number(postId));
    } catch (e) { toast(e.message, true); }
  }

  function matches(p, q) {
    return [p.student_no, p.author_name, p.nickname, p.display_name,
      ...(p.entries || []).flatMap((e) => [e.book_title, e.book_author, e.quote])]
      .join(" ").toLowerCase().includes(q);
  }

  function render() {
    const q = searchEl.value.trim().toLowerCase();
    const source = demo ? DEMO_POSTS : posts;
    const shown = q ? source.filter((p) => matches(p, q)) : source;

    const cards = shown.map((p) => renderPost(p));
    // 실제 게시판 첫머리에는 작성 예시 말풍선을 하나 보여 줍니다. (실제 글이 10개가 넘으면 숨김)
    if (!demo && !q && posts.length < 10) cards.unshift(renderPost(EXAMPLE_POST, { example: true }));
    layout(cards);
    clampCheck();
    if (flashId != null) {
      const el = boardEl.querySelector('.post[data-id="' + flashId + '"]');
      flashId = null;
      if (el) {
        el.classList.add("flash");
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    document.body.classList.toggle("demo-mode", demo);
    demoBanner.hidden = !demo;
    demoBtns.forEach((b) => (b.textContent = demo ? "← 실제 게시판" : "👀 예시 화면"));

    if (!demo && !posts.length) statusEl.textContent = "아직 게시물이 없어요. 위 예시처럼 읽고 있는 책을 소개해 보세요!";
    else if (!shown.length) statusEl.textContent = "‘" + searchEl.value.trim() + "’ 검색 결과가 없어요.";
    else statusEl.textContent = q ? shown.length + "개를 찾았어요." : "";
    statusEl.hidden = !statusEl.textContent;
  }

  // ---------- 예시 화면 ----------
  const { EXAMPLE_POST, DEMO_POSTS } = window.BoardExamples;
  const demoBanner = $("#demoBanner");
  const demoBtns = document.querySelectorAll("[data-demo-toggle]");
  let demo = false;
  function setDemo(on) {
    demo = on;
    searchEl.value = "";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  demoBtns.forEach((b) => b.addEventListener("click", () => setDemo(!demo)));

  // 최신 글이 왼쪽 위부터 가로로 놓이도록, 가장 짧은 열에 차례로 쌓습니다.
  let lastCards = [];
  function layout(cards) {
    lastCards = cards;
    const n = Math.max(1, Math.floor((boardEl.clientWidth + 24) / 324));
    const cols = Array.from({ length: n }, () => h("div", { class: "col" }));
    boardEl.replaceChildren(...cols);
    boardEl.removeAttribute("aria-busy");
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
    clampCheck();
  });

  let loaded = false;
  async function load(quiet) {
    if (!isConfigured()) {
      render();
      statusEl.textContent = "js/config.js 에 Supabase 주소와 키를 넣어 주세요. (README 참고)";
      return;
    }
    try {
      posts = await rpc("get_board");
      render();
      // 열어 둔 댓글 창은 댓글 수가 바뀌었을 때만 다시 불러옵니다.
      for (const id of openComments) {
        const p = posts.find((x) => x.id === id);
        if (p && (commentCache[id] || []).length !== p.comment_count) fetchComments(id);
      }
      loaded = true;
    } catch (e) {
      if (!quiet) {
        if (!loaded) render();
        statusEl.textContent = "게시판을 불러오지 못했어요: " + e.message;
        statusEl.hidden = false;
      }
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
  const updateEditCount = setupCounter(editForm);

  for (const dlg of [postDialog, addDialog, editDialog]) {
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
      if (!el.value.trim() && el.offsetParent !== null) {
        el.focus();
        const label = el.closest("label").querySelector("[data-label]") || el.closest("label").firstChild;
        return (label.textContent.trim() || "필수 항목") + " 칸을 채워 주세요.";
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

  // 학생 / 교사 선택: 교사는 학번 대신 부서를 입력하고, 전용 말풍선으로 보입니다.
  function applyRole() {
    const teacher = postForm.elements.role.value === "teacher";
    const sno = postForm.student_no;
    postForm.classList.toggle("is-teacher", teacher);
    $("#snoLabel").textContent = teacher ? "부서" : "학번";
    sno.placeholder = teacher ? "예: 국어과, 3학년부" : "예: 20315";
    sno.inputMode = teacher ? "text" : "numeric";
  }
  postForm.querySelectorAll('input[name="role"]').forEach((r) => r.addEventListener("change", applyRole));

  function openPost() {
    if (demo) setDemo(false);
    formError(postForm, "");
    const me = loadMe();
    if (!postForm.student_no.value && me.student_no) {
      if (me.role === "teacher") postForm.querySelector('input[name="role"][value="teacher"]').checked = true;
      applyRole();
      postForm.student_no.value = me.student_no;
      postForm.author_name.value = me.author_name || "";
      postForm.nickname.value = me.nickname || "";
    }
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
        const teacher = f.elements.role.value === "teacher";
        if (teacher && !f.teacher_code.value.trim()) {
          f.teacher_code.focus();
          return formError(f, "교사 인증 코드를 입력해 주세요.");
        }
        const created = await rpc("create_post", {
          p_teacher_code: teacher ? f.teacher_code.value.trim() : null,
          p_role: f.elements.role.value,
          p_student_no: f.student_no.value.trim(),
          p_name: f.author_name.value.trim(),
          p_nickname: f.nickname.value.trim() || null,
          p_pin: f.pin.value,
          p_color: f.color.value,
          p_quote: f.quote.value.trim(),
          p_book_title: f.book_title.value.trim(),
          p_book_author: f.book_author.value.trim(),
        });
        saveMe({ role: f.elements.role.value, student_no: f.student_no.value.trim(),
          author_name: f.author_name.value.trim(), nickname: f.nickname.value.trim() });
        postDialog.close();
        f.reset();
        applyRole();
        toast("게시했어요! 🎉");
        flashId = created && created.id;
        await load();
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
    $("#addTarget").textContent = (p.author_name || p.display_name) + " 님의 『" + last.book_title + "』 말풍선에 이어 씁니다.";
    addForm.book_title.value = last.book_title;
    addForm.book_author.value = last.book_author;
    addDialog.className = "sheet c-" + p.color + (p.role === "teacher" ? " teacher" : "");
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

  // ---------- 내 글 고치기 · 지우기 ----------
  let editPost = null;
  const entryPick = $("#entryPick");

  function fillEntry() {
    const e = editPost.entries.find((x) => String(x.id) === editForm.entry.value) || editPost.entries[0];
    editForm.book_title.value = e.book_title;
    editForm.book_author.value = e.book_author;
    editForm.quote.value = e.quote;
    updateEditCount();
  }
  editForm.entry.addEventListener("change", fillEntry);

  function openEdit(id) {
    const p = posts.find((x) => x.id === id);
    if (!p) return;
    editPost = p;
    editForm.reset();
    formError(editForm, "");
    $("#editTarget").textContent = (p.author_name || p.display_name) + " 님의 말풍선을 고치거나 지웁니다.";
    editForm.entry.replaceChildren(...p.entries.map((e, i) =>
      h("option", { value: e.id }, (i === 0 ? "첫 글" : "이어쓰기 " + i) + " · 『" + e.book_title + "』")));
    entryPick.hidden = p.entries.length < 2;
    fillEntry();
    editDialog.className = "sheet c-" + p.color + (p.role === "teacher" ? " teacher" : "");
    editDialog.showModal();
    editForm.pin.focus();
  }

  async function afterEdit(msg) {
    editDialog.close();
    toast(msg);
    await load();
  }

  editForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const err = validate(editForm);
    if (err) return formError(editForm, err);
    formError(editForm, "");
    const f = editForm;
    submitWith(f, async () => {
      try {
        const result = await rpc("edit_entry", {
          p_post_id: editPost.id,
          p_entry_id: Number(f.entry.value),
          p_pin: f.pin.value,
          p_quote: f.quote.value.trim(),
          p_book_title: f.book_title.value.trim(),
          p_book_author: f.book_author.value.trim(),
        });
        if (result !== "OK") throw new Error(window.Board.ERROR_TEXT[result] || result);
        await afterEdit("고쳤어요! ✏️");
      } catch (ex) {
        formError(f, ex.message);
      }
    });
  });

  $("#deleteBtn").addEventListener("click", () => {
    const f = editForm;
    if (!/^\d{4}$/.test(f.pin.value)) {
      f.pin.focus();
      return formError(f, "비밀번호 4자리를 먼저 입력해 주세요.");
    }
    const isFirst = String(editPost.entries[0].id) === f.entry.value;
    const msg = isFirst
      ? (editPost.entries.length > 1
          ? "첫 글을 지우면 이어 쓴 글까지 말풍선 전체가 지워져요. 지울까요?"
          : "이 말풍선을 지울까요? 되돌릴 수 없어요.")
      : "이 이어쓰기 글을 지울까요? 되돌릴 수 없어요.";
    if (!confirm(msg)) return;
    submitWith(f, async () => {
      try {
        const result = await rpc("delete_own", {
          p_post_id: editPost.id,
          p_entry_id: isFirst ? null : Number(f.entry.value),
          p_pin: f.pin.value,
        });
        if (result !== "OK") throw new Error(window.Board.ERROR_TEXT[result] || result);
        await afterEdit("지웠어요.");
      } catch (ex) {
        formError(f, ex.message);
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
    if (document.visibilityState !== "visible" || demo || postDialog.open || addDialog.open || editDialog.open) return;
    // 댓글을 쓰는 중이면 화면을 다시 그리지 않습니다.
    const typing = [...boardEl.querySelectorAll(".comment-form textarea, .comment-form input[name=pin]")]
      .some((el) => el.value || el === document.activeElement);
    if (!typing) load(true);
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load(true);
  });
})();
