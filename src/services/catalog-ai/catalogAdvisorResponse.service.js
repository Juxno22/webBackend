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

function getAdvisorTurns(intent = {}, sessionContext = {}) {
  return Number(
    intent.asesor_turnos ||
    sessionContext.asesor_turnos ||
    intent.contexto_corto?.asesor_turnos ||
    0
  );
}

function asksDefinition(intent = {}) {
  const text = String(intent.pregunta_normalizada || "").toUpperCase();

  return (
    /\bQUE\s+ES\b/.test(text) ||
    /\bQUÉ\s+ES\b/.test(text) ||
    /\bPARA\s+QUE\s+SIRVE\b/.test(text) ||
    /\bPARA\s+QUÉ\s+SIRVE\b/.test(text) ||
    /\bCOMO\s+FUNCIONA\b/.test(text) ||
    /\bCÓMO\s+FUNCIONA\b/.test(text)
  );
}

function buildCoolingProposalText() {
  return "Propuesta inicial a revisar: termostato, bomba de agua, tapón, radiador, mangueras, ventilador o sensor de temperatura.";
}

function buildDiagnosticGuideAnswer({ intent = {}, sessionContext = {} }) {
  const vehicleText = buildVehicleText(intent, sessionContext);
  const symptomKeys = getSymptomKeys(intent, sessionContext);
  const level = intent.nivel_usuario || "INTERMEDIO";

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
    const vehicleText = buildVehicleText(intent);

    return [
      vehicleText
        ? `Para ${vehicleText}, una fuga de anticongelante por abajo puede venir de varias zonas del sistema de enfriamiento.`
        : "Una fuga de anticongelante por abajo puede venir de varias zonas del sistema de enfriamiento.",
      "Lo más común a revisar es manguera, radiador, depósito, toma/brida, bomba de agua, tapón o abrazaderas.",
      vehicleText
        ? "Dime solo por qué zona tira: frente, centro, lado del motor o cerca del radiador, y te muestro opciones orientativas."
        : "Dime marca, modelo y año para mostrarte opciones orientativas.",
    ].join(" ");
  }

  if (symptomKeys.includes("COOLING_OVERHEAT")) {

    if (level === "MECANICO") {
      return [
        "Por calentamiento, revisaría flujo de anticongelante, apertura de termostato, eficiencia de radiador, presión de tapón, funcionamiento de motoventilador y posible aire en el sistema.",
        vehicleText
          ? `Con ${vehicleText}, conviene validar motor, temperatura de apertura, presión del tapón y aplicación exacta antes de elegir pieza.`
          : "Pásame marca, modelo, año, motor y si el calentamiento ocurre en tráfico, subida, carretera o con A/C.",
        "Validar aplicación y disponibilidad final antes de cotizar.",
      ].join(" ");
    }

    if (level === "PRINCIPIANTE") {
      const advisorTurns = getAdvisorTurns(intent, sessionContext);

      if (level === "PRINCIPIANTE") {
        return [
          "Cuando un carro se calienta, normalmente hay que revisar el sistema de enfriamiento.",
          "Las piezas más comunes son termostato, bomba de agua, radiador, tapón, mangueras, ventilador o sensor de temperatura.",
          vehicleText
            ? `Con ${vehicleText}, puedo buscar opciones orientativas para que ventas valide compatibilidad.`
            : "Dime solo marca, modelo y año para mostrarte opciones orientativas.",
        ].join(" ");
      }

      return [
        "Cuando un carro se calienta, no siempre es una sola pieza; normalmente es del sistema de enfriamiento.",
        buildCoolingProposalText(),
        "Dime solo marca, modelo y año para mostrarte opciones orientativas.",
      ].join(" ");
    }

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
  const definitionQuestion = asksDefinition(intent);
  const mentionsRadiatorCap = hasTerm(intent, /TAPON.*RADIADOR|TAPÓN.*RADIADOR/);
  const mentionsDepositCap = hasTerm(intent, /TAPON.*DEPOSITO|TAPÓN.*DEPÓSITO|TAPON.*DEPÓSITO|TAPÓN.*DEPOSITO/);

  const normalizedQuestion = String(intent.pregunta_normalizada || "").toUpperCase();

  if (intent.comparacion_temperatura_termostato) {
    const temps = Array.isArray(intent.temperaturas_detectadas)
      ? intent.temperaturas_detectadas
      : [];

    const sortedTemps = [...temps].sort((a, b) => a - b);
    const low = sortedTemps[0] || 82;
    const high = sortedTemps[1] || 87;

    return [
      `La diferencia entre un termostato de ${low}° y uno de ${high}° es la temperatura aproximada a la que empieza a abrir.`,
      `El de ${low}° abre antes; el de ${high}° deja que el motor trabaje un poco más caliente antes de abrir.`,
      "No se elige por cuál es mejor, sino por la especificación del motor y la aplicación registrada.",
      "Para cotizar uno correcto sí conviene validar marca, modelo, año y motor.",
    ].join(" ");
  }

  if (
    mentionsThermostat &&
    (
      /\bQUE\s+ES\b/.test(normalizedQuestion) ||
      /\bQUÉ\s+ES\b/.test(normalizedQuestion) ||
      /\bPARA\s+QUE\s+SIRVE\b/.test(normalizedQuestion) ||
      /\bPARA\s+QUÉ\s+SIRVE\b/.test(normalizedQuestion)
    )
  ) {
    return "El termostato es una válvula del sistema de enfriamiento. Ayuda a controlar cuándo circula el anticongelante hacia el radiador para mantener el motor en su temperatura correcta. Si falla, puede provocar calentamiento o que el motor trabaje fuera de temperatura.";
  }

  if (mentionsPump && mentionsThermostat) {
    return "La bomba de agua mueve el anticongelante por el motor y radiador; el termostato regula cuándo se abre el paso del anticongelante según temperatura. Si el auto se calienta, cualquiera de los dos puede estar involucrado, pero también influyen radiador, tapón, mangueras, ventilador y sensor. Para buscar la pieza correcta dime marca, modelo, año y motor.";
  }

  if (mentionsRadiatorCap || mentionsDepositCap) {
    return "El tapón de radiador y el tapón de depósito no siempre trabajan igual: uno puede controlar presión directamente en el radiador y el otro sellar o presurizar el depósito según el sistema del vehículo. La presión correcta en PSI y la aplicación son clave. Para ubicar el correcto dime marca, modelo, año y motor, o comparte el código de la pieza.";
  }

  return "Sí puedo ayudarte a comparar conceptos de refacciones, sobre todo del sistema de enfriamiento. Para una comparación precisa dime qué dos piezas, marcas o códigos quieres comparar; si buscas compatibilidad, también necesito marca, modelo, año y motor.";
}

function buildCompatibilityGuideAnswer({ intent = {}, sessionContext = {} }) {
  const text = String(intent.pregunta_normalizada || "").toUpperCase();

  if (/\b(PUEDO|PUEDE)\s+PONER\b/.test(text) || /\bLE\s+PUEDO\s+PONER\b/.test(text)) {
    return [
      "No conviene confirmar esa compatibilidad solo por decir Chevy y Corsa.",
      "Aunque algunas piezas pueden cruzar entre aplicaciones, la bomba de agua debe validarse por año, motor, código o aplicación registrada.",
      "Pásame el año/motor de tu Chevy y, si tienes, el código de la bomba del Corsa para validarlo contra catálogo. Ventas confirma compatibilidad final.",
    ].join(" ");
  }
  const vehicleText = buildVehicleText(intent, sessionContext);
  const productText = Array.isArray(intent.terminos_producto_detectados) && intent.terminos_producto_detectados.length
    ? intent.terminos_producto_detectados[0]
    : "la pieza";

  if (vehicleText && Array.isArray(intent.terminos_producto_detectados) && intent.terminos_producto_detectados.length) {
    return [
      `Para explicar por qué ${productText.toLowerCase()} podría aplicar en ${vehicleText}, se revisa la aplicación registrada en catálogo: marca, modelo, año, motor y rango de años.`,
      "También se valida diseño físico, temperatura o especificación técnica, cruces de fabricante y código de la pieza.",
      "No lo confirmaría solo por nombre comercial; ventas debe validar compatibilidad final antes de cotizar.",
    ].join(" ");
  }

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