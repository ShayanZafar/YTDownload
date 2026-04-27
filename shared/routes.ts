import { z } from "zod";
import { downloads } from "./schema";

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

export const api = {
  downloads: {
    list: {
      method: "GET" as const,
      path: "/api/downloads" as const,
      responses: {
        200: z.array(z.custom<typeof downloads.$inferSelect>()),
      },
    },
  },
  video: {
    info: {
      method: "POST" as const,
      path: "/api/video/info" as const,
      input: z.object({ url: z.string().url() }),
      responses: {
        200: z.object({
          title: z.string(),
          thumbnail: z.string(),
          url: z.string(),
        }),
        400: errorSchemas.validation,
        500: errorSchemas.internal,
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
