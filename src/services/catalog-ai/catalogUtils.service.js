import { normalizeText } from "../../utils/normalize.js";

const INVALID_CODES = new Set([
  "#N/A",
  "N/A",
  "NA",
  "ND",
  "N.D.",
  "SIN CODIGO",
  "SIN CÓDIGO",
  "NULL",
  "0",
]);

export function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export function isValidPublicCode(value) {
  const clean = normalizeText(value);
  return clean !== "" && !INVALID_CODES.has(clean);
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
