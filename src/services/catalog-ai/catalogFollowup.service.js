import { normalizeText } from "../../utils/normalize.js";

const COOLING_PART_SUGGESTIONS = [
  "Termostato",
  "Bomba de agua",
  "Radiador",
  "Manguera",
  "Tapón",
  "Depósito",
  "Sensor de temperatura",
  "Ventilador",
];

const COOLING_SYMPTOM_QUICK_REPLIES = [
  "Se calienta en tráfico",
  "Se calienta en subida",
  "Se calienta con clima",
  "Tira anticongelante",
  "No prende el ventilador",
];

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function hasVehicle(intent = {}) {
  return Boolean(
    hasValue(intent.marca_auto) ||
      hasValue(intent.modelo_auto) ||
      hasValue(intent.anio) ||
      hasValue(intent.motor)
  );
}

function hasCompleteBasicVehicle(intent = {}) {
  return Boolean(
    hasValue(intent.marca_auto) &&
      hasValue(intent.modelo_auto) &&
      hasValue(intent.anio)
  );
}

function hasProductTerm(intent = {}) {
  return Boolean(
    (Array.isArray(intent.terminos_producto_detectados) &&
      intent.terminos_producto_detectados.length > 0) ||
      (Array.isArray(intent.product_query_tokens) &&
        intent.product_query_tokens.length > 0) ||
      (Array.isArray(intent.strict_product_family_tokens) &&
        intent.strict_product_family_tokens.length > 0)
  );
}

function hasPartNumber(intent = {}) {
  return (
    Array.isArray(intent.numero_parte_tokens) &&
    intent.numero_parte_tokens.length > 0
  );
}

function hasMeasurements(intent = {}) {
  return (
    Array.isArray(intent.medidas_detectadas) &&
    intent.medidas_detectadas.length > 0
  );
}

function getSymptomKeys(intent = {}) {
  return Array.isArray(intent.sintomas_detectados)
    ? intent.sintomas_detectados.map((item) => item.key).filter(Boolean)
    : [];
}

function getMode(intent = {}, mode = null) {
  return (
    mode ||
    intent.modo_conversacion ||
    intent.modo_busqueda ||
    intent.gate_reason ||
    "PRODUCT_SEARCH"
  );
}

function buildMissingVehicleFields(intent = {}, { includeMotor = false } = {}) {
  const missing = [];

  if (!hasValue(intent.marca_auto)) missing.push("marca_auto");
  if (!hasValue(intent.modelo_auto)) missing.push("modelo_auto");
  if (!hasValue(intent.anio)) missing.push("anio");

  if (includeMotor && !hasValue(intent.motor)) {
    missing.push("motor");
  }

  return missing;
}

function compactMissingVehicle(missing = []) {
  const missingSet = new Set(missing);

  if (
    missingSet.has("marca_auto") ||
    missingSet.has("modelo_auto") ||
    missingSet.has("anio")
  ) {
    return [
      "vehiculo",
      ...(missingSet.has("motor") ? ["motor"] : []),
    ];
  }

  return missing;
}

function normalizeReplies(values = []) {
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))]
    .slice(0, 6);
}

function makeFollowup({
  requiereSeguimiento = false,
  bloqueante = false,
  siguienteAccion = "NONE",
  datosFaltantes = [],
  preguntas = [],
  respuestasRapidas = [],
} = {}) {
  return {
    requiere_seguimiento: Boolean(requiereSeguimiento),
    bloqueante: Boolean(bloqueante),
    siguiente_accion: siguienteAccion,
    datos_faltantes: [...new Set(datosFaltantes)].filter(Boolean),
    preguntas_seguimiento: normalizeReplies(preguntas).slice(0, 3),
    respuestas_rapidas: normalizeReplies(respuestasRapidas),
  };
}

function buildDiagnosticFollowup({ intent = {} } = {}) {
  const symptomKeys = getSymptomKeys(intent);
  const level = intent.nivel_usuario || "INTERMEDIO";
  const missingVehicle = compactMissingVehicle(
    buildMissingVehicleFields(intent, {
      includeMotor: level === "MECANICO",
    })
  );

  const hasOverheat = symptomKeys.includes("COOLING_OVERHEAT");
  const hasLeak = symptomKeys.includes("COOLING_LEAK");
  const hasNoStart = symptomKeys.includes("NO_START");

  const preguntas = [];

  if (!hasCompleteBasicVehicle(intent)) {
    preguntas.push("¿Qué marca, modelo y año es tu vehículo?");
  }

  if (level === "MECANICO" && !hasValue(intent.motor)) {
    preguntas.push("¿Qué motor trae?");
  }

  if (hasOverheat) {
    preguntas.push("¿Se calienta en tráfico, subida, carretera o con clima?");
  } else if (hasLeak) {
    preguntas.push("¿De dónde tira el líquido: frente, depósito, manguera o debajo del motor?");
  } else if (hasNoStart) {
    preguntas.push("¿Da marcha, prende y se apaga, o no hace nada?");
  } else {
    preguntas.push("¿Qué síntoma principal presenta?");
  }

  return makeFollowup({
    requiereSeguimiento: true,
    bloqueante: true,
    siguienteAccion: "ASK_DIAGNOSTIC_DETAILS",
    datosFaltantes: missingVehicle.length
      ? missingVehicle
      : ["detalle_sintoma"],
    preguntas,
    respuestasRapidas: hasOverheat || hasLeak
      ? COOLING_SYMPTOM_QUICK_REPLIES
      : [
          "Da marcha pero no prende",
          "No hace nada",
          "Prende y se apaga",
          "Hace ruido",
        ],
  });
}

function buildVehicleWithoutPartFollowup({ intent = {} } = {}) {
  return makeFollowup({
    requiereSeguimiento: true,
    bloqueante: true,
    siguienteAccion: "ASK_PART",
    datosFaltantes: ["pieza"],
    preguntas: [
      "¿Qué pieza necesitas para ese vehículo?",
      "Puede ser termostato, bomba de agua, radiador, manguera, tapón o número de parte.",
    ],
    respuestasRapidas: COOLING_PART_SUGGESTIONS,
  });
}

function buildProductSearchFollowup({ intent = {}, products = [] } = {}) {
  if (products.length > 0) {
    return makeFollowup({
      requiereSeguimiento: false,
      bloqueante: false,
      siguienteAccion: "SHOW_PRODUCTS",
      datosFaltantes: [],
      preguntas: [],
      respuestasRapidas: [],
    });
  }

  const missingVehicle = compactMissingVehicle(
    buildMissingVehicleFields(intent, {
      includeMotor: true,
    })
  );

  const missing = [];

  if (!hasProductTerm(intent) && !hasPartNumber(intent)) {
    missing.push("pieza");
  }

  missing.push(...missingVehicle);

  return makeFollowup({
    requiereSeguimiento: missing.length > 0,
    bloqueante: missing.length > 0,
    siguienteAccion: missing.includes("pieza")
      ? "ASK_PART"
      : "ASK_VEHICLE",
    datosFaltantes: missing,
    preguntas: [
      missing.includes("pieza")
        ? "¿Qué pieza necesitas buscar?"
        : null,
      missing.includes("vehiculo")
        ? "¿Qué marca, modelo y año es tu vehículo?"
        : null,
      missing.includes("motor")
        ? "¿Qué motor trae?"
        : null,
    ].filter(Boolean),
    respuestasRapidas: missing.includes("pieza")
      ? COOLING_PART_SUGGESTIONS
      : [],
  });
}

function buildCompatibilityFollowup({ intent = {}, products = [] } = {}) {
  const missing = [];

  if (!hasCompleteBasicVehicle(intent)) {
    missing.push("vehiculo");
  }

  if (!hasValue(intent.motor)) {
    missing.push("motor");
  }

  if (!hasPartNumber(intent) && !hasProductTerm(intent) && products.length === 0) {
    missing.push("pieza_o_codigo");
  }

  return makeFollowup({
    requiereSeguimiento: missing.length > 0,
    bloqueante: missing.length > 0,
    siguienteAccion: missing.includes("pieza_o_codigo")
      ? "ASK_PRODUCT_OR_CODE"
      : "ASK_COMPATIBILITY_DATA",
    datosFaltantes: missing,
    preguntas: [
      missing.includes("pieza_o_codigo")
        ? "¿Qué pieza o código quieres validar?"
        : null,
      missing.includes("vehiculo")
        ? "¿Para qué marca, modelo y año lo quieres validar?"
        : null,
      missing.includes("motor")
        ? "¿Qué motor trae?"
        : null,
    ].filter(Boolean),
    respuestasRapidas: [
      "Validar por aplicación",
      "Validar por código",
      "Validar por medida",
    ],
  });
}

function buildComparisonFollowup({ intent = {}, products = [] } = {}) {
  if (products.length >= 2) {
    return makeFollowup({
      requiereSeguimiento: false,
      bloqueante: false,
      siguienteAccion: "COMPARE_PRODUCTS",
      datosFaltantes: [],
      preguntas: [
        "¿Quieres que comparemos por aplicación, precio, marca o medidas?",
      ],
      respuestasRapidas: [
        "Comparar por aplicación",
        "Comparar por precio",
        "Comparar por marca",
        "Comparar por medidas",
      ],
    });
  }

  const missing = [];

  if (!hasPartNumber(intent) && !hasMeasurements(intent) && products.length < 2) {
    missing.push("productos_a_comparar");
  }

  return makeFollowup({
    requiereSeguimiento: true,
    bloqueante: true,
    siguienteAccion: "ASK_COMPARISON_ITEMS",
    datosFaltantes: missing,
    preguntas: [
      "¿Qué dos piezas, códigos o medidas quieres comparar?",
    ],
    respuestasRapidas: [
      "Comparar dos códigos",
      "Comparar por medida",
      "Comparar por aplicación",
    ],
  });
}

function buildStockFollowup({ intent = {} } = {}) {
  const missing = [];

  if (!hasProductTerm(intent) && !hasPartNumber(intent)) {
    missing.push("pieza");
  }

  if (!hasCompleteBasicVehicle(intent)) {
    missing.push("vehiculo");
  }

  return makeFollowup({
    requiereSeguimiento: true,
    bloqueante: missing.length > 0,
    siguienteAccion: "ASK_STOCK_DATA",
    datosFaltantes: missing,
    preguntas: [
      missing.includes("pieza")
        ? "¿Qué pieza quieres validar?"
        : null,
      missing.includes("vehiculo")
        ? "¿Para qué vehículo es?"
        : null,
    ].filter(Boolean),
    respuestasRapidas: [
      "Validar disponibilidad",
      "Agregar datos del vehículo",
      "Buscar por código",
    ],
  });
}

export function buildCatalogFollowup({
  question,
  intent = {},
  mode = null,
  products = [],
} = {}) {
  const detectedMode = getMode(intent, mode);
  const gateReason = intent.gate_reason || "";
  const normalizedQuestion = normalizeText(question);
  const hasProducts = Array.isArray(products) && products.length > 0;

  // Si ya hay productos recomendados, no generamos respuestas rápidas.
  // Las acciones reales se muestran en cada tarjeta: ver detalle y agregar.
  if (hasProducts) {
    return makeFollowup({
      requiereSeguimiento: false,
      bloqueante: false,
      siguienteAccion: "SHOW_PRODUCTS",
      datosFaltantes: [],
      preguntas: [],
      respuestasRapidas: [],
    });
  }

  if (gateReason === "SESSION_CONTEXT_RESET") {
    return makeFollowup({
      requiereSeguimiento: true,
      bloqueante: true,
      siguienteAccion: "ASK_NEW_CONTEXT",
      datosFaltantes: ["vehiculo_o_pieza"],
      preguntas: [
        "¿Qué nuevo vehículo o pieza quieres buscar?",
      ],
      respuestasRapidas: COOLING_PART_SUGGESTIONS,
    });
  }

  if (
    detectedMode === "DIAGNOSTIC_GUIDE" ||
    gateReason === "DIAGNOSTIC_SYMPTOM_WITHOUT_VEHICLE" ||
    gateReason === "TOO_BROAD_SYMPTOM"
  ) {
    return buildDiagnosticFollowup({ intent });
  }

  if (gateReason === "VEHICLE_WITHOUT_PART") {
    return buildVehicleWithoutPartFollowup({ intent });
  }

  if (
    detectedMode === "COMPATIBILITY_EXPLANATION" ||
    normalizedQuestion.includes("COMPATIBLE") ||
    normalizedQuestion.includes("APLICA") ||
    normalizedQuestion.includes("LE QUEDA")
  ) {
    return buildCompatibilityFollowup({ intent, products });
  }

  if (
    detectedMode === "PRODUCT_COMPARISON" ||
    detectedMode === "COMPARISON_GUIDE"
  ) {
    return buildComparisonFollowup({ intent, products });
  }

  if (
    detectedMode === "STOCK_QUERY" ||
    gateReason === "BRANCH_STOCK_NOT_AVAILABLE" ||
    gateReason === "FUTURE_STOCK_NOT_AVAILABLE"
  ) {
    return buildStockFollowup({ intent });
  }

  return buildProductSearchFollowup({ intent, products });
}

export function addFollowupToCatalogResult(
  result = {},
  { question, intent = {}, mode = null, products = [] } = {}
) {
  const followup = buildCatalogFollowup({
    question,
    intent,
    mode,
    products: products.length ? products : result.productos || [],
  });

  return {
    ...result,
    seguimiento: followup,
    requiere_mas_datos: Boolean(
      result.requiere_mas_datos || followup.bloqueante
    ),
  };
}