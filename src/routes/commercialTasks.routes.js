import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";

const router = Router();
const taskAccess = [requireAdminAuth, requireRole(["ADMIN", "VENTAS", "COMPRAS"])] ;

const VALID_ESTADOS = new Set([
  "NUEVO",
  "EN_REVISION",
  "SOLICITAR_IMAGEN",
  "SOLICITAR_CRUCE",
  "COMPLETADO",
  "DESCARTADO",
]);

const VALID_PRIORIDADES = new Set(["CRITICA", "ALTA", "MEDIA", "BAJA"]);

function cleanString(value, maxLength = 320) {
  if (value === undefined || value === null) return "";

  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function cleanText(value, maxLength = 4000) {
  if (value === undefined || value === null) return "";

  return String(value).trim().slice(0, maxLength);
}

function normalizeKey(value, maxLength = 120) {
  return cleanString(value, maxLength)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
}

function parsePositiveInt(value, fallback = 50, max = 500) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  return Math.min(parsed, max);
}

function parseOptionalInt(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return parsed;
}

function parseScore(value, fallback = 0) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) return fallback;

  return parsed;
}

function safeJson(value) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "string") return value.slice(0, 65000);

  try {
    return JSON.stringify(value).slice(0, 65000);
  } catch {
    return null;
  }
}

function parseDateOnly(value) {
  const clean = cleanString(value, 20);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return null;

  return clean;
}

function normalizeEstado(value, fallback = "NUEVO") {
  const estado = normalizeKey(value, 60) || fallback;

  return VALID_ESTADOS.has(estado) ? estado : fallback;
}

function normalizePrioridad(value, fallback = "MEDIA") {
  const prioridad = normalizeKey(value, 40) || fallback;

  return VALID_PRIORIDADES.has(prioridad) ? prioridad : fallback;
}

function getUserLabel(req) {
  return (
    cleanString(req.user?.nombre, 160) ||
    cleanString(req.user?.email, 160) ||
    cleanString(req.user?.usuario, 160) ||
    "ADMIN"
  );
}

function productBaseJoinsSql() {
  return `
    FROM productos p
    LEFT JOIN categorias c
      ON c.id = p.categoria_id
    LEFT JOIN (
      SELECT
        producto_id,
        COUNT(*) AS total_imagenes,
        SUM(CASE WHEN rol = 'PRINCIPAL' THEN 1 ELSE 0 END) AS total_principales
      FROM producto_multimedia
      WHERE activo = 1
        AND tipo = 'IMAGEN'
      GROUP BY producto_id
    ) pm
      ON pm.producto_id = p.id
    LEFT JOIN (
      SELECT
        producto_id,
        COUNT(*) AS total_cruces
      FROM producto_cruces
      GROUP BY producto_id
    ) pc
      ON pc.producto_id = p.id
    LEFT JOIN (
      SELECT
        producto_id,
        COUNT(*) AS total_aplicaciones
      FROM producto_aplicaciones
      GROUP BY producto_id
    ) pa
      ON pa.producto_id = p.id
    LEFT JOIN (
      SELECT
        producto_id,
        COALESCE(SUM(CASE WHEN disponible_web = 1 THEN stock ELSE 0 END), 0) AS stock_total_web,
        MIN(CASE WHEN disponible_web = 1 THEN precio ELSE NULL END) AS precio_minimo
      FROM inventario
      GROUP BY producto_id
    ) inv
      ON inv.producto_id = p.id
  `;
}

function productVisibleWhereSql() {
  return `
    p.activo = 1
    AND p.activo_web = 1
    AND p.visible_catalogo = 1
  `;
}

function taskQualityUnionSql() {
  const base = productBaseJoinsSql();
  const visible = productVisibleWhereSql();

  return `
    SELECT
      'PRODUCTO_SIN_IMAGEN' AS tipo_pendiente,
      'CATALOGO_CALIDAD' AS origen,
      'PRODUCTO' AS referencia_tipo,
      CONCAT('PRODUCTO:', p.id, ':SIN_IMAGEN') AS referencia_key,
      p.id AS producto_id,
      p.codigo_andyfers,
      p.codigo_importacion,
      c.nombre AS categoria_nombre,
      p.familia,
      p.armadora,
      CONCAT('Producto sin imagen: ', COALESCE(p.codigo_andyfers, p.codigo_importacion, CONCAT('ID ', p.id))) AS titulo,
      CONCAT('El producto visible en catálogo no tiene imagen activa en Cloudinary ni imagen_url local. ', COALESCE(p.descripcion, '')) AS descripcion,
      'SOLICITAR_IMAGEN' AS accion_sugerida,
      CASE WHEN COALESCE(p.destacado, 0) = 1 OR COALESCE(p.nuevo_web, 0) = 1 THEN 'ALTA' ELSE 'MEDIA' END AS prioridad,
      CASE WHEN COALESCE(p.destacado, 0) = 1 OR COALESCE(p.nuevo_web, 0) = 1 THEN 85 ELSE 65 END AS score,
      1 AS total_eventos,
      JSON_OBJECT(
        'issue', 'sin_imagen',
        'destacado', COALESCE(p.destacado, 0),
        'nuevo_web', COALESCE(p.nuevo_web, 0),
        'total_imagenes', COALESCE(pm.total_imagenes, 0)
      ) AS metadata_json
    ${base}
    WHERE ${visible}
      AND COALESCE(pm.total_imagenes, 0) = 0
      AND (p.imagen_url IS NULL OR TRIM(p.imagen_url) = '')

    UNION ALL

    SELECT
      'PRODUCTO_SIN_DESCRIPCION_WEB' AS tipo_pendiente,
      'CATALOGO_CALIDAD' AS origen,
      'PRODUCTO' AS referencia_tipo,
      CONCAT('PRODUCTO:', p.id, ':SIN_DESCRIPCION_WEB') AS referencia_key,
      p.id AS producto_id,
      p.codigo_andyfers,
      p.codigo_importacion,
      c.nombre AS categoria_nombre,
      p.familia,
      p.armadora,
      CONCAT('Completar descripción web: ', COALESCE(p.codigo_andyfers, p.codigo_importacion, CONCAT('ID ', p.id))) AS titulo,
      CONCAT('El producto visible tiene descripción web vacía o muy corta. Descripción actual: ', COALESCE(p.descripcion, '')) AS descripcion,
      'COMPLETAR_DESCRIPCION' AS accion_sugerida,
      'MEDIA' AS prioridad,
      50 AS score,
      1 AS total_eventos,
      JSON_OBJECT('issue', 'sin_descripcion_web') AS metadata_json
    ${base}
    WHERE ${visible}
      AND (
        p.descripcion_web IS NULL
        OR TRIM(p.descripcion_web) = ''
        OR CHAR_LENGTH(TRIM(p.descripcion_web)) < 20
      )

    UNION ALL

    SELECT
      'PRODUCTO_SIN_CRUCES' AS tipo_pendiente,
      'CATALOGO_CALIDAD' AS origen,
      'PRODUCTO' AS referencia_tipo,
      CONCAT('PRODUCTO:', p.id, ':SIN_CRUCES') AS referencia_key,
      p.id AS producto_id,
      p.codigo_andyfers,
      p.codigo_importacion,
      c.nombre AS categoria_nombre,
      p.familia,
      p.armadora,
      CONCAT('Producto sin cruces: ', COALESCE(p.codigo_andyfers, p.codigo_importacion, CONCAT('ID ', p.id))) AS titulo,
      CONCAT('El producto visible no tiene cruces registrados. ', COALESCE(p.descripcion, '')) AS descripcion,
      'SOLICITAR_CRUCE' AS accion_sugerida,
      'MEDIA' AS prioridad,
      55 AS score,
      1 AS total_eventos,
      JSON_OBJECT('issue', 'sin_cruces') AS metadata_json
    ${base}
    WHERE ${visible}
      AND COALESCE(pc.total_cruces, 0) = 0

    UNION ALL

    SELECT
      'PRODUCTO_SIN_APLICACIONES' AS tipo_pendiente,
      'CATALOGO_CALIDAD' AS origen,
      'PRODUCTO' AS referencia_tipo,
      CONCAT('PRODUCTO:', p.id, ':SIN_APLICACIONES') AS referencia_key,
      p.id AS producto_id,
      p.codigo_andyfers,
      p.codigo_importacion,
      c.nombre AS categoria_nombre,
      p.familia,
      p.armadora,
      CONCAT('Producto sin aplicaciones: ', COALESCE(p.codigo_andyfers, p.codigo_importacion, CONCAT('ID ', p.id))) AS titulo,
      CONCAT('El producto visible no tiene aplicaciones vehiculares registradas. ', COALESCE(p.descripcion, '')) AS descripcion,
      'COMPLETAR_APLICACIONES' AS accion_sugerida,
      'MEDIA' AS prioridad,
      45 AS score,
      1 AS total_eventos,
      JSON_OBJECT('issue', 'sin_aplicaciones') AS metadata_json
    ${base}
    WHERE ${visible}
      AND COALESCE(pa.total_aplicaciones, 0) = 0

    UNION ALL

    SELECT
      'PRODUCTO_SIN_STOCK_PRECIO' AS tipo_pendiente,
      'CATALOGO_CALIDAD' AS origen,
      'PRODUCTO' AS referencia_tipo,
      CONCAT('PRODUCTO:', p.id, ':SIN_STOCK_PRECIO') AS referencia_key,
      p.id AS producto_id,
      p.codigo_andyfers,
      p.codigo_importacion,
      c.nombre AS categoria_nombre,
      p.familia,
      p.armadora,
      CONCAT('Revisar stock/precio web: ', COALESCE(p.codigo_andyfers, p.codigo_importacion, CONCAT('ID ', p.id))) AS titulo,
      CONCAT('El producto visible no tiene stock web o precio web válido. ', COALESCE(p.descripcion, '')) AS descripcion,
      'REVISAR_STOCK_PRECIO' AS accion_sugerida,
      'BAJA' AS prioridad,
      30 AS score,
      1 AS total_eventos,
      JSON_OBJECT(
        'issue', 'sin_stock_precio',
        'stock_total_web', COALESCE(inv.stock_total_web, 0),
        'precio_minimo', inv.precio_minimo
      ) AS metadata_json
    ${base}
    WHERE ${visible}
      AND (
        COALESCE(inv.stock_total_web, 0) <= 0
        OR inv.precio_minimo IS NULL
        OR inv.precio_minimo <= 0
      )
  `;
}


function analyticsDateWhereSql(alias = "ae", options = {}) {
  const days = Number.parseInt(options.days, 10);
  const safeDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 90;

  return {
    sql: `${alias}.fecha_evento >= DATE_SUB(CURRENT_DATE, INTERVAL ? DAY)`,
    params: [safeDays],
    days: safeDays,
  };
}

function analyticsTasksUnionSql(options = {}) {
  const minEventos = Math.max(1, Math.min(Number.parseInt(options.min_eventos, 10) || 2, 1000));
  const dateFilter = analyticsDateWhereSql("ae", options);

  return {
    sql: `
      SELECT
        'BUSQUEDA_SIN_RESULTADO' AS tipo_pendiente,
        'ANALYTICS' AS origen,
        'BUSQUEDA' AS referencia_tipo,
        CONCAT('BUSQUEDA:', COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO')) AS referencia_key,
        NULL AS producto_id,
        NULL AS codigo_andyfers,
        NULL AS codigo_importacion,
        NULL AS categoria_nombre,
        NULL AS familia,
        NULL AS armadora,
        CONCAT('Búsqueda sin resultado: ', COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO')) AS titulo,
        CONCAT(
          'La búsqueda "', COALESCE(MIN(ae.busqueda_original), COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO')),
          '" aparece ', COUNT(*),
          ' veces sin resultado. Revisar si falta producto, cruce, descripción o sinónimo de búsqueda.'
        ) AS descripcion,
        'REVISAR_CATALOGO_O_COMPRAS' AS accion_sugerida,
        CASE
          WHEN COUNT(*) >= 20 THEN 'CRITICA'
          WHEN COUNT(*) >= 8 THEN 'ALTA'
          WHEN COUNT(*) >= 3 THEN 'MEDIA'
          ELSE 'BAJA'
        END AS prioridad,
        LEAST(COUNT(*) * 12, 1000) AS score,
        COUNT(*) AS total_eventos,
        MIN(ae.fecha_evento) AS primer_evento,
        MAX(ae.fecha_evento) AS ultimo_evento,
        JSON_OBJECT(
          'fuente', 'analytics_eventos',
          'issue', 'busqueda_sin_resultado',
          'busqueda_normalizada', COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO'),
          'ejemplo_busqueda', MIN(ae.busqueda_original),
          'sesiones', COUNT(DISTINCT ae.session_id)
        ) AS metadata_json
      FROM analytics_eventos ae
      WHERE ${dateFilter.sql}
        AND (
          ae.evento IN ('BUSQUEDA_CATALOGO_SIN_RESULTADO', 'BUSQUEDA_IA_SIN_RESULTADO')
          OR ae.resultado_estado = 'SIN_RESULTADO'
        )
      GROUP BY COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO')
      HAVING total_eventos >= ?

      UNION ALL

      SELECT
        'VEHICULO_SIN_RESULTADO' AS tipo_pendiente,
        'ANALYTICS' AS origen,
        'VEHICULO' AS referencia_tipo,
        CONCAT(
          'VEHICULO:',
          COALESCE(NULLIF(ae.marca_vehiculo, ''), 'SIN_MARCA'), ':',
          COALESCE(NULLIF(ae.modelo_vehiculo, ''), 'SIN_MODELO'), ':',
          COALESCE(NULLIF(ae.anio_vehiculo, ''), 'SIN_ANIO'), ':',
          COALESCE(NULLIF(ae.motor_vehiculo, ''), 'SIN_MOTOR')
        ) AS referencia_key,
        NULL AS producto_id,
        NULL AS codigo_andyfers,
        NULL AS codigo_importacion,
        NULL AS categoria_nombre,
        NULL AS familia,
        COALESCE(NULLIF(ae.marca_vehiculo, ''), NULL) AS armadora,
        CONCAT(
          'Vehículo con búsquedas sin resultado: ',
          COALESCE(NULLIF(ae.marca_vehiculo, ''), 'SIN MARCA'), ' ',
          COALESCE(NULLIF(ae.modelo_vehiculo, ''), 'SIN MODELO'), ' ',
          COALESCE(NULLIF(ae.anio_vehiculo, ''), 'SIN AÑO')
        ) AS titulo,
        CONCAT(
          'Hay ', COUNT(*),
          ' consultas sin resultado para este vehículo/motor. Revisar aplicaciones, equivalencias o productos faltantes.'
        ) AS descripcion,
        'REVISAR_APLICACIONES_Y_CATALOGO' AS accion_sugerida,
        CASE
          WHEN COUNT(*) >= 15 THEN 'CRITICA'
          WHEN COUNT(*) >= 6 THEN 'ALTA'
          WHEN COUNT(*) >= 3 THEN 'MEDIA'
          ELSE 'BAJA'
        END AS prioridad,
        LEAST(COUNT(*) * 14, 1000) AS score,
        COUNT(*) AS total_eventos,
        MIN(ae.fecha_evento) AS primer_evento,
        MAX(ae.fecha_evento) AS ultimo_evento,
        JSON_OBJECT(
          'fuente', 'analytics_eventos',
          'issue', 'vehiculo_sin_resultado',
          'marca', COALESCE(NULLIF(ae.marca_vehiculo, ''), 'SIN_MARCA'),
          'modelo', COALESCE(NULLIF(ae.modelo_vehiculo, ''), 'SIN_MODELO'),
          'anio', COALESCE(NULLIF(ae.anio_vehiculo, ''), 'SIN_ANIO'),
          'motor', COALESCE(NULLIF(ae.motor_vehiculo, ''), 'SIN_MOTOR')
        ) AS metadata_json
      FROM analytics_eventos ae
      WHERE ${dateFilter.sql}
        AND ae.resultado_estado = 'SIN_RESULTADO'
        AND (
          ae.marca_vehiculo IS NOT NULL
          OR ae.modelo_vehiculo IS NOT NULL
          OR ae.anio_vehiculo IS NOT NULL
          OR ae.motor_vehiculo IS NOT NULL
        )
      GROUP BY
        COALESCE(NULLIF(ae.marca_vehiculo, ''), 'SIN_MARCA'),
        COALESCE(NULLIF(ae.modelo_vehiculo, ''), 'SIN_MODELO'),
        COALESCE(NULLIF(ae.anio_vehiculo, ''), 'SIN_ANIO'),
        COALESCE(NULLIF(ae.motor_vehiculo, ''), 'SIN_MOTOR')
      HAVING total_eventos >= ?

      UNION ALL

      SELECT
        'PRODUCTO_COTIZADO_SIN_IMAGEN' AS tipo_pendiente,
        'ANALYTICS' AS origen,
        'PRODUCTO' AS referencia_tipo,
        CONCAT('PRODUCTO:', p.id, ':COTIZADO_SIN_IMAGEN') AS referencia_key,
        p.id AS producto_id,
        p.codigo_andyfers,
        p.codigo_importacion,
        c.nombre AS categoria_nombre,
        p.familia,
        p.armadora,
        CONCAT('Producto cotizado sin imagen: ', COALESCE(p.codigo_andyfers, p.codigo_importacion, CONCAT('ID ', p.id))) AS titulo,
        CONCAT(
          'El producto fue agregado a cotización ', COUNT(*),
          ' veces, pero no tiene imagen activa. ', COALESCE(p.descripcion, '')
        ) AS descripcion,
        'SOLICITAR_IMAGEN' AS accion_sugerida,
        CASE
          WHEN COUNT(*) >= 10 THEN 'CRITICA'
          WHEN COUNT(*) >= 4 THEN 'ALTA'
          ELSE 'MEDIA'
        END AS prioridad,
        LEAST(70 + COUNT(*) * 18, 1000) AS score,
        COUNT(*) AS total_eventos,
        MIN(ae.fecha_evento) AS primer_evento,
        MAX(ae.fecha_evento) AS ultimo_evento,
        JSON_OBJECT(
          'fuente', 'analytics_eventos',
          'issue', 'producto_cotizado_sin_imagen',
          'veces_agregado', COUNT(*),
          'cotizaciones', COUNT(DISTINCT ae.cotizacion_id)
        ) AS metadata_json
      FROM analytics_eventos ae
      JOIN productos p ON p.id = ae.producto_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN (
        SELECT producto_id, COUNT(*) AS total_imagenes
        FROM producto_multimedia
        WHERE activo = 1 AND tipo = 'IMAGEN'
        GROUP BY producto_id
      ) pm ON pm.producto_id = p.id
      WHERE ${dateFilter.sql}
        AND ae.evento = 'PRODUCTO_AGREGADO_COTIZACION'
        AND p.activo = 1
        AND p.activo_web = 1
        AND p.visible_catalogo = 1
        AND COALESCE(pm.total_imagenes, 0) = 0
        AND (p.imagen_url IS NULL OR TRIM(p.imagen_url) = '')
      GROUP BY
        p.id,
        p.codigo_andyfers,
        p.codigo_importacion,
        c.nombre,
        p.familia,
        p.armadora,
        p.descripcion
      HAVING total_eventos >= 1

      UNION ALL

      SELECT
        'PRODUCTO_CONSULTADO_SIN_IMAGEN' AS tipo_pendiente,
        'ANALYTICS' AS origen,
        'PRODUCTO' AS referencia_tipo,
        CONCAT('PRODUCTO:', p.id, ':CONSULTADO_SIN_IMAGEN') AS referencia_key,
        p.id AS producto_id,
        p.codigo_andyfers,
        p.codigo_importacion,
        c.nombre AS categoria_nombre,
        p.familia,
        p.armadora,
        CONCAT('Producto consultado sin imagen: ', COALESCE(p.codigo_andyfers, p.codigo_importacion, CONCAT('ID ', p.id))) AS titulo,
        CONCAT(
          'El producto fue consultado ', COUNT(*),
          ' veces, pero no tiene imagen activa. ', COALESCE(p.descripcion, '')
        ) AS descripcion,
        'SOLICITAR_IMAGEN' AS accion_sugerida,
        CASE
          WHEN COUNT(*) >= 25 THEN 'ALTA'
          WHEN COUNT(*) >= 8 THEN 'MEDIA'
          ELSE 'BAJA'
        END AS prioridad,
        LEAST(35 + COUNT(*) * 6, 1000) AS score,
        COUNT(*) AS total_eventos,
        MIN(ae.fecha_evento) AS primer_evento,
        MAX(ae.fecha_evento) AS ultimo_evento,
        JSON_OBJECT(
          'fuente', 'analytics_eventos',
          'issue', 'producto_consultado_sin_imagen',
          'consultas', COUNT(*),
          'sesiones', COUNT(DISTINCT ae.session_id)
        ) AS metadata_json
      FROM analytics_eventos ae
      JOIN productos p ON p.id = ae.producto_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN (
        SELECT producto_id, COUNT(*) AS total_imagenes
        FROM producto_multimedia
        WHERE activo = 1 AND tipo = 'IMAGEN'
        GROUP BY producto_id
      ) pm ON pm.producto_id = p.id
      WHERE ${dateFilter.sql}
        AND ae.evento = 'PRODUCTO_CONSULTADO'
        AND p.activo = 1
        AND p.activo_web = 1
        AND p.visible_catalogo = 1
        AND COALESCE(pm.total_imagenes, 0) = 0
        AND (p.imagen_url IS NULL OR TRIM(p.imagen_url) = '')
      GROUP BY
        p.id,
        p.codigo_andyfers,
        p.codigo_importacion,
        c.nombre,
        p.familia,
        p.armadora,
        p.descripcion
      HAVING total_eventos >= ?
    `,
    params: [
      ...dateFilter.params,
      minEventos,
      ...dateFilter.params,
      minEventos,
      ...dateFilter.params,
      ...dateFilter.params,
      minEventos,
    ],
    days: dateFilter.days,
    minEventos,
  };
}

router.get("/admin/pendientes-comerciales/resumen", taskAccess, async (req, res, next) => {
  try {
    const [estadoRows] = await pool.query(
      `
      SELECT estado, COUNT(*) AS total
      FROM catalogo_pendientes_comerciales
      GROUP BY estado
      ORDER BY total DESC
      `
    );

    const [prioridadRows] = await pool.query(
      `
      SELECT prioridad, COUNT(*) AS total
      FROM catalogo_pendientes_comerciales
      WHERE estado NOT IN ('COMPLETADO', 'DESCARTADO')
      GROUP BY prioridad
      ORDER BY
        CASE prioridad
          WHEN 'CRITICA' THEN 1
          WHEN 'ALTA' THEN 2
          WHEN 'MEDIA' THEN 3
          WHEN 'BAJA' THEN 4
          ELSE 5
        END
      `
    );

    const [tipoRows] = await pool.query(
      `
      SELECT tipo_pendiente, COUNT(*) AS total
      FROM catalogo_pendientes_comerciales
      WHERE estado NOT IN ('COMPLETADO', 'DESCARTADO')
      GROUP BY tipo_pendiente
      ORDER BY total DESC
      LIMIT 12
      `
    );

    const [origenRows] = await pool.query(
      `
      SELECT origen, COUNT(*) AS total
      FROM catalogo_pendientes_comerciales
      WHERE estado NOT IN ('COMPLETADO', 'DESCARTADO')
      GROUP BY origen
      ORDER BY total DESC
      `
    );

    const [kpisRows] = await pool.query(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN estado = 'NUEVO' THEN 1 ELSE 0 END) AS nuevos,
        SUM(CASE WHEN estado = 'EN_REVISION' THEN 1 ELSE 0 END) AS en_revision,
        SUM(CASE WHEN estado = 'SOLICITAR_IMAGEN' THEN 1 ELSE 0 END) AS solicitar_imagen,
        SUM(CASE WHEN estado = 'SOLICITAR_CRUCE' THEN 1 ELSE 0 END) AS solicitar_cruce,
        SUM(CASE WHEN estado = 'COMPLETADO' THEN 1 ELSE 0 END) AS completados,
        SUM(CASE WHEN estado = 'DESCARTADO' THEN 1 ELSE 0 END) AS descartados,
        SUM(CASE WHEN estado NOT IN ('COMPLETADO', 'DESCARTADO') THEN 1 ELSE 0 END) AS abiertos,
        SUM(CASE WHEN origen = 'ANALYTICS' AND estado NOT IN ('COMPLETADO', 'DESCARTADO') THEN 1 ELSE 0 END) AS analytics_abiertos,
        SUM(CASE WHEN origen = 'CATALOGO_CALIDAD' AND estado NOT IN ('COMPLETADO', 'DESCARTADO') THEN 1 ELSE 0 END) AS calidad_abiertos,
        SUM(CASE WHEN prioridad IN ('CRITICA', 'ALTA') AND estado NOT IN ('COMPLETADO', 'DESCARTADO') THEN 1 ELSE 0 END) AS alta_prioridad,
        SUM(CASE WHEN fecha_limite IS NOT NULL AND fecha_limite < CURDATE() AND estado NOT IN ('COMPLETADO', 'DESCARTADO') THEN 1 ELSE 0 END) AS vencidos
      FROM catalogo_pendientes_comerciales
      `
    );

    res.json({
      ok: true,
      data: {
        kpis: kpisRows[0] || {},
        por_estado: estadoRows,
        por_prioridad: prioridadRows,
        por_tipo: tipoRows,
        por_origen: origenRows,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/pendientes-comerciales", taskAccess, async (req, res, next) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 80, 500);
    const q = cleanString(req.query.q, 160);
    const estado = normalizeKey(req.query.estado, 60);
    const prioridad = normalizeKey(req.query.prioridad, 40);
    const tipo = normalizeKey(req.query.tipo_pendiente || req.query.tipo, 80);
    const origen = normalizeKey(req.query.origen, 80);
    const familia = cleanString(req.query.familia, 160);
    const categoria = cleanString(req.query.categoria, 160);
    const responsable = cleanString(req.query.responsable, 160);
    const abiertos = cleanString(req.query.abiertos, 20).toLowerCase();

    const clauses = [];
    const params = [];

    if (q) {
      clauses.push(`
        (
          titulo LIKE ?
          OR descripcion LIKE ?
          OR codigo_andyfers LIKE ?
          OR codigo_importacion LIKE ?
          OR familia LIKE ?
          OR armadora LIKE ?
          OR nota LIKE ?
        )
      `);
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like, like);
    }

    if (estado) {
      clauses.push("estado = ?");
      params.push(estado);
    }

    if (prioridad) {
      clauses.push("prioridad = ?");
      params.push(prioridad);
    }

    if (tipo) {
      clauses.push("tipo_pendiente = ?");
      params.push(tipo);
    }

    if (origen) {
      clauses.push("origen = ?");
      params.push(origen);
    }

    if (familia) {
      clauses.push("familia = ?");
      params.push(familia);
    }

    if (categoria) {
      clauses.push("categoria_nombre = ?");
      params.push(categoria);
    }

    if (responsable) {
      clauses.push("responsable LIKE ?");
      params.push(`%${responsable}%`);
    }

    if (["1", "true", "si", "sí", "abiertos"].includes(abiertos)) {
      clauses.push("estado NOT IN ('COMPLETADO', 'DESCARTADO')");
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [rows] = await pool.query(
      `
      SELECT *
      FROM catalogo_pendientes_comerciales
      ${where}
      ORDER BY
        CASE estado
          WHEN 'NUEVO' THEN 1
          WHEN 'EN_REVISION' THEN 2
          WHEN 'SOLICITAR_IMAGEN' THEN 3
          WHEN 'SOLICITAR_CRUCE' THEN 4
          WHEN 'COMPLETADO' THEN 8
          WHEN 'DESCARTADO' THEN 9
          ELSE 5
        END,
        CASE prioridad
          WHEN 'CRITICA' THEN 1
          WHEN 'ALTA' THEN 2
          WHEN 'MEDIA' THEN 3
          WHEN 'BAJA' THEN 4
          ELSE 5
        END,
        score DESC,
        updated_at DESC,
        id DESC
      LIMIT ?
      `,
      [...params, limit]
    );

    res.json({ ok: true, data: rows });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/pendientes-comerciales/opciones", taskAccess, async (req, res, next) => {
  try {
    const [familias] = await pool.query(
      `
      SELECT DISTINCT familia AS value
      FROM catalogo_pendientes_comerciales
      WHERE familia IS NOT NULL AND TRIM(familia) <> ''
      ORDER BY familia
      `
    );

    const [categorias] = await pool.query(
      `
      SELECT DISTINCT categoria_nombre AS value
      FROM catalogo_pendientes_comerciales
      WHERE categoria_nombre IS NOT NULL AND TRIM(categoria_nombre) <> ''
      ORDER BY categoria_nombre
      `
    );

    const [tipos] = await pool.query(
      `
      SELECT DISTINCT tipo_pendiente AS value
      FROM catalogo_pendientes_comerciales
      ORDER BY tipo_pendiente
      `
    );

    const [origenes] = await pool.query(
      `
      SELECT DISTINCT origen AS value
      FROM catalogo_pendientes_comerciales
      WHERE origen IS NOT NULL AND TRIM(origen) <> ''
      ORDER BY origen
      `
    );

    res.json({
      ok: true,
      data: {
        familias: familias.map((row) => row.value),
        categorias: categorias.map((row) => row.value),
        tipos: tipos.map((row) => row.value),
        origenes: origenes.map((row) => row.value),
        estados: [...VALID_ESTADOS],
        prioridades: [...VALID_PRIORIDADES],
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/pendientes-comerciales/:id", taskAccess, async (req, res, next) => {
  try {
    const id = parseOptionalInt(req.params.id);

    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const [rows] = await pool.query(
      `SELECT * FROM catalogo_pendientes_comerciales WHERE id = ? LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "Pendiente no encontrado." });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/pendientes-comerciales", taskAccess, async (req, res, next) => {
  try {
    const body = req.body || {};
    const tipoPendiente = normalizeKey(body.tipo_pendiente || "MANUAL", 80);
    const referenciaTipo = normalizeKey(body.referencia_tipo || "MANUAL", 80);
    const titulo = cleanString(body.titulo, 260);

    if (!titulo) {
      return res.status(400).json({ ok: false, error: "El título es obligatorio." });
    }

    const productoId = parseOptionalInt(body.producto_id);
    const referenciaKey =
      cleanString(body.referencia_key, 260) ||
      `${referenciaTipo}:${productoId || Date.now()}:${tipoPendiente}`;

    const prioridad = normalizePrioridad(body.prioridad, "MEDIA");
    const estado = normalizeEstado(body.estado, "NUEVO");
    const userLabel = getUserLabel(req);

    const [result] = await pool.query(
      `
      INSERT INTO catalogo_pendientes_comerciales (
        tipo_pendiente,
        origen,
        referencia_tipo,
        referencia_key,
        producto_id,
        codigo_andyfers,
        codigo_importacion,
        categoria_nombre,
        familia,
        armadora,
        titulo,
        descripcion,
        accion_sugerida,
        prioridad,
        estado,
        responsable,
        nota,
        score,
        total_eventos,
        metadata_json,
        fecha_limite,
        creado_por,
        actualizado_por,
        closed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('COMPLETADO', 'DESCARTADO') THEN CURRENT_TIMESTAMP ELSE NULL END)
      `,
      [
        tipoPendiente,
        normalizeKey(body.origen || "MANUAL", 80),
        referenciaTipo,
        referenciaKey,
        productoId,
        cleanString(body.codigo_andyfers, 80) || null,
        cleanString(body.codigo_importacion, 80) || null,
        cleanString(body.categoria_nombre, 160) || null,
        cleanString(body.familia, 160) || null,
        cleanString(body.armadora, 160) || null,
        titulo,
        cleanText(body.descripcion) || null,
        normalizeKey(body.accion_sugerida, 180) || null,
        prioridad,
        estado,
        cleanString(body.responsable, 160) || null,
        cleanText(body.nota) || null,
        parseScore(body.score, 0),
        parsePositiveInt(body.total_eventos, 0, 999999),
        safeJson(body.metadata_json || body.metadata),
        parseDateOnly(body.fecha_limite),
        userLabel,
        userLabel,
        estado,
      ]
    );

    res.status(201).json({
      ok: true,
      message: "Pendiente comercial creado correctamente.",
      data: { id: result.insertId },
    });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        ok: false,
        error: "Ya existe un pendiente con esa referencia.",
      });
    }

    next(error);
  }
});

router.patch("/admin/pendientes-comerciales/:id", taskAccess, async (req, res, next) => {
  try {
    const id = parseOptionalInt(req.params.id);

    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const body = req.body || {};
    const updates = [];
    const params = [];

    const stringFields = [
      ["titulo", 260],
      ["descripcion", 4000],
      ["accion_sugerida", 180],
      ["responsable", 160],
      ["nota", 4000],
      ["codigo_andyfers", 80],
      ["codigo_importacion", 80],
      ["categoria_nombre", 160],
      ["familia", 160],
      ["armadora", 160],
    ];

    for (const [field, maxLength] of stringFields) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        updates.push(`${field} = ?`);
        params.push(maxLength > 1000 ? cleanText(body[field], maxLength) : cleanString(body[field], maxLength));
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "estado")) {
      const estado = normalizeEstado(body.estado, "NUEVO");
      updates.push("estado = ?");
      params.push(estado);
      updates.push("closed_at = CASE WHEN ? IN ('COMPLETADO', 'DESCARTADO') THEN COALESCE(closed_at, CURRENT_TIMESTAMP) ELSE NULL END");
      params.push(estado);
    }

    if (Object.prototype.hasOwnProperty.call(body, "prioridad")) {
      updates.push("prioridad = ?");
      params.push(normalizePrioridad(body.prioridad, "MEDIA"));
    }

    if (Object.prototype.hasOwnProperty.call(body, "score")) {
      updates.push("score = ?");
      params.push(parseScore(body.score, 0));
    }

    if (Object.prototype.hasOwnProperty.call(body, "total_eventos")) {
      updates.push("total_eventos = ?");
      params.push(parsePositiveInt(body.total_eventos, 0, 999999));
    }

    if (Object.prototype.hasOwnProperty.call(body, "producto_id")) {
      updates.push("producto_id = ?");
      params.push(parseOptionalInt(body.producto_id));
    }

    if (Object.prototype.hasOwnProperty.call(body, "fecha_limite")) {
      updates.push("fecha_limite = ?");
      params.push(parseDateOnly(body.fecha_limite));
    }

    if (Object.prototype.hasOwnProperty.call(body, "metadata") || Object.prototype.hasOwnProperty.call(body, "metadata_json")) {
      updates.push("metadata_json = ?");
      params.push(safeJson(body.metadata_json || body.metadata));
    }

    if (!updates.length) {
      return res.status(400).json({ ok: false, error: "No hay campos para actualizar." });
    }

    updates.push("actualizado_por = ?");
    params.push(getUserLabel(req));

    params.push(id);

    const [result] = await pool.query(
      `
      UPDATE catalogo_pendientes_comerciales
      SET ${updates.join(", ")}
      WHERE id = ?
      `,
      params
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, error: "Pendiente no encontrado." });
    }

    res.json({ ok: true, message: "Pendiente actualizado correctamente." });
  } catch (error) {
    next(error);
  }
});

router.delete("/admin/pendientes-comerciales/:id", taskAccess, async (req, res, next) => {
  try {
    const id = parseOptionalInt(req.params.id);

    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const [result] = await pool.query(
      `
      UPDATE catalogo_pendientes_comerciales
      SET
        estado = 'DESCARTADO',
        actualizado_por = ?,
        closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
      WHERE id = ?
      `,
      [getUserLabel(req), id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, error: "Pendiente no encontrado." });
    }

    res.json({ ok: true, message: "Pendiente descartado correctamente." });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/pendientes-comerciales/generar-calidad", taskAccess, async (req, res, next) => {
  try {
    const limit = parsePositiveInt(req.body?.limit || req.query.limit, 500, 5000);
    const userLabel = getUserLabel(req);

    const [result] = await pool.query(
      `
      INSERT INTO catalogo_pendientes_comerciales (
        tipo_pendiente,
        origen,
        referencia_tipo,
        referencia_key,
        producto_id,
        codigo_andyfers,
        codigo_importacion,
        categoria_nombre,
        familia,
        armadora,
        titulo,
        descripcion,
        accion_sugerida,
        prioridad,
        estado,
        score,
        total_eventos,
        metadata_json,
        primer_evento,
        ultimo_evento,
        creado_por,
        actualizado_por
      )
      SELECT
        generated.tipo_pendiente,
        generated.origen,
        generated.referencia_tipo,
        generated.referencia_key,
        generated.producto_id,
        generated.codigo_andyfers,
        generated.codigo_importacion,
        generated.categoria_nombre,
        generated.familia,
        generated.armadora,
        generated.titulo,
        generated.descripcion,
        generated.accion_sugerida,
        generated.prioridad,
        'NUEVO' AS estado,
        generated.score,
        generated.total_eventos,
        generated.metadata_json,
        CURRENT_TIMESTAMP AS primer_evento,
        CURRENT_TIMESTAMP AS ultimo_evento,
        ? AS creado_por,
        ? AS actualizado_por
      FROM (
        ${taskQualityUnionSql()}
      ) generated
      ORDER BY generated.score DESC, generated.tipo_pendiente ASC
      LIMIT ?
      ON DUPLICATE KEY UPDATE
        producto_id = VALUES(producto_id),
        codigo_andyfers = VALUES(codigo_andyfers),
        codigo_importacion = VALUES(codigo_importacion),
        categoria_nombre = VALUES(categoria_nombre),
        familia = VALUES(familia),
        armadora = VALUES(armadora),
        titulo = VALUES(titulo),
        descripcion = VALUES(descripcion),
        accion_sugerida = VALUES(accion_sugerida),
        prioridad = CASE
          WHEN catalogo_pendientes_comerciales.estado IN ('COMPLETADO', 'DESCARTADO') THEN catalogo_pendientes_comerciales.prioridad
          ELSE VALUES(prioridad)
        END,
        score = VALUES(score),
        total_eventos = VALUES(total_eventos),
        metadata_json = VALUES(metadata_json),
        ultimo_evento = CURRENT_TIMESTAMP,
        actualizado_por = VALUES(actualizado_por),
        updated_at = CURRENT_TIMESTAMP
      `,
      [userLabel, userLabel, limit]
    );

    res.json({
      ok: true,
      message: "Pendientes de calidad generados/sincronizados correctamente.",
      data: {
        affected_rows: result.affectedRows,
      },
    });
  } catch (error) {
    next(error);
  }
});


router.post("/admin/pendientes-comerciales/generar-analytics", taskAccess, async (req, res, next) => {
  try {
    const body = req.body || {};
    const limit = parsePositiveInt(body.limit || req.query.limit, 500, 5000);
    const userLabel = getUserLabel(req);
    const generated = analyticsTasksUnionSql({
      days: body.days || req.query.days,
      min_eventos: body.min_eventos || req.query.min_eventos,
    });

    const [result] = await pool.query(
      `
      INSERT INTO catalogo_pendientes_comerciales (
        tipo_pendiente,
        origen,
        referencia_tipo,
        referencia_key,
        producto_id,
        codigo_andyfers,
        codigo_importacion,
        categoria_nombre,
        familia,
        armadora,
        titulo,
        descripcion,
        accion_sugerida,
        prioridad,
        estado,
        score,
        total_eventos,
        metadata_json,
        primer_evento,
        ultimo_evento,
        creado_por,
        actualizado_por
      )
      SELECT
        generated.tipo_pendiente,
        generated.origen,
        generated.referencia_tipo,
        generated.referencia_key,
        generated.producto_id,
        generated.codigo_andyfers,
        generated.codigo_importacion,
        generated.categoria_nombre,
        generated.familia,
        generated.armadora,
        generated.titulo,
        generated.descripcion,
        generated.accion_sugerida,
        generated.prioridad,
        'NUEVO' AS estado,
        generated.score,
        generated.total_eventos,
        generated.metadata_json,
        generated.primer_evento,
        generated.ultimo_evento,
        ? AS creado_por,
        ? AS actualizado_por
      FROM (
        ${generated.sql}
      ) generated
      ORDER BY generated.score DESC, generated.total_eventos DESC, generated.tipo_pendiente ASC
      LIMIT ?
      ON DUPLICATE KEY UPDATE
        producto_id = VALUES(producto_id),
        codigo_andyfers = VALUES(codigo_andyfers),
        codigo_importacion = VALUES(codigo_importacion),
        categoria_nombre = VALUES(categoria_nombre),
        familia = VALUES(familia),
        armadora = VALUES(armadora),
        titulo = VALUES(titulo),
        descripcion = VALUES(descripcion),
        accion_sugerida = VALUES(accion_sugerida),
        prioridad = CASE
          WHEN catalogo_pendientes_comerciales.estado IN ('COMPLETADO', 'DESCARTADO') THEN catalogo_pendientes_comerciales.prioridad
          ELSE VALUES(prioridad)
        END,
        score = VALUES(score),
        total_eventos = VALUES(total_eventos),
        metadata_json = VALUES(metadata_json),
        primer_evento = COALESCE(catalogo_pendientes_comerciales.primer_evento, VALUES(primer_evento)),
        ultimo_evento = VALUES(ultimo_evento),
        actualizado_por = VALUES(actualizado_por),
        updated_at = CURRENT_TIMESTAMP
      `,
      [userLabel, userLabel, ...generated.params, limit]
    );

    res.json({
      ok: true,
      message: "Pendientes desde analítica generados/sincronizados correctamente.",
      data: {
        affected_rows: result.affectedRows,
        days: generated.days,
        min_eventos: generated.minEventos,
      },
    });
  } catch (error) {
    next(error);
  }
});


/* =========================================================
   M9.5 - ACCIONES OPERATIVAS DESDE PENDIENTES
   ========================================================= */

const VALID_OPERATIVE_ACTIONS = new Set([
  "EN_REVISION",
  "SOLICITAR_IMAGEN",
  "SOLICITAR_CRUCE",
  "COMPLETAR_PENDIENTE",
  "DESCARTAR_PENDIENTE",
  "COPIAR_DESCRIPCION_WEB",
  "OCULTAR_CATALOGO",
  "ACTIVAR_CATALOGO",
  "DESMARCAR_NUEVO",
  "DESMARCAR_DESTACADO",
]);

function buildActionNote(req, action, extraNote = "") {
  const user = getUserLabel(req);
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const cleanExtra = cleanText(extraNote, 1000);

  return `[${timestamp}] ${user}: acción ${action}${cleanExtra ? ` - ${cleanExtra}` : ""}`;
}

function appendNoteSql() {
  return `
    nota = CASE
      WHEN nota IS NULL OR TRIM(nota) = '' THEN ?
      ELSE CONCAT(nota, '\n', ?)
    END
  `;
}

async function getCommercialTaskById(connection, id) {
  const [rows] = await connection.query(
    `
    SELECT *
    FROM catalogo_pendientes_comerciales
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );

  return rows[0] || null;
}

async function getProductQualitySnapshot(connection, productoId) {
  if (!productoId) return null;

  const [rows] = await connection.query(
    `
    SELECT
      p.id,
      p.codigo_andyfers,
      p.codigo_importacion,
      p.descripcion,
      p.descripcion_web,
      p.familia,
      p.armadora,
      p.activo,
      p.activo_web,
      p.visible_catalogo,
      p.destacado,
      p.nuevo_web,
      c.nombre AS categoria_nombre,
      COALESCE(pm.total_imagenes, 0) AS total_imagenes,
      COALESCE(pc.total_cruces, 0) AS total_cruces,
      COALESCE(pa.total_aplicaciones, 0) AS total_aplicaciones,
      COALESCE(inv.stock_total_web, 0) AS stock_total_web,
      inv.precio_minimo
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    LEFT JOIN (
      SELECT producto_id, COUNT(*) AS total_imagenes
      FROM producto_multimedia
      WHERE activo = 1 AND tipo = 'IMAGEN'
      GROUP BY producto_id
    ) pm ON pm.producto_id = p.id
    LEFT JOIN (
      SELECT producto_id, COUNT(*) AS total_cruces
      FROM producto_cruces
      GROUP BY producto_id
    ) pc ON pc.producto_id = p.id
    LEFT JOIN (
      SELECT producto_id, COUNT(*) AS total_aplicaciones
      FROM producto_aplicaciones
      GROUP BY producto_id
    ) pa ON pa.producto_id = p.id
    LEFT JOIN (
      SELECT
        producto_id,
        COALESCE(SUM(CASE WHEN disponible_web = 1 THEN stock ELSE 0 END), 0) AS stock_total_web,
        MIN(CASE WHEN disponible_web = 1 THEN precio ELSE NULL END) AS precio_minimo
      FROM inventario
      GROUP BY producto_id
    ) inv ON inv.producto_id = p.id
    WHERE p.id = ?
    LIMIT 1
    `,
    [productoId]
  );

  return rows[0] || null;
}

router.get(
  "/admin/pendientes-comerciales/:id/producto-contexto",
  taskAccess,
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      const id = parseOptionalInt(req.params.id);

      if (!id) {
        return res.status(400).json({ ok: false, error: "ID inválido." });
      }

      const task = await getCommercialTaskById(connection, id);

      if (!task) {
        return res.status(404).json({ ok: false, error: "Pendiente no encontrado." });
      }

      const product = await getProductQualitySnapshot(connection, task.producto_id);

      res.json({
        ok: true,
        data: {
          pendiente: task,
          producto: product,
        },
      });
    } catch (error) {
      next(error);
    } finally {
      connection.release();
    }
  }
);

router.post(
  "/admin/pendientes-comerciales/:id/aplicar-accion",
  taskAccess,
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      const id = parseOptionalInt(req.params.id);
      const action = normalizeKey(req.body?.accion || req.body?.action, 80);
      const note = cleanText(req.body?.nota || req.body?.note, 1000);

      if (!id) {
        return res.status(400).json({ ok: false, error: "ID inválido." });
      }

      if (!VALID_OPERATIVE_ACTIONS.has(action)) {
        return res.status(400).json({ ok: false, error: "Acción operativa inválida." });
      }

      await connection.beginTransaction();

      const task = await getCommercialTaskById(connection, id);

      if (!task) {
        await connection.rollback();
        return res.status(404).json({ ok: false, error: "Pendiente no encontrado." });
      }

      const actionNote = buildActionNote(req, action, note);
      const user = getUserLabel(req);
      const productUpdates = [];
      const productParams = [];
      let nextEstado = null;
      let message = "Acción aplicada correctamente.";

      if (action === "EN_REVISION") {
        nextEstado = "EN_REVISION";
      }

      if (action === "SOLICITAR_IMAGEN") {
        nextEstado = "SOLICITAR_IMAGEN";
      }

      if (action === "SOLICITAR_CRUCE") {
        nextEstado = "SOLICITAR_CRUCE";
      }

      if (action === "COMPLETAR_PENDIENTE") {
        nextEstado = "COMPLETADO";
      }

      if (action === "DESCARTAR_PENDIENTE") {
        nextEstado = "DESCARTADO";
      }

      if (action === "COPIAR_DESCRIPCION_WEB") {
        if (!task.producto_id) {
          await connection.rollback();
          return res.status(400).json({ ok: false, error: "El pendiente no está vinculado a producto." });
        }

        productUpdates.push("descripcion_web = COALESCE(NULLIF(TRIM(descripcion_web), ''), descripcion)");
        nextEstado = "COMPLETADO";
        message = "Descripción web completada desde descripción base.";
      }

      if (action === "OCULTAR_CATALOGO") {
        if (!task.producto_id) {
          await connection.rollback();
          return res.status(400).json({ ok: false, error: "El pendiente no está vinculado a producto." });
        }

        productUpdates.push("visible_catalogo = 0");
        nextEstado = "COMPLETADO";
        message = "Producto ocultado del catálogo público.";
      }

      if (action === "ACTIVAR_CATALOGO") {
        if (!task.producto_id) {
          await connection.rollback();
          return res.status(400).json({ ok: false, error: "El pendiente no está vinculado a producto." });
        }

        productUpdates.push("activo_web = 1", "visible_catalogo = 1");
        nextEstado = "COMPLETADO";
        message = "Producto activado/visible en catálogo público.";
      }

      if (action === "DESMARCAR_NUEVO") {
        if (!task.producto_id) {
          await connection.rollback();
          return res.status(400).json({ ok: false, error: "El pendiente no está vinculado a producto." });
        }

        productUpdates.push("nuevo_web = 0");
        nextEstado = "COMPLETADO";
        message = "Producto desmarcado como nuevo.";
      }

      if (action === "DESMARCAR_DESTACADO") {
        if (!task.producto_id) {
          await connection.rollback();
          return res.status(400).json({ ok: false, error: "El pendiente no está vinculado a producto." });
        }

        productUpdates.push("destacado = 0");
        nextEstado = "COMPLETADO";
        message = "Producto desmarcado como destacado.";
      }

      if (productUpdates.length) {
        productParams.push(task.producto_id);

        await connection.query(
          `
          UPDATE productos
          SET ${productUpdates.join(", ")}, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          productParams
        );
      }

      const closedSql = ["COMPLETADO", "DESCARTADO"].includes(nextEstado)
        ? ", closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)"
        : ", closed_at = NULL";

      await connection.query(
        `
        UPDATE catalogo_pendientes_comerciales
        SET
          ${nextEstado ? "estado = ?," : ""}
          actualizado_por = ?,
          ${appendNoteSql()}
          ${closedSql}
        WHERE id = ?
        `,
        nextEstado
          ? [nextEstado, user, actionNote, actionNote, id]
          : [user, actionNote, actionNote, id]
      );

      await connection.commit();

      const updatedTask = await getCommercialTaskById(connection, id);
      const product = await getProductQualitySnapshot(connection, updatedTask?.producto_id);

      res.json({
        ok: true,
        message,
        data: {
          pendiente: updatedTask,
          producto: product,
          accion: action,
        },
      });
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }
);

export default router;
