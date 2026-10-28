// 학생용 게시판 화면
(function () {
  const { cfg, COLORS, CATEGORIES, isConfigured, rpc, timeAgo, fmtDate, h, toast, ask } = window.Board;
  const REFRESH_MS = 60000;
  const PAGE = 60;   // 한 번에 그리는 말풍선 수 ('더 보기'로 이어서 그림)

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
  let revealId = null;              // '더 보기' 뒤에 있어도 그려야 하는 말풍선
  let limit = PAGE, lastFilterKey = "";

  // 같은 기기에서는 학번·이름을 기억해 다음에 자동으로 채웁니다.
  const ME_KEY = "reading-board-me";
  function loadMe() { try { return JSON.parse(localStorage.getItem(ME_KEY)) || {}; } catch (e) { return {}; } }
  function saveMe(patch) { try { localStorage.setItem(ME_KEY, JSON.stringify(Object.assign(loadMe(), patch))); } catch (e) {} }

  // 공감·신고는 로그인 없이 기기마다 한 번씩만 셉니다. (브라우저에 만든 임의의 기기 번호)
  function store(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; } }
  function keep(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  let device = store("reading-board-device", null);
  if (!device) {
    device = window.crypto && crypto.randomUUID ? crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    keep("reading-board-device", device);
  }
  const liked = new Set(store("reading-board-liked", []));

  // 이 기기에서 쓴 말풍선과, 그 말풍선의 댓글을 마지막으로 몇 개까지 봤는지 (새 댓글 알림용)
  const MINE_KEY = "reading-board-mine";
  const mine = store(MINE_KEY, {});
  function markMine(id, seen) { mine[id] = seen; keep(MINE_KEY, mine); }
  function unseen(p) { return p.id in mine ? Math.max(0, (p.comment_count || 0) - mine[p.id]) : 0; }

  // 계열 선택칸 채우기
  document.querySelectorAll("select[data-categories]").forEach((sel) =>
    sel.append(...CATEGORIES.map((c) => h("option", { value: c }, c))));
  $("#catFilter").append(...CATEGORIES.map((c) => h("option", { value: c }, c)));

  if (cfg.TITLE) {
    $("#boardTitle").textContent = cfg.TITLE;
    document.title = cfg.TITLE;
  }
  $("#boardSubtitle").textContent = cfg.SUBTITLE || "";

  // ---------- 그리기 ----------
  function bookLine(e) {
    return h("div", { class: "book" },
      h("span", { class: "book-title" }, "『" + e.book_title + "』"),
      h("span", { class: "book-author" }, e.book_author),
      e.category ? h("span", { class: "cat-chip" }, e.category) : null,
      e.topic ? h("span", { class: "topic-chip", title: "이달의 주제 참여 글" }, "🎯 " + e.topic) : null);
  }

  // 말풍선 아래 작성자 표시: 학번(교사는 부서) 이름 (닉네임)
  function identity(p) {
    const teacher = p.role === "teacher";
    return h("div", { class: "ident" },
      h("div", { class: "ident-line" },
        teacher ? h("span", { class: "role-chip" }, "선생님") : null,
        p.student_no ? h("span", { class: "sno" }, p.student_no) : null,
        h("span", { class: "name" }, p.author_name || p.display_name),
        p.nickname ? h("span", { class: "nick" }, "(" + p.nickname + ")") : null,
        badgesOf(p)),
      h("time", { datetime: p.created_at, title: fmtDate(p.created_at, true) }, timeAgo(p.updated_at)));
  }

  // ---------- 독서 배지: 같은 사람(학번+이름)이 소개한 책 수와 계열 수로 정합니다 ----------
  const BADGES = [
    [10, "🥇", "책 10권 이상 소개"],
    [5, "🥈", "책 5권 이상 소개"],
    [3, "🥉", "책 3권 이상 소개"],
  ];
  let people = new Map();
  const personKey = (p) => (p.role || "student") + "|" + norm(p.student_no) + "|" + norm(p.author_name || p.display_name);
  function countPeople(source) {
    people = new Map();
    for (const p of source) {
      const k = personKey(p);
      if (!people.has(k)) people.set(k, { books: new Set(), cats: new Set() });
      for (const e of p.entries || []) {
        people.get(k).books.add(norm(e.book_title));
        if (e.category && e.category !== "기타") people.get(k).cats.add(e.category);
      }
    }
  }
  function badgesOf(p) {
    const r = people.get(personKey(p));
    if (!r) return null;
    const out = [];
    const level = BADGES.find(([n]) => r.books.size >= n);
    if (level) out.push(h("span", { class: "reader-badge", title: level[2] + " (" + r.books.size + "권)" }, level[1]));
    if (r.cats.size >= 3) out.push(h("span", { class: "reader-badge", title: "3개 이상 계열의 책 소개 (" + r.cats.size + "개 계열)" }, "🌈"));
    return out;
  }

  function renderPost(p, opts) {
    const example = opts && opts.example;
    const teacher = p.role === "teacher";
    const entries = p.entries || [];
    const first = entries[0];
    const more = entries.slice(1);
    const initial = teacher ? "🍎" : (p.author_name || p.display_name || "?").trim().charAt(0);

    return h("article", {
        class: "post c-" + p.color + (teacher ? " teacher" : "") + (more.length ? " has-more" : "") + (example ? " example" : "") + (p.pinned ? " pinned" : ""),
        dataset: { id: p.id },
      },
      p.pinned ? h("div", { class: "pin-tag" }, "📌 선생님 추천") : null,
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
  function likeButton(p, readOnly) {
    const on = !readOnly && liked.has(p.id);
    return h("button", { class: "like-btn" + (on ? " on" : ""), type: "button", "aria-pressed": String(on),
      title: on ? "공감 취소" : "공감해요",
      onclick: async (ev) => {
        if (readOnly) return toast("예시 말풍선이에요. 실제 게시판에서 공감해 보세요!");
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
          const res = await rpc("toggle_like", { p_post_id: p.id, p_device: device });
          p.like_count = res.count;
          if (res.liked) liked.add(p.id); else liked.delete(p.id);
          keep("reading-board-liked", [...liked]);
          btn.replaceWith(likeButton(p, readOnly));
        } catch (e) { toast(e.message, true); btn.disabled = false; }
      } },
      on ? "❤️ " : "🤍 ", h("b", null, p.like_count || 0));
  }

  async function report(p, comment) {
    const what = comment ? "이 댓글" : "이 말풍선";
    const reason = await ask({ title: "🚩 " + what + "을 신고할까요?", okText: "신고하기", danger: true,
      message: "관리자에게 알려요. 신고한 사람은 공개되지 않아요.",
      input: { maxlength: 100, placeholder: "신고 이유 (선택) 예: 비방, 거짓 정보, 목적과 무관" } });
    if (reason == null) return;
    try {
      await rpc("report", { p_post_id: p.id, p_comment_id: comment ? comment.id : null,
        p_reason: reason.trim() || null, p_device: device });
      toast("신고했어요. 관리자가 확인할게요.");
    } catch (e) { toast(e.message, true); }
  }

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
      "💬 댓글 ", h("b", null, count), open ? " ▴" : " ▾",
      !readOnly && !open && unseen(p) ? h("span", { class: "new-dot" }, "새 " + unseen(p)) : null);
    wrap.append(h("div", { class: "react-row" },
      likeButton(p, readOnly), toggle,
      h("button", { class: "report-btn", type: "button", title: "신고하기", "aria-label": "이 말풍선 신고하기",
        onclick: () => (readOnly ? toast("예시 말풍선이에요.") : report(p)) }, "🚩")));
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
    list.replaceChildren(...items.map((c) => h("li", { class: "comment" + (c.is_teacher ? " teacher" : "") },
      h("div", { class: "comment-meta" },
        c.is_teacher ? h("span", { class: "role-chip" }, "🍎 선생님") : null,
        h("b", null, c.student_no), " ", h("b", null, c.author_name),
        h("time", { datetime: c.created_at, title: fmtDate(c.created_at, true) }, timeAgo(c.created_at)),
        readOnly ? null : h("span", { class: "comment-actions" },
          h("button", { class: "mini-btn", type: "button", onclick: () => removeComment(c) }, "삭제"),
          h("button", { class: "mini-btn", type: "button", onclick: () => {
            const post = posts.find((x) => String(x.id) === list.dataset.post);
            if (post) report(post, c);
          } }, "신고"))),
      h("p", null, c.body))));
  }

  let commentsFailed = false;   // 같은 오류 알림이 자동 새로고침마다 반복되지 않도록
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
        if (postId in mine) {   // 내 말풍선의 댓글 창을 열어 봤으면 읽은 것으로
          markMine(postId, items.length);
          updateNotice();
        }
      }
      commentsFailed = false;
    } catch (e) {
      if (!commentsFailed) toast(e.message, true);
      commentsFailed = true;
    }
  }

  function commentForm(p, readOnly) {
    const me = loadMe();
    const f = h("form", { class: "comment-form", novalidate: true },
      h("div", { class: "comment-fields" },
        h("input", { name: "student_no", maxlength: 20, placeholder: "학번/부서", "aria-label": "학번 또는 부서", value: me.student_no || "" }),
        h("input", { name: "author_name", maxlength: 20, placeholder: "이름", "aria-label": "이름", value: me.author_name || "" }),
        h("input", { name: "pin", type: "password", inputmode: "numeric", maxlength: 4, placeholder: "비번 4자리", "aria-label": "비밀번호 4자리", autocomplete: "off" })),
      h("div", { class: "comment-fields teacher-fields" },
        h("label", { class: "teacher-toggle" },
          h("input", { type: "checkbox", name: "as_teacher", checked: me.role === "teacher" }), "🍎 교사로 쓰기"),
        h("input", { name: "teacher_code", type: "password", maxlength: 40, placeholder: "교사 인증 코드", "aria-label": "교사 인증 코드", autocomplete: "off", hidden: me.role !== "teacher" })),
      h("div", { class: "comment-row" },
        h("textarea", { name: "body", maxlength: 200, rows: 2, placeholder: "댓글을 남겨 주세요 (200자)", "aria-label": "댓글 내용" }),
        h("button", { class: "btn primary small", type: "submit" }, "등록")),
      h("p", { class: "form-error", role: "alert" }));
    f.pin.addEventListener("input", () => (f.pin.value = f.pin.value.replace(/\D/g, "").slice(0, 4)));
    f.as_teacher.addEventListener("change", () => {
      f.teacher_code.hidden = !f.as_teacher.checked;
      if (f.as_teacher.checked) f.teacher_code.focus();
    });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (readOnly) return toast("예시 말풍선이에요. 실제 게시판에서 댓글을 남겨 보세요!");
      const err = !f.student_no.value.trim() ? "학번(교사는 부서)을 입력해 주세요."
        : !f.author_name.value.trim() ? "이름을 입력해 주세요."
        : !/^\d{4}$/.test(f.pin.value) ? "비밀번호는 숫자 4자리로 입력해 주세요."
        : !f.body.value.trim() ? "댓글 내용을 입력해 주세요."
        : f.as_teacher.checked && !f.teacher_code.value.trim() ? "교사 인증 코드를 입력해 주세요." : null;
      if (err) return formError(f, err);
      formError(f, "");
      await submitWith(f, async () => {
        try {
          await rpc("add_comment", {
            p_post_id: p.id, p_student_no: f.student_no.value.trim(), p_name: f.author_name.value.trim(),
            p_pin: f.pin.value, p_body: f.body.value.trim(),
            p_teacher_code: f.as_teacher.checked ? f.teacher_code.value.trim() : null,
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
    const pin = await ask({ title: "댓글 지우기", okText: "지우기", danger: true,
      message: "댓글을 쓸 때 정한 비밀번호 4자리를 입력해 주세요.",
      input: { type: "password", inputmode: "numeric", maxlength: 4, placeholder: "숫자 4자리" } });
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

  // ---------- 학년 탭 · 계열 · 정렬 ----------
  let grade = "all";
  const catFilter = $("#catFilter");
  const sortSel = $("#sortSel");
  document.querySelectorAll("[data-grade]").forEach((b) => b.addEventListener("click", () => {
    grade = b.dataset.grade;
    document.querySelectorAll("[data-grade]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }));
  catFilter.addEventListener("change", render);
  sortSel.addEventListener("change", render);

  function inGrade(p) {
    if (grade === "all") return true;
    if (grade === "teacher") return p.role === "teacher";
    return p.role !== "teacher" && String(p.student_no || "").charAt(0) === grade;
  }
  const SORTS = {
    new: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    comments: (a, b) => (b.comments ? b.comments.length : b.comment_count || 0) - (a.comments ? a.comments.length : a.comment_count || 0),
    likes: (a, b) => (b.like_count || 0) - (a.like_count || 0),
  };

  // 띄어쓰기·문장부호·대소문자가 달라도 같은 책으로 봅니다.
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

  // ---------- 책 제목 자동완성: 게시판에 이미 있는 책 + 카카오 책 검색 ----------
  // 카카오 검색은 Supabase 함수(book-search)를 거칩니다. 함수가 없으면 게시판 책만 보여 줍니다.
  let remoteSearch = isConfigured();
  const remoteCache = {};

  function localBooks(q) {
    const seen = new Set();
    const out = [];
    for (const p of posts) {
      for (const e of p.entries || []) {
        const key = norm(e.book_title) + "|" + norm(e.book_author);
        if (seen.has(key) || !norm(e.book_title).includes(q)) continue;
        seen.add(key);
        out.push({ title: e.book_title, author: e.book_author, category: e.category, source: "board" });
      }
    }
    return out.slice(0, 4);
  }

  // 서점 제목의 '(초판본)', '(리커버 한정판)', ': 오리지널 초판본 표지디자인' 같은 판 표시를 떼어 내야
  // 같은 책끼리 잘 묶입니다.
  const EDITION = /판|에디션|표지|리커버|양장|무선|큰글자|세트|special|edition/i;
  function cleanTitle(t) {
    let s = String(t || "").replace(/\s*[(\[][^)\]]*[)\]]/g, " ");
    const i = s.search(/\s*[:：]/);
    if (i > 0 && EDITION.test(s.slice(i))) s = s.slice(0, i);
    return s.replace(/\s+/g, " ").trim() || String(t || "").trim();
  }

  async function remoteBooks(q) {
    if (!remoteSearch) return [];
    if (remoteCache[q]) return remoteCache[q];
    try {
      const key = cfg.SUPABASE_ANON_KEY;
      const headers = { apikey: key };
      if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
      const res = await fetch(cfg.SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/" + (cfg.BOOK_SEARCH_FUNCTION || "book-search") + "?q=" + encodeURIComponent(q), { headers });
      const body = await res.json();
      if (!res.ok || !body.books) throw new Error(body.error || res.status);
      return (remoteCache[q] = body.books.map((b) => ({
        title: cleanTitle(b.title),
        author: (b.authors || []).join(", "), publisher: b.publisher,
        year: b.year, thumbnail: b.thumbnail, source: "kakao",
      })));
    } catch (e) {
      remoteSearch = false;   // 함수가 없거나 키가 없으면 이번 방문 동안은 게시판 책만
      return [];
    }
  }

  function setupBookSuggest(form) {
    const input = form.book_title;
    const list = h("ul", { class: "book-suggest", role: "listbox", hidden: true });
    input.after(list);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    let items = [], active = -1, timer, seq = 0;

    function close() { list.hidden = true; active = -1; }
    function choose(b) {
      input.value = b.title;
      form.book_author.value = b.author;
      if (b.category && form.category && !form.category.value) form.category.value = b.category;
      close();
      form.book_author.dispatchEvent(new Event("input"));
      (form.category && !form.category.value ? form.category : form.quote).focus();
    }
    function draw() {
      list.replaceChildren(...items.map((b, i) => h("li", {
          role: "option", class: "bs-item" + (i === active ? " active" : ""), "aria-selected": String(i === active),
          onmousedown: (ev) => { ev.preventDefault(); choose(b); } },
        b.thumbnail ? h("img", { src: b.thumbnail, alt: "", loading: "lazy" }) : h("span", { class: "bs-noimg" }, b.source === "board" ? "📌" : "📖"),
        h("span", { class: "bs-text" },
          h("b", null, b.title),
          h("small", null, [b.author, b.publisher, b.year].filter(Boolean).join(" · "))),
        b.source === "board" ? h("span", { class: "bs-tag" }, "게시판") : null)));
      list.hidden = !items.length;
    }
    async function update() {
      const raw = input.value.trim();
      const q = norm(raw);
      if (q.length < 2) return close();
      const mine = ++seq;
      const local = localBooks(q);
      items = local; active = -1; draw();
      const remote = await remoteBooks(raw);
      if (mine !== seq) return;   // 그사이 더 입력했으면 버림
      const seen = new Set(local.map((b) => norm(b.title) + "|" + norm(b.author)));
      const extra = remote.filter((b) => {
        const k = norm(b.title) + "|" + norm(b.author);
        if (!b.author || seen.has(k)) return false;   // 저자 없는 항목과 같은 책 중복은 뺍니다
        seen.add(k);
        return true;
      });
      items = local.concat(extra).slice(0, 8);
      draw();
    }
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(update, 250); });
    input.addEventListener("keydown", (e) => {
      if (list.hidden) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        draw();
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        choose(items[active]);
      } else if (e.key === "Escape") {
        e.preventDefault();   // 창은 닫지 않고 목록만 닫기
        close();
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 100));
  }

  // ---------- 많이 소개된 책 ----------
  const topBooksEl = $("#topBooks");
  function renderTopBooks(source) {
    const books = new Map();   // 띄어쓰기를 뺀 제목 → { title, people }
    for (const p of source) {
      for (const e of p.entries || []) {
        const key = norm(e.book_title);
        if (!books.has(key)) books.set(key, { title: e.book_title, people: new Set() });
        books.get(key).people.add(p.id);
      }
    }
    const top = [...books.values()].filter((b) => b.people.size >= 2)
      .sort((a, b) => b.people.size - a.people.size).slice(0, 5);
    topBooksEl.hidden = !top.length;
    const q = searchEl.value.trim();
    topBooksEl.replaceChildren(h("span", { class: "top-label" }, "🏆 많이 소개된 책"),
      ...top.map((b, i) => h("button", { type: "button", class: "top-book" + (q === b.title ? " on" : ""),
        title: "이 책 글만 보기",
        onclick: () => { searchEl.value = q === b.title ? "" : b.title; render(); } },
        h("b", null, i + 1), "『" + b.title + "』 ", h("small", null, b.people.size + "명"))));
  }

  // ---------- 공지 띠 · 이달의 주제 (관리자 화면에서 정함) ----------
  let settings = {};
  let topicOnly = false;
  const boardNoticeEl = $("#boardNotice");
  function renderBoardNotice() {
    const { notice, topic } = demo ? {} : settings;
    if (!topic) topicOnly = false;
    boardNoticeEl.hidden = !notice && !topic;
    boardNoticeEl.replaceChildren(
      notice ? h("div", null, "📢 ", notice) : null,
      topic ? h("div", { class: "bn-topic" }, "🎯 이달의 주제: ", h("b", null, topic),
        h("button", { class: "btn small" + (topicOnly ? " primary" : ""), type: "button",
          onclick: () => { topicOnly = !topicOnly; render(); } }, topicOnly ? "모든 글 보기" : "주제 글만 보기")) : null);
    document.querySelectorAll(".topic-join").forEach((el) => (el.hidden = !topic));
    document.querySelectorAll("[data-topic]").forEach((el) => (el.textContent = topic ? "‘" + topic + "’" : ""));
  }

  // ---------- 참여 많은 반 TOP 3 (학번 20315 → 2학년 3반) ----------
  const topClassesEl = $("#topClasses");
  function classOf(sno) {
    const m = String(sno || "").match(/^([1-3])(\d{2})\d{2}$/) || String(sno || "").match(/^([1-3])(\d)\d{2}$/);
    return m ? m[1] + "학년 " + Number(m[2]) + "반" : null;
  }
  function renderTopClasses(source) {
    const map = new Map();
    for (const p of source) {
      const c = p.role !== "teacher" && classOf(p.student_no);
      if (!c) continue;
      if (!map.has(c)) map.set(c, new Set());
      map.get(c).add(norm(p.student_no) + "|" + norm(p.author_name || p.display_name));
    }
    const top = [...map.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 3);
    topClassesEl.hidden = !top.length;
    topClassesEl.replaceChildren(h("span", { class: "top-label" }, "🏫 참여 많은 반"),
      ...top.map(([c, set], i) => h("span", { class: "top-class" }, h("b", null, i + 1), c + " ", h("small", null, set.size + "명"))));
  }

  let lastShown = [];
  function render() {
    const q = searchEl.value.trim().toLowerCase();
    const cat = catFilter.value;
    const source = demo ? DEMO_POSTS : posts;
    const topic = !demo && topicOnly && settings.topic;
    const shown = source.filter((p) => (!q || matches(p, q)) && inGrade(p)
      && (!cat || (p.entries || []).some((e) => e.category === cat))
      && (!topic || (p.entries || []).some((e) => e.topic === topic)));
    if (SORTS[sortSel.value]) shown.sort(SORTS[sortSel.value]);
    shown.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));   // 선생님 추천은 언제나 맨 앞
    lastShown = shown;
    // 검색·필터·정렬이 바뀌면 다시 처음 PAGE 개부터 보여 줍니다.
    const filterKey = [q, cat, grade, sortSel.value, topic, demo].join("|");
    if (filterKey !== lastFilterKey) { limit = PAGE; lastFilterKey = filterKey; }
    const want = revealId ?? flashId;
    revealId = null;
    const at = want == null ? -1 : shown.findIndex((p) => p.id === want);
    if (at >= limit) limit = Math.ceil((at + 1) / PAGE) * PAGE;
    countPeople(source);
    renderTopBooks(source);
    renderTopClasses(demo ? source : posts);
    renderBoardNotice();
    updateNotice();
    const filtering = q || cat || grade !== "all" || topic;
    const sorted = sortSel.value !== "recent";

    const cards = shown.slice(0, limit).map((p) => renderPost(p));
    // 실제 게시판 첫머리(추천 글 다음)에는 작성 예시 말풍선을 하나 보여 줍니다. (실제 글이 10개가 넘으면 숨김)
    if (!demo && !filtering && !sorted && posts.length < 10) {
      cards.splice(shown.filter((p) => p.pinned).length, 0, renderPost(EXAMPLE_POST, { example: true }));
    }
    layout(cards);
    clampCheck();
    const rest = shown.length - limit;
    moreBtn.hidden = rest <= 0;
    if (rest > 0) moreBtn.textContent = "말풍선 더 보기 (" + rest + "개 남음)";
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
    else if (!shown.length) statusEl.textContent = q ? "‘" + searchEl.value.trim() + "’ 검색 결과가 없어요." : "조건에 맞는 말풍선이 아직 없어요.";
    else statusEl.textContent = filtering ? shown.length + "개를 찾았어요." : "";
    statusEl.hidden = !statusEl.textContent;
  }

  // ---------- 내 말풍선 새 댓글 알림 (이 기기에서 쓴 말풍선만) ----------
  const noticeEl = $("#myNotice");
  function updateNotice() {
    const fresh = demo ? [] : posts.filter((p) => unseen(p));
    const n = fresh.reduce((sum, p) => sum + unseen(p), 0);
    noticeEl.hidden = !n;
    if (n) noticeEl.replaceChildren(h("span", null, "💬 내 말풍선에 새 댓글 ", h("b", null, n + "개"), "가 달렸어요"), h("span", { class: "go" }, "보러 가기 ›"));
  }
  noticeEl.addEventListener("click", () => {
    const p = posts.find((x) => unseen(x));
    if (!p) return updateNotice();
    if (!lastShown.includes(p)) {   // 필터에 가려져 있으면 필터를 풀고 찾아갑니다
      searchEl.value = "";
      catFilter.value = "";
      grade = "all";
      document.querySelectorAll("[data-grade]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.grade === "all")));
    }
    openComments.add(p.id);
    revealId = p.id;
    render();
    fetchComments(p.id);
    const el = boardEl.querySelector('.post[data-id="' + p.id + '"]');
    if (el) {
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  // ---------- 교실 전시 모드: 지금 보이는 말풍선을 하나씩 크게, 10초마다 넘김 ----------
  const SHOW_MS = 10000;
  const showcase = $("#showcase");
  let showList = [], showIdx = 0, showTimer = null, showPaused = false;

  function showSlide() {
    const p = showList[showIdx];
    const e = p.entries[p.entries.length - 1];
    const teacher = p.role === "teacher";
    $("#showStage").replaceChildren(h("article", { class: "show-card c-" + p.color + (teacher ? " teacher" : "") },
      teacher ? h("span", { class: "teacher-tag" }, "🍎 선생님의 책") : null,
      bookLine(e),
      h("p", { class: "show-quote" }, e.quote),
      h("footer", { class: "show-who" },
        teacher ? "선생님 · " : "", p.student_no + " " + (p.author_name || p.display_name),
        p.nickname ? " (" + p.nickname + ")" : "",
        p.entries.length > 1 ? h("span", { class: "show-more" }, "📖 " + (p.entries.length - 1) + "번 이어 씀") : null,
        p.like_count ? h("span", { class: "show-more" }, "❤️ " + p.like_count) : null)));
    $("#showCount").textContent = (showIdx + 1) + " / " + showList.length;
    const bar = $("#showProgress");
    bar.style.animation = "none";
    void bar.offsetWidth;   // 진행 막대 애니메이션을 처음부터 다시
    bar.style.animation = showPaused ? "none" : "showbar " + SHOW_MS / 1000 + "s linear";
    clearTimeout(showTimer);
    if (!showPaused) showTimer = setTimeout(() => moveShow(1), SHOW_MS);
  }
  function moveShow(d) {
    showIdx = (showIdx + d + showList.length) % showList.length;
    showSlide();
  }
  function openShow() {
    showList = lastShown.filter((p) => p.entries && p.entries.length);
    if (!showList.length) return toast("보여 줄 말풍선이 없어요.", true);
    showIdx = 0;
    showPaused = false;
    $("#showPause").textContent = "⏸";
    $("#showTitle").textContent = cfg.TITLE || "독서나눔 릴레이";
    showcase.hidden = false;
    document.body.classList.add("show-open");
    if (showcase.requestFullscreen) showcase.requestFullscreen().catch(() => {});
    showSlide();
  }
  function closeShow() {
    clearTimeout(showTimer);
    showcase.hidden = true;
    document.body.classList.remove("show-open");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  $("#showBtn").addEventListener("click", openShow);
  $("#showClose").addEventListener("click", closeShow);
  $("#showPrev").addEventListener("click", () => moveShow(-1));
  $("#showNext").addEventListener("click", () => moveShow(1));
  $("#showPause").addEventListener("click", () => {
    showPaused = !showPaused;
    $("#showPause").textContent = showPaused ? "▶︎ 재생" : "⏸";
    showSlide();
  });
  document.addEventListener("keydown", (e) => {
    if (showcase.hidden) return;
    if (e.key === "ArrowRight") moveShow(1);
    else if (e.key === "ArrowLeft") moveShow(-1);
    else if (e.key === "Escape") closeShow();
    else if (e.key === " ") { e.preventDefault(); $("#showPause").click(); }
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && !showcase.hidden) closeShow();
  });

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

  const moreBtn = h("button", { class: "btn more-btn", type: "button", hidden: true, onclick: () => {
    limit += PAGE;
    render();
  } });
  boardEl.after(moreBtn);

  // 처음에는 말풍선 전체를 받고, 그다음부터는 지난번 이후 바뀐 말풍선과 댓글·공감 수만 받습니다.
  // (글이 수백 개여도 자동 새로고침 한 번에 오가는 데이터가 작게 유지됩니다)
  let loaded = false;
  let since = null;       // 지난 응답의 서버 시각
  let lastSig = "";       // 바뀐 것이 없으면 화면을 다시 그리지 않습니다
  function merge(res) {
    const fresh = new Map(res.posts.map((p) => [p.id, p]));
    if (since == null) return res.posts;
    const old = new Map(posts.map((p) => [p.id, p]));
    const next = [];
    for (const [id, comments, likes] of res.counts) {
      const p = fresh.get(id) || old.get(id);
      if (!p) return null;   // 놓친 말풍선이 있으면 전체를 다시 받습니다
      p.comment_count = comments;
      p.like_count = likes;
      next.push(p);
    }
    return next.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }
  async function load(quiet) {
    if (!isConfigured()) {
      render();
      statusEl.textContent = "js/config.js 에 Supabase 주소와 키를 넣어 주세요. (README 참고)";
      return;
    }
    try {
      let res = await rpc("get_board_changes", { p_since: since });
      let next = merge(res);
      if (!next) {
        since = null;
        res = await rpc("get_board_changes", { p_since: null });
        next = merge(res);
      }
      const sig = JSON.stringify([res.counts, res.settings]);
      const changed = since == null || res.posts.length || sig !== lastSig;
      since = res.now;
      lastSig = sig;
      posts = next;
      settings = res.settings || {};
      if (changed || flashId != null) render();
      // 열어 둔 댓글 창은 댓글 수가 바뀌었을 때만 다시 불러옵니다.
      for (const id of openComments) {
        const p = posts.find((x) => x.id === id);
        if (p && p.comment_count != null && (commentCache[id] || []).length !== p.comment_count) fetchComments(id);
      }
      loaded = true;
      document.dispatchEvent(new Event("board:loaded"));
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
  [postForm, addForm, editForm].forEach(setupBookSuggest);

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

  // book: 추천도서 탭의 [이 책 소개하기]에서 넘겨주는 { title, author, category }
  function openPost(book) {
    if (demo) setDemo(false);
    formError(postForm, "");
    if (book && book.title) {
      postForm.book_title.value = book.title;
      postForm.book_author.value = book.author || "";
      if (book.category) postForm.category.value = book.category;
    }
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
  $("#newBtn").addEventListener("click", () => openPost());
  $("#fab").addEventListener("click", () => openPost());

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
          p_category: f.category.value,
          p_topic: !!settings.topic && f.topic_join.checked,
        });
        saveMe({ role: f.elements.role.value, student_no: f.student_no.value.trim(),
          author_name: f.author_name.value.trim(), nickname: f.nickname.value.trim() });
        postDialog.close();
        f.reset();
        applyRole();
        toast("게시했어요! 🎉");
        flashId = created && created.id;
        if (flashId != null) markMine(flashId, 0);
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
    addForm.category.value = last.category || "기타";
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
          p_category: f.category.value,
          p_topic: !!settings.topic && f.topic_join.checked,
        });
        if (result !== "OK") throw new Error(window.Board.ERROR_TEXT[result] || result);
        const target = posts.find((x) => x.id === addTargetId);
        if (target && !(target.id in mine)) markMine(target.id, target.comment_count || 0);   // 비밀번호를 아는 사람 = 글쓴이
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
    editForm.category.value = e.category || "기타";
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
          p_category: f.category.value,
        });
        if (result !== "OK") throw new Error(window.Board.ERROR_TEXT[result] || result);
        if (!(editPost.id in mine)) markMine(editPost.id, editPost.comment_count || 0);
        await afterEdit("고쳤어요! ✏️");
      } catch (ex) {
        formError(f, ex.message);
      }
    });
  });

  $("#deleteBtn").addEventListener("click", async () => {
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
    if (!(await ask({ title: "글 지우기", message: msg, okText: "지우기", danger: true }))) return;
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

  // ---------- 사용법 (처음 온 기기에서는 한 번 저절로 열림) ----------
  const helpDialog = $("#helpDialog");
  function openHelp() {
    helpDialog.showModal();
    helpDialog.querySelector(".help-body").scrollTop = 0;
  }
  $("#helpBtn").addEventListener("click", openHelp);
  helpDialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => helpDialog.close()));
  helpDialog.addEventListener("click", (e) => { if (e.target === helpDialog) helpDialog.close(); });
  helpDialog.querySelectorAll(".help-toc a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    helpDialog.querySelector(a.getAttribute("href")).scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  helpDialog.querySelector("[data-demo-help]").addEventListener("click", () => {
    helpDialog.close();
    if (!demo) setDemo(true);
  });
  if (!store("reading-board-help-seen", false)) {
    keep("reading-board-help-seen", true);
    setTimeout(openHelp, 600);
  }

  // 추천도서 탭(js/recommend.js)이 쓰는 연결
  window.BoardApp = { posts: () => posts, norm, write: openPost };

  // ---------- 시작 ----------
  let searchTimer;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150);
  });

  load();
  setInterval(() => {
    if (document.visibilityState !== "visible" || demo || !showcase.hidden || postDialog.open || addDialog.open || editDialog.open || helpDialog.open) return;
    // 댓글을 쓰는 중이면 화면을 다시 그리지 않습니다.
    const typing = [...boardEl.querySelectorAll(".comment-form textarea, .comment-form input[name=pin]")]
      .some((el) => el.value || el === document.activeElement);
    if (!typing) load(true);
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && loaded) load(true);
  });
})();
