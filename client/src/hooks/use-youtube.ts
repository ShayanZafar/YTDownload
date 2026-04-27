import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { z } from "zod";

/**
 * Safely parse data and log detailed errors if validation fails.
 * This ensures frontend doesn't silently fail when backend shapes change.
 */
function parseWithLogging<T>(schema: z.ZodSchema<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(`[Zod] ${label} validation failed:`, result.error.format());
    throw new Error(`Data validation failed for ${label}`);
  }
  return result.data;
}

export function useRecentDownloads() {
  return useQuery({
    queryKey: [api.downloads.list.path],
    queryFn: async () => {
      const res = await fetch(api.downloads.list.path, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch recent downloads");
      const data = await res.json();
      return parseWithLogging(api.downloads.list.responses[200], data, "downloads.list");
    },
  });
}

export function useVideoInfo() {
  return useMutation({
    mutationFn: async (url: string) => {
      // Validate input before sending
      const validatedInput = api.video.info.input.parse({ url });

      const res = await fetch(api.video.info.path, {
        method: api.video.info.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validatedInput),
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 400 || res.status === 500) {
          const errorData = await res.json();
          const schema =
            res.status === 400 ? api.video.info.responses[400] : api.video.info.responses[500];
          const parsedError = schema.safeParse(errorData);
          throw new Error(parsedError.success ? parsedError.data.message : "An error occurred");
        }
        throw new Error("Failed to fetch video information");
      }

      const data = await res.json();
      return parseWithLogging(api.video.info.responses[200], data, "video.info");
    },
    // Only invalidate if we actually triggered a background process that updates list,
    // though the app requires clicking "Download" to actually add to the list.
    // We will invalidate when the user clicks download instead.
  });
}
