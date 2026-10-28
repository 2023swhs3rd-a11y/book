// 관리자 화면: 조회 · 필터 · 숨김 · 삭제 · 비밀번호 초기화 · CSV/XLSX 내보내기
(function () {
  const { cfg, COLORS, CATEGORIES, SCHEMA_VERSION, ERROR_TEXT, isConfigured, rpc, fmtDate, h, toast, ask } = window.Board;
  const BACKUP_DAYS = 14;   // 이보다 오래 백업하지 않으면 알림
  const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  const QR_SRC = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
  const PW_KEY = "board-admin-pw";

  const $ = (sel) => document.querySelector(sel);
  const loginForm = $("#loginForm");
  const filters = $("#filters");
  const rowsEl = $("#rows");
  const colorLabel = Object.fromEntries(COLORS.map((c) => [c.key, c.label]));
  filters.elements.cat.append(...CATEGORIES.map((c) => h("option", { value: c }, c)));
  const reportCount = (p) => (p.reports || []).length;
  // 검토 대기: 신고 3건으로 자동 숨김됐거나 도배 정리로 숨긴 글, 자동 숨김된 댓글
  const reviewCount = (p) => (p.auto_hidden ? 1 : 0) + (p.comments || []).filter((c) => c.hidden).length;

  let pw = null;
  let allPosts = [];   // 보관한 학기까지 모든 글
  let posts = [];      // 위 '학기' 필터로 고른 글 (통계 · 표 · 내보내기의 기준)
  let lastBackup = null;
  let schemaOk = true;
  const expanded = new Set();

  function storage(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }

  // ---------- 로그인 ----------
  async function login(password, silent) {
    try {
      const res = await rpc("admin_list", { p_pw: password });
      pw = password;
      storage((s) => s.setItem(PW_KEY, password));
      allPosts = res.posts || [];
      lastBackup = res.last_backup_at;
      loginForm.hidden = true;
      $("#adminMain").hidden = false;
      $("#adminTools").hidden = false;
      render();
      checkSchema();
    } catch (e) {
      storage((s) => s.removeItem(PW_KEY));
      if (!silent) loginForm.querySelector(".form-error").textContent = e.message;
    }
  }

  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!isConfigured()) {
      loginForm.querySelector(".form-error").textContent = "js/config.js 에 Supabase 정보를 먼저 넣어 주세요.";
      return;
    }
    login($("#loginPw").value);
  });

  $("#logoutBtn").addEventListener("click", () => {
    storage((s) => s.removeItem(PW_KEY));
    location.reload();
  });

  $("#pwBtn").addEventListener("click", async () => {
    const next = await ask({ title: "관리자 비밀번호 변경", message: "새 비밀번호를 입력해 주세요. (10자 이상, 선생님 한두 분만 알도록)",
      input: { type: "password", autocomplete: "new-password" }, okText: "다음" });
    if (next == null) return;
    const again = await ask({ title: "관리자 비밀번호 변경", message: "확인을 위해 한 번 더 입력해 주세요.",
      input: { type: "password", autocomplete: "new-password" }, okText: "바꾸기" });
    if (again == null) return;
    if (next !== again) return toast("두 번 입력한 비밀번호가 달라요.", true);
    try {
      await rpc("admin_change_password", { p_pw: pw, p_new_pw: next });
      pw = next;
      storage((s) => s.setItem(PW_KEY, next));
      toast("비밀번호를 바꿨어요.");
    } catch (e) { toast(e.message, true); }
  });

  async function reload() {
    try {
      const res = await rpc("admin_list", { p_pw: pw });
      allPosts = res.posts || [];
      lastBackup = res.last_backup_at;
      render();
    } catch (e) { toast(e.message, true); }
  }
  $("#reloadBtn").addEventListener("click", reload);

  async function act(fn, params, okMsg) {
    try {
      await rpc(fn, Object.assign({ p_pw: pw }, params));
      toast(okMsg);
      await reload();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- 알림: DB 버전 · 신고 · 백업 ----------
  async function checkSchema() {
    try { schemaOk = (await rpc("schema_version")) >= SCHEMA_VERSION; } catch (e) { schemaOk = false; }
    renderAlerts();
  }

  const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

  function renderAlerts() {
    const out = [];
    if (!schemaOk) {
      out.push(h("div", { class: "alert danger" },
        h("span", null, "⚠️ ", h("b", null, "DB 업데이트가 필요해요."), " 저장소의 supabase/schema.sql 전체를 Supabase SQL Editor 에 붙여 넣고 Run 해 주세요. 그 전에는 새 기능에서 오류가 나요."),
        h("a", { class: "btn small", href: "https://github.com/2023swhs3rd-a11y/book/blob/main/supabase/schema.sql", target: "_blank", rel: "noopener" }, "schema.sql 열기")));
    }
    const review = allPosts.filter((p) => reviewCount(p));
    if (review.length) {
      out.push(h("div", { class: "alert report" },
        h("span", null, "🙈 자동으로 숨긴 글·댓글 ", h("b", null, review.reduce((n, p) => n + reviewCount(p), 0) + "개"), "가 검토를 기다려요. 괜찮은 글이면 다시 보이게, 아니면 삭제해 주세요."),
        h("button", { class: "btn small", type: "button", onclick: () => {
          const f = filters.elements;
          filters.reset();
          f.season.value = "*";
          f.state.value = "review";
          render();
          $(".export-bar").scrollIntoView({ behavior: "smooth", block: "start" });
        } }, "검토하기")));
    }
    const reported = allPosts.filter((p) => reportCount(p));
    const n = reported.reduce((sum, p) => sum + reportCount(p), 0);
    if (n) {
      out.push(h("div", { class: "alert report" },
        h("span", null, "🚩 확인하지 않은 신고 ", h("b", null, n + "건"), "이 있어요 (말풍선 " + reported.length + "개)."),
        h("button", { class: "btn small", type: "button", onclick: () => {
          const f = filters.elements;
          filters.reset();
          f.season.value = "*";
          f.state.value = "reported";
          f.sort.value = "reports";
          render();
          $(".export-bar").scrollIntoView({ behavior: "smooth", block: "start" });
        } }, "신고 글 보기")));
    }
    const days = lastBackup ? daysSince(lastBackup) : null;
    if (allPosts.length && (days == null || days >= BACKUP_DAYS)) {
      out.push(h("div", { class: "alert backup" },
        h("span", null, "💾 ", days == null ? "아직 엑셀 백업을 한 적이 없어요." : "마지막 엑셀 백업이 " + days + "일 전이에요.",
          " 무료 Supabase 는 자동 백업이 없으니 2주에 한 번은 내려받아 두세요."),
        h("button", { class: "btn small primary", type: "button", onclick: fullBackup }, "지금 전체 백업")));
    }
    $("#alerts").replaceChildren(...out);
    $("#backupInfo").textContent = "마지막 백업: " + (days == null ? "없음" : days === 0 ? "오늘" : days + "일 전");
  }

  async function markBackup() {
    try {
      await rpc("admin_mark_backup", { p_pw: pw });
      lastBackup = new Date().toISOString();
      renderAlerts();
    } catch (e) { toast(e.message, true); }
  }

  async function fullBackup() {
    try {
      await writeWorkbook(allPosts.map((p) => ({ post: p, entries: p.entries })), "독서현황_전체백업_" + fileName("xlsx").slice(5));
      await markBackup();
      toast("전체 백업 파일을 내려받았어요.");
    } catch (e) { toast(e.message, true); }
  }

  // ---------- 필터 ----------
  function dayStart(v) { return v ? new Date(v + "T00:00:00").getTime() : null; }

  function inRange(e, from, to) {
    const t = new Date(e.created_at).getTime();
    return (from == null || t >= from) && (to == null || t < to + 86400000);
  }

  // 조건에 맞는 게시물과, 그 안에서 기간에 맞는 글만 돌려줍니다.
  function filtered() {
    const f = filters.elements;
    const q = f.q.value.trim().toLowerCase();
    const sno = f.sno.value.trim();
    const from = dayStart(f.from.value);
    const to = dayStart(f.to.value);
    const state = f.state.value;
    const role = f.role.value;
    const cat = f.cat.value;

    const list = [];
    for (const p of posts) {
      if (state === "shown" && p.hidden) continue;
      if (state === "hidden" && !p.hidden) continue;
      if (state === "reported" && !reportCount(p)) continue;
      if (state === "review" && !reviewCount(p)) continue;
      if (role !== "all" && (p.role || "student") !== role) continue;
      if (sno && !(p.student_no || "").startsWith(sno)) continue;
      const entries = (p.entries || []).filter((e) => inRange(e, from, to) && (!cat || e.category === cat));
      if (!entries.length) continue;
      if (q) {
        const text = [p.author_name, p.nickname, p.student_no,
          ...p.entries.flatMap((e) => [e.book_title, e.book_author, e.quote, e.category]),
          ...(p.comments || []).flatMap((c) => [c.student_no, c.author_name, c.body])].join(" ").toLowerCase();
        if (!text.includes(q)) continue;
      }
      list.push({ post: p, entries });
    }

    const sort = f.sort.value;
    if (sort === "sno") list.sort((a, b) => a.post.student_no.localeCompare(b.post.student_no, "ko", { numeric: true }));
    else if (sort === "count") list.sort((a, b) => b.post.entries.length - a.post.entries.length);
    else if (sort === "reports") list.sort((a, b) => reportCount(b.post) - reportCount(a.post));
    return list;
  }

  // ---------- 그리기 ----------
  function renderStats() {
    const entries = posts.reduce((n, p) => n + (p.entries || []).length, 0);
    const students = new Set(posts.filter((p) => p.role !== "teacher").map((p) => p.student_no)).size;
    const teachers = posts.filter((p) => p.role === "teacher").length;
    const books = new Set(posts.flatMap((p) => (p.entries || []).map((e) => e.book_title.replace(/\s/g, "")))).size;
    const hidden = posts.filter((p) => p.hidden).length;
    const comments = posts.reduce((n, p) => n + (p.comments || []).length, 0);
    const likes = posts.reduce((n, p) => n + (p.like_count || 0), 0);
    const reported = posts.filter((p) => reportCount(p)).length;
    $("#stats").replaceChildren(
      ...[["게시물", posts.length], ["전체 글(이어쓰기 포함)", entries], ["참여 학생", students], ["교사 글", teachers],
          ["소개된 책", books], ["댓글", comments], ["공감", likes], ["🚩 신고된 글", reported], ["숨김", hidden]]
        .map(([k, v]) => h("div", { class: "stat" }, h("b", null, v), h("span", null, k))));
  }

  // ---------- 학급별 참여 현황 ----------
  // 학번 20315 → 2학년 3반 (4자리 2315 도 2학년 3반으로 봅니다)
  function classOf(sno) {
    const m = String(sno || "").match(/^([1-3])(\d{2})\d{2}$/) || String(sno || "").match(/^([1-3])(\d)\d{2}$/);
    return m ? { grade: +m[1], cls: +m[2], label: m[1] + "학년 " + +m[2] + "반" } : null;
  }

  function classStats(source = posts) {
    const map = new Map();
    const get = (c) => {
      if (!map.has(c.label)) map.set(c.label, { ...c, students: new Map(), posts: 0, entries: 0, comments: 0, likes: 0 });
      return map.get(c.label);
    };
    for (const p of source) {
      if (p.role === "teacher") continue;
      const c = classOf(p.student_no);
      if (c) {
        const row = get(c);
        row.students.set(p.student_no + p.author_name, p.student_no + " " + p.author_name);
        row.posts += 1;
        row.entries += (p.entries || []).length;
        row.likes += p.like_count || 0;
      }
      for (const cm of p.comments || []) {
        const cc = classOf(cm.student_no);
        if (cc) get(cc).comments += 1;
      }
    }
    return [...map.values()].sort((a, b) => a.grade - b.grade || a.cls - b.cls);
  }

  function renderClasses() {
    const rows = classStats();
    $("#classRows").replaceChildren(...(rows.length
      ? rows.map((r) => h("tr", null,
          h("td", { "data-label": "학년·반" }, h("b", null, r.label)),
          h("td", { "data-label": "참여 학생" }, r.students.size + "명"),
          h("td", { "data-label": "게시물" }, r.posts),
          h("td", { "data-label": "글" }, r.entries),
          h("td", { "data-label": "쓴 댓글" }, r.comments),
          h("td", { "data-label": "받은 공감" }, r.likes),
          h("td", { "data-label": "명단", class: "names" }, [...r.students.values()].sort().join(", "))))
      : [h("tr", null, h("td", { colspan: 7, class: "empty" }, "학번으로 학급을 알 수 있는 글이 아직 없어요."))]));
  }

  function classSheetRows(source) {
    return classStats(source).map((r) => ({
      "학년": r.grade, "반": r.cls, "참여 학생 수": r.students.size, "게시물": r.posts,
      "글(이어쓰기 포함)": r.entries, "쓴 댓글": r.comments, "받은 공감": r.likes,
      "참여 학생 명단": [...r.students.values()].sort().join(", "),
    }));
  }

  // ---------- QR 포스터 ----------
  function loadScript(src, name) {
    if (window[name]) return Promise.resolve(window[name]);
    return new Promise((resolve, reject) => {
      const s = h("script", { src });
      s.onload = () => resolve(window[name]);
      s.onerror = () => reject(new Error("도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요."));
      document.head.append(s);
    });
  }

  $("#qrBtn").addEventListener("click", async () => {
    try {
      const qrcode = await loadScript(QR_SRC, "qrcode");
      const url = new URL("./", location.href).href;
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      const box = h("div", { class: "p-qr" });
      box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
      $("#poster").replaceChildren(
        h("div", { class: "p-icon" }, "📚"),
        h("h1", null, cfg.TITLE || "독서나눔 릴레이"),
        h("p", { class: "p-sub" }, cfg.SUBTITLE || "지금 읽고 있는 책을 말풍선으로 소개해 주세요"),
        box,
        h("p", { class: "p-steps" }, "📱 휴대폰 카메라로 QR 코드를 비추고", h("br"), "✏️ [글쓰기] 를 눌러 읽고 있는 책을 소개해 주세요!"),
        h("p", { class: "p-url" }, url));
      document.body.classList.add("printing-poster");
      setTimeout(() => {
        window.print();
        document.body.classList.remove("printing-poster");
      }, 100);
    } catch (e) { toast(e.message, true); }
  });

  function postRow({ post: p, entries }) {
    const last = p.entries[p.entries.length - 1];
    const open = expanded.has(p.id);
    const tr = h("tr", { class: (p.hidden ? "is-hidden " : "") + "c-" + p.color },
      h("td", { "data-label": "학번/부서" }, p.student_no),
      h("td", { "data-label": "이름" }, p.role === "teacher" ? h("span", { class: "pill teacher" }, "교사") : null, " ", h("b", null, p.author_name)),
      h("td", { "data-label": "닉네임" }, p.nickname || "–"),
      h("td", { "data-label": "책", class: "book-cell" },
        h("span", { class: "dot", title: colorLabel[p.color] }),
        "『" + last.book_title + "』 ", h("small", null, last.book_author)),
      h("td", { "data-label": "글 수" }, entries.length === p.entries.length ? p.entries.length : entries.length + " / " + p.entries.length),
      h("td", { "data-label": "댓글" }, (p.comments || []).length),
      h("td", { "data-label": "처음 작성" }, fmtDate(p.created_at, true)),
      h("td", { "data-label": "최근 활동" }, fmtDate(p.updated_at, true)),
      h("td", { "data-label": "상태" }, p.hidden ? h("span", { class: "pill off" }, p.auto_hidden ? "🙈 자동 숨김" : "숨김") : h("span", { class: "pill on" }, "게시 중"),
        (p.comments || []).some((c) => c.hidden) ? h("span", { class: "pill off" }, "숨긴 댓글 " + p.comments.filter((c) => c.hidden).length) : null,
        reportCount(p) ? h("span", { class: "pill report" }, "🚩 " + reportCount(p)) : null,
        p.pinned ? h("span", { class: "pill pin" }, "📌 추천") : null,
        p.season ? h("span", { class: "pill season" }, p.season) : null),
      h("td", { class: "actions" },
        h("button", { class: "btn small", type: "button", onclick: () => { open ? expanded.delete(p.id) : expanded.add(p.id); render(); } }, open ? "접기" : "내용 보기"),
        h("button", { class: "btn small", type: "button",
          onclick: () => act("admin_set_hidden", { p_post_id: p.id, p_hidden: !p.hidden }, p.hidden ? "다시 보이게 했어요." : "숨겼어요.") },
          p.hidden ? "보이기" : "숨기기"),
        p.season ? null : h("button", { class: "btn small", type: "button", title: "학생 게시판 맨 위에 '선생님 추천'으로 고정해요",
          onclick: () => act("admin_set_pinned", { p_post_id: p.id, p_pinned: !p.pinned }, p.pinned ? "추천을 해제했어요." : "선생님 추천으로 맨 위에 고정했어요.") },
          p.pinned ? "추천 해제" : "📌 추천"),
        h("button", { class: "btn small", type: "button", title: "이 학생의 모든 학기 글을 한 장으로 인쇄해요",
          onclick: () => printCards([personKey(p)]) }, "🖨 기록 카드"),
        h("button", { class: "btn small", type: "button", onclick: async () => {
          const pin = await ask({ title: "비밀번호 초기화", message: p.student_no + " " + p.author_name + " 님의 새 비밀번호 (숫자 4자리)",
            input: { inputmode: "numeric", maxlength: 4, placeholder: "숫자 4자리" }, okText: "바꾸기" });
          if (pin != null) act("admin_reset_pin", { p_post_id: p.id, p_new_pin: pin.trim() }, "비밀번호를 " + pin.trim() + " 로 바꿨어요.");
        } }, "비번 초기화"),
        h("button", { class: "btn small danger", type: "button", onclick: async () => {
          if (await ask({ title: "게시물 삭제", danger: true, okText: "삭제",
            message: p.student_no + " " + p.author_name + " 님의 게시물(글 " + p.entries.length + "개, 댓글 " + (p.comments || []).length + "개)을 모두 삭제할까요? 되돌릴 수 없어요." }))
            act("admin_delete_post", { p_post_id: p.id }, "삭제했어요.");
        } }, "삭제")));

    if (!open) return [tr];
    const detail = h("tr", { class: "detail" }, h("td", { colspan: 10 },
      reportCount(p)
        ? h("div", { class: "report-box" },
            h("h4", null, "🚩 신고 " + reportCount(p) + "건",
              h("button", { class: "btn small", type: "button",
                onclick: () => act("admin_clear_reports", { p_post_id: p.id }, "신고를 확인 완료로 정리했어요.") }, "확인 완료(신고 지우기)")),
            h("ul", null, p.reports.map((r) => {
              const c = r.comment_id && (p.comments || []).find((x) => x.id === r.comment_id);
              return h("li", null, (r.comment_id ? "댓글" + (c ? "(" + c.author_name + ": " + c.body.slice(0, 20) + ")" : "") : "말풍선") +
                " · " + (r.reason || "이유 없음") + " · " + fmtDate(r.created_at, true));
            })))
        : null,
      h("ol", { class: "entry-list" }, p.entries.map((e, i) =>
        h("li", { class: entries.includes(e) ? "" : "dim" },
          h("div", { class: "entry-meta" },
            h("b", null, i === 0 ? "첫 글" : "이어쓰기 " + i),
            " · 『" + e.book_title + "』 " + e.book_author + (e.category ? " · " + e.category : "") + " · " + fmtDate(e.created_at, true),
            e.topic ? h("span", { class: "pill topic" }, "🎯 " + e.topic) : null,
            i > 0 ? h("button", { class: "btn small danger", type: "button", onclick: async () => {
              if (await ask({ title: "이어쓰기 글 삭제", message: "이 이어쓰기 글을 삭제할까요? 되돌릴 수 없어요.", okText: "삭제", danger: true })) act("admin_delete_entry", { p_entry_id: e.id }, "글을 삭제했어요.");
            } }, "이 글 삭제") : null),
          h("p", null, e.quote)))),
      (p.comments || []).length
        ? h("div", { class: "admin-comments" },
            h("h4", null, "💬 댓글 " + p.comments.length + "개"),
            h("ul", { class: "entry-list" }, p.comments.map((c) =>
              h("li", null,
                h("div", { class: "entry-meta" },
                  c.is_teacher ? h("span", { class: "pill teacher" }, "교사") : null, " ",
                  h("b", null, c.student_no + " " + c.author_name), " · " + fmtDate(c.created_at, true),
                  c.report_count ? h("span", { class: "pill report" }, "🚩 " + c.report_count) : null,
                  c.hidden ? h("span", { class: "pill off" }, "숨김") : null,
                  h("button", { class: "btn small", type: "button",
                    onclick: () => act("admin_set_comment_hidden", { p_comment_id: c.id, p_hidden: !c.hidden }, c.hidden ? "댓글을 다시 보이게 했어요." : "댓글을 숨겼어요.") },
                    c.hidden ? "보이기" : "숨기기"),
                  h("button", { class: "btn small danger", type: "button", onclick: async () => {
                    if (await ask({ title: "댓글 삭제", message: c.author_name + " 님의 댓글을 삭제할까요?", okText: "삭제", danger: true })) act("admin_delete_comment", { p_comment_id: c.id }, "댓글을 삭제했어요.");
                  } }, "댓글 삭제")),
                h("p", { class: c.hidden ? "dim" : null }, c.body)))))
        : null));
    return [tr, detail];
  }

  // ---------- 학기 ----------
  function seasons() {
    const map = new Map();
    for (const p of allPosts) if (p.season) map.set(p.season, (map.get(p.season) || 0) + 1);
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0], "ko", { numeric: true }));
  }

  function renderSeasons() {
    const sel = filters.elements.season;
    const value = sel.value;
    const list = seasons();
    sel.replaceChildren(h("option", { value: "" }, "이번 학기"),
      ...list.map(([name, n]) => h("option", { value: name }, name + " (" + n + ")")),
      h("option", { value: "*" }, "전체 (보관 포함)"));
    sel.value = [...sel.options].some((o) => o.value === value) ? value : "";
    $("#seasonList").replaceChildren(...list.map(([name, n]) => h("li", null,
      "🗄 ", h("b", null, name), h("span", null, "게시물 " + n + "개"),
      h("button", { class: "btn small", type: "button", onclick: async () => {
        if (await ask({ title: "보관 되돌리기", okText: "되돌리기",
          message: "'" + name + "'에 보관한 게시물 " + n + "개를 이번 학기 게시판으로 되돌릴까요? 학생 화면에 다시 보여요." }))
          act("admin_unarchive_season", { p_name: name }, "'" + name + "'을(를) 이번 학기로 되돌렸어요.");
      } }, "되돌리기"))));
  }

  function render() {
    const season = filters.elements.season.value;
    posts = season === "*" ? allPosts : allPosts.filter((p) => (p.season || "") === season);
    renderSeasons();
    renderAlerts();
    renderStats();
    renderClasses();
    const list = filtered();
    const entryCount = list.reduce((n, x) => n + x.entries.length, 0);
    $("#resultCount").textContent = "조건에 맞는 게시물 " + list.length + "개 · 글 " + entryCount + "개";
    rowsEl.replaceChildren(...(list.length
      ? list.flatMap(postRow)
      : [h("tr", null, h("td", { colspan: 10, class: "empty" }, posts.length ? "조건에 맞는 게시물이 없어요." : "아직 게시물이 없어요."))]));
  }

  let t;
  filters.addEventListener("input", () => { clearTimeout(t); t = setTimeout(render, 150); });
  filters.addEventListener("reset", () => setTimeout(render));

  // ---------- 내보내기 ----------
  function exportRows(list = filtered()) {
    const rows = [];
    for (const { post: p, entries } of list) {
      for (const e of entries) {
        const idx = p.entries.indexOf(e);
        rows.push({
          "게시물 번호": p.id,
          "학생/교사": p.role === "teacher" ? "교사" : "학생",
          "학번/부서": p.student_no,
          "이름": p.author_name,
          "닉네임": p.nickname || "",
          "글 구분": idx === 0 ? "첫 글" : "이어쓰기 " + idx,
          "책 제목": e.book_title,
          "저자": e.book_author,
          "계열": e.category || "",
          "이달의 주제": e.topic || "",
          "내용": e.quote,
          "작성일시": fmtDate(e.created_at, true),
          "말풍선 색": colorLabel[p.color] || p.color,
          "상태": p.hidden ? "숨김" : "게시 중",
          "학기": p.season || "이번 학기",
        });
      }
    }
    return rows;
  }

  function commentRows(list = filtered()) {
    const rows = [];
    for (const { post: p } of list) {
      for (const c of p.comments || []) {
        rows.push({
          "게시물 번호": p.id,
          "게시물 작성자": p.student_no + " " + p.author_name,
          "게시물 책": "『" + p.entries[p.entries.length - 1].book_title + "』",
          "댓글 학번/부서": c.student_no,
          "댓글 이름": c.author_name,
          "교사 댓글": c.is_teacher ? "교사" : "",
          "댓글 내용": c.body,
          "작성일시": fmtDate(c.created_at, true),
        });
      }
    }
    return rows;
  }

  function summaryRows(list = filtered()) {
    return list.map(({ post: p, entries }) => ({
      "학생/교사": p.role === "teacher" ? "교사" : "학생",
      "학번/부서": p.student_no,
      "이름": p.author_name,
      "닉네임": p.nickname || "",
      "글 수": entries.length,
      "받은 댓글": (p.comments || []).length,
      "받은 공감": p.like_count || 0,
      "읽은 책": [...new Set(entries.map((e) => "『" + e.book_title + "』 " + e.book_author))].join(", "),
      "처음 작성": fmtDate(entries[0].created_at, true),
      "마지막 작성": fmtDate(entries[entries.length - 1].created_at, true),
      "상태": p.hidden ? "숨김" : "게시 중",
    }));
  }

  function fileName(ext) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return "독서현황_" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes()) + "." + ext;
  }

  function download(blob, name) {
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  $("#csvBtn").addEventListener("click", () => {
    const rows = exportRows();
    if (!rows.length) return toast("내보낼 글이 없어요.", true);
    const cols = Object.keys(rows[0]);
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
    // 엑셀에서 한글이 깨지지 않도록 BOM 을 붙입니다.
    download(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), fileName("csv"));
  });

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((resolve, reject) => {
      const s = h("script", { src: XLSX_SRC });
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error("엑셀 도구를 불러오지 못했어요. CSV 를 이용해 주세요."));
      document.head.append(s);
    });
  }

  // list: [{ post, entries }] — 기본은 지금 필터에 맞는 글
  async function writeWorkbook(list, name) {
    const rows = exportRows(list);
    if (!rows.length) throw new Error("내보낼 글이 없어요.");
    const XLSX = await loadXlsx();
    const wb = XLSX.utils.book_new();
    const s1 = XLSX.utils.json_to_sheet(rows);
    s1["!cols"] = [8, 8, 10, 10, 12, 10, 24, 14, 10, 12, 60, 17, 8, 8, 14].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, s1, "전체 기록");
    const s2 = XLSX.utils.json_to_sheet(summaryRows(list));
    s2["!cols"] = [8, 10, 10, 12, 6, 8, 8, 50, 17, 17, 8].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, s2, "학생별 요약");
    const classes = classSheetRows(list.map((x) => x.post));
    if (classes.length) {
      const s4 = XLSX.utils.json_to_sheet(classes);
      s4["!cols"] = [6, 6, 10, 8, 14, 8, 8, 80].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, s4, "학급별 현황");
    }
    const comments = commentRows(list);
    if (comments.length) {
      const s3 = XLSX.utils.json_to_sheet(comments);
      s3["!cols"] = [8, 16, 20, 12, 10, 8, 60, 17].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, s3, "댓글");
    }
    XLSX.writeFile(wb, name);
  }

  $("#xlsxBtn").addEventListener("click", async () => {
    try {
      const list = filtered();
      await writeWorkbook(list, fileName("xlsx"));
      // 필터 없이 모든 글을 받았으면 전체 백업으로 칩니다.
      const count = (l) => l.reduce((n, x) => n + x.entries.length, 0);
      if (count(list) === count(allPosts.map((p) => ({ entries: p.entries })))) markBackup();
    } catch (e) { toast(e.message, true); }
  });
  $("#backupBtn").addEventListener("click", fullBackup);

  // ---------- 학기 보관 ----------
  $("#archiveForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.season_name;
    const name = input.value.trim();
    if (!name) { input.focus(); return toast("보관 이름을 입력해 주세요. 예: 2026학년도 2학기", true); }
    if (allPosts.some((p) => p.season === name)) return toast(window.Board.ERROR_TEXT.SEASON_EXISTS, true);
    const current = allPosts.filter((p) => !p.season);
    if (!current.length) return toast("보관할 이번 학기 글이 없어요.", true);
    if (!(await ask({ title: "🗄 '" + name + "'(으)로 보관할까요?", okText: "백업하고 보관", danger: true,
      message: "이번 학기 게시물 " + current.length + "개(숨긴 글 포함)를 보관해요. 먼저 엑셀 백업 파일을 내려받고, " +
        "학생 게시판은 빈 상태로 새로 시작돼요. 선생님 추천 고정도 풀려요. 보관한 글은 관리 화면에서 계속 볼 수 있고 되돌릴 수도 있어요." }))) return;
    try {
      await writeWorkbook(current.map((p) => ({ post: p, entries: p.entries })),
        "독서현황_" + name.replace(/[\\/:*?"<>|\s]+/g, "_") + "_백업.xlsx");
    } catch (ex) { return toast("백업 파일을 만들지 못해 보관을 멈췄어요. " + ex.message, true); }
    if (current.length === allPosts.length) markBackup();
    try {
      const res = await rpc("admin_archive_season", { p_pw: pw, p_name: name });
      input.value = "";
      toast("게시물 " + res.count + "개를 '" + name + "'(으)로 보관했어요. 새 학기를 시작해요!");
      await reload();
    } catch (ex) { toast(ex.message, true); }
  });

  // ---------- 학생별 독서 기록 카드 ----------
  // 같은 학번 + 이름의 글을 보관한 학기까지 모두 모아 한 장에 담습니다. (숨긴 글은 빼요)
  const personKey = (p) => (p.role || "student") + "|" + String(p.student_no || "").trim() + "|" + String(p.author_name || "").replace(/\s/g, "");

  function recordCard(key) {
    const mine = allPosts.filter((p) => personKey(p) === key && !p.hidden);
    if (!mine.length) return null;
    const who = mine[0];
    const rows = mine.flatMap((p) => p.entries.map((e) => ({ e, p })))
      .sort((a, b) => new Date(a.e.created_at) - new Date(b.e.created_at));
    const books = new Set(rows.map(({ e }) => e.book_title.replace(/\s/g, "")));
    const cats = {};
    for (const { e } of rows) if (e.category) cats[e.category] = (cats[e.category] || 0) + 1;
    const likes = mine.reduce((n, p) => n + (p.like_count || 0), 0);
    const comments = mine.reduce((n, p) => n + (p.comments || []).length, 0);
    const nick = [...new Set(mine.map((p) => p.nickname).filter(Boolean))].join(", ");
    return h("section", { class: "rc" },
      h("h1", null, "📚 독서 기록 카드"),
      h("p", { class: "rc-school" }, cfg.TITLE || "독서나눔 릴레이"),
      h("table", { class: "rc-info" }, h("tbody", null, h("tr", null,
        h("th", null, who.role === "teacher" ? "부서" : "학번"), h("td", null, who.student_no),
        h("th", null, "이름"), h("td", null, who.author_name),
        h("th", null, "닉네임"), h("td", null, nick || "–"),
        h("th", null, "출력일"), h("td", null, fmtDate(new Date().toISOString()))))),
      h("p", { class: "rc-sum" },
        h("b", null, "소개한 책 " + books.size + "권"), " · 글 " + rows.length + "개 · 받은 공감 " + likes + " · 받은 댓글 " + comments,
        h("br"), "계열: " + (Object.entries(cats).map(([c, n]) => c + " " + n).join(", ") || "–")),
      h("table", { class: "rc-list" },
        h("thead", null, h("tr", null, ["번호", "날짜", "책 제목", "저자", "계열", "내용"].map((t) => h("th", null, t)))),
        h("tbody", null, rows.map(({ e, p }, i) => h("tr", null,
          h("td", { class: "n" }, i + 1),
          h("td", { class: "d" }, fmtDate(e.created_at), p.season ? h("br") : null, p.season ? h("small", null, p.season) : null),
          h("td", null, "『" + e.book_title + "』"),
          h("td", null, e.book_author),
          h("td", { class: "d" }, e.category || "–"),
          h("td", { class: "q" }, e.quote))))),
      h("p", { class: "rc-foot" }, "봉일천고 독서나눔 릴레이 · 학생이 직접 쓴 글을 그대로 옮겼어요."));
  }

  function printCards(keys) {
    const cards = keys.map(recordCard).filter(Boolean);
    if (!cards.length) return toast("인쇄할 글이 없어요. (숨긴 글은 기록 카드에서 빠져요)", true);
    $("#cards").replaceChildren(...cards);
    document.body.classList.add("printing-cards");
    setTimeout(() => {
      window.print();
      document.body.classList.remove("printing-cards");
    }, 100);
  }

  $("#cardsBtn").addEventListener("click", async () => {
    const keys = [...new Set(filtered().filter(({ post: p }) => p.role !== "teacher").map(({ post: p }) => personKey(p)))]
      .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
    if (!keys.length) return toast("조건에 맞는 학생 글이 없어요.", true);
    if (keys.length > 1 && !(await ask({ title: "🖨 학생별 기록 카드", okText: "인쇄하기",
      message: "지금 조건에 맞는 학생 " + keys.length + "명의 기록 카드를 한 명에 한 장씩 인쇄해요. 카드에는 보관한 학기의 글까지 모두 들어가요." }))) return;
    printCards(keys);
  });

  // ---------- 설정: 교사 인증 코드 · 금지어 ----------
  const settings = $("#settings");
  async function loadSettings() {
    try {
      const res = await rpc("admin_get_words", { p_pw: pw });
      $("#wordsForm").words.value = res.words.join(", ");
      const state = $("#teacherCodeState");
      state.textContent = res.teacher_code_set ? "설정됨" : "미설정";
      state.className = "pill " + (res.teacher_code_set ? "on" : "off");
    } catch (e) { toast(e.message, true); }
  }
  settings.addEventListener("toggle", () => { if (settings.open) loadSettings(); });

  // ---------- 게시판 공지 · 이달의 주제 ----------
  const boardForm = $("#boardForm");
  $("#boardBox").addEventListener("toggle", async (e) => {
    if (!e.target.open) return;
    try {
      const conf = (await rpc("get_settings")) || {};
      boardForm.notice.value = conf.notice || "";
      boardForm.topic.value = conf.topic || "";
    } catch (ex) { toast(ex.message, true); }
  });
  boardForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await rpc("admin_set_board", { p_pw: pw, p_notice: boardForm.notice.value.trim(), p_topic: boardForm.topic.value.trim() });
      toast("게시판 공지와 이달의 주제를 저장했어요.");
    } catch (ex) { toast(ex.message, true); }
  });

  $("#teacherCodeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.code;
    try {
      await rpc("admin_set_teacher_code", { p_pw: pw, p_code: input.value.trim() });
      input.value = "";
      toast("교사 인증 코드를 저장했어요.");
      loadSettings();
    } catch (ex) { toast(ex.message, true); }
  });

  $("#wordsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const words = e.target.words.value.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
    try {
      await rpc("admin_set_words", { p_pw: pw, p_words: words });
      toast("금지어 " + words.length + "개를 저장했어요.");
      loadSettings();
    } catch (ex) { toast(ex.message, true); }
  });

  // ---------- 추천도서 ----------
  const LEVELS = { 1: "🌱 입문", 2: "🌿 보통", 3: "🌳 도전" };
  const recBox = $("#recBox");
  const recForm = $("#recForm");
  const rf = recForm.elements;
  let recBooks = [];
  recForm.querySelectorAll("select[data-categories]").forEach((sel) =>
    sel.append(...CATEGORIES.map((c) => h("option", { value: c }, c))));

  async function loadRec() {
    try {
      recBooks = await rpc("get_recommended");
      renderRec();
    } catch (e) { toast(e.message, true); }
  }
  recBox.addEventListener("toggle", () => { if (recBox.open) loadRec(); });

  function renderRec() {
    $("#recRows").replaceChildren(...(recBooks.length
      ? recBooks.map((b) => h("tr", null,
          h("td", { "data-label": "책" }, h("b", null, b.title), h("br"),
            h("small", null, [b.author, b.publisher, b.pub_year].filter(Boolean).join(" · "))),
          h("td", { "data-label": "분야" }, b.category || "–"),
          h("td", { "data-label": "난이도" }, LEVELS[b.level]),
          h("td", { "data-label": "대상" }, b.grade_from || "–"),
          h("td", { "data-label": "출처" }, b.source || "–"),
          h("td", { class: "actions" },
            h("button", { class: "btn small", type: "button", onclick: () => editRec(b) }, "고치기"),
            h("button", { class: "btn small danger", type: "button", onclick: async () => {
              if (!(await ask({ title: "추천도서 삭제", danger: true, okText: "삭제", message: "『" + b.title + "』을(를) 추천도서에서 뺄까요?" }))) return;
              try {
                await rpc("admin_delete_recommended", { p_pw: pw, p_id: b.id });
                toast("추천도서에서 뺐어요.");
                loadRec();
              } catch (e) { toast(e.message, true); }
            } }, "삭제"))))
      : [h("tr", null, h("td", { colspan: 6, class: "empty" }, "아직 등록한 추천도서가 없어요."))]));
  }

  // 난이도 채점: 네 항목 합계 4~6 입문, 7~9 보통, 10~12 도전
  function scoreRec() {
    const sum = ["s1", "s2", "s3", "s4"].reduce((n, k) => n + Number(rf[k].value), 0);
    rf.level.value = sum <= 6 ? "1" : sum <= 9 ? "2" : "3";
    $("#recScore").textContent = "합계 " + sum + "점 → " + LEVELS[rf.level.value] + " (직접 바꿔도 돼요)";
  }
  ["s1", "s2", "s3", "s4"].forEach((k) => rf[k].addEventListener("change", scoreRec));
  scoreRec();

  function editRec(b) {
    recForm.reset();
    for (const k of ["id", "title", "author", "publisher", "pub_year", "isbn", "thumbnail", "category", "grade_from", "note", "source"]) {
      rf[k].value = b[k] ?? "";
    }
    rf.level.value = String(b.level);
    $("#recScore").textContent = "저장된 난이도: " + LEVELS[b.level] + " (채점표를 바꾸면 다시 계산돼요)";
    $("#recSave").textContent = "고친 내용 저장";
    recForm.scrollIntoView({ behavior: "smooth", block: "start" });
    rf.title.focus();
  }
  recForm.addEventListener("reset", () => setTimeout(() => {
    rf.id.value = rf.isbn.value = rf.thumbnail.value = "";
    $("#recSave").textContent = "추천도서 추가";
    $("#recFound").hidden = true;
    scoreRec();
  }));

  // 카카오 책 검색 (학생 화면과 같은 Supabase 함수)
  $("#recFind").addEventListener("click", async () => {
    const q = rf.title.value.trim();
    if (q.length < 2) return toast("제목을 두 글자 이상 넣어 주세요.", true);
    const found = $("#recFound");
    try {
      const key = cfg.SUPABASE_ANON_KEY;
      const headers = { apikey: key };
      if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
      const res = await fetch(cfg.SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/" + (cfg.BOOK_SEARCH_FUNCTION || "book-search") + "?q=" + encodeURIComponent(q), { headers });
      const body = await res.json();
      if (!res.ok || !body.books) throw new Error(body.error || "책 검색을 쓸 수 없어요 (" + res.status + ")");
      if (!body.books.length) throw new Error("검색 결과가 없어요. 직접 입력해 주세요.");
      found.replaceChildren(...body.books.slice(0, 6).map((b) => h("li", null,
        h("button", { type: "button", onclick: () => {
          rf.title.value = String(b.title || "").replace(/\s*\(.*?\)\s*$/, "").trim();
          rf.author.value = (b.authors || []).join(", ");
          rf.publisher.value = b.publisher || "";
          rf.pub_year.value = b.year || "";
          rf.isbn.value = b.isbn || "";
          rf.thumbnail.value = b.thumbnail || "";
          found.hidden = true;
        } },
          b.thumbnail ? h("img", { src: b.thumbnail, alt: "", referrerpolicy: "no-referrer" }) : null,
          h("span", null, h("b", null, b.title), h("small", null, [(b.authors || []).join(", "), b.publisher, b.year].filter(Boolean).join(" · ")))))));
      found.hidden = false;
    } catch (e) { toast(e.message, true); }
  });

  recForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const book = {};
    for (const k of ["id", "title", "author", "publisher", "pub_year", "isbn", "thumbnail", "category", "level", "grade_from", "note", "source"]) book[k] = rf[k].value.trim();
    if (!book.title || !book.author) return toast("제목과 저자는 꼭 넣어 주세요.", true);
    if (book.pub_year && !/^\d{4}$/.test(book.pub_year)) return toast("출판년도는 네 자리 숫자로 넣어 주세요.", true);
    try {
      await rpc("admin_save_recommended", { p_pw: pw, p_book: book });
      toast(book.id ? "고친 내용을 저장했어요." : "『" + book.title + "』을(를) 추천도서에 넣었어요.");
      recForm.reset();
      loadRec();
    } catch (ex) { toast(ex.message, true); }
  });

  // 엑셀 양식과 일괄 등록
  const REC_COLS = ["제목", "저자", "출판사", "출판년도", "분야", "난이도", "대상 학년", "추천 이유", "출처"];
  $("#recTemplate").addEventListener("click", async () => {
    try {
      const XLSX = await loadXlsx();
      const ws = XLSX.utils.json_to_sheet([{ "제목": "데미안", "저자": "헤르만 헤세", "출판사": "민음사", "출판년도": 2000,
        "분야": "소설", "난이도": "보통", "대상 학년": "중3부터", "추천 이유": "나를 찾아가는 성장 이야기", "출처": "예시 (지우고 쓰세요)" }], { header: REC_COLS });
      ws["!cols"] = [24, 14, 12, 8, 12, 8, 10, 40, 18].map((w) => ({ wch: w }));
      const guide = XLSX.utils.aoa_to_sheet([["항목", "쓰는 법"], ["분야", CATEGORIES.join(", ")], ["난이도", "입문, 보통, 도전 (또는 1, 2, 3)"],
        ["제목·저자", "꼭 써야 해요. 나머지는 비워도 돼요."]]);
      guide["!cols"] = [{ wch: 10 }, { wch: 80 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "추천도서");
      XLSX.utils.book_append_sheet(wb, guide, "쓰는 법");
      XLSX.writeFile(wb, "추천도서_양식.xlsx");
    } catch (e) { toast(e.message, true); }
  });

  $("#recFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await file.arrayBuffer());
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
      const lv = { "입문": 1, "보통": 2, "도전": 3, "1": 1, "2": 2, "3": 3 };
      const books = rows.map((r) => ({
        title: String(r["제목"]).trim(), author: String(r["저자"]).trim(), publisher: String(r["출판사"]).trim(),
        pub_year: String(r["출판년도"]).trim(), category: String(r["분야"]).trim(),
        level: lv[String(r["난이도"]).replace(/[^가-힣0-9]/g, "")] || 2,
        grade_from: String(r["대상 학년"]).trim(), note: String(r["추천 이유"]).trim(), source: String(r["출처"]).trim(),
      })).filter((b) => b.title && b.author && !b.source.startsWith("예시"));
      if (!books.length) return toast("제목·저자가 있는 줄이 없어요. 양식의 첫 줄(제목, 저자 …)을 지켜 주세요.", true);
      if (!(await ask({ title: "📚 추천도서 일괄 등록", okText: "등록",
        message: "‘" + file.name + "’에서 " + books.length + "권을 찾았어요. 등록할까요? (이미 있는 책은 건너뛰어요)" }))) return;
      const res = await rpc("admin_import_recommended", { p_pw: pw, p_books: books.slice(0, 500) });
      toast(res.added + "권을 넣었어요." + (res.skipped ? " (" + res.skipped + "권은 이미 있거나 빈칸이라 건너뜀)" : ""));
      loadRec();
    } catch (ex) { toast(ex.message, true); }
  });

  // ---------- 도배 정리 · 작업 기록 ----------
  const opsBox = $("#opsBox");
  async function loadLog() {
    try {
      const res = await rpc("admin_get_log", { p_pw: pw });
      $("#logRows").replaceChildren(...(res.log.length
        ? res.log.map((l) => h("tr", null,
            h("td", { "data-label": "시각" }, fmtDate(l.created_at, true)),
            h("td", { "data-label": "작업" }, h("b", null, l.action)),
            h("td", { "data-label": "내용" }, l.detail || "")))
        : [h("tr", null, h("td", { colspan: 3, class: "empty" }, "아직 기록이 없어요."))]));
    } catch (e) { toast(e.message, true); }
  }
  opsBox.addEventListener("toggle", () => { if (opsBox.open) loadLog(); });

  $("#hideRecentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const minutes = Number(e.target.minutes.value);
    if (!(minutes >= 1 && minutes <= 1440)) return toast("1분에서 1440분(하루) 사이로 정해 주세요.", true);
    const n = allPosts.filter((p) => !p.season && !p.hidden && !p.pinned && p.role !== "teacher"
      && Date.now() - new Date(p.created_at).getTime() < minutes * 60000).length;
    if (!(await ask({ title: "🧹 도배 정리", danger: true, okText: "숨기기",
      message: "최근 " + minutes + "분 동안 올라온 학생 게시물 약 " + n + "개를 숨길까요? 숨긴 글은 '검토 대기'에서 다시 보이게 할 수 있어요." }))) return;
    try {
      const res = await rpc("admin_hide_recent", { p_pw: pw, p_minutes: minutes });
      toast("게시물 " + res.count + "개를 숨겼어요.");
      await reload();
      loadLog();
    } catch (ex) { toast(ex.message, true); }
  });

  // ---------- 시작 ----------
  const saved = storage((s) => s.getItem(PW_KEY));
  if (saved && isConfigured()) login(saved, true);
})();
