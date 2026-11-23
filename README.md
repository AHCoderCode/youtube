# YouTube

A responsive video-sharing web app built for desktop, tablet and mobile screens.

## What is included

- Responsive video home feed with category filters and search
- Video watch page with player, description, likes, comments and related videos
- Upload dialog with title, description, category, thumbnail and visibility options
- Channel page, subscriptions, Shorts-style vertical feed, history and Watch later
- Light/dark theme, collapsible desktop sidebar and mobile bottom navigation
- PWA manifest and service-worker app shell
- Local demo mode with IndexedDB: uploaded video files remain in the current browser
- Optional Supabase integration for shared accounts, public video storage and database-backed interactions

## Run it

This is a static site. Open the project through a local web server or deploy the repository to Vercel. No build command is required.

## Local demo mode

The site starts in demo mode. Uploads and interactions are saved in the current browser only. They are not shared with other people or devices until Supabase is connected.

## Enable shared accounts and uploads

1. Create a separate Supabase project for this app.
2. In Supabase SQL Editor, run the SQL file at supabase/schema.sql.
3. In Storage, confirm the videos, thumbnails and avatars buckets were created by the SQL.
4. Open config.js and paste the Project URL and the publishable key (or legacy anon key) from the Supabase project API settings.
5. Deploy again. Users can then create accounts and share public uploads.

Only use the publishable/anon browser key in config.js. Never use a service-role key in frontend code.

The SQL sets Row Level Security policies for user-owned data and storage uploads. Public videos are readable by everyone; uploading and managing a user's own videos requires authentication.

## Deployment

Import this repository into Vercel. The framework preset can be Other; leave the build command empty and set the output directory to the repository root. The app uses hash navigation and needs no server rewrite.

## Important scope

This is a starter video platform, not a production-scale YouTube replacement. It does not include YouTube's proprietary recommendation systems, livestream/CDN infrastructure, copyright enforcement, monetization, ads, advanced creator analytics, or moderation operations. For a public service, add content reporting, moderation, abuse prevention, upload quotas, backups, and a video transcoding/streaming pipeline before inviting a large audience.
