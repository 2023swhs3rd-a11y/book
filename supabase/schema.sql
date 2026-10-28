-- =====================================================================
-- 독서 현황판 · Supabase 데이터베이스 설정
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여 넣고 [Run] 하세요.
-- 맨 아래 "관리자 비밀번호" 부분은 꼭 원하는 값으로 바꾼 뒤 실행하세요.
-- 여러 번 실행해도 안전합니다(기존 게시물은 지워지지 않습니다).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 테이블
-- ---------------------------------------------------------------------
create table if not exists public.posts (
  id            bigint generated always as identity primary key,
  student_no    text not null check (char_length(student_no) between 1 and 20),
  author_name   text not null check (char_length(author_name) between 1 and 20),
  nickname      text check (nickname is null or char_length(nickname) between 1 and 20),
  pin_hash      text not null,
  color         text not null default 'yellow',
  hidden        boolean not null default false,
  fail_count    int not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.entries (
  id          bigint generated always as identity primary key,
  post_id     bigint not null references public.posts(id) on delete cascade,
  quote       text not null check (char_length(quote) between 1 and 500),
  book_title  text not null check (char_length(book_title) between 1 and 100),
  book_author text not null check (char_length(book_author) between 1 and 50),
  created_at  timestamptz not null default now()
);
create index if not exists entries_post_id_idx on public.entries(post_id);

-- [2차 업데이트] 학생/교사 구분. 교사는 student_no 칸에 학번 대신 '부서'를 저장합니다.
alter table public.posts add column if not exists role text not null default 'student'
  check (role in ('student', 'teacher'));

-- [4차 업데이트] 말풍선 댓글. 교사는 student_no 칸에 부서를 적습니다.
create table if not exists public.comments (
  id            bigint generated always as identity primary key,
  post_id       bigint not null references public.posts(id) on delete cascade,
  student_no    text not null check (char_length(student_no) between 1 and 20),
  author_name   text not null check (char_length(author_name) between 1 and 20),
  body          text not null check (char_length(body) between 1 and 200),
  pin_hash      text not null,
  fail_count    int not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists comments_post_id_idx on public.comments(post_id);
alter table public.comments enable row level security;
revoke all on public.comments from anon, authenticated;

-- [5차 업데이트] 책 계열, 공감, 신고
alter table public.entries add column if not exists category text;

create table if not exists public.post_likes (
  post_id     bigint not null references public.posts(id) on delete cascade,
  device      text not null,
  created_at  timestamptz not null default now(),
  primary key (post_id, device)
);
alter table public.post_likes enable row level security;
revoke all on public.post_likes from anon, authenticated;

-- 신고: comment_id 가 비어 있으면 말풍선(게시물) 신고, 있으면 댓글 신고
create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  post_id     bigint not null references public.posts(id) on delete cascade,
  comment_id  bigint references public.comments(id) on delete cascade,
  device      text not null,
  reason      text check (reason is null or char_length(reason) <= 100),
  created_at  timestamptz not null default now()
);
create unique index if not exists reports_once_idx
  on public.reports (post_id, coalesce(comment_id, 0), device);
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;

-- [6차 업데이트] 선생님 추천(맨 위 고정), 학기 보관
-- season 이 비어 있으면 이번 학기 글, 값이 있으면 그 이름으로 보관된 글(학생 화면에서 숨김)
alter table public.posts add column if not exists pinned boolean not null default false;
alter table public.posts add column if not exists season text;
create index if not exists posts_season_idx on public.posts(season);

create table if not exists public.admin_config (
  id            int primary key default 1 check (id = 1),
  pw_hash       text not null,
  fail_count    int not null default 0,
  locked_until  timestamptz
);
-- [7차 업데이트] 마지막 엑셀 백업 시각 (관리자 화면의 백업 알림용)
alter table public.admin_config add column if not exists last_backup_at timestamptz;
-- [8차 업데이트] 공지 띠, 이달의 주제, 선생님 댓글 표시
alter table public.admin_config add column if not exists notice text;
alter table public.admin_config add column if not exists topic text;
alter table public.entries add column if not exists topic text;
alter table public.comments add column if not exists is_teacher boolean not null default false;
-- [9차 업데이트] 700명 운영 대비: 바뀐 글만 받기, 단계적 잠금, 신고 자동 숨김, 관리자 작업 기록
alter table public.posts add column if not exists changed_at timestamptz not null default now();
alter table public.posts add column if not exists lock_level int not null default 0;
alter table public.posts add column if not exists auto_hidden boolean not null default false;
alter table public.comments add column if not exists lock_level int not null default 0;
alter table public.comments add column if not exists hidden boolean not null default false;
create index if not exists posts_changed_at_idx on public.posts(changed_at);
create index if not exists posts_created_at_idx on public.posts(created_at);
create index if not exists entries_created_at_idx on public.entries(created_at);
create index if not exists comments_created_at_idx on public.comments(created_at);

create table if not exists public.admin_log (
  id          bigint generated always as identity primary key,
  action      text not null,
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists admin_log_created_at_idx on public.admin_log(created_at);

-- [10차 업데이트] 추천도서 목록 (관리자가 등록, 학생 화면 '추천도서' 탭에서 봄)
-- level: 난이도 1 입문 · 2 보통 · 3 도전 / grade_from: 대상 학년(예: '고1부터')
create table if not exists public.recommended_books (
  id          bigint generated always as identity primary key,
  title       text not null check (char_length(title) between 1 and 100),
  author      text not null check (char_length(author) between 1 and 100),
  publisher   text check (publisher is null or char_length(publisher) <= 50),
  pub_year    int check (pub_year is null or pub_year between 1000 and 2100),
  isbn        text check (isbn is null or isbn ~ '^[0-9X]{10,13}$'),
  thumbnail   text check (thumbnail is null or (thumbnail ~ '^https://' and char_length(thumbnail) <= 500)),
  category    text,
  level       smallint not null default 2 check (level between 1 and 3),
  grade_from  text check (grade_from is null or char_length(grade_from) <= 20),
  note        text check (note is null or char_length(note) <= 200),
  source      text check (source is null or char_length(source) <= 50),
  created_at  timestamptz not null default now()
);

-- 모든 테이블은 직접 접근을 막고, 아래 함수(RPC)를 통해서만 읽고 씁니다.
alter table public.posts        enable row level security;
alter table public.entries      enable row level security;
alter table public.admin_config enable row level security;
alter table public.admin_log    enable row level security;
alter table public.recommended_books enable row level security;
revoke all on public.posts, public.entries, public.admin_config, public.admin_log, public.recommended_books from anon, authenticated;

-- ---------------------------------------------------------------------
-- 내부 도우미
-- ---------------------------------------------------------------------
create or replace function public._clean(p text, max_len int)
returns text language sql immutable as $$
  select nullif(left(btrim(coalesce(p, '')), max_len), '')
$$;

create or replace function public._check_color(p text)
returns text language sql immutable as $$
  select case when p in ('yellow','pink','sky','mint','lavender','peach','lime','gray')
              then p else 'yellow' end
$$;

-- 책 계열: 목록에 없는 값이면 null
create or replace function public._check_category(p text)
returns text language sql immutable as $$
  select case when p in ('소설','시·에세이','인문과학','사회과학','자연과학','공학·기술','예술·체육','진로·자기계발','기타')
              then p end
$$;

-- 기기 표시(브라우저마다 만든 임의의 값)가 올바른지
create or replace function public._check_device(p text)
returns boolean language sql immutable as $$
  select coalesce(p, '') ~ '^[A-Za-z0-9-]{16,64}$'
$$;

-- 너무 쉬운 비밀번호(0000, 1234, 9876 처럼 같은 숫자나 연속 숫자)인지
create or replace function public._weak_pin(p text)
returns boolean language sql immutable as $$
  select coalesce(p, '') ~ '^([0-9])\1{3}$'
      or position(coalesce(p, '') in '0123456789') > 0
      or position(coalesce(p, '') in '9876543210') > 0
$$;

-- 비밀번호를 5번 틀릴 때마다 잠그는 시간: 처음 10분, 다음 1시간, 그다음부터 하루
create or replace function public._lock_span(p_level int)
returns interval language sql immutable as $$
  select case when p_level <= 0 then interval '10 minutes'
              when p_level = 1 then interval '1 hour'
              else interval '1 day' end
$$;

-- 관리자 작업 기록 (관리자 화면의 '작업 기록'에서 봅니다. 1년이 지난 기록은 지웁니다)
create or replace function public._log(p_action text, p_detail text)
returns void language sql security definer
set search_path = public as $$
  delete from public.admin_log where created_at < now() - interval '1 year';
  insert into public.admin_log (action, detail) values (p_action, left(p_detail, 300));
$$;

-- 학생 화면이 바뀐 글만 다시 받을 수 있도록, 글이 바뀌면 changed_at 을 새로 적습니다.
-- (비밀번호 실패 횟수처럼 화면에 보이지 않는 값만 바뀌면 그대로 둡니다)
create or replace function public._post_changed()
returns trigger language plpgsql as $$
begin
  if row(new.hidden, new.pinned, new.season, new.nickname, new.color, new.updated_at, new.student_no, new.author_name)
     is distinct from row(old.hidden, old.pinned, old.season, old.nickname, old.color, old.updated_at, old.student_no, old.author_name) then
    new.changed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists posts_changed on public.posts;
create trigger posts_changed before update on public.posts
  for each row execute function public._post_changed();

create or replace function public._entry_changed()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  update public.posts set changed_at = now() where id = coalesce(new.post_id, old.post_id);
  return null;
end $$;
drop trigger if exists entries_changed on public.entries;
create trigger entries_changed after insert or update or delete on public.entries
  for each row execute function public._entry_changed();

-- 관리자 비밀번호 확인 (5회 틀리면 1분 잠금)
-- 맞으면 null, 아니면 오류 코드를 돌려줍니다. 실패 횟수가 롤백되지 않도록
-- 예외를 던지지 않고, 각 관리자 함수가 {"error": 코드} 를 반환합니다.
create or replace function public._admin_check(p_pw text)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare cfg public.admin_config;
begin
  select * into cfg from public.admin_config where id = 1 for update;
  if not found then return 'ADMIN_NOT_SET'; end if;
  if cfg.locked_until is not null and cfg.locked_until > now() then
    return 'ADMIN_LOCKED';
  end if;
  if cfg.pw_hash = crypt(coalesce(p_pw, ''), cfg.pw_hash) then
    update public.admin_config set fail_count = 0, locked_until = null where id = 1;
    return null;
  end if;
  -- 잠금은 1분만: 비밀번호가 길면 1분에 5번으로는 맞힐 수 없고, 누가 일부러 틀려도 선생님이 오래 막히지 않습니다.
  update public.admin_config
     set fail_count = case when cfg.fail_count + 1 >= 5 then 0 else cfg.fail_count + 1 end,
         locked_until = case when cfg.fail_count + 1 >= 5 then now() + interval '1 minute' end
   where id = 1;
  if cfg.fail_count + 1 >= 5 then perform _log('관리자 로그인 잠금', '비밀번호 5번 틀림 (1분 잠금)'); end if;
  return 'ADMIN_BAD_PASSWORD';
end $$;

-- ---------------------------------------------------------------------
-- 학생용 함수
-- ---------------------------------------------------------------------

-- 게시판 조회: 말풍선에 학번(교사는 부서)·이름·닉네임을 표시합니다. 비밀번호는 내보내지 않습니다.
-- p_since 가 있으면 그 뒤에 바뀐 말풍선만 돌려줍니다.
create or replace function public._board_posts(p_since timestamptz)
returns json language sql stable security definer
set search_path = public as $$
  select coalesce(json_agg(b order by b.updated_at desc), '[]'::json)
  from (
    select p.id, p.role, p.student_no, p.author_name, p.nickname,
           coalesce(p.nickname, p.author_name) as display_name,
           p.color, p.pinned, p.created_at, p.updated_at,
           (select count(*) from public.comments c where c.post_id = p.id and not c.hidden) as comment_count,
           (select count(*) from public.post_likes l where l.post_id = p.id) as like_count,
           (select json_agg(json_build_object(
                     'id', e.id, 'quote', e.quote, 'book_title', e.book_title,
                     'book_author', e.book_author, 'category', e.category, 'topic', e.topic, 'created_at', e.created_at)
                   order by e.created_at, e.id)
              from public.entries e where e.post_id = p.id) as entries
      from public.posts p
     where not p.hidden and p.season is null and (p_since is null or p.changed_at > p_since)
  ) b
$$;

create or replace function public.get_board()
returns json language sql stable security definer
set search_path = public as $$ select public._board_posts(null) $$;

-- 자동 새로고침용: 바뀐 말풍선 전체 + 모든 말풍선의 [번호, 댓글 수, 공감 수] + 공지·주제.
-- 화면은 counts 에 없는 말풍선을 지우고(삭제·숨김), posts 로 받은 말풍선만 새로 바꿉니다.
-- p_since 는 지난번 응답의 now 를 그대로 보내면 됩니다. 늦게 끝난 저장을 놓치지 않도록 30초 겹쳐 봅니다.
create or replace function public.get_board_changes(p_since timestamptz)
returns json language sql stable security definer
set search_path = public as $$
  select json_build_object(
    'now', now(),
    'settings', (select json_build_object('notice', nullif(btrim(notice), ''), 'topic', nullif(btrim(topic), ''))
                   from public.admin_config where id = 1),
    'posts', public._board_posts(p_since - interval '30 seconds'),
    'counts', (select coalesce(json_agg(json_build_array(p.id,
                 (select count(*) from public.comments c where c.post_id = p.id and not c.hidden),
                 (select count(*) from public.post_likes l where l.post_id = p.id))), '[]'::json)
                 from public.posts p where not p.hidden and p.season is null))
$$;

-- [3차 업데이트] 금지어, 교사 인증 코드
create table if not exists public.banned_words (
  word text primary key check (char_length(word) between 1 and 30)
);
alter table public.banned_words enable row level security;
revoke all on public.banned_words from anon, authenticated;
-- 기본 금지어 (관리자 화면에서 추가·삭제할 수 있습니다)
insert into public.banned_words (word)
select unnest(array['시발','씨발','씨빨','씨바','ㅅㅂ','ㅆㅂ','병신','븅신','ㅂㅅ','좆','존나','ㅈㄴ',
  '개새끼','개색','미친놈','미친년','지랄','ㅈㄹ','엠창','느금','니애미','섹스','fuck','shit'])
where not exists (select 1 from public.banned_words)
on conflict do nothing;

alter table public.admin_config add column if not exists teacher_code_hash text;
alter table public.admin_config add column if not exists teacher_fail_count int not null default 0;
alter table public.admin_config add column if not exists teacher_locked_until timestamptz;

-- 기호·숫자를 끼워 넣어도 걸러지도록 정리한 뒤 금지어를 찾습니다.
-- (띄어쓰기는 지우지 않습니다. 지우면 '질병 신호' 같은 정상 문장이 걸립니다.)
create or replace function public._has_banned(variadic texts text[])
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from public.banned_words w
     where position(lower(regexp_replace(w.word, '[[:punct:]0-9]', '', 'g'))
                    in lower(regexp_replace(array_to_string(texts, ' '), '[[:punct:]0-9]', '', 'g'))) > 0
  )
$$;

-- 게시물 비밀번호 확인. 5회 틀릴 때마다 잠그고, 잠길수록 길게(10분 → 1시간 → 하루) 잠급니다.
-- 맞으면 null, 아니면 'LOCKED' | 'BAD_PIN'
create or replace function public._pin_check(p public.posts, p_pin text)
returns text language plpgsql security definer
set search_path = public, extensions as $$
begin
  if p.locked_until is not null and p.locked_until > now() then return 'LOCKED'; end if;
  if p.pin_hash <> crypt(coalesce(p_pin, ''), p.pin_hash) then
    update public.posts
       set fail_count = case when p.fail_count + 1 >= 5 then 0 else p.fail_count + 1 end,
           locked_until = case when p.fail_count + 1 >= 5 then now() + _lock_span(p.lock_level) end,
           lock_level = case when p.fail_count + 1 >= 5 then p.lock_level + 1 else p.lock_level end
     where id = p.id;
    return 'BAD_PIN';
  end if;
  if p.fail_count <> 0 or p.lock_level <> 0 or p.locked_until is not null then
    update public.posts set fail_count = 0, lock_level = 0, locked_until = null where id = p.id;
  end if;
  return null;
end $$;

-- 교사 인증 코드 확인 (10회 틀리면 1분 동안 교사 글쓰기 잠금)
create or replace function public._teacher_check(p_code text)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare cfg public.admin_config;
begin
  select * into cfg from public.admin_config where id = 1 for update;
  if not found or cfg.teacher_code_hash is null then return 'TEACHER_CODE_NOT_SET'; end if;
  if cfg.teacher_locked_until is not null and cfg.teacher_locked_until > now() then
    return 'TEACHER_LOCKED';
  end if;
  if cfg.teacher_code_hash = crypt(coalesce(p_code, ''), cfg.teacher_code_hash) then
    update public.admin_config set teacher_fail_count = 0, teacher_locked_until = null where id = 1;
    return null;
  end if;
  update public.admin_config
     set teacher_fail_count = case when cfg.teacher_fail_count + 1 >= 10 then 0 else cfg.teacher_fail_count + 1 end,
         teacher_locked_until = case when cfg.teacher_fail_count + 1 >= 10 then now() + interval '1 minute' end
   where id = 1;
  if cfg.teacher_fail_count + 1 >= 10 then perform _log('교사 코드 잠금', '교사 인증 코드 10번 틀림 (1분 잠금)'); end if;
  return 'TEACHER_CODE';
end $$;

-- 이달의 주제에 참여했으면 지금 정해진 주제 이름, 아니면 null
create or replace function public._current_topic(p_join boolean)
returns text language sql stable security definer
set search_path = public as $$
  select case when coalesce(p_join, false) then (select nullif(btrim(topic), '') from public.admin_config where id = 1) end
$$;

-- 새 글: 성공하면 {"ok": true, "id": 번호}, 실패하면 {"error": 코드}
drop function if exists public.create_post(text, text, text, text, text, text, text, text);
drop function if exists public.create_post(text, text, text, text, text, text, text, text, text);
drop function if exists public.create_post(text, text, text, text, text, text, text, text, text, text);
drop function if exists public.create_post(text, text, text, text, text, text, text, text, text, text, text);
-- p_topic: 이달의 주제에 참여하면 true (주제 이름은 서버에 저장된 값을 씁니다)
create or replace function public.create_post(
  p_role text, p_student_no text, p_name text, p_nickname text, p_pin text, p_color text,
  p_quote text, p_book_title text, p_book_author text, p_teacher_code text default null,
  p_category text default null, p_topic boolean default false)
returns json language plpgsql security definer
set search_path = public, extensions as $$
declare
  new_id bigint;
  is_teacher boolean := (p_role = 'teacher');
  err text;
begin
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return json_build_object('error', 'PIN_FORMAT'); end if;
  if _weak_pin(p_pin) then return json_build_object('error', 'PIN_WEAK'); end if;
  if _clean(p_student_no, 20) is null or _clean(p_name, 20) is null
     or _clean(p_quote, 500) is null or _clean(p_book_title, 100) is null
     or _clean(p_book_author, 50) is null then
    return json_build_object('error', 'MISSING_FIELD');
  end if;
  if _check_category(p_category) is null then return json_build_object('error', 'CATEGORY'); end if;
  if is_teacher then
    err := _teacher_check(p_teacher_code);
    if err is not null then return json_build_object('error', err); end if;
  end if;
  -- 도배 방지: 같은 학번(부서)·이름으로는 1분에 한 번만 새 글
  if exists (select 1 from public.posts
              where lower(student_no) = lower(_clean(p_student_no, 20))
                and author_name = _clean(p_name, 20)
                and created_at > now() - interval '1 minute') then
    return json_build_object('error', 'TOO_FAST');
  end if;
  -- 도배 방지: 게시판 전체로 1분에 새 글 60개까지 (가짜 학번을 바꿔 가며 올려도 여기서 멈춥니다)
  if (select count(*) from public.posts where created_at > now() - interval '1 minute') >= 60 then
    return json_build_object('error', 'BUSY');
  end if;
  if _has_banned(p_name, p_nickname, p_quote, p_book_title, p_book_author) then
    return json_build_object('error', 'BANNED_WORD');
  end if;

  insert into public.posts (role, student_no, author_name, nickname, pin_hash, color)
  values (case when is_teacher then 'teacher' else 'student' end, _clean(p_student_no, 20),
          _clean(p_name, 20), _clean(p_nickname, 20), crypt(p_pin, gen_salt('bf')), _check_color(p_color))
  returning id into new_id;

  insert into public.entries (post_id, quote, book_title, book_author, category, topic)
  values (new_id, _clean(p_quote, 500), _clean(p_book_title, 100), _clean(p_book_author, 50),
          _check_category(p_category), _current_topic(p_topic));
  return json_build_object('ok', true, 'id', new_id);
end $$;

-- 내용 이어쓰기. 반환값: 'OK' | 'BAD_PIN' | 'LOCKED' | 'TOO_FAST' | 'BANNED_WORD'
-- 계열을 비워 보내면 바로 앞 글의 계열을 이어받습니다.
drop function if exists public.add_entry(bigint, text, text, text, text);
drop function if exists public.add_entry(bigint, text, text, text, text, text);
create or replace function public.add_entry(
  p_post_id bigint, p_pin text, p_quote text, p_book_title text, p_book_author text,
  p_category text default null, p_topic boolean default false)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare
  p public.posts;
  err text;
begin
  select * into p from public.posts where id = p_post_id and not hidden and season is null for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  err := _pin_check(p, p_pin);
  if err is not null then return err; end if;

  if _clean(p_quote, 500) is null or _clean(p_book_title, 100) is null
     or _clean(p_book_author, 50) is null then
    raise exception 'MISSING_FIELD';
  end if;
  if (select count(*) from public.entries where post_id = p.id) >= 30 then
    raise exception 'TOO_MANY_ENTRIES';
  end if;
  if exists (select 1 from public.entries where post_id = p.id and created_at > now() - interval '1 minute') then
    return 'TOO_FAST';
  end if;
  if (select count(*) from public.entries where created_at > now() - interval '1 minute') >= 120 then
    return 'BUSY';
  end if;
  if _has_banned(p_quote, p_book_title, p_book_author) then return 'BANNED_WORD'; end if;

  insert into public.entries (post_id, quote, book_title, book_author, category, topic)
  values (p.id, _clean(p_quote, 500), _clean(p_book_title, 100), _clean(p_book_author, 50),
          coalesce(_check_category(p_category),
                   (select category from public.entries where post_id = p.id
                     order by created_at desc, id desc limit 1)),
          _current_topic(p_topic));
  update public.posts set updated_at = now() where id = p.id;
  return 'OK';
end $$;

-- 본인 글 고치기 (비밀번호 필요). 반환값은 add_entry 와 같습니다. 계열을 비워 보내면 그대로 둡니다.
drop function if exists public.edit_entry(bigint, bigint, text, text, text, text);
create or replace function public.edit_entry(
  p_post_id bigint, p_entry_id bigint, p_pin text, p_quote text, p_book_title text, p_book_author text,
  p_category text default null)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare
  p public.posts;
  err text;
begin
  select * into p from public.posts where id = p_post_id and not hidden and season is null for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not exists (select 1 from public.entries where id = p_entry_id and post_id = p.id) then
    raise exception 'NOT_FOUND';
  end if;
  err := _pin_check(p, p_pin);
  if err is not null then return err; end if;
  if _clean(p_quote, 500) is null or _clean(p_book_title, 100) is null
     or _clean(p_book_author, 50) is null then
    raise exception 'MISSING_FIELD';
  end if;
  if _has_banned(p_quote, p_book_title, p_book_author) then return 'BANNED_WORD'; end if;

  update public.entries
     set quote = _clean(p_quote, 500), book_title = _clean(p_book_title, 100),
         book_author = _clean(p_book_author, 50),
         category = coalesce(_check_category(p_category), category)
   where id = p_entry_id;
  return 'OK';
end $$;

-- 본인 글 지우기 (비밀번호 필요). p_entry_id 가 null 이면 게시물 전체를 지웁니다.
-- 첫 글만 지우면 이어 쓴 글이 남지 않도록, 첫 글을 고르면 게시물 전체를 지웁니다.
create or replace function public.delete_own(p_post_id bigint, p_entry_id bigint, p_pin text)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare
  p public.posts;
  err text;
  first_id bigint;
begin
  select * into p from public.posts where id = p_post_id and not hidden and season is null for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  err := _pin_check(p, p_pin);
  if err is not null then return err; end if;

  select id into first_id from public.entries where post_id = p.id order by created_at, id limit 1;
  if p_entry_id is null or p_entry_id = first_id then
    delete from public.posts where id = p.id;
  else
    delete from public.entries where id = p_entry_id and post_id = p.id;
  end if;
  return 'OK';
end $$;

-- 댓글 목록 (비밀번호는 내보내지 않습니다)
create or replace function public.get_comments(p_post_id bigint)
returns json language sql stable security definer
set search_path = public as $$
  select coalesce(json_agg(json_build_object(
           'id', c.id, 'student_no', c.student_no, 'author_name', c.author_name,
           'body', c.body, 'is_teacher', c.is_teacher, 'created_at', c.created_at) order by c.created_at, c.id), '[]'::json)
    from public.comments c
    join public.posts p on p.id = c.post_id and not p.hidden and p.season is null
   where c.post_id = p_post_id and not c.hidden
$$;

-- 댓글 쓰기: {"ok": true} 또는 {"error": 코드}
-- p_teacher_code 가 있으면 교사 인증 후 '선생님' 댓글로 표시합니다.
drop function if exists public.add_comment(bigint, text, text, text, text);
create or replace function public.add_comment(
  p_post_id bigint, p_student_no text, p_name text, p_pin text, p_body text,
  p_teacher_code text default null)
returns json language plpgsql security definer
set search_path = public, extensions as $$
declare err text;
begin
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return json_build_object('error', 'PIN_FORMAT'); end if;
  if _weak_pin(p_pin) then return json_build_object('error', 'PIN_WEAK'); end if;
  if _clean(p_student_no, 20) is null or _clean(p_name, 20) is null or _clean(p_body, 200) is null then
    return json_build_object('error', 'MISSING_FIELD');
  end if;
  if not exists (select 1 from public.posts where id = p_post_id and not hidden and season is null) then
    return json_build_object('error', 'NOT_FOUND');
  end if;
  if (select count(*) from public.comments where post_id = p_post_id) >= 100 then
    return json_build_object('error', 'TOO_MANY_COMMENTS');
  end if;
  -- 도배 방지: 같은 학번·이름으로는 20초에 댓글 하나
  if exists (select 1 from public.comments
              where lower(student_no) = lower(_clean(p_student_no, 20))
                and author_name = _clean(p_name, 20)
                and created_at > now() - interval '20 seconds') then
    return json_build_object('error', 'TOO_FAST_COMMENT');
  end if;
  if (select count(*) from public.comments where created_at > now() - interval '1 minute') >= 120 then
    return json_build_object('error', 'BUSY');
  end if;
  if _has_banned(p_name, p_body) then return json_build_object('error', 'BANNED_WORD'); end if;
  if nullif(btrim(coalesce(p_teacher_code, '')), '') is not null then
    err := _teacher_check(p_teacher_code);
    if err is not null then return json_build_object('error', err); end if;
  end if;

  insert into public.comments (post_id, student_no, author_name, body, pin_hash, is_teacher)
  values (p_post_id, _clean(p_student_no, 20), _clean(p_name, 20), _clean(p_body, 200),
          crypt(p_pin, gen_salt('bf')), nullif(btrim(coalesce(p_teacher_code, '')), '') is not null);
  return json_build_object('ok', true);
end $$;

-- 내 댓글 지우기 (게시물 비밀번호와 같이 단계적으로 잠금). 반환값: 'OK' | 'BAD_PIN' | 'LOCKED'
create or replace function public.delete_comment(p_comment_id bigint, p_pin text)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare c public.comments;
begin
  select * into c from public.comments where id = p_comment_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if c.locked_until is not null and c.locked_until > now() then return 'LOCKED'; end if;
  if c.pin_hash <> crypt(coalesce(p_pin, ''), c.pin_hash) then
    update public.comments
       set fail_count = case when c.fail_count + 1 >= 5 then 0 else c.fail_count + 1 end,
           locked_until = case when c.fail_count + 1 >= 5 then now() + _lock_span(c.lock_level) end,
           lock_level = case when c.fail_count + 1 >= 5 then c.lock_level + 1 else c.lock_level end
     where id = c.id;
    return 'BAD_PIN';
  end if;
  delete from public.comments where id = c.id;
  return 'OK';
end $$;

-- 공감 누르기/취소 (기기마다 한 번). {"ok": true, "liked": 참/거짓, "count": 공감 수}
create or replace function public.toggle_like(p_post_id bigint, p_device text)
returns json language plpgsql security definer
set search_path = public as $$
declare liked boolean;
begin
  if not _check_device(p_device) then return json_build_object('error', 'MISSING_FIELD'); end if;
  if not exists (select 1 from public.posts where id = p_post_id and not hidden and season is null) then
    return json_build_object('error', 'NOT_FOUND');
  end if;
  delete from public.post_likes where post_id = p_post_id and device = p_device;
  liked := not found;
  if liked then
    insert into public.post_likes (post_id, device) values (p_post_id, p_device);
  end if;
  return json_build_object('ok', true, 'liked', liked,
    'count', (select count(*) from public.post_likes where post_id = p_post_id));
end $$;

-- 신고 (기기마다 대상 하나에 한 번, 한 시간에 20번까지). {"ok": true} 또는 {"error": 코드}
-- 서로 다른 기기에서 신고가 3건 모이면 바로 숨기고 관리자 화면의 '검토 대기'에 올립니다(교사 글·댓글은 제외).
create or replace function public.report(p_post_id bigint, p_comment_id bigint, p_reason text, p_device text)
returns json language plpgsql security definer
set search_path = public as $$
declare
  auto_hide constant int := 3;
begin
  if not _check_device(p_device) then return json_build_object('error', 'MISSING_FIELD'); end if;
  if not exists (select 1 from public.posts where id = p_post_id and not hidden and season is null)
     or (p_comment_id is not null and not exists
          (select 1 from public.comments where id = p_comment_id and post_id = p_post_id)) then
    return json_build_object('error', 'NOT_FOUND');
  end if;
  if (select count(*) from public.reports
       where device = p_device and created_at > now() - interval '1 hour') >= 20 then
    return json_build_object('error', 'TOO_MANY_REPORTS');
  end if;
  insert into public.reports (post_id, comment_id, device, reason)
  values (p_post_id, p_comment_id, p_device, _clean(p_reason, 100))
  on conflict do nothing;
  if p_comment_id is null then
    if (select count(*) from public.reports where post_id = p_post_id and comment_id is null) >= auto_hide then
      update public.posts set hidden = true, auto_hidden = true
       where id = p_post_id and not hidden and role <> 'teacher';
      if found then perform _log('자동 숨김', '게시물 #' || p_post_id || ' (신고 ' || auto_hide || '건)'); end if;
    end if;
  elsif (select count(*) from public.reports where comment_id = p_comment_id) >= auto_hide then
    update public.comments set hidden = true where id = p_comment_id and not hidden and not is_teacher;
    if found then perform _log('자동 숨김', '댓글 #' || p_comment_id || ' (게시물 #' || p_post_id || ', 신고 ' || auto_hide || '건)'); end if;
  end if;
  return json_build_object('ok', true);
end $$;

-- 관리자: 게시물(과 그 댓글)의 신고를 확인 완료로 지우기
create or replace function public.admin_clear_reports(p_pw text, p_post_id bigint)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  delete from public.reports where post_id = p_post_id;
  perform _log('신고 확인', '게시물 #' || p_post_id);
  return json_build_object('ok', true);
end $$;

-- 관리자: 댓글 삭제
create or replace function public.admin_delete_comment(p_pw text, p_comment_id bigint)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  perform _log('댓글 삭제', (select '댓글 #' || id || ' ' || student_no || ' ' || author_name || ': ' || left(body, 40)
                              from public.comments where id = p_comment_id));
  delete from public.comments where id = p_comment_id;
  return json_build_object('ok', true);
end $$;

-- 관리자: 댓글 숨기기/보이기. 다시 보이게 하면 그 댓글의 신고도 정리합니다(바로 다시 자동 숨김되지 않도록).
create or replace function public.admin_set_comment_hidden(p_pw text, p_comment_id bigint, p_hidden boolean)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  update public.comments set hidden = p_hidden where id = p_comment_id;
  if not p_hidden then delete from public.reports where comment_id = p_comment_id; end if;
  perform _log(case when p_hidden then '댓글 숨김' else '댓글 숨김 해제' end, '댓글 #' || p_comment_id);
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 관리자용 함수: 모두 관리자 비밀번호를 확인하고
-- 성공하면 {"ok": true, ...}, 실패하면 {"error": "코드"} 를 돌려줍니다.
-- ---------------------------------------------------------------------
create or replace function public.admin_list(p_pw text)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  return json_build_object('ok', true,
    'last_backup_at', (select last_backup_at from public.admin_config where id = 1),
    'posts', (
    select coalesce(json_agg(b order by b.updated_at desc), '[]'::json)
    from (
      select p.id, p.role, p.student_no, p.author_name, p.nickname, p.color, p.hidden,
             p.pinned, p.season, p.auto_hidden, p.created_at, p.updated_at,
             (select count(*) from public.post_likes l where l.post_id = p.id) as like_count,
             (select json_agg(json_build_object(
                       'id', e.id, 'quote', e.quote, 'book_title', e.book_title,
                       'book_author', e.book_author, 'category', e.category, 'topic', e.topic, 'created_at', e.created_at)
                     order by e.created_at, e.id)
                from public.entries e where e.post_id = p.id) as entries,
             (select json_agg(json_build_object(
                       'id', c.id, 'student_no', c.student_no, 'author_name', c.author_name,
                       'body', c.body, 'is_teacher', c.is_teacher, 'hidden', c.hidden, 'created_at', c.created_at,
                       'report_count', (select count(*) from public.reports r where r.comment_id = c.id))
                     order by c.created_at, c.id)
                from public.comments c where c.post_id = p.id) as comments,
             (select json_agg(json_build_object(
                       'comment_id', r.comment_id, 'reason', r.reason, 'created_at', r.created_at)
                     order by r.created_at)
                from public.reports r where r.post_id = p.id) as reports
        from public.posts p
    ) b));
end $$;

create or replace function public.admin_delete_post(p_pw text, p_post_id bigint)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  perform _log('게시물 삭제', (select '게시물 #' || id || ' ' || student_no || ' ' || author_name
                               from public.posts where id = p_post_id));
  delete from public.posts where id = p_post_id;
  return json_build_object('ok', true);
end $$;

-- 이어쓴 내용 하나만 삭제 (글이 하나만 남은 게시물은 게시물 삭제를 사용)
create or replace function public.admin_delete_entry(p_pw text, p_entry_id bigint)
returns json language plpgsql security definer
set search_path = public as $$
declare
  err text := public._admin_check(p_pw);
  pid bigint;
begin
  if err is not null then return json_build_object('error', err); end if;
  select post_id into pid from public.entries where id = p_entry_id;
  if pid is null then return json_build_object('ok', true); end if;
  if (select count(*) from public.entries where post_id = pid) <= 1 then
    return json_build_object('error', 'LAST_ENTRY');
  end if;
  delete from public.entries where id = p_entry_id;
  perform _log('이어쓰기 삭제', '게시물 #' || pid || '의 글 #' || p_entry_id);
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_set_hidden(p_pw text, p_post_id bigint, p_hidden boolean)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  update public.posts set hidden = p_hidden, auto_hidden = false where id = p_post_id;
  -- 다시 보이게 하면 말풍선 신고를 정리합니다(바로 다시 자동 숨김되지 않도록).
  if not p_hidden then delete from public.reports where post_id = p_post_id and comment_id is null; end if;
  perform _log(case when p_hidden then '숨김' else '숨김 해제' end, '게시물 #' || p_post_id);
  return json_build_object('ok', true);
end $$;

-- 엑셀 전체 백업을 내려받은 시각을 기록합니다.
create or replace function public.admin_mark_backup(p_pw text)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  update public.admin_config set last_backup_at = now() where id = 1;
  perform _log('엑셀 백업', null);
  return json_build_object('ok', true);
end $$;

-- DB 구조의 버전. schema.sql 을 바꿀 때마다 1씩 올리고 js/common.js 의 SCHEMA_VERSION 도 같이 올립니다.
-- 화면은 이 값이 더 작으면 "schema.sql 을 다시 실행해 주세요" 라고 알려 줍니다.
create or replace function public.schema_version()
returns int language sql immutable as $$ select 10 $$;

-- 게시판 맨 위 공지와 이달의 주제 (학생 화면에서 읽음)
create or replace function public.get_settings()
returns json language sql stable security definer
set search_path = public as $$
  select json_build_object('notice', nullif(btrim(notice), ''), 'topic', nullif(btrim(topic), ''))
    from public.admin_config where id = 1
$$;

create or replace function public.admin_set_board(p_pw text, p_notice text, p_topic text)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  update public.admin_config set notice = _clean(p_notice, 200), topic = _clean(p_topic, 30) where id = 1;
  perform _log('공지·주제 저장', concat_ws(' / ', _clean(p_notice, 200), _clean(p_topic, 30)));
  return json_build_object('ok', true);
end $$;

-- 선생님 추천: 말풍선을 맨 위에 고정하고 '선생님 추천' 표시를 답니다.
create or replace function public.admin_set_pinned(p_pw text, p_post_id bigint, p_pinned boolean)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  update public.posts set pinned = p_pinned where id = p_post_id;
  perform _log(case when p_pinned then '추천 고정' else '추천 해제' end, '게시물 #' || p_post_id);
  return json_build_object('ok', true);
end $$;

-- 학기 보관: 이번 학기 글 전체에 이름을 붙여 보관합니다(학생 화면에서는 사라지고 관리자 화면에 남음).
create or replace function public.admin_archive_season(p_pw text, p_name text)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
        n int;
begin
  if err is not null then return json_build_object('error', err); end if;
  if _clean(p_name, 30) is null then return json_build_object('error', 'MISSING_FIELD'); end if;
  if exists (select 1 from public.posts where season = _clean(p_name, 30)) then
    return json_build_object('error', 'SEASON_EXISTS');
  end if;
  update public.posts set season = _clean(p_name, 30), pinned = false where season is null;
  get diagnostics n = row_count;
  perform _log('학기 보관', _clean(p_name, 30) || ' (게시물 ' || n || '개)');
  return json_build_object('ok', true, 'count', n);
end $$;

-- 보관 취소: 보관한 학기의 글을 다시 이번 학기 게시판으로 돌려놓습니다.
create or replace function public.admin_unarchive_season(p_pw text, p_name text)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
        n int;
begin
  if err is not null then return json_build_object('error', err); end if;
  update public.posts set season = null where season = p_name;
  get diagnostics n = row_count;
  perform _log('보관 되돌리기', p_name || ' (게시물 ' || n || '개)');
  return json_build_object('ok', true, 'count', n);
end $$;

-- 학생이 비밀번호를 잊었을 때 새 4자리 비밀번호로 바꿔 줍니다.
create or replace function public.admin_reset_pin(p_pw text, p_post_id bigint, p_new_pin text)
returns json language plpgsql security definer
set search_path = public, extensions as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  if coalesce(p_new_pin, '') !~ '^[0-9]{4}$' then
    return json_build_object('error', 'PIN_FORMAT');
  end if;
  if _weak_pin(p_new_pin) then return json_build_object('error', 'PIN_WEAK'); end if;
  update public.posts
     set pin_hash = crypt(p_new_pin, gen_salt('bf')), fail_count = 0, lock_level = 0, locked_until = null
   where id = p_post_id;
  perform _log('비밀번호 초기화', '게시물 #' || p_post_id);
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_change_password(p_pw text, p_new_pw text)
returns json language plpgsql security definer
set search_path = public, extensions as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  if char_length(coalesce(p_new_pw, '')) < 10 then
    return json_build_object('error', 'ADMIN_PW_TOO_SHORT');
  end if;
  update public.admin_config set pw_hash = crypt(p_new_pw, gen_salt('bf')) where id = 1;
  perform _log('관리자 비밀번호 변경', null);
  return json_build_object('ok', true);
end $$;

-- 교사 인증 코드 설정 (관리자 화면에서 사용)
create or replace function public.admin_set_teacher_code(p_pw text, p_code text)
returns json language plpgsql security definer
set search_path = public, extensions as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  if char_length(coalesce(p_code, '')) < 8 then
    return json_build_object('error', 'TEACHER_CODE_TOO_SHORT');
  end if;
  update public.admin_config
     set teacher_code_hash = crypt(p_code, gen_salt('bf')), teacher_fail_count = 0, teacher_locked_until = null
   where id = 1;
  perform _log('교사 인증 코드 변경', null);
  return json_build_object('ok', true);
end $$;

-- 금지어 목록 보기 / 통째로 바꾸기
create or replace function public.admin_get_words(p_pw text)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  return json_build_object('ok', true,
    'words', (select coalesce(json_agg(word order by word), '[]'::json) from public.banned_words),
    'teacher_code_set', (select teacher_code_hash is not null from public.admin_config where id = 1));
end $$;

create or replace function public.admin_set_words(p_pw text, p_words text[])
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  delete from public.banned_words;
  insert into public.banned_words (word)
  select distinct left(btrim(w), 30) from unnest(coalesce(p_words, '{}')) w where btrim(w) <> ''
  on conflict do nothing;
  perform _log('금지어 저장', (select count(*) || '개' from public.banned_words));
  return json_build_object('ok', true);
end $$;

-- 도배 정리: 최근 몇 분 동안 올라온 학생 게시물을 한꺼번에 숨깁니다(교사 글·추천 글 제외).
-- 숨긴 글은 '검토 대기'에 올라가므로 하나씩 다시 보이게 할 수 있습니다.
create or replace function public.admin_hide_recent(p_pw text, p_minutes int)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
        n int;
begin
  if err is not null then return json_build_object('error', err); end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 1440 then return json_build_object('error', 'MISSING_FIELD'); end if;
  update public.posts set hidden = true, auto_hidden = true
   where season is null and not hidden and not pinned and role <> 'teacher'
     and created_at > now() - make_interval(mins => p_minutes);
  get diagnostics n = row_count;
  perform _log('도배 정리', '최근 ' || p_minutes || '분 게시물 ' || n || '개 숨김');
  return json_build_object('ok', true, 'count', n);
end $$;

-- ---------------------------------------------------------------------
-- 추천도서
-- ---------------------------------------------------------------------
create or replace function public.get_recommended()
returns json language sql stable security definer
set search_path = public as $$
  select coalesce(json_agg(json_build_object(
           'id', id, 'title', title, 'author', author, 'publisher', publisher, 'pub_year', pub_year,
           'isbn', isbn, 'thumbnail', thumbnail, 'category', category, 'level', level,
           'grade_from', grade_from, 'note', note, 'source', source, 'created_at', created_at)
         order by created_at desc, id desc), '[]'::json)
    from public.recommended_books
$$;

-- 한 권 저장: p_book 에 id 가 있으면 고치고, 없으면 새로 넣습니다. {"ok": true, "id": 번호}
create or replace function public._rec_row(b jsonb)
returns public.recommended_books language plpgsql immutable as $$
declare r public.recommended_books;
begin
  r.title := _clean(b->>'title', 100);
  r.author := _clean(b->>'author', 100);
  r.publisher := _clean(b->>'publisher', 50);
  r.pub_year := case when coalesce(b->>'pub_year', '') ~ '^[0-9]{4}$' then (b->>'pub_year')::int end;
  r.isbn := case when coalesce(b->>'isbn', '') ~ '^[0-9X]{10,13}$' then b->>'isbn' end;
  r.thumbnail := case when coalesce(b->>'thumbnail', '') ~ '^https://' and char_length(b->>'thumbnail') <= 500 then b->>'thumbnail' end;
  r.category := _check_category(b->>'category');
  r.level := case when b->>'level' in ('1', '2', '3') then (b->>'level')::smallint else 2 end;
  r.grade_from := _clean(b->>'grade_from', 20);
  r.note := _clean(b->>'note', 200);
  r.source := _clean(b->>'source', 50);
  return r;
end $$;

create or replace function public.admin_save_recommended(p_pw text, p_book jsonb)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
        r public.recommended_books;
        rid bigint := nullif(p_book->>'id', '')::bigint;
begin
  if err is not null then return json_build_object('error', err); end if;
  r := _rec_row(p_book);
  if r.title is null or r.author is null then return json_build_object('error', 'MISSING_FIELD'); end if;
  if rid is null then
    insert into public.recommended_books (title, author, publisher, pub_year, isbn, thumbnail, category, level, grade_from, note, source)
    values (r.title, r.author, r.publisher, r.pub_year, r.isbn, r.thumbnail, r.category, r.level, r.grade_from, r.note, r.source)
    returning id into rid;
    perform _log('추천도서 추가', r.title || ' / ' || r.author);
  else
    update public.recommended_books
       set title = r.title, author = r.author, publisher = r.publisher, pub_year = r.pub_year, isbn = r.isbn,
           thumbnail = r.thumbnail, category = r.category, level = r.level, grade_from = r.grade_from,
           note = r.note, source = r.source
     where id = rid;
    perform _log('추천도서 수정', r.title || ' / ' || r.author);
  end if;
  return json_build_object('ok', true, 'id', rid);
end $$;

-- 엑셀 일괄 등록: 제목+저자가 이미 있는 책은 건너뜁니다. {"ok": true, "added": n, "skipped": n}
create or replace function public.admin_import_recommended(p_pw text, p_books jsonb)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
        b jsonb;
        r public.recommended_books;
        added int := 0;
        skipped int := 0;
begin
  if err is not null then return json_build_object('error', err); end if;
  if jsonb_typeof(p_books) <> 'array' or jsonb_array_length(p_books) > 500 then
    return json_build_object('error', 'MISSING_FIELD');
  end if;
  for b in select * from jsonb_array_elements(p_books) loop
    r := _rec_row(b);
    if r.title is null or r.author is null
       or exists (select 1 from public.recommended_books x
                   where regexp_replace(lower(x.title), '\s', '', 'g') = regexp_replace(lower(r.title), '\s', '', 'g')
                     and regexp_replace(lower(x.author), '\s', '', 'g') = regexp_replace(lower(r.author), '\s', '', 'g')) then
      skipped := skipped + 1;
      continue;
    end if;
    insert into public.recommended_books (title, author, publisher, pub_year, isbn, thumbnail, category, level, grade_from, note, source)
    values (r.title, r.author, r.publisher, r.pub_year, r.isbn, r.thumbnail, r.category, r.level, r.grade_from, r.note, r.source);
    added := added + 1;
  end loop;
  perform _log('추천도서 일괄 등록', added || '권 추가, ' || skipped || '권 건너뜀');
  return json_build_object('ok', true, 'added', added, 'skipped', skipped);
end $$;

create or replace function public.admin_delete_recommended(p_pw text, p_id bigint)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  perform _log('추천도서 삭제', (select title || ' / ' || author from public.recommended_books where id = p_id));
  delete from public.recommended_books where id = p_id;
  return json_build_object('ok', true);
end $$;

-- 관리자 작업 기록 (최근 300개)
create or replace function public.admin_get_log(p_pw text)
returns json language plpgsql security definer
set search_path = public as $$
declare err text := public._admin_check(p_pw);
begin
  if err is not null then return json_build_object('error', err); end if;
  return json_build_object('ok', true, 'log', (
    select coalesce(json_agg(json_build_object('action', action, 'detail', detail, 'created_at', created_at)
                             order by created_at desc, id desc), '[]'::json)
      from (select * from public.admin_log order by created_at desc, id desc limit 300) l));
end $$;

-- ---------------------------------------------------------------------
-- 권한: 학생(anon)은 아래 공개 함수만 호출할 수 있습니다.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.schema_version(),
  public.get_settings(),
  public.get_board(),
  public.get_board_changes(timestamptz),
  public.get_recommended(),
  public.create_post(text, text, text, text, text, text, text, text, text, text, text, boolean),
  public.add_entry(bigint, text, text, text, text, text, boolean),
  public.edit_entry(bigint, bigint, text, text, text, text, text),
  public.delete_own(bigint, bigint, text),
  public.get_comments(bigint),
  public.add_comment(bigint, text, text, text, text, text),
  public.delete_comment(bigint, text),
  public.admin_delete_comment(text, bigint),
  public.toggle_like(bigint, text),
  public.report(bigint, bigint, text, text),
  public.admin_clear_reports(text, bigint),
  public.admin_set_teacher_code(text, text),
  public.admin_get_words(text),
  public.admin_set_words(text, text[]),
  public.admin_list(text),
  public.admin_delete_post(text, bigint),
  public.admin_delete_entry(text, bigint),
  public.admin_set_hidden(text, bigint, boolean),
  public.admin_set_pinned(text, bigint, boolean),
  public.admin_archive_season(text, text),
  public.admin_unarchive_season(text, text),
  public.admin_reset_pin(text, bigint, text),
  public.admin_change_password(text, text),
  public.admin_mark_backup(text),
  public.admin_set_board(text, text, text),
  public.admin_set_comment_hidden(text, bigint, boolean),
  public.admin_hide_recent(text, int),
  public.admin_get_log(text),
  public.admin_save_recommended(text, jsonb),
  public.admin_import_recommended(text, jsonb),
  public.admin_delete_recommended(text, bigint)
to anon, authenticated;

-- ---------------------------------------------------------------------
-- 관리자 비밀번호 (처음 한 번만 설정됩니다)
-- ↓ '여기에-관리자-비밀번호' 를 원하는 비밀번호(10자 이상)로 바꾼 뒤 실행하세요.
--   이후 변경은 관리자 화면의 [비밀번호 변경] 에서 할 수 있습니다.
-- ---------------------------------------------------------------------
insert into public.admin_config (id, pw_hash)
values (1, extensions.crypt('여기에-관리자-비밀번호', extensions.gen_salt('bf')))
on conflict (id) do nothing;

-- 새로 만든 함수를 API 가 바로 알아보도록 목록을 새로 고칩니다.
notify pgrst, 'reload schema';
