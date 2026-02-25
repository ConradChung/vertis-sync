# Database Schema

## Tables

### profiles
Stores user profile information and roles.

```sql
create table profiles (
  id uuid references auth.users on delete cascade primary key,
  email text unique not null,
  role text not null check (role in ('admin', 'client')),
  company_name text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security
alter table profiles enable row level security;

-- Admin can see all profiles
create policy "Admin can view all profiles"
  on profiles for select
  using (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );

-- Clients can only see their own profile
create policy "Clients can view own profile"
  on profiles for select
  using (auth.uid() = id);

-- Admin can insert profiles
create policy "Admin can insert profiles"
  on profiles for insert
  with check (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );

-- Admin can update profiles
create policy "Admin can update profiles"
  on profiles for update
  using (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );
```

### campaigns
Stores campaign information for each client.

```sql
create table campaigns (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references profiles(id) on delete cascade not null,
  instantly_campaign_id text not null,
  campaign_name text not null,
  status text default 'active' check (status in ('active', 'paused', 'completed')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security
alter table campaigns enable row level security;

-- Admin can see all campaigns
create policy "Admin can view all campaigns"
  on campaigns for select
  using (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );

-- Clients can only see their own campaigns
create policy "Clients can view own campaigns"
  on campaigns for select
  using (auth.uid() = client_id);

-- Admin can manage campaigns
create policy "Admin can insert campaigns"
  on campaigns for insert
  with check (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );

create policy "Admin can update campaigns"
  on campaigns for update
  using (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );

create policy "Admin can delete campaigns"
  on campaigns for delete
  using (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );
```

### onboarding_steps
Stores onboarding checklist items for each client.

```sql
create table onboarding_steps (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references profiles(id) on delete cascade not null,
  step_title text not null,
  step_description text,
  completed boolean default false,
  "order" integer not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security
alter table onboarding_steps enable row level security;

-- Admin can see all onboarding steps
create policy "Admin can view all onboarding steps"
  on onboarding_steps for select
  using (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );

-- Clients can only see their own onboarding steps
create policy "Clients can view own onboarding steps"
  on onboarding_steps for select
  using (auth.uid() = client_id);

-- Admin can manage onboarding steps
create policy "Admin can insert onboarding steps"
  on onboarding_steps for insert
  with check (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );

create policy "Admin can update onboarding steps"
  on onboarding_steps for update
  using (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );

create policy "Admin can delete onboarding steps"
  on onboarding_steps for delete
  using (
    auth.uid() in (
      select id from profiles where role = 'admin'
    )
  );
```

## Setup Instructions

1. Go to your Supabase project's SQL Editor
2. Run each table creation SQL in order: profiles → campaigns → onboarding_steps
3. The Row Level Security (RLS) policies ensure that:
   - Admins can see and manage everything
   - Clients can only see their own data
   - All data is properly protected

## Function to Create Client Accounts

```sql
-- Function to create a new client with profile
create or replace function create_client(
  client_email text,
  client_password text,
  client_company_name text
)
returns json
language plpgsql
security definer
as $$
declare
  new_user_id uuid;
  result json;
begin
  -- Create auth user
  insert into auth.users (email, encrypted_password, email_confirmed_at)
  values (
    client_email,
    crypt(client_password, gen_salt('bf')),
    now()
  )
  returning id into new_user_id;

  -- Create profile
  insert into profiles (id, email, role, company_name)
  values (new_user_id, client_email, 'client', client_company_name);

  result := json_build_object(
    'user_id', new_user_id,
    'email', client_email,
    'company_name', client_company_name
  );

  return result;
end;
$$;
```
