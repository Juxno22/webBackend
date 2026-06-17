import { describeMeasurementFilters } from "./catalogMeasurements.service.js";
import { cleanString } from "./catalogUtils.service.js";

function normalizeCatalogText(value) {
  return cleanString(value)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function hasIntentTerm(intent = {}, pattern) {
  const values = [
    intent.pregunta_normalizada,
    ...(Array.isArray(intent.terminos_producto_detectados)
      ? intent.terminos_producto_detectados
      : []),
    ...(Array.isArray(intent.product_query_tokens)
      ? intent.product_query_tokens
      : []),
    ...(Array.isArray(intent.strict_product_family_tokens)
      ? intent.strict_product_family_tokens
      : []),
  ];

  return values.some((value) => pattern.test(normalizeCatalogText(value)));
}

function buildVehicleText(intent = {}) {
  return [
    intent.marca_auto,
    intent.modelo_auto,
    intent.anio,
    intent.motor,
  ]
    .filter(Boolean)
    .join(" ");
}

function requestedRadiatorCap(intent = {}) {
  const text = normalizeCatalogText(
    [
      intent.pregunta_normalizada,
      ...(intent.terminos_producto_detectados || []),
      ...(intent.product_query_tokens || []),
      ...(intent.strict_product_family_tokens || []),
    ].join(" ")
  );

  return (
    /\bTAPON\b/.test(text) &&
    (
      /\bRADIADOR\b/.test(text) ||
      /\bTAPON\s+RADIADOR\b/.test(text)
    )
  );
}

function productIsDepositWithCap(product = {}) {
  const text = normalizeCatalogText(
    [
      product.descripcion,
      product.descripcion_web,
      product.familia,
      product.categoria,
    ].join(" ")
  );

  return /\bDEPOSITO\b/.test(text) && /\bTAPON\b/.test(text);
}

function requestedUpperHose(intent = {}) {
  return (
    hasIntentTerm(intent, /\bMANGUERA\b/) &&
    Array.isArray(intent.posiciones_detectadas) &&
    intent.posiciones_detectadas.includes("SUPERIOR")
  );
}

function requestedRadiator(intent = {}) {
  return hasIntentTerm(intent, /\bRADIADOR\b/);
}

function buildApproxYearText(intent = {}) {
  if (
    !intent.anio_aproximado ||
    !Array.isArray(intent.anios_posibles) ||
    !intent.anios_posibles.length
  ) {
    return "";
  }

  return `Tomé como referencia ${intent.anios_posibles.join(" o ")} porque el año viene aproximado.`;
}

function buildNoResultsAnswer(intent) {
  const vehicleText = buildVehicleText(intent);

  if (requestedRadiator(intent)) {
    return [
      vehicleText
        ? `No encontré radiadores cargados o coincidencias visibles en catálogo para ${vehicleText}.`
        : "No encontré radiadores cargados o coincidencias visibles en catálogo con los datos escritos.",
      "Los datos del vehículo sí se detectaron; por ahora esa familia puede no estar cargada en la base o no tiene aplicación visible.",
      "Ventas puede validarlo manualmente con código, medida, muestra física o foto de la pieza.",
    ].join(" ");
  }

  if (requestedUpperHose(intent)) {
    return [
      vehicleText
        ? `No encontré una coincidencia confiable para manguera superior de ${vehicleText}.`
        : "No encontré una coincidencia confiable para manguera superior con los datos escritos.",
      "Para validar mejor, dime solo el año del vehículo.",
      "Si no tienes el año, ventas puede revisarlo con foto o muestra física.",
    ].join(" ");
  }

  const suggestions = [];

  if (intent.numero_parte_tokens.length) {
    suggestions.push("El código podría no estar registrado o puede tener una variación.");
  }

  if (intent.marca_auto || intent.modelo_auto || intent.anio || intent.motor) {
    suggestions.push("Los datos del vehículo se detectaron, pero no hubo coincidencia visible en catálogo.");
  }

  if (Array.isArray(intent.medidas_detectadas) && intent.medidas_detectadas.length) {
    suggestions.push(
      `Detecté medidas técnicas, pero no encontré una coincidencia confiable.`
    );
  }

  if (intent.terminos_producto_detectados.length) {
    suggestions.push(
      `Detecté la pieza "${intent.terminos_producto_detectados.join(", ")}", pero no encontré una coincidencia confiable.`
    );
  }

  if (!suggestions.length) {
    suggestions.push("Agrega marca, modelo, año, motor o número de parte para mejorar la búsqueda.");
  }

  return [
    "No encontré una coincidencia confiable en el catálogo con los datos escritos.",
    ...suggestions,
    "Un asesor puede ayudarte a validarlo manualmente.",
  ].join(" ");
}

export function buildLocalAnswer({ intent, products }) {
  if (!products.length) {
    return buildNoResultsAnswer(intent);
  }

  const top = products[0];

  if (requestedRadiatorCap(intent) && productIsDepositWithCap(top)) {
    const vehicleText = buildVehicleText(intent);
    const approxYearText = buildApproxYearText(intent);

    return [
      vehicleText
        ? `Con la información detectada para ${vehicleText}, encontré una opción relacionada.`
        : "Encontré una opción relacionada en catálogo.",
      `${top.codigo_andyfers || top.codigo_importacion}: ${top.descripcion}.`,
      "Ojo: este resultado corresponde a depósito de anticongelante con tapón; no lo tomaría automáticamente como tapón de radiador suelto.",
      approxYearText,
      "Si buscas solo el tapón, ventas debe validarlo por presión, medida, código o muestra física antes de confirmar.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const measurementText =
    Array.isArray(intent.medidas_detectadas) && intent.medidas_detectadas.length
      ? describeMeasurementFilters(intent.medidas_detectadas)
      : "";

  const relaxedMeasurementSearch = intent.busqueda_medidas_relajada || null;

  const relaxedMeasurementText = (() => {
    if (!relaxedMeasurementSearch?.activa) return "";

    const filteredMeasurementText = relaxedMeasurementSearch.medida_filtrada
      ? describeMeasurementFilters([relaxedMeasurementSearch.medida_filtrada])
      : "";

    if (relaxedMeasurementSearch.motivo === "PRODUCT_ONLY_WITHOUT_MEASUREMENT_FILTERS") {
      return "No encontré coincidencia exacta con todas las medidas; abrí la búsqueda por pieza y vehículo sin usar las medidas como filtro duro.";
    }

    if (
      relaxedMeasurementSearch.motivo ===
      "PRODUCT_ONLY_WITHOUT_MEASUREMENTS_OR_VEHICLE_FILTER"
    ) {
      return "No encontré coincidencia exacta con todas las medidas ni con la aplicación vehicular; abrí la búsqueda solo por pieza para mostrar opciones orientativas del catálogo.";
    }

    if (relaxedMeasurementSearch.vehiculo_relajado) {
      return `No encontré coincidencia exacta con todas las medidas y aplicación vehicular; abrí la búsqueda por medida principal${filteredMeasurementText ? ` (${filteredMeasurementText})` : ""} sin usar el vehículo como filtro duro.`;
    }

    return `No encontré coincidencia exacta con todas las medidas; abrí la búsqueda por medida principal${filteredMeasurementText ? ` (${filteredMeasurementText})` : ""}.`;
  })();

  const conditionText = Array.isArray(intent.condiciones_detectadas)
    ? intent.condiciones_detectadas.map((item) => item.label).join(" ")
    : "";

  const preferenceText = intent.preferencias_comerciales?.economica
    ? "Ordené las opciones dando prioridad a productos con precio registrado más bajo."
    : "";

  const productBrandExclusionText =
    Array.isArray(intent.excluded_product_brand_tokens) &&
      intent.excluded_product_brand_tokens.length
      ? "Tomé en cuenta que buscas una alternativa o una opción no original. La marca/fabricante final de la pieza debe validarla ventas."
      : "";

  if (intent.modo_busqueda === "EXPLORATORY") {
    const exclusionText =
      Array.isArray(intent.excluded_tokens) && intent.excluded_tokens.length
        ? ` que no corresponden a ${intent.excluded_tokens.join(", ")}`
        : "";

    return [
      `Encontré ${products.length} opción(es) del catálogo${exclusionText}.`,
      `La primera opción es ${top.codigo_andyfers || top.codigo_importacion}: ${top.descripcion}.`,
      preferenceText,
      conditionText ? `Nota: ${conditionText}` : "",
      "Para confirmar cuál aplica a tu vehículo, dime marca, modelo, año y motor. Ventas valida compatibilidad y disponibilidad final.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const vehicleParts = [
    intent.marca_auto,
    intent.modelo_auto,
    intent.anio,
    intent.motor,
  ]
    .filter(Boolean)
    .join(" ");

  const symptomText = Array.isArray(intent.sintomas_detectados)
    ? intent.sintomas_detectados
      .filter((item) => item.searchable)
      .map((item) => item.label)
      .join(", ")
    : "";

  const introParts = [];

  if (vehicleParts) {
    introParts.push(`Con la información detectada para ${vehicleParts}`);
  } else {
    introParts.push("Con la información escrita");
  }

  if (symptomText) {
    introParts.push(`y el síntoma de ${symptomText}`);
  }

  const intro = `${introParts.join(" ")} encontré ${products.length} opción(es) posibles en el catálogo Andyfers.`;

  return [
    intro,
    relaxedMeasurementText,
    `La opción más fuerte es ${top.codigo_andyfers || top.codigo_importacion}: ${top.descripcion}.`,
    measurementText ? `Tomé como referencia técnica: ${measurementText}.` : "",
    `Compatibilidad estimada: ${top.compatibilidad_estimada}%.`,
    conditionText ? `Nota: ${conditionText}` : "",
    preferenceText,
    productBrandExclusionText,
    "Esta recomendación es orientativa. Ventas debe validar compatibilidad, medidas físicas y disponibilidad final antes de confirmar la cotización.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildAiMessages({ question, intent, products }) {
  const contextProducts = products.slice(0, 5).map((product) => ({
    producto_id: product.id,
    codigo_andyfers: product.codigo_andyfers,
    codigo_importacion: product.codigo_importacion,
    descripcion: product.descripcion,
    familia: product.familia,
    armadora: product.armadora,
    categoria: product.categoria,
    compatibilidad_estimada: product.compatibilidad_estimada,
    razones_compatibilidad: product.razones_compatibilidad,
    aplicaciones: product.aplicaciones,
    cruces: product.cruces,
    atributos: product.atributos,
  }));

  return [
    {
      role: "system",
      content: [
        "Eres el asistente de refacciones de Andyfers.",
        "Responde únicamente usando los productos enviados en CONTEXTO.",
        "No inventes códigos, compatibilidades, precios ni stock.",
        "Nunca confirmes compatibilidad de forma definitiva.",
        "Evita frases como: es compatible, sí es compatible, le queda, queda perfecto, sirve seguro.",
        "Usa frases seguras como: puede aplicar, opción relacionada, coincidencia orientativa, se debe validar por año/motor/código/medida.",
        "Si el producto encontrado no es exactamente la pieza solicitada, acláralo.",
        "Siempre aclara que ventas valida compatibilidad y disponibilidad final.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          pregunta_cliente: question,
          intencion_detectada: intent,
          contexto_productos: contextProducts,
        },
        null,
        2
      ),
    },
  ];
}

