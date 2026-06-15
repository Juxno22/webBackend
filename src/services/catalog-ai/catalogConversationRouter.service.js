import { normalizeText } from "../../utils/normalize.js";

export const CATALOG_CONVERSATION_MODES = Object.freeze({
  PRODUCT_SEARCH: "PRODUCT_SEARCH",
  DIAGNOSTIC_GUIDE: "DIAGNOSTIC_GUIDE",
  COMPARISON_GUIDE: "COMPARISON_GUIDE",
  PRODUCT_COMPARISON: "PRODUCT_COMPARISON",
  COMPATIBILITY_EXPLANATION: "COMPATIBILITY_EXPLANATION",
  STOCK_QUERY: "STOCK_QUERY",
});

function hasAny(items) {
  return Array.isArray(items) && items.length > 0;
}

function hasVehicleData(intent = {}) {
  return Boolean(intent.marca_auto || intent.modelo_auto || intent.anio || intent.motor);
}

function hasProductData(intent = {}) {
  return (
    hasAny(intent.terminos_producto_detectados) ||
    hasAny(intent.product_query_tokens) ||
    hasAny(intent.numero_parte_tokens) ||
    hasAny(intent.medidas_detectadas)
  );
}

function hasSearchableSymptom(intent = {}) {
  return hasAny(intent.sintomas_detectados)
    ? intent.sintomas_detectados.some((item) => item.searchable)
    : false;
}

function hasNonSearchableSymptom(intent = {}) {
  return hasAny(intent.sintomas_detectados)
    ? intent.sintomas_detectados.some((item) => !item.searchable)
    : false;
}

function hasPendingDiagnostic(sessionContext = {}) {
  return (
    hasAny(sessionContext.pendiente_sintomas) ||
    sessionContext.pendiente_modo === CATALOG_CONVERSATION_MODES.DIAGNOSTIC_GUIDE
  );
}

function asksCompatibilityExplanation(question) {
  const text = normalizeText(question);

  return (
    /\bPOR\s+QUE\b.*\b(LE\s+QUEDA|APLICA|COMPATIBLE|SIRVE)\b/.test(text) ||
    /\bPOR\s+QUÉ\b.*\b(LE\s+QUEDA|APLICA|COMPATIBLE|SIRVE)\b/.test(text) ||
    /\b(LE\s+QUEDA|LE\s+SIRVE|APLICA|COMPATIBLE)\b.*\b(POR\s+QUE|POR\s+QUÉ)\b/.test(text)
  );
}

function isConceptComparison(question) {
  const text = normalizeText(question);

  return (
    /\bDIFERENCIA\b/.test(text) ||
    /\bDIFERENCIAS\b/.test(text) ||
    /\bCOMPARAR\b/.test(text) ||
    /\bCOMPARACION\b/.test(text) ||
    /\bCOMPARACIÓN\b/.test(text) ||
    /\bVS\b/.test(text) ||
    /\bMEJOR\b/.test(text) ||
    /\bCONVIENE\b/.test(text)
  );
}

function mentionsMultipleProductConcepts(intent = {}) {
  const terms = Array.isArray(intent.terminos_producto_detectados)
    ? intent.terminos_producto_detectados.map((item) => normalizeText(item))
    : [];

  const distinctFamilies = new Set(
    terms.map((term) => {
      if (term.includes("BOMBA")) return "BOMBA_DE_AGUA";
      if (term.includes("TERMOSTATO")) return "TERMOSTATO";
      if (term.includes("RADIADOR")) return "RADIADOR";
      if (term.includes("TAPON") || term.includes("TAPÓN")) return "TAPON";
      if (term.includes("DEPOSITO") || term.includes("DEPÓSITO")) return "DEPOSITO";
      if (term.includes("MANGUERA")) return "MANGUERA";
      if (term.includes("VENTILADOR") || term.includes("MOTOVENTILADOR")) return "VENTILADOR";
      if (term.includes("SENSOR") || term.includes("BULBO")) return "SENSOR";
      return term;
    })
  );

  return distinctFamilies.size >= 2;
}

function hasProductComparisonContext(question, intent = {}) {
  const hasProduct = hasProductData(intent);
  const hasVehicle = hasVehicleData(intent);
  const hasCodes = hasAny(intent.numero_parte_tokens);
  const hasMeasurements = hasAny(intent.medidas_detectadas);

  return (
    isConceptComparison(question) &&
    (
      hasCodes ||
      hasMeasurements ||
      (hasProduct && hasVehicle)
    )
  );
}

function hasDiagnosticQuestion(question, intent = {}, sessionContext = {}) {
  const text = normalizeText(question);

  if (hasPendingDiagnostic(sessionContext) && hasVehicleData(intent) && !hasProductData(intent)) {
    return true;
  }

  if (hasSearchableSymptom(intent) && !hasAny(intent.terminos_producto_detectados)) {
    return true;
  }

  if (hasNonSearchableSymptom(intent)) {
    return true;
  }

  return (
    /\bQUE\s+PUEDE\s+SER\b/.test(text) ||
    /\bQUÉ\s+PUEDE\s+SER\b/.test(text) ||
    /\bQUE\s+SERA\b/.test(text) ||
    /\bQUÉ\s+SERÁ\b/.test(text) ||
    /\bSERA\s+LA\b/.test(text) ||
    /\bSERÁ\s+LA\b/.test(text) ||
    /\bSERA\s+EL\b/.test(text) ||
    /\bSERÁ\s+EL\b/.test(text) ||
    /\bNO\s+ARRANCA\b/.test(text) ||
    /\bNO\s+PRENDE\b/.test(text) ||
    /\bNO\s+ENCIENDE\b/.test(text)
  );
}

export function routeCatalogConversation({ question, intent = {}, sessionContext = {} } = {}) {
  const hasVehicle = hasVehicleData(intent);
  const hasProduct = hasProductData(intent);
  const hasSymptoms = hasAny(intent.sintomas_detectados);
  const hasCodes = hasAny(intent.numero_parte_tokens);

  if (asksCompatibilityExplanation(question)) {
    return {
      mode: CATALOG_CONVERSATION_MODES.COMPATIBILITY_EXPLANATION,
      reason: "COMPATIBILITY_EXPLANATION_REQUEST",
      shouldSearchCatalog: hasProduct || hasCodes,
      requiresMoreData: !(hasProduct || hasCodes) || !hasVehicle,
    };
  }

  if (hasProductComparisonContext(question, intent)) {
    return {
      mode: CATALOG_CONVERSATION_MODES.PRODUCT_COMPARISON,
      reason: "PRODUCT_COMPARISON_REQUEST",
      shouldSearchCatalog: true,
      requiresMoreData: false,
    };
  }

  if (hasProductComparisonContext(question, intent)) {
    return {
      mode: CATALOG_CONVERSATION_MODES.PRODUCT_COMPARISON,
      reason: "PRODUCT_COMPARISON_WITH_CATALOG_CONTEXT",
      shouldSearchCatalog: true,
      requiresMoreData: false,
    };
  }

  if (isConceptComparison(question) || mentionsMultipleProductConcepts(intent)) {
    return {
      mode: CATALOG_CONVERSATION_MODES.COMPARISON_GUIDE,
      reason: "CONCEPT_COMPARISON_REQUEST",
      shouldSearchCatalog: false,
      requiresMoreData: false,
    };
  }

  if (hasDiagnosticQuestion(question, intent, sessionContext)) {
    return {
      mode: CATALOG_CONVERSATION_MODES.DIAGNOSTIC_GUIDE,
      reason: hasPendingDiagnostic(sessionContext)
        ? "PENDING_DIAGNOSTIC_CONTEXT"
        : "DIAGNOSTIC_GUIDE_REQUEST",
      shouldSearchCatalog: false,
      requiresMoreData: !hasVehicle,
      hasSymptoms,
    };
  }

  return {
    mode: CATALOG_CONVERSATION_MODES.PRODUCT_SEARCH,
    reason: "PRODUCT_SEARCH_REQUEST",
    shouldSearchCatalog: true,
    requiresMoreData: false,
  };
}