# NorthStar CRM

A modern Next.js + Supabase client dashboard for lead generation agencies. Features role-based access, campaign analytics from Instantly.ai, and client onboarding management.

## Features

- 🔐 **Authentication** - Supabase Auth with role-based access (admin & client)
- 👥 **Admin Panel** - Manage clients, assign campaigns, and track onboarding
- 📊 **Analytics Dashboard** - Live campaign metrics from Instantly API
- 📧 **Reply Tracking** - View recent campaign replies
- ✅ **Onboarding Checklist** - Track client setup progress
- 🎨 **Dark Mode** - Linear.app-inspired minimal design
- 🔒 **Secure** - Row-level security with Supabase RLS policies

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Database & Auth:** Supabase
- **Styling:** Tailwind CSS
- **API Integration:** Instantly.ai
- **Language:** TypeScript

## Project Structure

```
northstarcrm/
├── app/
│   ├── admin/              # Admin panel
│   ├── dashboard/          # Client dashboard
│   ├── login/              # Authentication
│   ├── api/                # API routes
│   │   ├── analytics/      # Instantly analytics endpoint
│   │   └── replies/        # Instantly replies endpoint
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── AdminDashboard.tsx  # Admin UI component
│   └── ClientDashboard.tsx # Client UI component
├── lib/
│   ├── supabase/
│   │   ├── client.ts       # Browser client
│   │   ├── server.ts       # Server client
│   │   └── middleware.ts   # Auth middleware
│   └── instantly.ts        # Instantly API wrapper
├── middleware.ts           # Route protection
└── DATABASE_SCHEMA.md      # Database setup guide
```

## Getting Started

### Prerequisites

- Node.js 18+ installed
- A Supabase account and project
- An Instantly.ai account with API key

### 1. Clone and Install

```bash
git clone https://github.com/ConradChung/northstarcrm.git
cd northstarcrm
npm install
```

### 2. Environment Setup

Copy the example environment file:

```bash
cp .env.local.example .env.local
```

Update `.env.local` with your credentials:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

# Instantly API (server-side only)
INSTANTLY_API_KEY=your_instantly_api_key
```

### 3. Database Setup

1. Go to your Supabase project's SQL Editor
2. Open `DATABASE_SCHEMA.md` and run each SQL block in order:
   - Create `profiles` table with RLS policies
   - Create `campaigns` table with RLS policies
   - Create `onboarding_steps` table with RLS policies

3. Create your admin account:

```sql
-- In Supabase SQL Editor
-- First, sign up through the Auth UI or API, then update the profile:
UPDATE profiles 
SET role = 'admin' 
WHERE email = 'your-admin-email@example.com';
```

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

### Admin Workflow

1. **Login** as admin at `/login`
2. **Create Clients** - Add new client accounts with email and company name
3. **Assign Campaigns** - Link Instantly campaign IDs to clients
4. **Manage Onboarding** - Add and track onboarding steps for each client

### Client Experience

1. **Login** at `/login` with credentials provided by admin
2. **View Analytics** - See campaign performance metrics
3. **Check Replies** - Browse recent email replies
4. **Track Onboarding** - Monitor setup progress

## API Endpoints

### Internal API Routes

- `GET /api/analytics?campaign_id={id}` - Fetch campaign analytics
- `GET /api/replies?campaign_id={id}` - Fetch recent replies

These routes proxy to Instantly.ai and keep the API key secure on the server.

## Database Schema

### Tables

- **profiles** - User accounts and roles
- **campaigns** - Campaign assignments
- **onboarding_steps** - Client onboarding tasks

See `DATABASE_SCHEMA.md` for complete schema and RLS policies.

## Security

- ✅ Row-level security (RLS) on all tables
- ✅ Role-based route protection via middleware
- ✅ Server-side API key management
- ✅ Secure session handling with Supabase Auth

## Deployment

### Deploy to Vercel

1. Push your code to GitHub
2. Import the project in Vercel
3. Add environment variables in Vercel dashboard
4. Deploy!

### Environment Variables for Production

Make sure to set these in your hosting platform:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `INSTANTLY_API_KEY`

## Development Notes

- The app uses Next.js App Router with Server Components
- Authentication state is managed via Supabase session cookies
- Middleware handles route protection and role checks
- Dark mode is the default (and only) theme

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## License

MIT

## Support

For issues or questions, please open an issue on GitHub or contact the development team.
