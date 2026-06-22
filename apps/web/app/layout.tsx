import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";

import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "PeopleOS",
  description: "AI-native HR operating system — ATS + HRMS + AI agents.",
};

/**
 * Root layout. Provider order: Clerk (auth/session) on the outside, then
 * TanStack Query for server state. Clerk reads NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
 * from the environment automatically.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <body className="min-h-screen bg-background text-foreground antialiased">
          <Providers>
            <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
              <header className="flex items-center justify-between border-b py-4">
                <Link href="/" className="text-lg font-semibold tracking-tight">
                  PeopleOS
                </Link>
                <nav className="flex items-center gap-4 text-sm text-muted-foreground">
                  <Link href="/" className="hover:text-foreground">
                    Dashboard
                  </Link>
                  <Link href="/assistant" className="hover:text-foreground">
                    Assistant
                  </Link>
                  <Link href="/jobs" className="hover:text-foreground">
                    Jobs
                  </Link>
                  <Link href="/analytics" className="hover:text-foreground">
                    Analytics
                  </Link>
                  <Link href="/attrition" className="hover:text-foreground">
                    Attrition
                  </Link>
                  <Link href="/skills/inventory" className="hover:text-foreground">
                    Skills
                  </Link>
                  <Link href="/skills/team" className="hover:text-foreground">
                    Team
                  </Link>
                  <Link href="/mobility" className="hover:text-foreground">
                    Mobility
                  </Link>
                  <Link href="/workflows" className="hover:text-foreground">
                    Workflows
                  </Link>
                  <Link href="/copilot/jd" className="hover:text-foreground">
                    JD Writer
                  </Link>
                  <Link href="/interviews" className="hover:text-foreground">
                    Interviews
                  </Link>
                  <Link href="/hr-chat" className="hover:text-foreground">
                    HR Assistant
                  </Link>
                  <Link href="/policies" className="hover:text-foreground">
                    Policies
                  </Link>
                </nav>
              </header>
              <main className="flex-1 py-8">{children}</main>
              <footer className="border-t py-4 text-xs text-muted-foreground">
                PeopleOS skeleton — Phase 1 web foundation.
              </footer>
            </div>
          </Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}
