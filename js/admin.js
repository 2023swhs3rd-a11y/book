// 관리자 화면: 조회 · 필터 · 숨김 · 삭제 · 비밀번호 초기화 · CSV/XLSX 내보내기
(function () {
  const { cfg, COLORS, CATEGORIES, isConfigured, rpc, fmtDate, h, toast } = window.Board;
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

  let pw = null;
  let posts = [];
  const expanded = new Set();

  function storage(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }

  // ---------- 로그인 ----------
  async function login(password, silent) {
    try {
      const res = await rpc("admin_list", { p_pw: password });
      pw = password;
      storage((s) => s.setItem(PW_KEY, password));
      posts = res.posts || [];
      loginForm.hidden = true;
      $("#adminMain").hidden = false;
      $("#adminTools").hidden = false;
      render();
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
    const next = prompt("새 관리자 비밀번호 (6자 이상)");
    if (next == null) return;
    if (next !== prompt("한 번 더 입력해 주세요")) return toast("두 번 입력한 비밀번호가 달라요.", true);
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
      posts = res.posts || [];
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

  function classStats() {
    const map = new Map();
    const get = (c) => {
      if (!map.has(c.label)) map.set(c.label, { ...c, students: new Map(), posts: 0, entries: 0, comments: 0, likes: 0 });
      return map.get(c.label);
    };
    for (const p of posts) {
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

  function classSheetRows() {
    return classStats().map((r) => ({
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
      h("td", { "data-label": "상태" }, p.hidden ? h("span", { class: "pill off" }, "숨김") : h("span", { class: "pill on" }, "게시 중"),
        reportCount(p) ? h("span", { class: "pill report" }, "🚩 " + reportCount(p)) : null),
      h("td", { class: "actions" },
        h("button", { class: "btn small", type: "button", onclick: () => { open ? expanded.delete(p.id) : expanded.add(p.id); render(); } }, open ? "접기" : "내용 보기"),
        h("button", { class: "btn small", type: "button",
          onclick: () => act("admin_set_hidden", { p_post_id: p.id, p_hidden: !p.hidden }, p.hidden ? "다시 보이게 했어요." : "숨겼어요.") },
          p.hidden ? "보이기" : "숨기기"),
        h("button", { class: "btn small", type: "button", onclick: () => {
          const pin = prompt(p.author_name + " 학생의 새 비밀번호 (숫자 4자리)");
          if (pin != null) act("admin_reset_pin", { p_post_id: p.id, p_new_pin: pin.trim() }, "비밀번호를 " + pin.trim() + " 로 바꿨어요.");
        } }, "비번 초기화"),
        h("button", { class: "btn small danger", type: "button", onclick: () => {
          if (confirm(p.student_no + " " + p.author_name + " 학생의 게시물(글 " + p.entries.length + "개)을 모두 삭제할까요?\n되돌릴 수 없어요."))
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
            i > 0 ? h("button", { class: "btn small danger", type: "button", onclick: () => {
              if (confirm("이 이어쓰기 글을 삭제할까요?")) act("admin_delete_entry", { p_entry_id: e.id }, "글을 삭제했어요.");
            } }, "이 글 삭제") : null),
          h("p", null, e.quote)))),
      (p.comments || []).length
        ? h("div", { class: "admin-comments" },
            h("h4", null, "💬 댓글 " + p.comments.length + "개"),
            h("ul", { class: "entry-list" }, p.comments.map((c) =>
              h("li", null,
                h("div", { class: "entry-meta" },
                  h("b", null, c.student_no + " " + c.author_name), " · " + fmtDate(c.created_at, true),
                  c.report_count ? h("span", { class: "pill report" }, "🚩 " + c.report_count) : null,
                  h("button", { class: "btn small danger", type: "button", onclick: () => {
                    if (confirm(c.author_name + " 님의 댓글을 삭제할까요?")) act("admin_delete_comment", { p_comment_id: c.id }, "댓글을 삭제했어요.");
                  } }, "댓글 삭제")),
                h("p", null, c.body)))))
        : null));
    return [tr, detail];
  }

  function render() {
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
  function exportRows() {
    const rows = [];
    for (const { post: p, entries } of filtered()) {
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
          "내용": e.quote,
          "작성일시": fmtDate(e.created_at, true),
          "말풍선 색": colorLabel[p.color] || p.color,
          "상태": p.hidden ? "숨김" : "게시 중",
        });
      }
    }
    return rows;
  }

  function commentRows() {
    const rows = [];
    for (const { post: p } of filtered()) {
      for (const c of p.comments || []) {
        rows.push({
          "게시물 번호": p.id,
          "게시물 작성자": p.student_no + " " + p.author_name,
          "게시물 책": "『" + p.entries[p.entries.length - 1].book_title + "』",
          "댓글 학번/부서": c.student_no,
          "댓글 이름": c.author_name,
          "댓글 내용": c.body,
          "작성일시": fmtDate(c.created_at, true),
        });
      }
    }
    return rows;
  }

  function summaryRows() {
    return filtered().map(({ post: p, entries }) => ({
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

  $("#xlsxBtn").addEventListener("click", async () => {
    const rows = exportRows();
    if (!rows.length) return toast("내보낼 글이 없어요.", true);
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.utils.book_new();
      const s1 = XLSX.utils.json_to_sheet(rows);
      s1["!cols"] = [8, 8, 10, 10, 12, 10, 24, 14, 10, 60, 17, 8, 8].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, s1, "전체 기록");
      const s2 = XLSX.utils.json_to_sheet(summaryRows());
      s2["!cols"] = [8, 10, 10, 12, 6, 8, 8, 50, 17, 17, 8].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, s2, "학생별 요약");
      const classes = classSheetRows();
      if (classes.length) {
        const s4 = XLSX.utils.json_to_sheet(classes);
        s4["!cols"] = [6, 6, 10, 8, 14, 8, 8, 80].map((w) => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, s4, "학급별 현황");
      }
      const comments = commentRows();
      if (comments.length) {
        const s3 = XLSX.utils.json_to_sheet(comments);
        s3["!cols"] = [8, 16, 20, 12, 10, 60, 17].map((w) => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, s3, "댓글");
      }
      XLSX.writeFile(wb, fileName("xlsx"));
    } catch (e) { toast(e.message, true); }
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

  // ---------- 시작 ----------
  const saved = storage((s) => s.getItem(PW_KEY));
  if (saved && isConfigured()) login(saved, true);
})();
