export function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export function boolFromEnv(value, defaultValue = false) {
  const clean = cleanString(value).toLowerCase();

  if (!clean) return defaultValue;

  return ["1", "true", "yes", "on", "si", "sí"].includes(clean);
}

export function numberFromEnv(value, defaultValue) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function safeJsonParse(value) {
  try {
    if (!value) return null;
    if (typeof value === "object") return value;

    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function cleanAiText(value) {
  return cleanString(value)
    .replace(/^```(?:json|txt|text|markdown)?/i, "")
    .replace(/```$/i, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/^\s*\|[-:\s|]+\|\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseJsonObjectFromAi(value) {
  const clean = cleanAiText(value);

  if (!clean) return null;

  const direct = safeJsonParse(clean);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct;
  }

  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;

  const parsed = safeJsonParse(match[0]);

  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : null;
}

export function coerceStringArray(value) {
  const source = Array.isArray(value) ? value : value ? [value] : [];

  return source
    .map((item) => cleanString(item).toUpperCase())
    .filter(Boolean)
    .slice(0, 8);
}

export function coerceBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function coerceConfidence(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return 0;

  return Math.max(0, Math.min(1, number));
}

export function coerceYear(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return null;
  if (number < 1900 || number > 2049) return null;

  return number;
}
