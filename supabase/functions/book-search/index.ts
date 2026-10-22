// 책 검색 중계 함수 (Supabase Edge Function)
// 게시판에서 책 제목을 입력하면 카카오(다음) 책 검색 결과를 돌려줍니다.
// 카카오 REST API 키는 Supabase 의 비밀값(KAKAO_REST_KEY)에만 두고, 게시판에는 드러나지 않습니다.
// 설치 방법은 README 의 "책 제목 자동완성 켜기" 를 보세요.

// 우리 게시판 주소에서 온 요청만 받습니다. 주소가 바뀌면 Supabase 비밀값 ALLOWED_ORIGINS 에
// 쉼표로 적어 주세요. (예: https://2023swhs3rd-a11y.github.io,http://localhost:8080)
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") || "https://2023swhs3rd-a11y.github.io")
  .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

function originOf(req: Request) {
  const o = req.headers.get("origin");
  if (o) return o;
  try { return new URL(req.headers.get("referer") || "").origin; } catch { return ""; }
}

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = originOf(req);
  const allowed = ALLOWED.includes(origin);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...(allowed ? cors(origin) : {}), "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, max-age=3600" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { status: allowed ? 200 : 403, headers: allowed ? cors(origin) : {} });
  // 다른 사이트나 주소창에서 직접 부르면 막습니다.
  if (!allowed) return json({ error: "FORBIDDEN" }, 403);

  const q = (new URL(req.url).searchParams.get("q") || "").trim().slice(0, 50);
  if (q.length < 2) return json({ books: [] });

  const key = Deno.env.get("KAKAO_REST_KEY");
  if (!key) return json({ error: "NO_KEY" }, 500);

  const url = "https://dapi.kakao.com/v3/search/book?size=8&target=title&query=" + encodeURIComponent(q);
  const res = await fetch(url, { headers: { Authorization: "KakaoAK " + key } });
  if (!res.ok) return json({ error: "SEARCH_FAILED", status: res.status }, 502);

  const data = await res.json();
  const books = (data.documents || []).map((d: Record<string, unknown>) => ({
    title: d.title,
    authors: d.authors,
    publisher: d.publisher,
    isbn: String(d.isbn || "").split(" ").pop(),
    year: String(d.datetime || "").slice(0, 4),
    thumbnail: d.thumbnail,
  }));
  return json({ books });
});
