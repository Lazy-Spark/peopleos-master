import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Clerk v5 middleware. Mounting `clerkMiddleware` makes `auth()` and the Clerk
 * client available to routes. This skeleton does NOT gate any routes yet — once
 * the API derives the org from the Clerk session, add `auth().protect()` (or a
 * route matcher) here to enforce sign-in before reaching tenant data.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next internals and static files unless referenced in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
