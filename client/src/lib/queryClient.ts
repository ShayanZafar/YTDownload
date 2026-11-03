import { QueryClient } from "@tanstack/react-query";

/**
 * The page's query cache. Every query and mutation brings its own function,
 * which calls the app through `requestJson()` (lib/api.ts); none is fetched
 * again on its own unless it says so.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
