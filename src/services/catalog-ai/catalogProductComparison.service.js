function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function productCode(product = {}) {
  return cleanString(product.codigo_andyfers || product.codigo_importacion || `ID ${product.producto_id || product.id}`);
}

function productTitle(product = {}) {
  return cleanString(product.descripcion_web || product.descripcion || product.familia || "Producto sin descripción");
}

function formatPrice(product = {}) {
  const price = Number(product.precio_minimo);

  if (!Number.isFinite(price) || price <= 0) return null;

  return `$${price.toFixed(2)}`;
}

function summarizeApplications(product = {}) {
  const apps = Array.isArray(product.aplicaciones) ? product.aplicaciones : [];

  if (!apps.length) return "sin aplicaciones visibles en contexto";

  return apps
    .slice(0, 3)
    .map((app) =>
      [
        app.marca_auto,
        app.modelo_auto,
        app.motor,
        app.anio_inicio && app.anio_fin
          ? `${app.anio_inicio}-${app.anio_fin}`
          : app.anio_inicio || app.anio_fin,
      ]
        .filter(Boolean)
        .join(" ")
    )
    .filter(Boolean)
    .join("; ");
}

function summarizeAttributes(product = {}) {
  const attrs = Array.isArray(product.atributos) ? product.atributos : [];

  const useful = attrs
    .filter((attr) => {
      const key = cleanString(attr.atributo_normalizado || attr.atributo).toUpperCase();

      return [
        "DIAMETRO",
        "ANCHO",
        "ALTURA",
        "LARGO",
        "CANALES",
        "NUMERO_CANALES",
        "TEMPERATURA",
        "PSI",
        "PRESION",
        "MATERIAL",
        "TIPO",
      ].includes(key);
    })
    .slice(0, 5)
    .map((attr) => {
      const label = cleanString(attr.atributo || attr.atributo_normalizado);
      const value =
        attr.valor_numero !== undefined && attr.valor_numero !== null
          ? `${attr.valor_numero}${attr.unidad ? ` ${attr.unidad}` : ""}`
          : [attr.valor, attr.unidad].filter(Boolean).join(" ");

      return [label, value].filter(Boolean).join(": ");
    })
    .filter(Boolean);

  return useful.length ? useful.join("; ") : "sin atributos técnicos visibles en contexto";
}

function summarizeCrosses(product = {}) {
  const cruces = Array.isArray(product.cruces) ? product.cruces : [];

  if (!cruces.length) return "sin cruces visibles en contexto";

  return cruces
    .slice(0, 4)
    .map((cruce) => [cruce.marca, cruce.numero_parte].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");
}

function summarizeBrand(product = {}) {
  const marca = cleanString(product.marca_producto);
  const tipo = cleanString(product.tipo_marca_producto);
  const confirmada = Boolean(product.marca_producto_confirmada);

  if (!marca) return "marca/fabricante no confirmado en catálogo";

  return `${marca}${tipo ? ` (${tipo})` : ""}${confirmada ? "" : " por validar"}`;
}

export function buildProductComparisonEvidence({ products = [] } = {}) {
  return {
    tipo: "PRODUCT_COMPARISON",
    productos: products.slice(0, 4).map((product) => ({
      producto_id: product.producto_id || product.id,
      codigo: productCode(product),
      descripcion: productTitle(product),
      familia: product.familia || null,
      categoria: product.categoria || null,
      armadora: product.armadora || null,
      marca_producto: product.marca_producto || null,
      tipo_marca_producto: product.tipo_marca_producto || null,
      marca_producto_confirmada: Boolean(product.marca_producto_confirmada),
      precio_minimo: product.precio_minimo || null,
      stock_total_web: Number(product.stock_total_web || 0),
      compatibilidad_estimada: product.compatibilidad_estimada || null,
      razones_compatibilidad: product.razones_compatibilidad || [],
      aplicaciones_resumen: summarizeApplications(product),
      atributos_resumen: summarizeAttributes(product),
      cruces_resumen: summarizeCrosses(product),
    })),
  };
}

export function buildProductComparisonLocalAnswer({ products = [], intent = {} } = {}) {
  if (!products.length) {
    return [
      "No encontré productos reales suficientes en el catálogo para comparar.",
      "Para comparar bien necesito códigos, pieza exacta o datos del vehículo.",
      "Ventas valida compatibilidad y disponibilidad final.",
    ].join(" ");
  }

  if (products.length === 1) {
    const only = products[0];

    return [
      `Encontré una opción principal: ${productCode(only)} - ${productTitle(only)}.`,
      `En catálogo aparece como ${only.familia || only.categoria || "refacción"} y tiene compatibilidad estimada de ${only.compatibilidad_estimada || "N/D"}%.`,
      "Para comparar necesito otra opción, código o marca contra la cual revisarla.",
      "Ventas valida compatibilidad y disponibilidad final.",
    ].join(" ");
  }

  const first = products[0];
  const second = products[1];

  const firstPrice = formatPrice(first);
  const secondPrice = formatPrice(second);

  const priceText =
    firstPrice || secondPrice
      ? `Precio de referencia: ${productCode(first)} ${firstPrice || "sin precio visible"}; ${productCode(second)} ${secondPrice || "sin precio visible"}.`
      : "No tengo precio visible suficiente para comparar por costo.";

  const sameFamily =
    cleanString(first.familia).toUpperCase() &&
    cleanString(first.familia).toUpperCase() === cleanString(second.familia).toUpperCase();

  const familyText = sameFamily
    ? `Ambas opciones pertenecen a ${first.familia}.`
    : `No son exactamente la misma familia en catálogo: ${productCode(first)} aparece como ${first.familia || first.categoria || "N/D"} y ${productCode(second)} como ${second.familia || second.categoria || "N/D"}.`;

  return [
    `Comparé las dos opciones más fuertes del catálogo: ${productCode(first)} y ${productCode(second)}.`,
    familyText,
    `La primera tiene compatibilidad estimada de ${first.compatibilidad_estimada || "N/D"}% y la segunda de ${second.compatibilidad_estimada || "N/D"}%.`,
    priceText,
    "La diferencia real debe validarse con aplicación, motor, medida y cruces antes de cotizar; ventas confirma compatibilidad y disponibilidad final.",
  ].join(" ");
}

function buildCrossVehicleText(vehicle = {}) {
  return [
    vehicle.marca,
    vehicle.modelo,
    vehicle.anio,
    vehicle.motor,
  ]
    .filter(Boolean)
    .join(" ");
}

function getCrossApplicationData(intent = {}) {
  return intent.comparacion_aplicacion || {};
}

export function buildCrossApplicationComparisonEvidence({
  products = [],
  intent = {},
} = {}) {
  const crossData = getCrossApplicationData(intent);

  return {
    tipo: "CROSS_APPLICATION_COMPARISON",
    regla_seguridad:
      "No confirmar compatibilidad final si no hay coincidencia de aplicación, código, motor, años o cruce registrado.",
    pregunta:
      "El cliente pregunta si puede usar una pieza de un vehículo donante en su vehículo.",
    pieza_detectada: crossData.pieza || intent.terminos_producto_detectados || [],
    vehiculo_objetivo: crossData.vehiculo_objetivo || {
      marca: intent.marca_auto,
      modelo: intent.modelo_auto,
      anio: intent.anio,
      motor: intent.motor,
    },
    vehiculo_donante: crossData.vehiculo_donante || null,
    productos_encontrados: products.slice(0, 4).map((product) => ({
      codigo: product.codigo_andyfers || product.codigo_importacion,
      descripcion: product.descripcion_web || product.descripcion,
      familia: product.familia || product.categoria,
      compatibilidad_estimada: product.compatibilidad_estimada,
      aplicaciones: Array.isArray(product.aplicaciones)
        ? product.aplicaciones.slice(0, 4)
        : [],
      cruces: Array.isArray(product.cruces)
        ? product.cruces.slice(0, 4)
        : [],
    })),
    instruccion_respuesta:
      "Responder como asesor: explicar que puede haber cruces, pero no confirmar que sí queda. Pedir año/motor/código o muestra física. Máximo 4 oraciones.",
  };
}

export function buildCrossApplicationComparisonLocalAnswer({
  products = [],
  intent = {},
} = {}) {
  const crossData = getCrossApplicationData(intent);
  const targetText = buildCrossVehicleText(crossData.vehiculo_objetivo || {
    marca: intent.marca_auto,
    modelo: intent.modelo_auto,
    anio: intent.anio,
    motor: intent.motor,
  });

  const donorText = buildCrossVehicleText(crossData.vehiculo_donante || {});
  const partText =
    Array.isArray(crossData.pieza) && crossData.pieza.length
      ? crossData.pieza.join(", ")
      : "la pieza";

  const foundText = products.length
    ? "Voy a comparar contra las opciones encontradas en catálogo, pero la validación final depende de aplicación, años, motor y cruces."
    : "No encontré una coincidencia suficiente en catálogo para confirmarlo automáticamente.";

  return [
    `Lo tomaría como comparación de aplicación: ${partText} de ${donorText || "otro vehículo"} contra ${targetText || "tu vehículo"}.`,
    "No conviene confirmar que sí queda solo por nombre comercial; Chevy y Corsa pueden compartir algunas referencias, pero depende de año, motor, código y aplicación registrada.",
    foundText,
    "Pásame año/motor del Chevy o el código de la bomba del Corsa para validarlo mejor; ventas confirma compatibilidad final.",
  ].join(" ");
}