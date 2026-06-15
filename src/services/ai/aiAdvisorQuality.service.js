import { cleanAiText, cleanString } from "./aiText.service.js";

const MAX_SENTENCES = 4;
const MAX_LENGTH = 850;

const DANGEROUS_CERTAINTY_PATTERNS = [
  /\bDEFINITIVAMENTE\b/gi,
  /\bSIN DUDA\b/gi,
  /\bESTO RESUELVE\b/gi,
  /\bESTA PIEZA RESUELVE\b/gi,
  /\bCON ESTO SE ARREGLA\b/gi,
  /\bES LA FALLA\b/gi,
  /\bES EL PROBLEMA\b/gi,
  /\b100%\b/g,
];

const HARD_DIAGNOSIS_PATTERNS = [
  /\bTU\s+(AUTO|CARRO|COCHE|VEH[IÍ]CULO)\s+TIENE\b/gi,
  /\bLA FALLA ES\b/gi,
  /\bEL PROBLEMA ES\b/gi,
  /\bSE DEBE A\b/gi,
];

const INVENTORY_CERTAINTY_PATTERNS = [
  /\bS[IÍ]\s+HAY\s+STOCK\b/gi,
  /\bS[IÍ]\s+LO\s+TENEMOS\b/gi,
  /\bEST[AÁ]\s+DISPONIBLE\b/gi,
  /\bLO TENEMOS DISPONIBLE\b/gi,
];

function splitSentences(text) {
  return cleanString(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function limitSentences(text, maxSentences = MAX_SENTENCES) {
  const sentences = splitSentences(text);

  if (sentences.length <= maxSentences) return text;

  return sentences.slice(0, maxSentences).join(" ");
}

function limitLength(text, maxLength = MAX_LENGTH) {
  const clean = cleanString(text);

  if (clean.length <= maxLength) return clean;

  const cut = clean.slice(0, maxLength);
  const lastPeriod = Math.max(
    cut.lastIndexOf("."),
    cut.lastIndexOf("?"),
    cut.lastIndexOf("!")
  );

  if (lastPeriod > 250) {
    return cut.slice(0, lastPeriod + 1).trim();
  }

  return `${cut.trim()}...`;
}

function softenCertainty(text) {
  let next = text;

  for (const pattern of DANGEROUS_CERTAINTY_PATTERNS) {
    next = next.replace(pattern, "podría estar relacionado");
  }

  for (const pattern of HARD_DIAGNOSIS_PATTERNS) {
    next = next.replace(pattern, "podría estar relacionado con");
  }

  for (const pattern of INVENTORY_CERTAINTY_PATTERNS) {
    next = next.replace(pattern, "ventas puede validar disponibilidad");
  }

  return next;
}

function removeMarkdownNoise(text) {
  return cleanString(text)
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureCommercialClose(text, { mode } = {}) {
  const clean = cleanString(text);

  if (
    /\bVENTAS\s+VALIDA\b/i.test(clean) ||
    /\bVALIDA\s+COMPATIBILIDAD\b/i.test(clean) ||
    /\bVALIDAR\s+COMPATIBILIDAD\b/i.test(clean)
  ) {
    return clean;
  }

  const shouldClose =
    mode === "PRODUCT_COMPARISON" ||
    mode === "COMPATIBILITY_EXPLANATION" ||
    mode === "PRODUCT_SEARCH";

  if (!shouldClose) return clean;

  return `${clean} Ventas valida compatibilidad y disponibilidad final.`;
}

function ensureCoolingFocus(text, { mode, intent = {} } = {}) {
  const clean = cleanString(text);

  if (mode !== "DIAGNOSTIC_GUIDE" && mode !== "COMPARISON_GUIDE") {
    return clean;
  }

  const alreadyMentionsCooling =
    /\bENFRIAMIENTO\b/i.test(clean) ||
    /\bANTICONGELANTE\b/i.test(clean) ||
    /\bRADIADOR\b/i.test(clean) ||
    /\bTERMOSTATO\b/i.test(clean) ||
    /\bBOMBA\s+DE\s+AGUA\b/i.test(clean);

  if (alreadyMentionsCooling) return clean;

  const hasCoolingSymptom = Array.isArray(intent.sintomas_detectados)
    ? intent.sintomas_detectados.some((item) =>
        ["COOLING_OVERHEAT", "COOLING_LEAK"].includes(item.key)
      )
    : false;

  if (!hasCoolingSymptom) return clean;

  return `${clean} En sistema de enfriamiento también conviene revisar radiador, termostato, bomba de agua, tapón, mangueras y anticongelante.`;
}

export function polishAdvisorResponse({
  response,
  mode = null,
  intent = {},
} = {}) {
  let text = cleanAiText(response);

  if (!text) return "";

  text = removeMarkdownNoise(text);
  text = softenCertainty(text);
  text = ensureCoolingFocus(text, { mode, intent });
  text = ensureCommercialClose(text, { mode, intent });
  text = limitSentences(text, MAX_SENTENCES);
  text = limitLength(text, MAX_LENGTH);

  return text;
}