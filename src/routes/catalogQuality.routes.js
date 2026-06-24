import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";

const router = Router();
const adminQualityAccess = [requireAdminAuth, requireRole(["ADMIN", "VENTAS"])] ;

function cleanString(value, maxLength = 320) {
  if (value === undefined || value === null) return "";

  return String(value)
    .trim()
    .replace(/\s+/g, " ")
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

function parseBooleanFilter(value) {
  if (value === undefined || value === null || value === "") return null;

  const clean = String(value).trim().toLowerCase();

  if (["1", "true", "si", "sí", "yes", "activo"].includes(clean)) return 1;
  if (["0", "false", "no", "inactivo"].includes(clean)) return 0;

  return null;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function defaultDesde() {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}

function defaultHasta() {
  return new Date().toISOString().slice(0, 10);
}

function getDateRange(query = {}) {
  const desde = isValidDate(query.desde) ? query.desde : defaultDesde();
  const hasta = isValidDate(query.hasta) ? query.hasta : defaultHasta();

  return { desde, hasta };
}

function normalizeIssue(value) {
  return cleanString(value, 80)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function invalidCodeSql(column) {
  return `
    (
      ${column} IS NULL
      OR TRIM(${column}) = ''
      OR UPPER(TRIM(${column})) IN (
        '#N/A', 'N/A', 'NA', 'ND', 'N.D.', 'NULL', '0',
        'SIN CODIGO', 'SIN CÓDIGO', 'SIN-CODIGO', 'SIN-CÓDIGO'
      )
    )
  `;
}

const flagSql = {
  sin_imagen: `
    (
      COALESCE(pm.total_imagenes, 0) = 0
      AND (p.imagen_url IS NULL OR TRIM(p.imagen_url) = '')
    )
  `,
  sin_descripcion_web: `
    (
      p.descripcion_web IS NULL
      OR TRIM(p.descripcion_web) = ''
      OR CHAR_LENGTH(TRIM(p.descripcion_web)) < 20
    )
  `,
  sin_cruces: `COALESCE(pc.total_cruces, 0) = 0`,
  sin_aplicaciones: `COALESCE(pa.total_aplicaciones, 0) = 0`,
  sin_atributos_buscables: `COALESCE(pat.total_atributos_buscables, 0) = 0`,
  sin_familia: `(p.familia IS NULL OR TRIM(p.familia) = '')`,
  sin_imagen_principal: `COALESCE(pm.total_principales, 0) = 0`,
  sin_thumbnail: `(
    COALESCE(pm.total_imagenes, 0) > 0
    AND COALESCE(pm.total_thumbnails, 0) = 0
  )`,
  sin_stock: `COALESCE(inv.stock_total_web, 0) <= 0`,
  sin_precio: `(inv.precio_minimo IS NULL OR inv.precio_minimo <= 0)`,
  codigo_sospechoso: `
    (
      ${invalidCodeSql("p.codigo_andyfers")}
      AND ${invalidCodeSql("p.codigo_importacion")}
    )
  `,
};

flagSql.visible_incompleto = `
  (
    p.activo = 1
    AND p.activo_web = 1
    AND p.visible_catalogo = 1
    AND (
      ${flagSql.sin_imagen}
      OR ${flagSql.sin_imagen_principal}
      OR ${flagSql.sin_descripcion_web}
      OR ${flagSql.sin_cruces}
      OR ${flagSql.sin_aplicaciones}
      OR ${flagSql.sin_atributos_buscables}
      OR ${flagSql.sin_familia}
      OR ${flagSql.codigo_sospechoso}
    )
  )
`;

flagSql.consultado_sin_imagen = `
  (
    ${flagSql.sin_imagen}
    AND COALESCE(an.total_consultas, 0) > 0
  )
`;

flagSql.cotizado_sin_imagen = `
  (
    ${flagSql.sin_imagen}
    AND COALESCE(an.total_agregados_cotizacion, 0) > 0
  )
`;

function productQualityBaseSql({ includeAnalytics = true } = {}) {
  const range = getDateRange({});

  return `
    FROM productos p
    LEFT JOIN categorias c
      ON c.id = p.categoria_id
    LEFT JOIN (
      SELECT
        producto_id,
        COUNT(*) AS total_imagenes,
        SUM(CASE WHEN rol = 'PRINCIPAL' THEN 1 ELSE 0 END) AS total_principales,
        SUM(CASE WHEN thumbnail_url IS NOT NULL AND TRIM(thumbnail_url) <> '' THEN 1 ELSE 0 END) AS total_thumbnails
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
        COUNT(*) AS total_atributos,
        SUM(CASE WHEN buscable = 1 THEN 1 ELSE 0 END) AS total_atributos_buscables,
        SUM(CASE WHEN visible_web = 1 THEN 1 ELSE 0 END) AS total_atributos_visibles
      FROM producto_atributos
      GROUP BY producto_id
    ) pat
      ON pat.producto_id = p.id
    LEFT JOIN (
      SELECT
        producto_id,
        COALESCE(SUM(CASE WHEN disponible_web = 1 THEN stock ELSE 0 END), 0) AS stock_total_web,
        MIN(CASE WHEN disponible_web = 1 THEN precio ELSE NULL END) AS precio_minimo
      FROM inventario
      GROUP BY producto_id
    ) inv
      ON inv.producto_id = p.id
    ${
      includeAnalytics
        ? `
          LEFT JOIN (
            SELECT
              producto_id,
              SUM(CASE WHEN evento = 'PRODUCTO_CONSULTADO' THEN 1 ELSE 0 END) AS total_consultas,
              SUM(CASE WHEN evento = 'PRODUCTO_AGREGADO_COTIZACION' THEN 1 ELSE 0 END) AS total_agregados_cotizacion,
              COUNT(DISTINCT CASE WHEN evento = 'COTIZACION_GENERADA' THEN cotizacion_id ELSE NULL END) AS total_cotizaciones,
              MAX(fecha_evento) AS ultimo_evento
            FROM analytics_eventos
            WHERE producto_id IS NOT NULL
              AND fecha_evento >= '${range.desde}'
              AND fecha_evento < DATE_ADD('${range.hasta}', INTERVAL 1 DAY)
            GROUP BY producto_id
          ) an
            ON an.producto_id = p.id
        `
        : `
          LEFT JOIN (
            SELECT
              NULL AS producto_id,
              0 AS total_consultas,
              0 AS total_agregados_cotizacion,
              0 AS total_cotizaciones,
              NULL AS ultimo_evento
          ) an
            ON an.producto_id = p.id
        `
    }
  `;
}

function productQualitySelectSql() {
  return `
    SELECT
      p.id,
      p.codigo_andyfers,
      p.codigo_importacion,
      p.categoria_id,
      c.nombre AS categoria,
      p.clasif_vta,
      p.armadora,
      p.familia,
      p.descripcion,
      p.descripcion_web,
      p.marca_producto,
      p.tipo_marca_producto,
      p.destacado,
      p.nuevo_web,
      p.visible_catalogo,
      p.activo_web,
      p.activo,
      p.created_at,
      p.updated_at,

      COALESCE(pm.total_imagenes, 0) AS total_imagenes,
      COALESCE(pm.total_principales, 0) AS total_imagenes_principales,
      COALESCE(pm.total_thumbnails, 0) AS total_thumbnails,
      COALESCE(pc.total_cruces, 0) AS total_cruces,
      COALESCE(pa.total_aplicaciones, 0) AS total_aplicaciones,
      COALESCE(pat.total_atributos, 0) AS total_atributos,
      COALESCE(pat.total_atributos_buscables, 0) AS total_atributos_buscables,
      COALESCE(pat.total_atributos_visibles, 0) AS total_atributos_visibles,
      COALESCE(inv.stock_total_web, 0) AS stock_total_web,
      inv.precio_minimo,

      COALESCE(an.total_consultas, 0) AS total_consultas,
      COALESCE(an.total_agregados_cotizacion, 0) AS total_agregados_cotizacion,
      COALESCE(an.total_cotizaciones, 0) AS total_cotizaciones,
      an.ultimo_evento,

      CASE WHEN ${flagSql.sin_imagen} THEN 1 ELSE 0 END AS sin_imagen,
      CASE WHEN ${flagSql.sin_descripcion_web} THEN 1 ELSE 0 END AS sin_descripcion_web,
      CASE WHEN ${flagSql.sin_cruces} THEN 1 ELSE 0 END AS sin_cruces,
      CASE WHEN ${flagSql.sin_aplicaciones} THEN 1 ELSE 0 END AS sin_aplicaciones,
      CASE WHEN ${flagSql.sin_atributos_buscables} THEN 1 ELSE 0 END AS sin_atributos_buscables,
      CASE WHEN ${flagSql.sin_familia} THEN 1 ELSE 0 END AS sin_familia,
      CASE WHEN ${flagSql.sin_imagen_principal} THEN 1 ELSE 0 END AS sin_imagen_principal,
      CASE WHEN ${flagSql.sin_thumbnail} THEN 1 ELSE 0 END AS sin_thumbnail,
      CASE WHEN ${flagSql.sin_stock} THEN 1 ELSE 0 END AS sin_stock,
      CASE WHEN ${flagSql.sin_precio} THEN 1 ELSE 0 END AS sin_precio,
      CASE WHEN ${flagSql.codigo_sospechoso} THEN 1 ELSE 0 END AS codigo_sospechoso,
      CASE WHEN ${flagSql.visible_incompleto} THEN 1 ELSE 0 END AS visible_incompleto,
      CASE
        WHEN p.activo = 1 AND p.activo_web = 1 AND p.visible_catalogo = 1 AND ${flagSql.visible_incompleto} THEN 'CRITICO'
        WHEN ${flagSql.sin_imagen} OR ${flagSql.sin_imagen_principal} OR ${flagSql.codigo_sospechoso} THEN 'ALTA'
        WHEN ${flagSql.sin_descripcion_web} OR ${flagSql.sin_cruces} OR ${flagSql.sin_aplicaciones} OR ${flagSql.sin_atributos_buscables} THEN 'MEDIA'
        ELSE 'OK'
      END AS severidad_calidad,
      CASE
        WHEN ${flagSql.sin_imagen} THEN 'Subir imagen principal del producto'
        WHEN ${flagSql.sin_imagen_principal} THEN 'Marcar una imagen como principal'
        WHEN ${flagSql.codigo_sospechoso} THEN 'Corregir código Andyfers/importación'
        WHEN ${flagSql.sin_descripcion_web} THEN 'Completar descripción web'
        WHEN ${flagSql.sin_cruces} THEN 'Agregar cruces equivalentes'
        WHEN ${flagSql.sin_aplicaciones} THEN 'Agregar aplicaciones vehiculares'
        WHEN ${flagSql.sin_atributos_buscables} THEN 'Agregar atributos buscables'
        WHEN ${flagSql.sin_familia} THEN 'Asignar familia'
        WHEN ${flagSql.sin_thumbnail} THEN 'Regenerar thumbnail'
        ELSE 'Sin acción crítica'
      END AS accion_sugerida,

      (
        CASE WHEN ${flagSql.sin_imagen} THEN 40 ELSE 0 END +
        CASE WHEN ${flagSql.sin_imagen_principal} THEN 25 ELSE 0 END +
        CASE WHEN ${flagSql.sin_thumbnail} THEN 8 ELSE 0 END +
        CASE WHEN ${flagSql.sin_descripcion_web} THEN 12 ELSE 0 END +
        CASE WHEN ${flagSql.sin_cruces} THEN 18 ELSE 0 END +
        CASE WHEN ${flagSql.sin_aplicaciones} THEN 18 ELSE 0 END +
        CASE WHEN ${flagSql.sin_atributos_buscables} THEN 12 ELSE 0 END +
        CASE WHEN ${flagSql.sin_familia} THEN 20 ELSE 0 END +
        CASE WHEN ${flagSql.sin_stock} THEN 8 ELSE 0 END +
        CASE WHEN ${flagSql.sin_precio} THEN 6 ELSE 0 END +
        CASE WHEN ${flagSql.codigo_sospechoso} THEN 30 ELSE 0 END +
        LEAST(COALESCE(an.total_consultas, 0) * 3, 45) +
        LEAST(COALESCE(an.total_agregados_cotizacion, 0) * 8, 80) +
        CASE WHEN p.destacado = 1 THEN 15 ELSE 0 END +
        CASE WHEN p.nuevo_web = 1 THEN 10 ELSE 0 END
      ) AS prioridad_calidad
  `;
}

function buildProductFilters(query = {}) {
  const clauses = ["p.activo = 1"];
  const params = [];

  const q = cleanString(query.q, 160);
  const categoriaId = parseOptionalInt(query.categoria_id);
  const familia = cleanString(query.familia, 160);
  const armadora = cleanString(query.armadora, 160);
  const clasifVta = cleanString(query.clasif_vta, 160);
  const issue = normalizeIssue(query.issue || query.estado_calidad);
  const activoWeb = parseBooleanFilter(query.activo_web);
  const visibleCatalogo = parseBooleanFilter(query.visible_catalogo);
  const destacado = parseBooleanFilter(query.destacado);
  const nuevoWeb = parseBooleanFilter(query.nuevo_web);

  if (q) {
    clauses.push(`
      (
        p.codigo_andyfers LIKE ?
        OR p.codigo_importacion LIKE ?
        OR p.descripcion LIKE ?
        OR p.descripcion_web LIKE ?
        OR p.familia LIKE ?
        OR p.armadora LIKE ?
        OR c.nombre LIKE ?
      )
    `);

    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }

  if (categoriaId) {
    clauses.push("p.categoria_id = ?");
    params.push(categoriaId);
  }

  if (familia) {
    clauses.push("p.familia = ?");
    params.push(familia);
  }

  if (armadora) {
    clauses.push("p.armadora = ?");
    params.push(armadora);
  }

  if (clasifVta) {
    clauses.push("p.clasif_vta = ?");
    params.push(clasifVta);
  }

  if (activoWeb !== null) {
    clauses.push("p.activo_web = ?");
    params.push(activoWeb);
  }

  if (visibleCatalogo !== null) {
    clauses.push("p.visible_catalogo = ?");
    params.push(visibleCatalogo);
  }

  if (destacado !== null) {
    clauses.push("p.destacado = ?");
    params.push(destacado);
  }

  if (nuevoWeb !== null) {
    clauses.push("p.nuevo_web = ?");
    params.push(nuevoWeb);
  }

  const issueMap = {
    SIN_IMAGEN: flagSql.sin_imagen,
    SIN_DESCRIPCION: flagSql.sin_descripcion_web,
    SIN_DESCRIPCION_WEB: flagSql.sin_descripcion_web,
    SIN_CRUCES: flagSql.sin_cruces,
    SIN_APLICACIONES: flagSql.sin_aplicaciones,
    SIN_ATRIBUTOS_BUSCABLES: flagSql.sin_atributos_buscables,
    SIN_FAMILIA: flagSql.sin_familia,
    SIN_IMAGEN_PRINCIPAL: flagSql.sin_imagen_principal,
    SIN_THUMBNAIL: flagSql.sin_thumbnail,
    SIN_STOCK: flagSql.sin_stock,
    SIN_PRECIO: flagSql.sin_precio,
    CODIGO_SOSPECHOSO: flagSql.codigo_sospechoso,
    VISIBLE_INCOMPLETO: flagSql.visible_incompleto,
    CONSULTADO_SIN_IMAGEN: flagSql.consultado_sin_imagen,
    COTIZADO_SIN_IMAGEN: flagSql.cotizado_sin_imagen,
  };

  if (issue && issueMap[issue]) {
    clauses.push(`(${issueMap[issue]})`);
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
    issue,
  };
}

function resolveOrder(query = {}) {
  const order = normalizeIssue(query.order || query.orden || "PRIORIDAD");

  const orders = {
    PRIORIDAD: "prioridad_calidad DESC, total_agregados_cotizacion DESC, total_consultas DESC, p.updated_at DESC",
    CODIGO: "p.codigo_andyfers ASC, p.codigo_importacion ASC",
    CATEGORIA: "c.nombre ASC, p.familia ASC, p.codigo_andyfers ASC",
    RECIENTES: "p.updated_at DESC, p.id DESC",
    CONSULTAS: "total_consultas DESC, prioridad_calidad DESC",
    COTIZACIONES: "total_agregados_cotizacion DESC, prioridad_calidad DESC",
  };

  return orders[order] || orders.PRIORIDAD;
}

function toNumber(value) {
  const number = Number(value || 0);

  return Number.isFinite(number) ? number : 0;
}

function buildCatalogCloseStatus(kpis = {}) {
  const totalPublicados = toNumber(kpis.publicados_web);
  const visiblesIncompletos = toNumber(kpis.visibles_incompletos);
  const cotizadosSinImagen = toNumber(kpis.cotizados_sin_imagen);
  const codigoSospechoso = toNumber(kpis.codigo_sospechoso);
  const sinImagen = toNumber(kpis.sin_imagen);
  const sinImagenPrincipal = toNumber(kpis.sin_imagen_principal);
  const sinAtributosBuscables = toNumber(kpis.sin_atributos_buscables);
  const sinFamilia = toNumber(kpis.sin_familia);

  const bloqueantes = [];
  const advertencias = [];

  if (totalPublicados <= 0) {
    bloqueantes.push({
      key: "SIN_PRODUCTOS_PUBLICADOS",
      label: "No hay productos publicados en catálogo web.",
      action: "Validar activo_web y visible_catalogo antes de publicar.",
    });
  }

  if (visiblesIncompletos > 0) {
    bloqueantes.push({
      key: "VISIBLES_INCOMPLETOS",
      label: `${visiblesIncompletos} productos visibles están incompletos.`,
      action: "Revisar la tabla priorizada y corregir producto por producto desde admin.",
    });
  }

  if (cotizadosSinImagen > 0) {
    bloqueantes.push({
      key: "COTIZADOS_SIN_IMAGEN",
      label: `${cotizadosSinImagen} productos cotizados/agregados no tienen imagen.`,
      action: "Subir imagen principal a los productos con demanda antes de publicar.",
    });
  }

  if (codigoSospechoso > 0) {
    bloqueantes.push({
      key: "CODIGO_SOSPECHOSO",
      label: `${codigoSospechoso} productos tienen código sospechoso o vacío.`,
      action: "Corregir código Andyfers o código de importación.",
    });
  }

  if (sinImagen > 0) {
    advertencias.push({
      key: "SIN_IMAGEN",
      label: `${sinImagen} productos activos no tienen imagen cargada.`,
      action: "Completar imágenes por prioridad comercial.",
    });
  }

  if (sinImagenPrincipal > 0) {
    advertencias.push({
      key: "SIN_IMAGEN_PRINCIPAL",
      label: `${sinImagenPrincipal} productos no tienen imagen principal definida.`,
      action: "Asignar una imagen principal desde el panel de multimedia.",
    });
  }

  if (sinAtributosBuscables > 0) {
    advertencias.push({
      key: "SIN_ATRIBUTOS_BUSCABLES",
      label: `${sinAtributosBuscables} productos no tienen atributos buscables.`,
      action: "Agregar atributos útiles para búsqueda y filtros.",
    });
  }

  if (sinFamilia > 0) {
    advertencias.push({
      key: "SIN_FAMILIA",
      label: `${sinFamilia} productos no tienen familia asignada.`,
      action: "Asignar familia para mejorar navegación y filtros.",
    });
  }

  return {
    apto_publicacion: bloqueantes.length === 0,
    estado: bloqueantes.length ? "NO_APTO" : advertencias.length ? "APTO_CON_OBSERVACIONES" : "APTO",
    bloqueantes,
    advertencias,
    reglas: [
      "Debe existir al menos un producto publicado en web.",
      "No debe haber productos visibles incompletos.",
      "No debe haber productos cotizados/agregados sin imagen.",
      "No debe haber códigos sospechosos en productos activos.",
    ],
  };
}


router.get(
  "/admin/catalogo-calidad/cierre",
  adminQualityAccess,
  async (req, res, next) => {
    try {
      const baseSql = productQualityBaseSql();

      const [summaryRows] = await pool.query(
        `
        SELECT
          COUNT(*) AS total_productos_activos,
          SUM(CASE WHEN p.activo_web = 1 THEN 1 ELSE 0 END) AS activos_web,
          SUM(CASE WHEN p.visible_catalogo = 1 THEN 1 ELSE 0 END) AS visibles_catalogo,
          SUM(CASE WHEN p.activo_web = 1 AND p.visible_catalogo = 1 THEN 1 ELSE 0 END) AS publicados_web,
          SUM(CASE WHEN ${flagSql.sin_imagen} THEN 1 ELSE 0 END) AS sin_imagen,
          SUM(CASE WHEN ${flagSql.sin_imagen_principal} THEN 1 ELSE 0 END) AS sin_imagen_principal,
          SUM(CASE WHEN ${flagSql.sin_thumbnail} THEN 1 ELSE 0 END) AS sin_thumbnail,
          SUM(CASE WHEN ${flagSql.sin_descripcion_web} THEN 1 ELSE 0 END) AS sin_descripcion_web,
          SUM(CASE WHEN ${flagSql.sin_cruces} THEN 1 ELSE 0 END) AS sin_cruces,
          SUM(CASE WHEN ${flagSql.sin_aplicaciones} THEN 1 ELSE 0 END) AS sin_aplicaciones,
          SUM(CASE WHEN ${flagSql.sin_atributos_buscables} THEN 1 ELSE 0 END) AS sin_atributos_buscables,
          SUM(CASE WHEN ${flagSql.sin_familia} THEN 1 ELSE 0 END) AS sin_familia,
          SUM(CASE WHEN ${flagSql.sin_stock} THEN 1 ELSE 0 END) AS sin_stock,
          SUM(CASE WHEN ${flagSql.sin_precio} THEN 1 ELSE 0 END) AS sin_precio,
          SUM(CASE WHEN ${flagSql.codigo_sospechoso} THEN 1 ELSE 0 END) AS codigo_sospechoso,
          SUM(CASE WHEN ${flagSql.visible_incompleto} THEN 1 ELSE 0 END) AS visibles_incompletos,
          SUM(CASE WHEN ${flagSql.consultado_sin_imagen} THEN 1 ELSE 0 END) AS consultados_sin_imagen,
          SUM(CASE WHEN ${flagSql.cotizado_sin_imagen} THEN 1 ELSE 0 END) AS cotizados_sin_imagen
        ${baseSql}
        WHERE p.activo = 1
        `
      );

      const [criticalRows] = await pool.query(
        `
        ${productQualitySelectSql()}
        ${baseSql}
        WHERE p.activo = 1
          AND p.activo_web = 1
          AND p.visible_catalogo = 1
          AND (${flagSql.visible_incompleto})
        ORDER BY prioridad_calidad DESC, total_agregados_cotizacion DESC, total_consultas DESC, p.updated_at DESC
        LIMIT 25
        `
      );

      const [manualRows] = await pool.query(
        `
        SELECT
          estado,
          prioridad,
          tipo_pendiente,
          COUNT(*) AS total
        FROM catalogo_pendientes_comerciales
        WHERE estado NOT IN ('CERRADO', 'DESCARTADO')
        GROUP BY estado, prioridad, tipo_pendiente
        ORDER BY
          FIELD(prioridad, 'CRITICA', 'ALTA', 'MEDIA', 'BAJA'),
          total DESC,
          tipo_pendiente ASC
        LIMIT 40
        `
      );

      const kpis = summaryRows[0] || {};
      const cierre = buildCatalogCloseStatus(kpis);

      res.json({
        ok: true,
        data: {
          generado_en: new Date().toISOString(),
          kpis,
          cierre,
          productos_criticos: criticalRows,
          pendientes_manuales: manualRows,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/catalogo-calidad/resumen",
  adminQualityAccess,
  async (req, res, next) => {
    try {
      const baseSql = productQualityBaseSql();

      const [summaryRows] = await pool.query(
        `
        SELECT
          COUNT(*) AS total_productos_activos,
          SUM(CASE WHEN p.activo_web = 1 THEN 1 ELSE 0 END) AS activos_web,
          SUM(CASE WHEN p.visible_catalogo = 1 THEN 1 ELSE 0 END) AS visibles_catalogo,
          SUM(CASE WHEN p.activo_web = 1 AND p.visible_catalogo = 1 THEN 1 ELSE 0 END) AS publicados_web,

          SUM(CASE WHEN ${flagSql.sin_imagen} THEN 1 ELSE 0 END) AS sin_imagen,
          SUM(CASE WHEN ${flagSql.sin_descripcion_web} THEN 1 ELSE 0 END) AS sin_descripcion_web,
          SUM(CASE WHEN ${flagSql.sin_cruces} THEN 1 ELSE 0 END) AS sin_cruces,
          SUM(CASE WHEN ${flagSql.sin_aplicaciones} THEN 1 ELSE 0 END) AS sin_aplicaciones,
          SUM(CASE WHEN ${flagSql.sin_atributos_buscables} THEN 1 ELSE 0 END) AS sin_atributos_buscables,
          SUM(CASE WHEN ${flagSql.sin_familia} THEN 1 ELSE 0 END) AS sin_familia,
          SUM(CASE WHEN ${flagSql.sin_imagen_principal} THEN 1 ELSE 0 END) AS sin_imagen_principal,
          SUM(CASE WHEN ${flagSql.sin_thumbnail} THEN 1 ELSE 0 END) AS sin_thumbnail,
          SUM(CASE WHEN ${flagSql.sin_stock} THEN 1 ELSE 0 END) AS sin_stock,
          SUM(CASE WHEN ${flagSql.sin_precio} THEN 1 ELSE 0 END) AS sin_precio,
          SUM(CASE WHEN ${flagSql.codigo_sospechoso} THEN 1 ELSE 0 END) AS codigo_sospechoso,
          SUM(CASE WHEN ${flagSql.visible_incompleto} THEN 1 ELSE 0 END) AS visibles_incompletos,
          SUM(CASE WHEN ${flagSql.consultado_sin_imagen} THEN 1 ELSE 0 END) AS consultados_sin_imagen,
          SUM(CASE WHEN ${flagSql.cotizado_sin_imagen} THEN 1 ELSE 0 END) AS cotizados_sin_imagen
        ${baseSql}
        WHERE p.activo = 1
        `
      );

      const [categoryRows] = await pool.query(
        `
        SELECT
          c.id AS categoria_id,
          COALESCE(c.nombre, 'SIN_CATEGORIA') AS categoria,
          COUNT(*) AS total_productos,
          SUM(CASE WHEN p.activo_web = 1 AND p.visible_catalogo = 1 THEN 1 ELSE 0 END) AS publicados_web,
          SUM(CASE WHEN ${flagSql.sin_imagen} THEN 1 ELSE 0 END) AS sin_imagen,
          SUM(CASE WHEN ${flagSql.sin_descripcion_web} THEN 1 ELSE 0 END) AS sin_descripcion_web,
          SUM(CASE WHEN ${flagSql.sin_cruces} THEN 1 ELSE 0 END) AS sin_cruces,
          SUM(CASE WHEN ${flagSql.sin_aplicaciones} THEN 1 ELSE 0 END) AS sin_aplicaciones,
          SUM(CASE WHEN ${flagSql.sin_atributos_buscables} THEN 1 ELSE 0 END) AS sin_atributos_buscables,
          SUM(CASE WHEN ${flagSql.sin_imagen_principal} THEN 1 ELSE 0 END) AS sin_imagen_principal,
          SUM(CASE WHEN ${flagSql.visible_incompleto} THEN 1 ELSE 0 END) AS visibles_incompletos
        ${baseSql}
        WHERE p.activo = 1
        GROUP BY c.id, c.nombre
        ORDER BY visibles_incompletos DESC, sin_imagen DESC, categoria ASC
        `
      );

      const [familyRows] = await pool.query(
        `
        SELECT
          COALESCE(NULLIF(p.familia, ''), 'SIN_FAMILIA') AS familia,
          COUNT(*) AS total_productos,
          SUM(CASE WHEN ${flagSql.sin_imagen} THEN 1 ELSE 0 END) AS sin_imagen,
          SUM(CASE WHEN ${flagSql.sin_cruces} THEN 1 ELSE 0 END) AS sin_cruces,
          SUM(CASE WHEN ${flagSql.sin_aplicaciones} THEN 1 ELSE 0 END) AS sin_aplicaciones,
          SUM(CASE WHEN ${flagSql.sin_atributos_buscables} THEN 1 ELSE 0 END) AS sin_atributos_buscables,
          SUM(CASE WHEN ${flagSql.sin_imagen_principal} THEN 1 ELSE 0 END) AS sin_imagen_principal,
          SUM(CASE WHEN ${flagSql.visible_incompleto} THEN 1 ELSE 0 END) AS visibles_incompletos
        ${baseSql}
        WHERE p.activo = 1
        GROUP BY COALESCE(NULLIF(p.familia, ''), 'SIN_FAMILIA')
        ORDER BY visibles_incompletos DESC, sin_imagen DESC, familia ASC
        LIMIT 20
        `
      );

      res.json({
        ok: true,
        data: {
          kpis: summaryRows[0] || {},
          por_categoria: categoryRows,
          familias_criticas: familyRows,
          issues_disponibles: [
            "SIN_IMAGEN",
            "SIN_DESCRIPCION_WEB",
            "SIN_CRUCES",
            "SIN_APLICACIONES",
            "SIN_ATRIBUTOS_BUSCABLES",
            "SIN_FAMILIA",
            "SIN_IMAGEN_PRINCIPAL",
            "SIN_THUMBNAIL",
            "SIN_STOCK",
            "SIN_PRECIO",
            "CODIGO_SOSPECHOSO",
            "VISIBLE_INCOMPLETO",
            "CONSULTADO_SIN_IMAGEN",
            "COTIZADO_SIN_IMAGEN",
          ],
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/catalogo-calidad/productos",
  adminQualityAccess,
  async (req, res, next) => {
    try {
      const limit = parsePositiveInt(req.query.limit, 50, 500);
      const filters = buildProductFilters(req.query);
      const baseSql = productQualityBaseSql();
      const orderSql = resolveOrder(req.query);

      const [rows] = await pool.query(
        `
        ${productQualitySelectSql()}
        ${baseSql}
        ${filters.sql}
        ORDER BY ${orderSql}
        LIMIT ?
        `,
        [...filters.params, limit]
      );

      res.json({
        ok: true,
        data: rows,
        meta: {
          limit,
          issue: filters.issue || null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/catalogo-calidad/sin-imagen",
  adminQualityAccess,
  async (req, res, next) => {
    try {
      req.query.issue = "SIN_IMAGEN";
      const limit = parsePositiveInt(req.query.limit, 200, 1000);
      const filters = buildProductFilters(req.query);
      const baseSql = productQualityBaseSql();

      const [rows] = await pool.query(
        `
        ${productQualitySelectSql()}
        ${baseSql}
        ${filters.sql}
        ORDER BY total_agregados_cotizacion DESC, total_consultas DESC, c.nombre ASC, p.familia ASC, p.codigo_andyfers ASC
        LIMIT ?
        `,
        [...filters.params, limit]
      );

      res.json({
        ok: true,
        data: rows,
        meta: {
          limit,
          issue: "SIN_IMAGEN",
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/catalogo-calidad/incompletos",
  adminQualityAccess,
  async (req, res, next) => {
    try {
      req.query.issue = req.query.issue || "VISIBLE_INCOMPLETO";
      const limit = parsePositiveInt(req.query.limit, 200, 1000);
      const filters = buildProductFilters(req.query);
      const baseSql = productQualityBaseSql();

      const [rows] = await pool.query(
        `
        ${productQualitySelectSql()}
        ${baseSql}
        ${filters.sql}
        ORDER BY prioridad_calidad DESC, total_agregados_cotizacion DESC, total_consultas DESC, p.updated_at DESC
        LIMIT ?
        `,
        [...filters.params, limit]
      );

      res.json({
        ok: true,
        data: rows,
        meta: {
          limit,
          issue: filters.issue || "VISIBLE_INCOMPLETO",
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/catalogo-calidad/opciones",
  adminQualityAccess,
  async (req, res, next) => {
    try {
      const [categorias] = await pool.query(
        `
        SELECT id, nombre
        FROM categorias
        WHERE activo = 1
        ORDER BY nombre ASC
        `
      );

      const [familias] = await pool.query(
        `
        SELECT DISTINCT familia
        FROM productos
        WHERE activo = 1
          AND familia IS NOT NULL
          AND TRIM(familia) <> ''
        ORDER BY familia ASC
        `
      );

      const [armadoras] = await pool.query(
        `
        SELECT DISTINCT armadora
        FROM productos
        WHERE activo = 1
          AND armadora IS NOT NULL
          AND TRIM(armadora) <> ''
        ORDER BY armadora ASC
        LIMIT 300
        `
      );

      res.json({
        ok: true,
        data: {
          categorias,
          familias: familias.map((row) => row.familia),
          armadoras: armadoras.map((row) => row.armadora),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/catalogo-calidad/oportunidades",
  adminQualityAccess,
  async (req, res, next) => {
    try {
      const range = getDateRange(req.query);
      const limit = parsePositiveInt(req.query.limit, 50, 300);

      const [productosSinImagenConDemanda] = await pool.query(
        `
        SELECT
          p.id,
          p.codigo_andyfers,
          p.codigo_importacion,
          c.nombre AS categoria,
          p.familia,
          p.armadora,
          p.descripcion,
          COALESCE(an.total_consultas, 0) AS total_consultas,
          COALESCE(an.total_agregados_cotizacion, 0) AS total_agregados_cotizacion,
          COALESCE(an.total_cotizaciones, 0) AS total_cotizaciones,
          an.ultimo_evento,
          (
            COALESCE(an.total_consultas, 0) * 3 +
            COALESCE(an.total_agregados_cotizacion, 0) * 12 +
            COALESCE(an.total_cotizaciones, 0) * 18 +
            CASE WHEN p.destacado = 1 THEN 15 ELSE 0 END +
            CASE WHEN p.nuevo_web = 1 THEN 10 ELSE 0 END
          ) AS score
        FROM productos p
        LEFT JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN (
          SELECT
            producto_id,
            COUNT(*) AS total_imagenes
          FROM producto_multimedia
          WHERE activo = 1
            AND tipo = 'IMAGEN'
          GROUP BY producto_id
        ) pm ON pm.producto_id = p.id
        JOIN (
          SELECT
            producto_id,
            SUM(CASE WHEN evento = 'PRODUCTO_CONSULTADO' THEN 1 ELSE 0 END) AS total_consultas,
            SUM(CASE WHEN evento = 'PRODUCTO_AGREGADO_COTIZACION' THEN 1 ELSE 0 END) AS total_agregados_cotizacion,
            COUNT(DISTINCT cotizacion_id) AS total_cotizaciones,
            MAX(fecha_evento) AS ultimo_evento
          FROM analytics_eventos
          WHERE producto_id IS NOT NULL
            AND fecha_evento >= ?
            AND fecha_evento < DATE_ADD(?, INTERVAL 1 DAY)
            AND evento IN ('PRODUCTO_CONSULTADO', 'PRODUCTO_AGREGADO_COTIZACION')
          GROUP BY producto_id
        ) an ON an.producto_id = p.id
        WHERE p.activo = 1
          AND p.activo_web = 1
          AND p.visible_catalogo = 1
          AND COALESCE(pm.total_imagenes, 0) = 0
          AND (p.imagen_url IS NULL OR TRIM(p.imagen_url) = '')
        ORDER BY score DESC, an.ultimo_evento DESC
        LIMIT ?
        `,
        [range.desde, range.hasta, limit]
      );

      const [productosIncompletosConDemanda] = await pool.query(
        `
        SELECT
          p.id,
          p.codigo_andyfers,
          p.codigo_importacion,
          c.nombre AS categoria,
          p.familia,
          p.armadora,
          p.descripcion,
          COALESCE(pc.total_cruces, 0) AS total_cruces,
          COALESCE(pa.total_aplicaciones, 0) AS total_aplicaciones,
          COALESCE(an.total_consultas, 0) AS total_consultas,
          COALESCE(an.total_agregados_cotizacion, 0) AS total_agregados_cotizacion,
          an.ultimo_evento,
          (
            COALESCE(an.total_consultas, 0) * 3 +
            COALESCE(an.total_agregados_cotizacion, 0) * 12 +
            CASE WHEN COALESCE(pc.total_cruces, 0) = 0 THEN 20 ELSE 0 END +
            CASE WHEN COALESCE(pa.total_aplicaciones, 0) = 0 THEN 20 ELSE 0 END
          ) AS score
        FROM productos p
        LEFT JOIN categorias c ON c.id = p.categoria_id
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
        JOIN (
          SELECT
            producto_id,
            SUM(CASE WHEN evento = 'PRODUCTO_CONSULTADO' THEN 1 ELSE 0 END) AS total_consultas,
            SUM(CASE WHEN evento = 'PRODUCTO_AGREGADO_COTIZACION' THEN 1 ELSE 0 END) AS total_agregados_cotizacion,
            MAX(fecha_evento) AS ultimo_evento
          FROM analytics_eventos
          WHERE producto_id IS NOT NULL
            AND fecha_evento >= ?
            AND fecha_evento < DATE_ADD(?, INTERVAL 1 DAY)
            AND evento IN ('PRODUCTO_CONSULTADO', 'PRODUCTO_AGREGADO_COTIZACION')
          GROUP BY producto_id
        ) an ON an.producto_id = p.id
        WHERE p.activo = 1
          AND p.activo_web = 1
          AND p.visible_catalogo = 1
          AND (
            COALESCE(pc.total_cruces, 0) = 0
            OR COALESCE(pa.total_aplicaciones, 0) = 0
          )
        ORDER BY score DESC, an.ultimo_evento DESC
        LIMIT ?
        `,
        [range.desde, range.hasta, limit]
      );

      const [busquedasSinResultado] = await pool.query(
        `
        SELECT
          COALESCE(NULLIF(busqueda_normalizada, ''), 'SIN_TEXTO') AS busqueda_normalizada,
          MIN(busqueda_original) AS ejemplo_busqueda,
          COUNT(*) AS total_busquedas,
          COUNT(DISTINCT session_id) AS sesiones,
          MAX(marca_vehiculo) AS marca_vehiculo,
          MAX(modelo_vehiculo) AS modelo_vehiculo,
          MAX(anio_vehiculo) AS anio_vehiculo,
          MAX(motor_vehiculo) AS motor_vehiculo,
          MIN(fecha_evento) AS primera_busqueda,
          MAX(fecha_evento) AS ultima_busqueda,
          COUNT(*) * 10 AS score
        FROM analytics_eventos
        WHERE fecha_evento >= ?
          AND fecha_evento < DATE_ADD(?, INTERVAL 1 DAY)
          AND (
            evento IN ('BUSQUEDA_CATALOGO_SIN_RESULTADO', 'BUSQUEDA_IA_SIN_RESULTADO')
            OR resultado_estado = 'SIN_RESULTADO'
          )
        GROUP BY COALESCE(NULLIF(busqueda_normalizada, ''), 'SIN_TEXTO')
        HAVING total_busquedas >= 1
        ORDER BY total_busquedas DESC, ultima_busqueda DESC
        LIMIT ?
        `,
        [range.desde, range.hasta, limit]
      );

      res.json({
        ok: true,
        data: {
          rango: range,
          productos_sin_imagen_con_demanda: productosSinImagenConDemanda,
          productos_incompletos_con_demanda: productosIncompletosConDemanda,
          busquedas_sin_resultado: busquedasSinResultado,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
