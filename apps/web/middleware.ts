import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Clerk v5 middleware — mounted ONLY when a Clerk publishable key is configured.
 *
 * For the header-auth demo deployment (no Clerk), `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
 * is unset, so `clerkMiddleware()` (which throws without keys) is skipped and we
 * fall through to a no-op. A real multi-tenant deploy sets the Clerk keys and the
 * full middleware runs; once the API derives the org from the Clerk session, add
 * `auth().protect()` (or a route matcher) here to enforce sign-in.
 */
const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default clerkEnabled ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // Skip Next internals and static files unless referenced in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
