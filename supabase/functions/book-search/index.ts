// 책 검색 중계 함수 (Supabase Edge Function)
// 게시판에서 책 제목을 입력하면 카카오(다음) 책 검색 결과를 돌려줍니다.
// 카카오 REST API 키는 Supabase 의 비밀값(KAKAO_REST_KEY)에만 두고, 게시판에는 드러나지 않습니다.
// 설치 방법은 README 의 "책 제목 자동완성 켜기" 를 보세요.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

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
