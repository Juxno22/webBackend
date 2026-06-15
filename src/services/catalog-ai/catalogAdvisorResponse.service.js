import { CATALOG_CONVERSATION_MODES } from "./catalogConversationRouter.service.js";

function buildVehicleText(intent = {}, sessionContext = {}) {
  return [
    intent.marca_auto || sessionContext.marca_auto,
    intent.modelo_auto || sessionContext.modelo_auto,
    intent.anio || sessionContext.anio,
    intent.motor || sessionContext.motor,
  ]
    .filter(Boolean)
    .join(" ");
}

function getSymptomKeys(intent = {}, sessionContext = {}) {
  const current = Array.isArray(intent.sintomas_detectados)
    ? intent.sintomas_detectados.map((item) => item.key).filter(Boolean)
    : [];

  const pending = Array.isArray(sessionContext.pendiente_sintomas)
    ? sessionContext.pendiente_sintomas.map((item) => item.key).filter(Boolean)
    : [];

  return [...new Set([...current, ...pending])];
}

function hasTerm(intent = {}, pattern) {
  const text = [
    ...(intent.terminos_producto_detectados || []),
    ...(intent.product_query_tokens || []),
    intent.pregunta_normalizada || "",
  ].join(" ").toUpperCase();

  return pattern.test(text);
}

function buildDiagnosticGuideAnswer({ intent = {}, sessionContext = {} }) {
  const vehicleText = buildVehicleText(intent, sessionContext);
  const symptomKeys = getSymptomKeys(intent, sessionContext);

  if (symptomKeys.includes("NO_START")) {
    return [
      "Puede ser una falla eléctrica, de combustible, marcha, batería o sensores; no conviene asumir bomba de agua solo porque no arranca.",
      "La bomba de agua normalmente se relaciona más con calentamiento, fugas o circulación de anticongelante.",
      vehicleText
        ? `Con ${vehicleText}, dime qué hace al intentar arrancar: si da marcha, si prende y se apaga, o si no hace nada.`
        : "Dime marca, modelo, año, motor y qué hace al intentar arrancar: si da marcha, si prende y se apaga, o si no hace nada.",
    ].join(" ");
  }

  if (symptomKeys.includes("COOLING_LEAK")) {
    return [
      "Ese síntoma puede estar relacionado con mangueras, radiador, depósito, tapón, toma de agua o bomba de agua.",
      vehicleText
        ? `Como veníamos con ${vehicleText}, dime si la fuga viene del frente, del depósito, de una manguera o debajo del motor para orientar mejor la búsqueda.`
        : "Para buscar una pieza correcta necesito marca, modelo, año y motor; también ayuda saber de dónde tira el líquido.",
      "Ventas valida compatibilidad y disponibilidad final.",
    ].join(" ");
  }

  if (symptomKeys.includes("COOLING_OVERHEAT")) {
    return [
      "El calentamiento puede relacionarse con termostato, bomba de agua, radiador, tapón, depósito, mangueras, ventilador o sensor de temperatura.",
      vehicleText
        ? `Como veníamos con ${vehicleText}, dime si se calienta en tráfico, en subida, con clima o después de varios kilómetros para enfocar la búsqueda.`
        : "Para buscar opciones reales necesito marca, modelo, año y motor; también dime si se calienta en tráfico, en subida, con clima o después de varios kilómetros.",
      "La recomendación es orientativa; ventas valida compatibilidad y disponibilidad final.",
    ].join(" ");
  }

  return [
    "Puedo orientarte, pero con ese síntoma todavía no conviene recomendar una pieza exacta.",
    vehicleText
      ? `Con ${vehicleText}, dime qué sistema falla o qué síntoma específico presenta.`
      : "Dime marca, modelo, año, motor y el síntoma principal para ayudarte mejor.",
    "Ventas valida compatibilidad y disponibilidad final.",
  ].join(" ");
}

function buildComparisonGuideAnswer({ intent = {} }) {
  const mentionsPump = hasTerm(intent, /BOMBA/);
  const mentionsThermostat = hasTerm(intent, /TERMOSTATO/);
  const mentionsRadiatorCap = hasTerm(intent, /TAPON.*RADIADOR|TAPÓN.*RADIADOR/);
  const mentionsDepositCap = hasTerm(intent, /TAPON.*DEPOSITO|TAPÓN.*DEPÓSITO|TAPON.*DEPÓSITO|TAPÓN.*DEPOSITO/);

  if (mentionsPump && mentionsThermostat) {
    return "La bomba de agua mueve el anticongelante por el motor y radiador; el termostato regula cuándo se abre el paso del anticongelante según temperatura. Si el auto se calienta, cualquiera de los dos puede estar involucrado, pero también influyen radiador, tapón, mangueras, ventilador y sensor. Para buscar la pieza correcta dime marca, modelo, año y motor.";
  }

  if (mentionsRadiatorCap || mentionsDepositCap) {
    return "El tapón de radiador y el tapón de depósito no siempre trabajan igual: uno puede controlar presión directamente en el radiador y el otro sellar o presurizar el depósito según el sistema del vehículo. La presión correcta en PSI y la aplicación son clave. Para ubicar el correcto dime marca, modelo, año y motor, o comparte el código de la pieza.";
  }

  return "Sí puedo ayudarte a comparar conceptos de refacciones, sobre todo del sistema de enfriamiento. Para una comparación precisa dime qué dos piezas, marcas o códigos quieres comparar; si buscas compatibilidad, también necesito marca, modelo, año y motor.";
}

function buildCompatibilityGuideAnswer({ intent = {}, sessionContext = {} }) {
  const vehicleText = buildVehicleText(intent, sessionContext);

  return [
    "Para explicar compatibilidad necesito cruzar la pieza contra aplicaciones, motor, años y posibles cruces registrados en el catálogo.",
    vehicleText
      ? `Ya tengo como contexto ${vehicleText}; compárteme el código o la pieza exacta que quieres validar.`
      : "Dime marca, modelo, año, motor y el código o pieza que quieres validar.",
    "No voy a confirmar compatibilidad final sin datos del catálogo; ventas debe validar la aplicación antes de cotizar.",
  ].join(" ");
}

export function buildAdvisorLocalAnswer({ mode, intent = {}, sessionContext = {} }) {
  if (mode === CATALOG_CONVERSATION_MODES.DIAGNOSTIC_GUIDE) {
    return buildDiagnosticGuideAnswer({ intent, sessionContext });
  }

  if (mode === CATALOG_CONVERSATION_MODES.COMPARISON_GUIDE) {
    return buildComparisonGuideAnswer({ intent, sessionContext });
  }

  if (mode === CATALOG_CONVERSATION_MODES.COMPATIBILITY_EXPLANATION) {
    return buildCompatibilityGuideAnswer({ intent, sessionContext });
  }

  return "Puedo ayudarte como asesor de refacciones. Dime si quieres buscar una pieza, comparar opciones o explicar un síntoma del sistema de enfriamiento.";
}

export function buildAdvisorAiMessages({
  question,
  mode,
  route,
  intent = {},
  sessionContext = {},
  products = [],
  evidence = null,
}) {
  return [
    {
      role: "user",
      content: JSON.stringify(
        {
          pregunta_cliente: question,
          modo_conversacion: mode,
          ruta: route,
          intencion_detectada: intent,
          contexto_sesion: sessionContext,
          contexto_productos: products.slice(0, 6),
          evidencia_controlada: evidence,
        },
        null,
        2
      ),
    },
  ];
}