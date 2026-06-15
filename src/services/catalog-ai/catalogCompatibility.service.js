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

function findMatchingApplications(product = {}, intent = {}) {
  const apps = Array.isArray(product.aplicaciones) ? product.aplicaciones : [];

  if (!apps.length) return [];

  return apps.filter((app) => {
    const brandOk = !intent.marca_auto ||
      cleanString(app.marca_auto).toUpperCase().includes(cleanString(intent.marca_auto).toUpperCase());

    const modelOk = !intent.modelo_auto ||
      cleanString(app.modelo_auto).toUpperCase().includes(cleanString(intent.modelo_auto).toUpperCase());

    const motorOk = !intent.motor ||
      cleanString(app.motor).toUpperCase().includes(cleanString(intent.motor).toUpperCase());

    let yearOk = true;

    if (intent.anio) {
      const start = Number(app.anio_inicio || intent.anio);
      const end = Number(app.anio_fin || intent.anio);

      yearOk = Number(intent.anio) >= start && Number(intent.anio) <= end;
    }

    return brandOk && modelOk && motorOk && yearOk;
  });
}

function summarizeApplications(apps = []) {
  if (!apps.length) return "no encontré una aplicación exacta visible en el contexto enviado";

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
        app.version_auto,
      ]
        .filter(Boolean)
        .join(" ")
    )
    .filter(Boolean)
    .join("; ");
}

function summarizeAttributes(product = {}) {
  const attrs = Array.isArray(product.atributos) ? product.atributos : [];

  if (!attrs.length) return "sin atributos visibles";

  return attrs
    .slice(0, 6)
    .map((attr) => {
      const label = cleanString(attr.atributo || attr.atributo_normalizado);
      const value =
        attr.valor_numero !== undefined && attr.valor_numero !== null
          ? `${attr.valor_numero}${attr.unidad ? ` ${attr.unidad}` : ""}`
          : [attr.valor, attr.unidad].filter(Boolean).join(" ");

      return [label, value].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .join("; ");
}

export function buildCompatibilityEvidence({ products = [], intent = {} } = {}) {
  const top = products[0] || null;

  if (!top) {
    return {
      tipo: "COMPATIBILITY_EXPLANATION",
      producto: null,
      vehiculo_detectado: buildVehicleText(intent) || null,
      aplicaciones_coincidentes: [],
    };
  }

  const matchingApps = findMatchingApplications(top, intent);

  return {
    tipo: "COMPATIBILITY_EXPLANATION",
    producto: {
      producto_id: top.producto_id || top.id,
      codigo: productCode(top),
      descripcion: productTitle(top),
      familia: top.familia || null,
      categoria: top.categoria || null,
      compatibilidad_estimada: top.compatibilidad_estimada || null,
      razones_compatibilidad: top.razones_compatibilidad || [],
      atributos_resumen: summarizeAttributes(top),
      cruces: Array.isArray(top.cruces) ? top.cruces.slice(0, 5) : [],
    },
    vehiculo_detectado: buildVehicleText(intent) || null,
    aplicaciones_coincidentes: matchingApps.slice(0, 5),
    aplicaciones_resumen: summarizeApplications(matchingApps),
  };
}

export function buildCompatibilityExplanationLocalAnswer({ products = [], intent = {} } = {}) {
  const vehicleText = buildVehicleText(intent);

  if (!products.length) {
    return [
      "No encontré un producto real del catálogo para explicar compatibilidad.",
      vehicleText
        ? `Tengo como vehículo ${vehicleText}, pero falta una pieza o código concreto para validar.`
        : "Dime marca, modelo, año, motor y el código o pieza que quieres validar.",
      "Ventas debe confirmar compatibilidad y disponibilidad final.",
    ].join(" ");
  }

  const top = products[0];
  const matchingApps = findMatchingApplications(top, intent);
  const appText = summarizeApplications(matchingApps);
  const attrText = summarizeAttributes(top);

  if (!vehicleText) {
    return [
      `Encontré ${productCode(top)} - ${productTitle(top)}.`,
      "Puedo explicar mejor la compatibilidad si me das marca, modelo, año y motor del vehículo.",
      `Atributos visibles: ${attrText}.`,
      "Ventas valida compatibilidad y disponibilidad final.",
    ].join(" ");
  }

  return [
    `Para ${vehicleText}, la opción más fuerte encontrada es ${productCode(top)} - ${productTitle(top)}.`,
    `La compatibilidad estimada es ${top.compatibilidad_estimada || "N/D"}% por las coincidencias detectadas en catálogo.`,
    `Aplicación visible relacionada: ${appText}.`,
    `Atributos visibles: ${attrText}.`,
    "Esto es orientativo; ventas debe confirmar aplicación, medida, motor y disponibilidad final.",
  ].join(" ");
}