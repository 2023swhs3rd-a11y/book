// 학생 화면의 '추천도서' 탭: 관리자가 등록한 추천도서를 분야·난이도별로 보여 줍니다.
(function () {
  const { isConfigured, rpc, h } = window.Board;
  const LEVELS = { 1: "🌱 입문", 2: "🌿 보통", 3: "🌳 도전" };

  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#recList");
  const statusEl = $("#recStatus");
  const searchEl = $("#recSearch");
  const catSel = $("#recCat");
  const sortSel = $("#recSort");
  const tabs = document.querySelectorAll(".main-tabs [data-tab]");

  let books = null;      // null = 아직 안 불러옴
  let level = "all";
  const PAGE = 60;       // 한 번에 그리는 책 수 (목록이 수백 권이어도 휴대폰에서 가볍게)
  let limit = PAGE;

  // ---------- 탭 ----------
  function setTab(tab, save) {
    const rec = tab === "rec";
    tabs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $("#recView").hidden = !rec;
    $("#relayView").hidden = rec;
    document.body.classList.toggle("tab-rec", rec);
    if (save) history.replaceState(null, "", rec ? "#추천도서" : location.pathname + location.search);
    if (rec && books == null) load();
  }
  tabs.forEach((b) => b.addEventListener("click", () => {
    setTab(b.dataset.tab, true);
    window.scrollTo({ top: 0 });
  }));

  // ---------- 불러오기 ----------
  async function load() {
    if (!isConfigured()) return;
    statusEl.textContent = "추천도서를 불러오는 중…";
    statusEl.hidden = false;
    try {
      books = await rpc("get_recommended");
      render();
    } catch (e) {
      books = null;
      statusEl.textContent = "추천도서를 불러오지 못했어요: " + e.message;
    }
  }

  // 이번 학기 릴레이에서 이 책을 소개한 사람 수 (제목이 같으면 같은 책으로 봅니다)
  function introCounts() {
    const app = window.BoardApp;
    const map = new Map();
    if (!app) return map;
    for (const p of app.posts()) {
      for (const e of p.entries || []) {
        const key = app.norm(e.book_title);
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(p.role + "|" + p.student_no + "|" + p.author_name);
      }
    }
    return map;
  }

  // ---------- 그리기 ----------
  function cover(b) {
    const box = h("div", { class: "rec-cover" + (b.thumbnail ? "" : " empty") });
    if (b.thumbnail) {
      const img = h("img", { src: b.thumbnail, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
      img.addEventListener("error", () => { img.remove(); box.classList.add("empty"); box.append(h("span", null, "📖")); });
      box.append(img);
    } else box.append(h("span", null, "📖"));
    return box;
  }

  function card(b, count) {
    return h("article", { class: "rec-card" },
      cover(b),
      h("div", { class: "rec-body" },
        h("h3", null, b.title),
        h("p", { class: "rec-meta" }, [b.author, b.publisher, b.pub_year ? b.pub_year + "년" : null].filter(Boolean).join(" · ")),
        h("div", { class: "rec-tags" },
          h("span", { class: "rec-level l" + b.level }, LEVELS[b.level] || LEVELS[2]),
          b.category ? h("span", { class: "rec-tag" }, b.category) : null,
          b.grade_from ? h("span", { class: "rec-tag grade" }, b.grade_from) : null),
        b.note ? h("p", { class: "rec-note" }, b.note) : null,
        h("footer", { class: "rec-foot" },
          h("span", { class: "rec-count" }, count ? "✏️ 이번 학기 " + count + "명이 소개했어요" : "아직 소개한 사람이 없어요"),
          h("button", { class: "btn small primary", type: "button", onclick: () => write(b) }, "✏️ 이 책 소개하기")),
        b.source ? h("small", { class: "rec-source" }, "출처: " + b.source) : null));
  }

  function write(b) {
    setTab("relay", true);
    if (window.BoardApp) window.BoardApp.write({ title: b.title, author: b.author, category: b.category });
  }

  function render() {
    if (books == null) return;
    const app = window.BoardApp;
    const norm = app ? app.norm : (s) => String(s || "").toLowerCase();
    const q = norm(searchEl.value);
    const cat = catSel.value;
    const counts = introCounts();
    const countOf = (b) => (counts.get(norm(b.title)) || new Set()).size;
    const shown = books.filter((b) => (level === "all" || String(b.level) === level)
      && (!cat || b.category === cat)
      && (!q || norm(b.title + b.author).includes(q)));
    const sort = sortSel.value;
    if (sort === "easy") shown.sort((a, b) => a.level - b.level);
    else if (sort === "hard") shown.sort((a, b) => b.level - a.level);
    else if (sort === "popular") shown.sort((a, b) => countOf(b) - countOf(a));
    listEl.replaceChildren(...shown.slice(0, limit).map((b) => card(b, countOf(b))));
    const rest = shown.length - limit;
    moreBtn.hidden = rest <= 0;
    if (rest > 0) moreBtn.textContent = "추천도서 더 보기 (" + rest + "권 남음)";
    statusEl.textContent = !books.length ? "아직 등록된 추천도서가 없어요. 곧 선생님들이 채워 줄 거예요!"
      : !shown.length ? "조건에 맞는 추천도서가 없어요."
      : (level !== "all" || cat || q) ? shown.length + "권을 찾았어요." : "";
    statusEl.hidden = !statusEl.textContent;
  }

  const moreBtn = h("button", { class: "btn more-btn", type: "button", hidden: true, onclick: () => {
    limit += PAGE;
    render();
  } });
  listEl.after(moreBtn);
  // 조건을 바꾸면 다시 처음 60권부터 보여 줍니다.
  const refilter = () => { limit = PAGE; render(); };

  document.querySelectorAll("[data-level]").forEach((b) => b.addEventListener("click", () => {
    level = b.dataset.level;
    document.querySelectorAll("[data-level]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    refilter();
  }));
  let timer;
  searchEl.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(refilter, 150); });
  catSel.addEventListener("change", refilter);
  sortSel.addEventListener("change", refilter);
  // 릴레이 글이 새로 들어오면 '소개한 사람 수'를 고칩니다.
  document.addEventListener("board:loaded", () => { if (!$("#recView").hidden) render(); });

  // 주소 끝에 #추천도서 를 붙여 나눠 주면 바로 추천도서 탭이 열립니다.
  if (decodeURIComponent(location.hash) === "#추천도서") setTab("rec", false);
})();
