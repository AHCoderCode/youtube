-- YouTube starter database schema for Supabase
-- Run this file once in the Supabase SQL Editor for a new, dedicated project.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  avatar_url text,
  subscribers_count bigint not null default 0 check (subscribers_count >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  description text not null default '',
  category text not null default 'Other',
  storage_path text not null unique,
  thumbnail_path text,
  visibility text not null default 'public' check (visibility in ('public', 'unlisted')),
  is_short boolean not null default false,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  views bigint not null default 0 check (views >= 0),
  likes_count bigint not null default 0 check (likes_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists videos_created_at_idx on public.videos (created_at desc);
create index if not exists videos_user_id_created_at_idx on public.videos (user_id, created_at desc);
create index if not exists videos_category_idx on public.videos (category);
create index if not exists videos_visibility_idx on public.videos (visibility);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists comments_video_created_idx on public.comments (video_id, created_at desc);

create table if not exists public.video_likes (
  video_id uuid not null references public.videos(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (video_id, user_id)
);

create table if not exists public.subscriptions (
  subscriber_id uuid not null references public.profiles(id) on delete cascade,
  channel_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (subscriber_id, channel_id),
  constraint subscriptions_no_self_follow check (subscriber_id <> channel_id)
);
create index if not exists subscriptions_channel_idx on public.subscriptions (channel_id);

create table if not exists public.video_views (
  id bigint generated always as identity primary key,
  video_id uuid not null references public.videos(id) on delete cascade,
  visitor_id text not null,
  view_date date not null default current_date,
  created_at timestamptz not null default now(),
  unique (video_id, visitor_id, view_date)
);
create index if not exists video_views_video_idx on public.video_views (video_id);

create table if not exists public.playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  description text not null default '',
  is_public boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.playlist_videos (
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  video_id uuid not null references public.videos(id) on delete cascade,
  position integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (playlist_id, video_id)
);

create table if not exists public.video_reports (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (reason in ('spam', 'misleading', 'harassment', 'unsafe', 'copyright', 'other')),
  details text not null default '',
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  unique (video_id, reporter_id)
);

-- Create a profile when someone signs up. The suffix keeps usernames unique.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_name text;
  safe_name text;
begin
  requested_name := coalesce(new.raw_user_meta_data ->> 'username', split_part(coalesce(new.email, 'creator'), '@', 1));
  safe_name := left(regexp_replace(requested_name, '[^a-zA-Z0-9_]', '', 'g'), 18);
  if char_length(safe_name) < 3 then safe_name := 'creator'; end if;
  insert into public.profiles (id, username)
  values (new.id, safe_name || '_' || substr(new.id::text, 1, 4))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- These trigger functions keep public counters accurate without giving browsers
-- permission to update counter columns directly.
create or replace function public.bump_video_views()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.videos set views = views + 1 where id = new.video_id;
  return new;
end;
$$;

create or replace function public.bump_video_likes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    update public.videos set likes_count = likes_count + 1 where id = new.video_id;
    return new;
  elsif (tg_op = 'DELETE') then
    update public.videos set likes_count = greatest(0, likes_count - 1) where id = old.video_id;
    return old;
  end if;
  return null;
end;
$$;

create or replace function public.bump_subscriber_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    update public.profiles set subscribers_count = subscribers_count + 1 where id = new.channel_id;
    return new;
  elsif (tg_op = 'DELETE') then
    update public.profiles set subscribers_count = greatest(0, subscribers_count - 1) where id = old.channel_id;
    return old;
  end if;
  return null;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.bump_video_views() from public, anon, authenticated;
revoke all on function public.bump_video_likes() from public, anon, authenticated;
revoke all on function public.bump_subscriber_count() from public, anon, authenticated;

drop trigger if exists video_views_counter_trigger on public.video_views;
create trigger video_views_counter_trigger after insert on public.video_views
  for each row execute procedure public.bump_video_views();

drop trigger if exists video_likes_counter_insert on public.video_likes;
create trigger video_likes_counter_insert after insert on public.video_likes
  for each row execute procedure public.bump_video_likes();
drop trigger if exists video_likes_counter_delete on public.video_likes;
create trigger video_likes_counter_delete after delete on public.video_likes
  for each row execute procedure public.bump_video_likes();

drop trigger if exists subscription_counter_insert on public.subscriptions;
create trigger subscription_counter_insert after insert on public.subscriptions
  for each row execute procedure public.bump_subscriber_count();
drop trigger if exists subscription_counter_delete on public.subscriptions;
create trigger subscription_counter_delete after delete on public.subscriptions
  for each row execute procedure public.bump_subscriber_count();

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.videos enable row level security;
alter table public.comments enable row level security;
alter table public.video_likes enable row level security;
alter table public.subscriptions enable row level security;
alter table public.video_views enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_videos enable row level security;
alter table public.video_reports enable row level security;

drop policy if exists "profiles are publicly readable" on public.profiles;
create policy "profiles are publicly readable" on public.profiles
  for select to anon, authenticated using (true);
drop policy if exists "users update their own profile" on public.profiles;
create policy "users update their own profile" on public.profiles
  for update to authenticated using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "public and unlisted videos are readable" on public.videos;
create policy "public and unlisted videos are readable" on public.videos
  for select to anon, authenticated using (
    visibility in ('public', 'unlisted') or (select auth.uid()) = user_id
  );
drop policy if exists "users publish their own videos" on public.videos;
create policy "users publish their own videos" on public.videos
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "users update their own videos" on public.videos;
create policy "users update their own videos" on public.videos
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "users delete their own videos" on public.videos;
create policy "users delete their own videos" on public.videos
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "comments are readable for visible videos" on public.comments;
create policy "comments are readable for visible videos" on public.comments
  for select to anon, authenticated using (
    exists (
      select 1 from public.videos v
      where v.id = comments.video_id
        and (v.visibility in ('public', 'unlisted') or v.user_id = (select auth.uid()))
    )
  );
drop policy if exists "signed-in users add their own comments" on public.comments;
create policy "signed-in users add their own comments" on public.comments
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.videos v where v.id = comments.video_id and v.visibility in ('public', 'unlisted'))
  );
drop policy if exists "users edit their own comments" on public.comments;
create policy "users edit their own comments" on public.comments
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "users delete their own comments" on public.comments;
create policy "users delete their own comments" on public.comments
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "users read their own likes" on public.video_likes;
create policy "users read their own likes" on public.video_likes
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "users like videos as themselves" on public.video_likes;
create policy "users like videos as themselves" on public.video_likes
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.videos v where v.id = video_id and v.visibility in ('public', 'unlisted'))
  );
drop policy if exists "users remove their own likes" on public.video_likes;
create policy "users remove their own likes" on public.video_likes
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "users read their own subscriptions" on public.subscriptions;
create policy "users read their own subscriptions" on public.subscriptions
  for select to authenticated using ((select auth.uid()) = subscriber_id or (select auth.uid()) = channel_id);
drop policy if exists "users subscribe as themselves" on public.subscriptions;
create policy "users subscribe as themselves" on public.subscriptions
  for insert to authenticated with check ((select auth.uid()) = subscriber_id and subscriber_id <> channel_id);
drop policy if exists "users remove their own subscriptions" on public.subscriptions;
create policy "users remove their own subscriptions" on public.subscriptions
  for delete to authenticated using ((select auth.uid()) = subscriber_id);

drop policy if exists "visitors can record a unique view" on public.video_views;
create policy "visitors can record a unique view" on public.video_views
  for insert to anon, authenticated with check (
    exists (select 1 from public.videos v where v.id = video_id and v.visibility in ('public', 'unlisted'))
  );

drop policy if exists "owners manage their playlists" on public.playlists;
create policy "owners manage their playlists" on public.playlists
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "owners manage their playlist videos" on public.playlist_videos;
create policy "owners manage their playlist videos" on public.playlist_videos
  for all to authenticated using (
    exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = (select auth.uid()))
  );

drop policy if exists "signed-in users can submit video reports" on public.video_reports;
create policy "signed-in users can submit video reports" on public.video_reports
  for insert to authenticated with check ((select auth.uid()) = reporter_id);
drop policy if exists "reporters can read their own reports" on public.video_reports;
create policy "reporters can read their own reports" on public.video_reports
  for select to authenticated using ((select auth.uid()) = reporter_id);

-- Explicit Data API privileges; RLS still applies to every exposed table.
grant select on public.profiles, public.videos, public.comments to anon, authenticated;
grant insert, delete on public.videos to authenticated;
grant insert, update, delete on public.comments to authenticated;
grant select, insert, delete on public.video_likes to authenticated;
grant select, insert, delete on public.subscriptions to authenticated;
grant insert on public.video_views to anon, authenticated;
grant select, insert, update, delete on public.playlists, public.playlist_videos to authenticated;
grant select, insert on public.video_reports to authenticated;

-- Public playback is enabled for the public video and thumbnail buckets.
-- Upload and delete operations remain restricted to the owner's folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('videos', 'videos', true, 524288000, array['video/mp4','video/webm','video/quicktime','video/x-matroska']),
  ('thumbnails', 'thumbnails', true, 10485760, array['image/jpeg','image/png','image/webp','image/gif']),
  ('avatars', 'avatars', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public video objects can be read" on storage.objects;
create policy "public video objects can be read" on storage.objects
  for select to anon, authenticated using (bucket_id in ('videos', 'thumbnails', 'avatars'));

drop policy if exists "users upload video objects to their own folder" on storage.objects;
create policy "users upload video objects to their own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id in ('videos', 'thumbnails', 'avatars')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "users update their own media objects" on storage.objects;
create policy "users update their own media objects" on storage.objects
  for update to authenticated using (
    bucket_id in ('videos', 'thumbnails', 'avatars')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id in ('videos', 'thumbnails', 'avatars')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "users delete their own media objects" on storage.objects;
create policy "users delete their own media objects" on storage.objects
  for delete to authenticated using (
    bucket_id in ('videos', 'thumbnails', 'avatars')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
