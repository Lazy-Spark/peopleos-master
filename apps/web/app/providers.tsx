"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import * as React from "react";

import { AssistantProvider } from "@/components/assistant/assistant-provider";

/**
 * Client-side providers. TanStack Query v5 owns server-state caching; the
 * QueryClient is created once per browser session (lazy state init so it isn't
 * recreated on re-render). Clerk's provider is mounted in layout.tsx.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {/* Mounted once here so an in-flight assistant turn survives page navigation. */}
      <AssistantProvider>{children}</AssistantProvider>
      {process.env.NODE_ENV !== "production" ? (
        <ReactQueryDevtools initialIsOpen={false} />
      ) : null}
    </QueryClientProvider>
  );
}
