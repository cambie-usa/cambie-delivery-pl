-- =================================================================
-- Cambie Local Delivery P&L — Supabase Schema
-- Run this entire file once in the Supabase SQL Editor.
-- Project Settings → SQL Editor → New Query → paste → Run
-- =================================================================

-- Invoices table
create table if not exists invoices (
  id           bigserial primary key,
  inv_no       text not null unique,
  customer     text not null,
  inv_date     text not null,
  invoice_total numeric(10,2) not null default 0,
  gross_profit  numeric(10,2) not null default 0,
  delivery      numeric(10,2) not null default 0,
  net_profit    numeric(10,2) not null default 0,
  items        jsonb not null default '[]',   -- full line items with margins
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- Auto-update updated_at on row change
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger invoices_updated_at
  before update on invoices
  for each row execute procedure set_updated_at();

-- =================================================================
-- ROW LEVEL SECURITY
-- All team members with the anon key can read and write.
-- To restrict to authenticated users only, swap the policies below.
-- =================================================================
alter table invoices enable row level security;

-- Allow anyone with the anon key to read
create policy "public read"
  on invoices for select
  using (true);

-- Allow anyone with the anon key to insert/update/delete
-- Tighten this to `auth.role() = 'authenticated'` if you add Netlify Identity later
create policy "public write"
  on invoices for all
  using (true)
  with check (true);

-- =================================================================
-- DONE — note your Supabase URL and anon key from
-- Project Settings → API, then add them to public/config.js
-- =================================================================
