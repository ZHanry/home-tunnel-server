import { z } from "zod";
import { parseBody } from "./validation.js";

export function pagination(query: unknown) {
  const value = parseBody(
    z.object({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      page_size: z.coerce.number().int().min(1).max(100).default(100),
      search: z.string().trim().max(120).default(""),
    }),
    query,
  );
  return { ...value, offset: (value.page - 1) * value.page_size };
}

export function pageInfo(page: number, pageSize: number, total: number) {
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
