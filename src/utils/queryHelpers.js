export function cleanString(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return null;

  const clean = String(value).trim();

  return clean === "" ? null : clean;
}

export function parsePositiveInt(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 1) return fallback;

  return parsed;
}

export function buildPagination(query = {}, defaultLimit = 20, maxLimit = 80) {
  const page = parsePositiveInt(query.page, 1);
  const limit = Math.min(parsePositiveInt(query.limit, defaultLimit), maxLimit);
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

export function placeholders(values = []) {
  return values.map(() => "?").join(", ");
}

export function parseCsvParam(value) {
  if (!value) return [];

  const rawValues = Array.isArray(value) ? value : String(value).split(",");

  return [
    ...new Set(
      rawValues
        .map((item) => cleanString(item))
        .filter(Boolean)
    ),
  ];
}
