import { Router } from "express";
import { pool } from "../config/db.js";
import {
  normalizePartNumber,
  normalizeText,
  normalizeSearchQuery,
  extractSearchNumbers,
  getSearchTokens,
  parsePositiveInt,
  clampNumber,
} from "../utils/normalize.js";
import {
  buildApplicationMotorExactSql,
  buildApplicationMotorLabelSql,
  buildApplicationMotorTextSearchSql,
  normalizeMotorSearchValue,
} from "../utils/applicationMotor.js";

const router = Router();

function buildValidPublicCodeCondition(alias = "p") {
  const invalidValues = `
    '#N/A',
    'N/A',
    'NA',
    'ND',
    'N.D.',
    'SIN CODIGO',
    'SIN CÓDIGO',
    'NULL',
    '0'
  `;

  return `
    (
      (
        ${alias}.codigo_andyfers IS NOT NULL
        AND TRIM(${alias}.codigo_andyfers) <> ''
        AND UPPER(TRIM(${alias}.codigo_andyfers)) NOT IN (${invalidValues})
      )
      OR
      (
        ${alias}.codigo_importacion IS NOT NULL
        AND TRIM(${alias}.codigo_importacion) <> ''
        AND UPPER(TRIM(${alias}.codigo_importacion)) NOT IN (${invalidValues})
      )
    )
  `;
}

function buildVisibleProductCodeSql(alias = "p") {
  const invalidValues = `
    '#N/A',
    'N/A',
    'NA',
    'ND',
    'N.D.',
    'SIN CODIGO',
    'SIN CÓDIGO',
    'NULL',
    '0'
  `;

  return `
    COALESCE(
      CASE
        WHEN ${alias}.codigo_andyfers IS NOT NULL
          AND TRIM(${alias}.codigo_andyfers) <> ''
          AND UPPER(TRIM(${alias}.codigo_andyfers)) NOT IN (${invalidValues})
        THEN TRIM(${alias}.codigo_andyfers)
      END,
      CASE
        WHEN ${alias}.codigo_importacion IS NOT NULL
          AND TRIM(${alias}.codigo_importacion) <> ''
          AND UPPER(TRIM(${alias}.codigo_importacion)) NOT IN (${invalidValues})
        THEN TRIM(${alias}.codigo_importacion)
      END
    )
  `;
}

function buildProductoMultimediaSelectSql(alias = "p") {
  return `
    (
      SELECT pm.thumbnail_url
      FROM producto_multimedia pm
      WHERE pm.producto_id = ${alias}.id
        AND pm.tipo = 'IMAGEN'
        AND pm.activo = 1
      ORDER BY
        CASE pm.rol
          WHEN 'PRINCIPAL' THEN 0
          WHEN 'GALERIA' THEN 1
          ELSE 2
        END,
        pm.orden ASC,
        pm.id ASC
      LIMIT 1
    ) AS imagen_thumbnail_url,

    (
      SELECT pm.secure_url
      FROM producto_multimedia pm
      WHERE pm.producto_id = ${alias}.id
        AND pm.tipo = 'IMAGEN'
        AND pm.activo = 1
      ORDER BY
        CASE pm.rol
          WHEN 'PRINCIPAL' THEN 0
          WHEN 'GALERIA' THEN 1
          ELSE 2
        END,
        pm.orden ASC,
        pm.id ASC
      LIMIT 1
    ) AS imagen_url,

    (
      SELECT COUNT(*)
      FROM producto_multimedia pm
      WHERE pm.producto_id = ${alias}.id
        AND pm.tipo = 'IMAGEN'
        AND pm.activo = 1
    ) AS total_imagenes
  `;
}

function cleanQueryValue(value) {
  if (value === undefined || value === null) return "";

  return String(value).trim();
};

function buildProductSeoVehicleSelectSql(alias = "p") {
  return `
    (
      SELECT pa.anio_inicio
      FROM producto_aplicaciones pa
      WHERE pa.producto_id = ${alias}.id
        AND pa.anio_inicio IS NOT NULL
      ORDER BY
        pa.confianza_extraccion DESC,
        pa.anio_inicio DESC,
        pa.id ASC
      LIMIT 1
    ) AS seo_anio,

    (
      SELECT pa.marca_auto
      FROM producto_aplicaciones pa
      WHERE pa.producto_id = ${alias}.id
        AND pa.marca_auto IS NOT NULL
        AND TRIM(pa.marca_auto) <> ''
      ORDER BY
        pa.confianza_extraccion DESC,
        pa.anio_inicio DESC,
        pa.id ASC
      LIMIT 1
    ) AS seo_marca_auto,

    (
      SELECT pa.modelo_auto
      FROM producto_aplicaciones pa
      WHERE pa.producto_id = ${alias}.id
        AND pa.modelo_auto IS NOT NULL
        AND TRIM(pa.modelo_auto) <> ''
      ORDER BY
        pa.confianza_extraccion DESC,
        pa.anio_inicio DESC,
        pa.id ASC
      LIMIT 1
    ) AS seo_modelo_auto,

    (
      SELECT pa.motor
      FROM producto_aplicaciones pa
      WHERE pa.producto_id = ${alias}.id
        AND (
          pa.motor IS NOT NULL
          OR pa.cilindraje IS NOT NULL
          OR pa.motor_detalle IS NOT NULL
          OR pa.motor_original IS NOT NULL
        )
      ORDER BY
        pa.confianza_extraccion DESC,
        pa.anio_inicio DESC,
        pa.id ASC
      LIMIT 1
    ) AS seo_motor,

    ${alias}.familia AS seo_linea
  `;
}

function getCatalogEcommerceSucursalClave() {
  return String(process.env.ECOMMERCE_SUCURSAL_CLAVE || "ECOMMERCE").trim();
}

function buildEcommerceInventorySelectSql() {
  return `
    COALESCE(
      MAX(CASE WHEN i.disponible_web = 1 THEN i.stock ELSE 0 END),
      0
    ) AS stock_total_web,

    MAX(CASE WHEN i.disponible_web = 1 THEN i.precio ELSE NULL END) AS precio_interno_web,
    MAX(CASE WHEN i.disponible_web = 1 THEN i.precio_publico ELSE NULL END) AS precio_minimo,
    MAX(CASE WHEN i.disponible_web = 1 THEN i.precio_publico ELSE NULL END) AS precio_venta_web,

    MAX(CASE WHEN i.disponible_web = 1 THEN i.mostrar_precio ELSE 0 END) AS mostrar_precio_web,

    MAX(
      CASE
        WHEN i.disponible_web = 1
          AND COALESCE(i.stock, 0) > 0
          AND COALESCE(i.precio_publico, 0) > 0
        THEN 1
        ELSE 0
      END
    ) AS venta_web_habilitada
  `;
}

function buildProductWhere(query) {
  const conditions = ["p.activo = 1", "p.activo_web = 1"];
  conditions.push(buildValidPublicCodeCondition("p"));
  const params = [];

  if (query.categoria) {
    conditions.push("c.nombre = ?");
    params.push(query.categoria);
  }

  if (query.familia) {
    conditions.push("p.familia = ?");
    params.push(query.familia);
  }

  if (query.linea) {
    conditions.push("p.familia = ?");
    params.push(query.linea);
  }

  if (query.armadora) {
    conditions.push("p.armadora = ?");
    params.push(query.armadora);
  }

  if (String(query.nuevo || "") === "1") {
    conditions.push("p.nuevo_web = 1");
  }

  if (query.q) {
    const q = String(query.q).trim();
    const terms = getSearchTokens(q);
    const searchNumbers = extractSearchNumbers(q);

    const termClauses = [];

    for (const term of terms) {
      const normalizedTerm = normalizeSearchQuery(term);
      const normalizedPart = normalizePartNumber(term);

      const likeOriginal = `%${term}%`;
      const likeNormalized = `%${normalizedTerm}%`;
      const likePart = `%${normalizedPart}%`;

      termClauses.push(`
      (
        p.codigo_andyfers LIKE ?
        OR p.codigo_andyfers_normalizado LIKE ?
        OR p.codigo_importacion LIKE ?
        OR p.armadora LIKE ?
        OR p.familia LIKE ?
        OR p.familia LIKE ?
        OR p.descripcion LIKE ?
        OR p.descripcion LIKE ?
        OR c.nombre LIKE ?
        OR c.nombre LIKE ?

        OR EXISTS (
          SELECT 1
          FROM producto_cruces pc
          JOIN marcas_cruce mc ON mc.id = pc.marca_id
          WHERE pc.producto_id = p.id
            AND (
              pc.numero_parte LIKE ?
              OR pc.numero_parte_normalizado LIKE ?
              OR mc.nombre LIKE ?
            )
        )

        OR EXISTS (
          SELECT 1
          FROM producto_aplicaciones pa
          WHERE pa.producto_id = p.id
            AND (
              pa.marca_auto LIKE ?
              OR pa.modelo_auto LIKE ?
              OR ${buildApplicationMotorTextSearchSql("pa")}
              OR pa.version_auto LIKE ?
              OR pa.notas LIKE ?
            )
        )

        OR EXISTS (
          SELECT 1
          FROM producto_atributos pat
          WHERE pat.producto_id = p.id
            AND pat.buscable = 1
            AND (
              pat.atributo LIKE ?
              OR pat.atributo_normalizado LIKE ?
              OR pat.valor_texto LIKE ?
              OR pat.valor_normalizado LIKE ?
              OR CONCAT(
                pat.atributo_normalizado,
                ' ',
                pat.valor_normalizado,
                ' ',
                COALESCE(pat.unidad, '')
              ) LIKE ?
            )
        )

        OR EXISTS (
          SELECT 1
          FROM sinonimos_busqueda sb
          WHERE (
            sb.texto_usuario LIKE ?
            OR sb.texto_normalizado LIKE ?
          )
          AND (
            p.armadora = sb.texto_normalizado
            OR p.familia = sb.texto_normalizado
            OR p.descripcion LIKE CONCAT('%', sb.texto_normalizado, '%')
          )
        )
      )
    `);

      params.push(
        // productos / categoría
        likeOriginal,   // p.codigo_andyfers
        likePart,       // p.codigo_andyfers_normalizado
        likeOriginal,   // p.codigo_importacion
        likeOriginal,   // p.armadora
        likeOriginal,   // p.familia
        likeNormalized, // p.familia
        likeOriginal,   // p.descripcion
        likeNormalized, // p.descripcion
        likeOriginal,   // c.nombre
        likeNormalized, // c.nombre

        // cruces
        likeOriginal,   // pc.numero_parte
        likePart,       // pc.numero_parte_normalizado
        likeOriginal,   // mc.nombre

        // aplicaciones
        likeOriginal,   // pa.marca_auto
        likeOriginal,   // pa.modelo_auto
        likeOriginal,   // pa.motor
        likeOriginal,   // pa.cilindraje
        likeOriginal,   // pa.motor_detalle
        likeOriginal,   // pa.motor_original
        likeOriginal,   // motor_label
        likeOriginal,   // pa.version_auto
        likeOriginal,   // pa.notas

        // atributos
        likeOriginal,   // pat.atributo
        likeNormalized, // pat.atributo_normalizado
        likeOriginal,   // pat.valor_texto
        likeNormalized, // pat.valor_normalizado
        likeNormalized, // CONCAT(...)

        // sinónimos
        likeOriginal,   // sb.texto_usuario
        likeNormalized  // sb.texto_normalizado
      );
    }

    const numberClauses = [];

    for (const number of searchNumbers) {
      numberClauses.push(`
      EXISTS (
        SELECT 1
        FROM producto_atributos pat_num
        WHERE pat_num.producto_id = p.id
          AND pat_num.buscable = 1
          AND pat_num.valor_numero BETWEEN ? AND ?
      )
    `);

      params.push(number - 0.5, number + 0.5);
    }

    const searchClauses = [...termClauses, ...numberClauses];

    if (searchClauses.length > 0) {
      conditions.push(`
      (
        ${searchClauses.join(" OR ")}
      )
    `);
    }
  }

  const hasVehicleFilter =
    query.anio || query.marca_auto || query.modelo_auto || query.motor;

  if (hasVehicleFilter) {
    const vehicleConditions = ["pa.producto_id = p.id"];

    if (query.anio) {
      vehicleConditions.push("? BETWEEN pa.anio_inicio AND pa.anio_fin");
      params.push(Number(query.anio));
    }

    if (query.marca_auto) {
      vehicleConditions.push("pa.marca_auto = ?");
      params.push(query.marca_auto);
    }

    if (query.modelo_auto) {
      vehicleConditions.push("pa.modelo_auto = ?");
      params.push(query.modelo_auto);
    }

    if (query.motor) {
      const motor = cleanQueryValue(query.motor);
      const normalizedMotor = normalizeMotorSearchValue(motor) || motor;

      vehicleConditions.push(buildApplicationMotorExactSql("pa"));
      params.push(normalizedMotor, motor, motor);
    }

    conditions.push(`
            EXISTS (
                SELECT 1
                FROM producto_aplicaciones pa
                WHERE ${vehicleConditions.join(" AND ")}
            )
        `);
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

router.get("/categorias", async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        c.id,
        c.nombre,
        c.nombre_normalizado,
        COUNT(p.id) AS total_productos
      FROM categorias c
      LEFT JOIN productos p
        ON p.categoria_id = c.id
        AND p.activo = 1
        AND p.activo_web = 1
      WHERE c.activo = 1
      GROUP BY c.id, c.nombre, c.nombre_normalizado
      ORDER BY c.nombre ASC
    `);

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/familias", async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        p.familia,
        COUNT(*) AS total_productos
      FROM productos p
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND p.familia IS NOT NULL
        AND p.familia <> ''
      GROUP BY p.familia
      ORDER BY p.familia ASC
    `);

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/armadoras", async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        p.armadora,
        COUNT(*) AS total_productos
      FROM productos p
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND p.armadora IS NOT NULL
        AND p.armadora <> ''
      GROUP BY p.armadora
      ORDER BY p.armadora ASC
    `);

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/productos/destacados", async (req, res, next) => {
  try {
    const limit = clampNumber(parsePositiveInt(req.query.limit, 8), 1, 24);

    const ecommerceClave = getCatalogEcommerceSucursalClave();

    const [rows] = await pool.query(
      `
      SELECT
        p.id,
        p.codigo_andyfers,
        p.codigo_importacion,
        c.nombre AS categoria,
        p.clasif_vta,
        p.armadora,
        p.familia,
        p.descripcion,
        p.multiplo,
        p.unidad_medida,
        p.prioridad_ia,
        p.nuevo_web,
        p.destacado,
        ${buildEcommerceInventorySelectSql()},
        ${buildProductSeoVehicleSelectSql("p")},
        COUNT(DISTINCT pc.id) AS total_cruces,
        ${buildProductoMultimediaSelectSql("p")}
      FROM productos p
      JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN sucursales se ON se.clave = ?
      LEFT JOIN inventario i
        ON i.producto_id = p.id
        AND i.sucursal_id = se.id
      LEFT JOIN producto_cruces pc ON pc.producto_id = p.id
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND p.visible_catalogo = 1
        AND p.destacado = 1
        AND ${buildValidPublicCodeCondition("p")}
      GROUP BY
        p.id,
        p.codigo_andyfers,
        p.codigo_importacion,
        c.nombre,
        p.clasif_vta,
        p.armadora,
        p.familia,
        p.descripcion,
        p.multiplo,
        p.unidad_medida,
        p.prioridad_ia,
        p.nuevo_web,
        p.destacado
      ORDER BY
        p.prioridad_ia DESC,
        p.nuevo_web DESC,
        p.id DESC
      LIMIT ?
      `,
      [ecommerceClave, limit]
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/vehiculos/anios", async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        pa.anio_inicio,
        pa.anio_fin
      FROM producto_aplicaciones pa
      JOIN productos p ON p.id = pa.producto_id
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND pa.anio_inicio IS NOT NULL
        AND pa.anio_fin IS NOT NULL
        AND pa.anio_inicio BETWEEN 1900 AND 2100
        AND pa.anio_fin BETWEEN 1900 AND 2100
    `);

    const years = new Set();

    rows.forEach((row) => {
      const start = Number(row.anio_inicio);
      const end = Number(row.anio_fin);

      if (!Number.isFinite(start) || !Number.isFinite(end)) return;

      for (let year = start; year <= end; year++) {
        years.add(year);
      }
    });

    const data = Array.from(years)
      .sort((a, b) => b - a)
      .map((anio) => ({ anio }));

    res.json({
      ok: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/vehiculos/marcas", async (req, res, next) => {
  try {
    const anio = Number(req.query.anio);

    if (!anio) {
      return res.status(400).json({
        ok: false,
        error: "El año es obligatorio.",
      });
    }

    const [rows] = await pool.query(
      `
      SELECT DISTINCT
        pa.marca_auto AS marca
      FROM producto_aplicaciones pa
      JOIN productos p ON p.id = pa.producto_id
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND ? BETWEEN pa.anio_inicio AND pa.anio_fin
        AND pa.marca_auto IS NOT NULL
        AND pa.marca_auto <> ''
      ORDER BY pa.marca_auto ASC
      `,
      [anio]
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/vehiculos/modelos", async (req, res, next) => {
  try {
    const anio = Number(req.query.anio);
    const marca = cleanQueryValue(req.query.marca);

    if (!anio || !marca) {
      return res.status(400).json({
        ok: false,
        error: "El año y la marca son obligatorios.",
      });
    }

    const [rows] = await pool.query(
      `
      SELECT DISTINCT
        pa.modelo_auto AS modelo
      FROM producto_aplicaciones pa
      JOIN productos p ON p.id = pa.producto_id
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND ? BETWEEN pa.anio_inicio AND pa.anio_fin
        AND pa.marca_auto = ?
        AND pa.modelo_auto IS NOT NULL
        AND pa.modelo_auto <> ''
      ORDER BY pa.modelo_auto ASC
      `,
      [anio, marca]
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/vehiculos/motores", async (req, res, next) => {
  try {
    const anio = Number(req.query.anio);
    const marca = cleanQueryValue(req.query.marca);
    const modelo = cleanQueryValue(req.query.modelo);

    if (!anio || !marca || !modelo) {
      return res.status(400).json({
        ok: false,
        error: "El año, marca y modelo son obligatorios.",
      });
    }

    const [rows] = await pool.query(
      `
      SELECT
        pa.motor,
        GROUP_CONCAT(
          DISTINCT NULLIF(TRIM(pa.cilindraje), '')
          ORDER BY pa.cilindraje ASC
          SEPARATOR ', '
        ) AS cilindraje,
        GROUP_CONCAT(
          DISTINCT NULLIF(TRIM(pa.motor_detalle), '')
          ORDER BY pa.motor_detalle ASC
          SEPARATOR ', '
        ) AS motor_detalle,
        CONCAT_WS(
          ' · ',
          NULLIF(TRIM(pa.motor), ''),
          GROUP_CONCAT(
            DISTINCT NULLIF(TRIM(pa.cilindraje), '')
            ORDER BY pa.cilindraje ASC
            SEPARATOR ', '
          ),
          GROUP_CONCAT(
            DISTINCT NULLIF(TRIM(pa.motor_detalle), '')
            ORDER BY pa.motor_detalle ASC
            SEPARATOR ', '
          )
        ) AS motor_label
      FROM producto_aplicaciones pa
      JOIN productos p ON p.id = pa.producto_id
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND ? BETWEEN pa.anio_inicio AND pa.anio_fin
        AND pa.marca_auto = ?
        AND pa.modelo_auto = ?
        AND pa.motor IS NOT NULL
        AND TRIM(pa.motor) <> ''
      GROUP BY pa.motor
      ORDER BY
        CAST(REPLACE(UPPER(pa.motor), 'L', '') AS DECIMAL(10, 2)) ASC,
        pa.motor ASC
      `,
      [anio, marca, modelo]
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/vehiculos/lineas", async (req, res, next) => {
  try {
    const anio = Number(req.query.anio);
    const marca = cleanQueryValue(req.query.marca);
    const modelo = cleanQueryValue(req.query.modelo);
    const motor = cleanQueryValue(req.query.motor);

    if (!anio || !marca || !modelo || !motor) {
      return res.status(400).json({
        ok: false,
        error: "El año, marca, modelo y motor son obligatorios.",
      });
    }

    const [rows] = await pool.query(
      `
      SELECT
        p.familia AS linea,
        COUNT(DISTINCT p.id) AS total_productos
      FROM producto_aplicaciones pa
      JOIN productos p ON p.id = pa.producto_id
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND ? BETWEEN pa.anio_inicio AND pa.anio_fin
        AND pa.marca_auto = ?
        AND pa.modelo_auto = ?
        AND ${buildApplicationMotorExactSql("pa")}
        AND p.familia IS NOT NULL
        AND p.familia <> ''
      GROUP BY p.familia
      ORDER BY p.familia ASC
      `,
      [anio, marca, modelo, normalizeMotorSearchValue(motor) || motor, motor, motor]
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/productos", async (req, res, next) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = clampNumber(parsePositiveInt(req.query.limit, 12), 1, 60);
    const offset = (page - 1) * limit;

    const { whereSql, params } = buildProductWhere(req.query);
    const ecommerceClave = getCatalogEcommerceSucursalClave();

    const [countRows] = await pool.query(
      `
      SELECT COUNT(DISTINCT p.id) AS total
      FROM productos p
      JOIN categorias c ON c.id = p.categoria_id
      ${whereSql}
      `,
      params,
    );

    const total = Number(countRows?.[0]?.total || 0);

    const [rows] = await pool.query(
      `
      SELECT
        p.id,
        p.codigo_andyfers,
        p.codigo_importacion,
        c.nombre AS categoria,
        p.clasif_vta,
        p.armadora,
        p.familia,
        p.descripcion,
        p.multiplo,
        p.unidad_medida,
        p.prioridad_ia,
        p.nuevo_web,
        ${buildEcommerceInventorySelectSql()},
        ${buildProductSeoVehicleSelectSql("p")},
        COUNT(DISTINCT pc.id) AS total_cruces,
        ${buildProductoMultimediaSelectSql("p")}
      FROM productos p
      JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN sucursales se ON se.clave = ?
      LEFT JOIN inventario i
        ON i.producto_id = p.id
        AND i.sucursal_id = se.id
      LEFT JOIN producto_cruces pc ON pc.producto_id = p.id
      ${whereSql}
      GROUP BY
        p.id,
        p.codigo_andyfers,
        p.codigo_importacion,
        c.nombre,
        p.clasif_vta,
        p.armadora,
        p.familia,
        p.descripcion,
        p.multiplo,
        p.unidad_medida,
        p.prioridad_ia,
        p.nuevo_web
      ORDER BY
        CASE
            WHEN ${buildVisibleProductCodeSql("p")} REGEXP '^[0-9]+$' THEN 0
            ELSE 1
        END ASC,
        CASE
            WHEN ${buildVisibleProductCodeSql("p")} REGEXP '^[0-9]+$'
            THEN CAST(${buildVisibleProductCodeSql("p")} AS UNSIGNED)
            ELSE NULL
        END ASC,
        ${buildVisibleProductCodeSql("p")} ASC,
        p.id ASC
      LIMIT ? OFFSET ?
      `,
      [ecommerceClave, ...params, limit, offset],
    );

    res.json({
      ok: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
      filters: {
        q: req.query.q || "",
        categoria: req.query.categoria || "",
        familia: req.query.familia || "",
        armadora: req.query.armadora || "",
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/buscar/sugerencias", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();

    if (q.length < 2) {
      return res.json({
        ok: true,
        data: [],
      });
    }

    const qNormalized = normalizeSearchQuery(q);
    const normalizedPart = normalizePartNumber(q);
    const like = `%${q}%`;
    const likeNormalized = `%${qNormalized}%`;

    const [rows] = await pool.query(
      `
      SELECT
        sugerencia,
        tipo,
        total
      FROM (
        SELECT
          p.familia AS sugerencia,
          'FAMILIA' AS tipo,
          COUNT(*) AS total
        FROM productos p
        WHERE p.activo = 1
          AND p.activo_web = 1
          AND p.familia LIKE ?
        GROUP BY p.familia

        UNION ALL

        SELECT
          p.armadora AS sugerencia,
          'ARMADORA' AS tipo,
          COUNT(*) AS total
        FROM productos p
        WHERE p.activo = 1
          AND p.activo_web = 1
          AND p.armadora LIKE ?
        GROUP BY p.armadora

        UNION ALL

        SELECT
          pc.numero_parte AS sugerencia,
          'CRUCE' AS tipo,
          COUNT(*) AS total
        FROM producto_cruces pc
        WHERE pc.numero_parte LIKE ?
          OR pc.numero_parte_normalizado LIKE ?
        GROUP BY pc.numero_parte

        UNION ALL

        SELECT
          CONCAT(pat.atributo, ': ', pat.valor_texto) AS sugerencia,
          'ATRIBUTO' AS tipo,
          COUNT(*) AS total
        FROM producto_atributos pat
        WHERE pat.buscable = 1
          AND (
            pat.atributo_normalizado LIKE ?
            OR pat.valor_normalizado LIKE ?
          )
        GROUP BY pat.atributo, pat.valor_texto
      ) sugerencias
      WHERE sugerencia IS NOT NULL
        AND sugerencia <> ''
      ORDER BY total DESC, sugerencia ASC
      LIMIT 12
      `,
      [
        like,
        like,
        like,
        `%${normalizedPart}%`,
        likeNormalized,
        likeNormalized,
      ]
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/productos/:codigo", async (req, res, next) => {
  try {
    const codigo = String(req.params.codigo || "").trim();
    const codigoNormalizado = normalizePartNumber(codigo);
    const ecommerceClave = getCatalogEcommerceSucursalClave();

    const [productos] = await pool.query(
      `
      SELECT
        p.id,
        p.codigo_andyfers,
        p.codigo_andyfers_normalizado,
        p.codigo_importacion,
        c.nombre AS categoria,
        p.clasif_vta,
        p.armadora,
        p.familia,
        p.descripcion,
        p.multiplo,
        p.unidad_medida,
        p.prioridad_ia,
        p.nuevo_web,
        p.activo_web,
        p.activo,
        ${buildEcommerceInventorySelectSql()},
        ${buildProductSeoVehicleSelectSql("p")},
        ${buildProductoMultimediaSelectSql("p")}
      FROM productos p
      JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN sucursales se ON se.clave = ?
      LEFT JOIN inventario i
        ON i.producto_id = p.id
        AND i.sucursal_id = se.id
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND (
          p.codigo_andyfers = ?
          OR p.codigo_andyfers_normalizado = ?
          OR p.codigo_importacion = ?
        )
      GROUP BY
        p.id,
        p.codigo_andyfers,
        p.codigo_andyfers_normalizado,
        p.codigo_importacion,
        c.nombre,
        p.clasif_vta,
        p.armadora,
        p.familia,
        p.descripcion,
        p.multiplo,
        p.unidad_medida,
        p.prioridad_ia,
        p.nuevo_web,
        p.activo_web,
        p.activo
      LIMIT 1
      `,
      [ecommerceClave, codigo, codigoNormalizado, codigo]
    );

    const producto = productos?.[0];

    if (!producto) {
      return res.status(404).json({
        ok: false,
        error: "Producto no encontrado",
      });
    }

    const [cruces] = await pool.query(
      `
      SELECT
        pc.id,
        mc.nombre AS marca,
        pc.numero_parte,
        pc.numero_parte_normalizado
      FROM producto_cruces pc
      JOIN marcas_cruce mc ON mc.id = pc.marca_id
      WHERE pc.producto_id = ?
      ORDER BY mc.nombre ASC, pc.numero_parte ASC
      `,
      [producto.id]
    );

    const [aplicaciones] = await pool.query(
      `
      SELECT
        id,
        marca_auto,
        modelo_auto,
        motor,
        cilindraje,
        motor_detalle,
        motor_original,
        ${buildApplicationMotorLabelSql("producto_aplicaciones")} AS motor_label,
        anio_inicio,
        anio_fin,
        version_auto,
        fuente,
        confianza_extraccion,
        notas
      FROM producto_aplicaciones
      WHERE producto_id = ?
      ORDER BY marca_auto ASC, modelo_auto ASC, anio_inicio ASC
      `,
      [producto.id]
    );

    const [relaciones] = await pool.query(
      `
      SELECT
        id,
        tipo_relacion,
        codigo_relacionado,
        notas
      FROM producto_relaciones
      WHERE producto_id = ?
      ORDER BY tipo_relacion ASC, codigo_relacionado ASC
      `,
      [producto.id]
    );

    const [inventario] = await pool.query(
      `
      SELECT
        i.id,
        s.nombre AS sucursal,
        s.clave AS sucursal_clave,
        i.stock,
        i.precio,
        i.precio_publico,
        i.mostrar_precio,
        i.disponible_web,
        i.updated_at
      FROM inventario i
      JOIN sucursales s ON s.id = i.sucursal_id
      WHERE i.producto_id = ?
        AND s.clave = ?
      ORDER BY s.nombre ASC
      `,
      [producto.id, ecommerceClave]
    );

    const [atributos] = await pool.query(
      `
            SELECT
                id,
                atributo,
                atributo_normalizado,
                valor_texto,
                valor_normalizado,
                valor_numero,
                unidad,
                orden
            FROM producto_atributos
            WHERE producto_id = ?
                AND visible_web = 1
            ORDER BY orden ASC, atributo ASC
            `,
      [producto.id]
    );

    const [multimedia] = await pool.query(
      `
            SELECT
                id,
                tipo,
                rol,
                cloudinary_public_id,
                secure_url,
                thumbnail_url,
                codigo_archivo_original,
                nombre_archivo_original,
                orden,
                activo
            FROM producto_multimedia
            WHERE producto_id = ?
                AND activo = 1
            ORDER BY
                CASE rol
                WHEN 'PRINCIPAL' THEN 0
                WHEN 'GALERIA' THEN 1
                WHEN 'VIDEO' THEN 2
                ELSE 3
                END,
                orden ASC,
                id ASC
            `,
      [producto.id]
    );

    const imagenes = multimedia.filter((item) => item.tipo === "IMAGEN");
    const videos = multimedia.filter((item) => item.tipo === "VIDEO");

    const imagenPrincipal =
      imagenes.find((item) => item.rol === "PRINCIPAL") ||
      imagenes[0] ||
      null;

    const galeria = imagenes.filter((item) => item.id !== imagenPrincipal?.id);
    const videoPrincipal = videos[0] || null;

    res.json({
      ok: true,
      data: {
        ...producto,
        cruces,
        aplicaciones,
        relaciones,
        inventario,
        atributos,
        multimedia,
        imagen_principal: imagenPrincipal,
        galeria,
        video_principal: videoPrincipal,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
