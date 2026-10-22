// 학생 화면과 관리자 화면이 함께 쓰는 도우미
(function () {
  const cfg = window.BOARD_CONFIG || {};

  const COLORS = [
    { key: "yellow", label: "노랑" },
    { key: "pink", label: "분홍" },
    { key: "sky", label: "하늘" },
    { key: "mint", label: "민트" },
    { key: "lavender", label: "보라" },
    { key: "peach", label: "살구" },
    { key: "lime", label: "연두" },
    { key: "gray", label: "회색" },
  ];

  // 책 계열 (schema.sql 의 _check_category 와 같아야 합니다)
  const CATEGORIES = ["소설", "시·에세이", "인문과학", "사회과학", "자연과학", "공학·기술", "예술·체육", "진로·자기계발", "기타"];

  // 화면 아래에 보이는 버전. 기능을 바꿀 때마다 올려 주세요.
  const VERSION = "v1.12 (2026.10.22)";

  const ERROR_TEXT = {
    PIN_FORMAT: "비밀번호는 숫자 4자리로 입력해 주세요.",
    MISSING_FIELD: "빠진 칸이 있어요. 필수 항목을 모두 채워 주세요.",
    NOT_FOUND: "게시물을 찾을 수 없어요. 새로고침해 주세요.",
    TOO_MANY_ENTRIES: "한 게시물에는 30번까지 이어 쓸 수 있어요.",
    BAD_PIN: "비밀번호가 맞지 않아요.",
    LOCKED: "비밀번호를 여러 번 틀려서 10분 동안 잠겼어요. 잠시 후 다시 시도해 주세요.",
    ADMIN_BAD_PASSWORD: "관리자 비밀번호가 맞지 않아요.",
    ADMIN_LOCKED: "비밀번호를 5번 틀려 10분 동안 잠겼어요.",
    ADMIN_NOT_SET: "관리자 비밀번호가 설정되지 않았어요. schema.sql 을 다시 실행해 주세요.",
    ADMIN_PW_TOO_SHORT: "새 비밀번호는 6자 이상이어야 해요.",
    TOO_FAST: "방금 글을 올렸어요. 1분 뒤에 다시 시도해 주세요.",
    BANNED_WORD: "바르지 않은 표현이 들어 있어요. 고운 말로 바꿔 주세요.",
    TEACHER_CODE: "교사 인증 코드가 맞지 않아요.",
    TEACHER_CODE_NOT_SET: "아직 교사 인증 코드가 설정되지 않았어요. 관리자에게 문의해 주세요.",
    TEACHER_LOCKED: "교사 인증 코드를 여러 번 틀려서 10분 동안 교사 글쓰기가 잠겼어요.",
    TEACHER_CODE_TOO_SHORT: "교사 인증 코드는 4자 이상이어야 해요.",
    TOO_FAST_COMMENT: "방금 댓글을 남겼어요. 잠시 뒤에 다시 시도해 주세요.",
    TOO_MANY_COMMENTS: "이 말풍선에는 댓글을 더 남길 수 없어요(최대 100개).",
    CATEGORY: "책 계열을 골라 주세요.",
    TOO_MANY_REPORTS: "신고는 한 시간에 20번까지 할 수 있어요.",
    SEASON_EXISTS: "이미 같은 이름으로 보관한 학기가 있어요. 다른 이름을 써 주세요.",
    LAST_ENTRY: "글이 하나뿐인 게시물이에요. 게시물 전체 삭제를 사용해 주세요.",
  };

  function isConfigured() {
    return (
      cfg.SUPABASE_URL &&
      cfg.SUPABASE_ANON_KEY &&
      !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
      !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON-KEY")
    );
  }

  class ApiError extends Error {
    constructor(code) {
      super(ERROR_TEXT[code] || code);
      this.code = code;
    }
  }

  function headers() {
    const hd = { "Content-Type": "application/json", apikey: cfg.SUPABASE_ANON_KEY };
    // 예전 방식의 anon 키(JWT)일 때만 Authorization 헤더를 함께 보냅니다.
    // 새 방식의 Publishable key(sb_publishable_…)는 apikey 헤더만으로 충분합니다.
    if (cfg.SUPABASE_ANON_KEY.startsWith("eyJ")) hd.Authorization = "Bearer " + cfg.SUPABASE_ANON_KEY;
    return hd;
  }

  // Supabase(PostgREST)의 RPC 함수를 호출합니다.
  async function rpc(fn, params) {
    let res;
    try {
      res = await fetch(cfg.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(params || {}),
      });
    } catch (e) {
      throw new ApiError("인터넷 연결을 확인해 주세요.");
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const code = body && body.message ? body.message : "서버 오류가 났어요 (" + res.status + ")";
      throw new ApiError(code);
    }
    if (body && typeof body === "object" && !Array.isArray(body) && body.error) {
      throw new ApiError(body.error);
    }
    if (typeof body === "string" && ERROR_TEXT[body]) throw new ApiError(body);
    return body;
  }

  function fmtDate(iso, withTime) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    const date = d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate());
    return withTime ? date + " " + p(d.getHours()) + ":" + p(d.getMinutes()) : date;
  }

  function timeAgo(iso) {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return "방금 전";
    if (sec < 3600) return Math.floor(sec / 60) + "분 전";
    if (sec < 86400) return Math.floor(sec / 3600) + "시간 전";
    if (sec < 86400 * 7) return Math.floor(sec / 86400) + "일 전";
    return fmtDate(iso);
  }

  // 간단한 요소 생성기: h("div", {class: "x"}, "text", child)
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  let toastTimer;
  function toast(msg, isError) {
    let el = document.getElementById("toast");
    if (!el) {
      el = h("div", { id: "toast", role: "status", "aria-live": "polite" });
      document.body.append(el);
    }
    el.textContent = msg;
    el.className = "show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ""), 2800);
  }

  // 확인·입력 창. 카카오톡 등 앱 안 브라우저에서는 prompt/confirm 이 막히는 일이 있어 직접 만든 창을 씁니다.
  // 입력칸이 있으면 입력한 글자를, 없으면 true 를, 취소하면 null 을 돌려줍니다.
  function ask(opts) {
    return new Promise((resolve) => {
      const input = opts.input
        ? h("input", Object.assign({ class: "ask-input", autocomplete: "off" }, opts.input))
        : null;
      const dlg = h("dialog", { class: "sheet ask" + (opts.danger ? " danger" : "") },
        h("form", { method: "dialog", novalidate: true },
          h("div", { class: "sheet-body" },
            h("h2", null, opts.title),
            opts.message ? h("p", { class: "ask-msg" }, opts.message) : null,
            input),
          h("div", { class: "sheet-foot" },
            h("button", { class: "btn", type: "button", value: "cancel", onclick: () => dlg.close("cancel") }, "취소"),
            h("button", { class: "btn " + (opts.danger ? "danger-fill" : "primary"), type: "submit", value: "ok" }, opts.okText || "확인"))));
      if (input && input.inputMode === "numeric") {
        input.addEventListener("input", () => (input.value = input.value.replace(/\D/g, "").slice(0, Number(input.maxLength) || 99)));
      }
      dlg.addEventListener("close", () => {
        const ok = dlg.returnValue === "ok";
        dlg.remove();
        resolve(ok ? (input ? input.value : true) : null);
      });
      dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close("cancel"); });
      document.body.append(dlg);
      dlg.showModal();
      (input || dlg.querySelector('button[type="submit"]')).focus();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-version]").forEach((el) => (el.textContent = VERSION));
  });

  window.Board = { cfg, VERSION, COLORS, CATEGORIES, ERROR_TEXT, isConfigured, rpc, fmtDate, timeAgo, h, toast, ask };
})();
