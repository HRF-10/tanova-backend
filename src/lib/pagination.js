export function pageParams(q = {}) {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
  return { page, limit, offset: (page - 1) * limit };
}
export const pageMeta = (page, limit, total) => ({
  page,
  limit,
  total,
  total_pages: Math.max(1, Math.ceil(total / limit)),
});
