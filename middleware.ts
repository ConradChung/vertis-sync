import { updateSession } from '@/lib/supabase/middleware'
import { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - api/validate-emails (SSE streaming — middleware buffering breaks it)
     */
    '/((?!_next/static|_next/image|favicon.ico|api/validate-emails|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
