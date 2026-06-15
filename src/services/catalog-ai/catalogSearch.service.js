import { pool } from "../../config/db.js";
import { normalizeText } from "../../utils/normalize.js";
import { isValidPublicCode } from "./catalogUtils.service.js";

export function buildCandidateWhere(intent) {
  const conditions = [
    "p.activo = 1",
    "p.activo_web = 1",
    `
    (
      (p.codigo_andyfers IS NOT NULL AND TRIM(p.codigo_andyfers) <> '')
      OR
      (p.codigo_importacion IS NOT NULL AND TRIM(p.codigo_importacion) <> '')
    )
    `,
  ];

  const params = [];

  const codeConditions = [];
  const productConditions = [];
  const vehicleConditions = [];

  const hasCodes =
    Array.isArray(intent.numero_parte_tokens) &&
    intent.numero_parte_tokens.length > 0;

  const productTokens = Array.isArray(intent.product_query_tokens)
    ? intent.product_query_tokens
    : [];
  const strictProductFamilyTokens = Array.isArray(intent.strict_product_family_tokens)
    ? intent.strict_product_family_tokens
    : [];
  const measurementFilters = Array.isArray(intent.medidas_detectadas)
    ? intent.medidas_detectadas
    : [];

  /**
   * 1) CÓDIGOS
   * Si el usuario busca código, permitimos búsqueda directa por código/cruces.
   */
  for (const code of intent.numero_parte_tokens || []) {
    codeConditions.push("p.codigo_andyfers_normalizado LIKE ?");
    params.push(`%${code}%`);

    codeConditions.push(
      "REPLACE(REPLACE(REPLACE(UPPER(COALESCE(p.codigo_importacion, '')), '-', ''), '.', ''), ' ', '') LIKE ?"
    );
    params.push(`%${code}%`);

    codeConditions.push("pc.numero_parte_normalizado LIKE ?");
    params.push(`%${code}%`);
  }

  if (strictProductFamilyTokens.length > 0) {
    for (const token of strictProductFamilyTokens) {
      const like = `%${token}%`;

      // Búsqueda fuerte: familia/categoría.
      // Esto evita que "TUBO ... A BOMBA DE AGUA" gane como si fuera bomba.
      productConditions.push("UPPER(COALESCE(p.familia, '')) LIKE ?");
      params.push(like);

      productConditions.push("UPPER(COALESCE(c.nombre, '')) LIKE ?");
      params.push(like);
    }
  } else {
    for (const token of productTokens) {
      const like = `%${token}%`;

      productConditions.push("UPPER(COALESCE(p.descripcion, '')) LIKE ?");
      params.push(like);

      productConditions.push("UPPER(COALESCE(p.descripcion_web, '')) LIKE ?");
      params.push(like);

      productConditions.push("UPPER(COALESCE(p.familia, '')) LIKE ?");
      params.push(like);

      productConditions.push("UPPER(COALESCE(c.nombre, '')) LIKE ?");
      params.push(like);

      productConditions.push("UPPER(COALESCE(pat.valor_texto, '')) LIKE ?");
      params.push(like);
    }
  }

  /**
   * 3) VEHÍCULO
   * Marca/modelo/año/motor se aplican como filtro adicional, no como OR general.
   */
  if (intent.marca_auto) {
    vehicleConditions.push("UPPER(COALESCE(pa.marca_auto, '')) LIKE ?");
    params.push(`%${normalizeText(intent.marca_auto)}%`);
  }

  if (intent.modelo_auto) {
    vehicleConditions.push("UPPER(COALESCE(pa.modelo_auto, '')) LIKE ?");
    params.push(`%${normalizeText(intent.modelo_auto)}%`);
  }

  if (intent.motor) {
    vehicleConditions.push("UPPER(COALESCE(pa.motor, '')) LIKE ?");
    params.push(`%${normalizeText(intent.motor)}%`);
  }

  if (intent.anio) {
    vehicleConditions.push(
      "(? BETWEEN COALESCE(pa.anio_inicio, ?) AND COALESCE(pa.anio_fin, ?))"
    );
    params.push(intent.anio, intent.anio, intent.anio);
  }

  for (const measurement of measurementFilters) {
    const value = Number(measurement.valor_numero);
    const tolerance = Number.isFinite(Number(measurement.tolerancia))
      ? Number(measurement.tolerancia)
      : 0;

    if (!Number.isFinite(value) || !measurement.atributo_normalizado) continue;

    conditions.push(`
      EXISTS (
        SELECT 1
        FROM producto_atributos pam
        WHERE pam.producto_id = p.id
          AND pam.buscable = 1
          AND pam.atributo_normalizado = ?
          AND pam.valor_numero BETWEEN ? AND ?
      )
    `);

    params.push(
      normalizeText(measurement.atributo_normalizado),
      value - tolerance,
      value + tolerance
    );
  }

  /**
   * Si hay código, ese grupo basta para buscar.
   * Si no hay código, debe existir pieza/familia/síntoma/producto.
   */
  if (hasCodes) {
    conditions.push(`(${codeConditions.join(" OR ")})`);
  } else if (productConditions.length > 0) {
    conditions.push(`(${productConditions.join(" OR ")})`);
  }

  /**
   * El vehículo afina resultados, no reemplaza la pieza.
   */
  if (vehicleConditions.length > 0) {
    conditions.push(`(${vehicleConditions.join(" AND ")})`);
  }

  const excludedVehicleTokens = Array.isArray(intent.excluded_vehicle_tokens)
    ? intent.excluded_vehicle_tokens
    : Array.isArray(intent.excluded_tokens)
      ? intent.excluded_tokens
      : [];

  if (excludedVehicleTokens.length) {
    for (const excluded of excludedVehicleTokens) {
      const normalizedExcluded = normalizeText(excluded);
      const likeExcluded = `%${normalizedExcluded}%`;

      conditions.push(`
      NOT EXISTS (
        SELECT 1
        FROM producto_aplicaciones pax
        WHERE pax.producto_id = p.id
          AND (
            UPPER(COALESCE(pax.marca_auto, '')) LIKE ?
            OR UPPER(COALESCE(pax.modelo_auto, '')) LIKE ?
          )
      )
    `);

      params.push(likeExcluded);
      params.push(likeExcluded);

      conditions.push("UPPER(COALESCE(p.descripcion, '')) NOT LIKE ?");
      params.push(likeExcluded);

      conditions.push("UPPER(COALESCE(p.descripcion_web, '')) NOT LIKE ?");
      params.push(likeExcluded);

      conditions.push("UPPER(COALESCE(p.armadora, '')) NOT LIKE ?");
      params.push(likeExcluded);

      conditions.push("UPPER(COALESCE(c.nombre, '')) NOT LIKE ?");
      params.push(likeExcluded);
    }
  }

  return {
    whereSql: conditions.join(" AND "),
    params,
  };
}

export async function searchCandidates(intent) {
  const { whereSql, params } = buildCandidateWhere(intent);

  const [rows] = await pool.query(
    `
    SELECT
      p.id,
      p.codigo_andyfers,
      p.codigo_importacion,
      p.imagen_url,
      c.nombre AS categoria,
      p.armadora,
      p.familia,
      p.descripcion,
      p.descripcion_web,
      p.marca_producto,
      p.tipo_marca_producto,
      p.marca_producto_confirmado,
      p.prioridad_ia,
      COALESCE(SUM(CASE WHEN i.disponible_web = 1 THEN i.stock ELSE 0 END), 0) AS stock_total_web,
      MIN(CASE WHEN i.disponible_web = 1 THEN i.precio ELSE NULL END) AS precio_minimo,
      COUNT(DISTINCT pc.id) AS total_cruces
    FROM productos p
    JOIN categorias c ON c.id = p.categoria_id
    LEFT JOIN inventario i ON i.producto_id = p.id
    LEFT JOIN producto_cruces pc ON pc.producto_id = p.id
    LEFT JOIN producto_aplicaciones pa ON pa.producto_id = p.id
    LEFT JOIN producto_atributos pat ON pat.producto_id = p.id AND pat.buscable = 1
    WHERE ${whereSql}
    GROUP BY
      p.id,
      p.codigo_andyfers,
      p.codigo_importacion,
      p.imagen_url,
      c.nombre,
      p.armadora,
      p.familia,
      p.descripcion,
      p.descripcion_web,
      p.marca_producto,
      p.tipo_marca_producto,
      p.marca_producto_confirmado,
      p.prioridad_ia
    ORDER BY p.prioridad_ia DESC, p.id ASC
    LIMIT 80
    `,
    params
  );

  return rows.filter(
    (row) =>
      isValidPublicCode(row.codigo_andyfers) ||
      isValidPublicCode(row.codigo_importacion)
  );
}

export async function getCandidateDetails(productIds) {
  if (!productIds.length) {
    return {
      aplicacionesByProduct: new Map(),
      crucesByProduct: new Map(),
      atributosByProduct: new Map(),
    };
  }

  const placeholders = productIds.map(() => "?").join(", ");

  const [aplicaciones] = await pool.query(
    `
    SELECT producto_id, marca_auto, modelo_auto, motor, anio_inicio, anio_fin, version_auto
    FROM producto_aplicaciones
    WHERE producto_id IN (${placeholders})
    ORDER BY producto_id, marca_auto, modelo_auto, anio_inicio
    `,
    productIds
  );

  const [cruces] = await pool.query(
    `
    SELECT pc.producto_id, mc.nombre AS marca, pc.numero_parte, pc.numero_parte_normalizado
    FROM producto_cruces pc
    JOIN marcas_cruce mc ON mc.id = pc.marca_id
    WHERE pc.producto_id IN (${placeholders})
    ORDER BY pc.producto_id, mc.nombre, pc.numero_parte
    `,
    productIds
  );

  const [atributos] = await pool.query(
    `
    SELECT producto_id, atributo, atributo_normalizado, valor_texto, valor_normalizado, valor_numero, unidad
    FROM producto_atributos
    WHERE producto_id IN (${placeholders}) AND buscable = 1
    ORDER BY producto_id, orden, atributo
    `,
    productIds
  );

  const groupByProduct = (rows) => {
    const grouped = new Map();

    for (const row of rows) {
      if (!grouped.has(row.producto_id)) grouped.set(row.producto_id, []);
      grouped.get(row.producto_id).push(row);
    }

    return grouped;
  };

  return {
    aplicacionesByProduct: groupByProduct(aplicaciones),
    crucesByProduct: groupByProduct(cruces),
    atributosByProduct: groupByProduct(atributos),
  };
}

