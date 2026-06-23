import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";

const router = Router();
const exportAccess = [requireAdminAuth, requireRole(["ADMIN", "VENTAS", "COMPRAS"])] ;

function cleanString(value, maxLength = 320) {
  if (value === undefined || value === null) return "";

  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
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

function parsePositiveInt(value, fallback = 500, max = 5000) {
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

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function defaultDesde() {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return toIsoDate(date);
}

function defaultHasta() {
  return toIsoDate(new Date());
}

function getDateRange(query = {}) {
  const desde = isValidDate(query.desde) ? query.desde : defaultDesde();
  const hasta = isValidDate(query.hasta) ? query.hasta : defaultHasta();

  return { desde, hasta };
}

function dateWhere(alias = "ae", query = {}) {
  const { desde, hasta } = getDateRange(query);

  return {
    sql: `${alias}.fecha_evento >= ? AND ${alias}.fecha_evento < DATE_ADD(?, INTERVAL 1 DAY)`,
    params: [desde, hasta],
    desde,
    hasta,
  };
}

function excelEscape(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function excelValue(value) {
  if (value === null || value === undefined) return "";

  if (value instanceof Date) {
    return value.toISOString().replace("T", " ").slice(0, 19);
  }

  return String(value);
}

function sanitizeWorksheetName(value, fallback = "Reporte") {
  const clean = cleanString(value || fallback, 31)
    .replace(/[\\/?*\[\]:]/g, " ")
    .trim();

  return clean || fallback;
}

function buildWorksheetXml(sheet) {
  const columns = sheet.columns || [];
  const rows = sheet.rows || [];

  const headerCells = columns
    .map((column) => `<Cell><Data ss:Type="String">${excelEscape(column.header || column.key)}</Data></Cell>`)
    .join("");

  const bodyRows = rows
    .map((row) => {
      const cells = columns
        .map((column) => {
          const value = excelValue(row?.[column.key]);
          const numeric = value !== "" && /^-?\d+(\.\d+)?$/.test(value);
          const type = numeric && column.type === "number" ? "Number" : "String";

          return `<Cell><Data ss:Type="${type}">${excelEscape(value)}</Data></Cell>`;
        })
        .join("");

      return `<Row>${cells}</Row>`;
    })
    .join("\n");

  const columnWidths = columns
    .map((column) => `<Column ss:AutoFitWidth="0" ss:Width="${column.width || 140}"/>`)
    .join("\n");

  return `
    <Worksheet ss:Name="${excelEscape(sanitizeWorksheetName(sheet.name))}">
      <Table>
        ${columnWidths}
        <Row ss:StyleID="Header">${headerCells}</Row>
        ${bodyRows}
      </Table>
    </Worksheet>
  `;
}

function sendExcelXml(res, { filename, sheets }) {
  const safeFilename = cleanString(filename || "reporte_andyfers", 120)
    .replace(/[^a-zA-Z0-9_\-.]/g, "_")
    .replace(/_+/g, "_");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 ${sheets.map(buildWorksheetXml).join("\n")}
</Workbook>`;

  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeFilename.endsWith(".xls") ? safeFilename : `${safeFilename}.xls`}"`
  );
  res.status(200).send(xml);
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
      OR ${flagSql.sin_descripcion_web}
      OR ${flagSql.sin_cruces}
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

function productQualityBaseSql(query = {}) {
  const range = getDateRange(query);

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
  `;
}

function productQualitySelectSql() {
  return `
    SELECT
      p.id,
      p.codigo_andyfers,
      p.codigo_importacion,
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
      COALESCE(pm.total_imagenes, 0) AS total_imagenes,
      COALESCE(pm.total_principales, 0) AS total_imagenes_principales,
      COALESCE(pc.total_cruces, 0) AS total_cruces,
      COALESCE(pa.total_aplicaciones, 0) AS total_aplicaciones,
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
      CASE WHEN ${flagSql.sin_stock} THEN 1 ELSE 0 END AS sin_stock,
      CASE WHEN ${flagSql.sin_precio} THEN 1 ELSE 0 END AS sin_precio,
      CASE WHEN ${flagSql.codigo_sospechoso} THEN 1 ELSE 0 END AS codigo_sospechoso,
      CASE WHEN ${flagSql.visible_incompleto} THEN 1 ELSE 0 END AS visible_incompleto,
      (
        CASE WHEN ${flagSql.sin_imagen} THEN 35 ELSE 0 END +
        CASE WHEN ${flagSql.sin_descripcion_web} THEN 12 ELSE 0 END +
        CASE WHEN ${flagSql.sin_cruces} THEN 18 ELSE 0 END +
        CASE WHEN ${flagSql.sin_aplicaciones} THEN 18 ELSE 0 END +
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

function buildProductQualityFilters(query = {}) {
  const clauses = ["p.activo = 1"];
  const params = [];

  const q = cleanString(query.q, 160);
  const categoriaId = parseOptionalInt(query.categoria_id);
  const familia = cleanString(query.familia, 160);
  const armadora = cleanString(query.armadora, 160);
  const issue = normalizeKey(query.issue || query.estado_calidad);
  const activoWeb = parseBooleanFilter(query.activo_web);
  const visibleCatalogo = parseBooleanFilter(query.visible_catalogo);

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

  if (activoWeb !== null) {
    clauses.push("p.activo_web = ?");
    params.push(activoWeb);
  }

  if (visibleCatalogo !== null) {
    clauses.push("p.visible_catalogo = ?");
    params.push(visibleCatalogo);
  }

  const issueMap = {
    SIN_IMAGEN: flagSql.sin_imagen,
    SIN_DESCRIPCION: flagSql.sin_descripcion_web,
    SIN_DESCRIPCION_WEB: flagSql.sin_descripcion_web,
    SIN_CRUCES: flagSql.sin_cruces,
    SIN_APLICACIONES: flagSql.sin_aplicaciones,
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

function qualityColumns() {
  return [
    { key: "id", header: "ID", type: "number", width: 55 },
    { key: "codigo_andyfers", header: "Código Andyfers", width: 115 },
    { key: "codigo_importacion", header: "Código importación", width: 130 },
    { key: "categoria", header: "Categoría", width: 160 },
    { key: "familia", header: "Familia", width: 130 },
    { key: "armadora", header: "Armadora", width: 150 },
    { key: "descripcion", header: "Descripción", width: 420 },
    { key: "total_imagenes", header: "Imágenes", type: "number", width: 70 },
    { key: "total_cruces", header: "Cruces", type: "number", width: 70 },
    { key: "total_aplicaciones", header: "Aplicaciones", type: "number", width: 90 },
    { key: "stock_total_web", header: "Stock web", type: "number", width: 80 },
    { key: "precio_minimo", header: "Precio min", type: "number", width: 90 },
    { key: "total_consultas", header: "Consultas", type: "number", width: 80 },
    { key: "total_agregados_cotizacion", header: "Agregados cotización", type: "number", width: 110 },
    { key: "sin_imagen", header: "Sin imagen", type: "number", width: 75 },
    { key: "sin_descripcion_web", header: "Sin desc web", type: "number", width: 85 },
    { key: "sin_cruces", header: "Sin cruces", type: "number", width: 75 },
    { key: "sin_aplicaciones", header: "Sin aplicaciones", type: "number", width: 95 },
    { key: "visible_incompleto", header: "Visible incompleto", type: "number", width: 110 },
    { key: "prioridad_calidad", header: "Prioridad", type: "number", width: 80 },
  ];
}

async function getQualityRows(query = {}, forcedIssue = "") {
  const limit = parsePositiveInt(query.limit, 1000, 10000);
  const filters = buildProductQualityFilters({ ...query, issue: forcedIssue || query.issue });
  const baseSql = productQualityBaseSql(query);

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

  return rows;
}

async function exportProductosSinImagen(req, res) {
  const rows = await getQualityRows(req.query, "SIN_IMAGEN");

  sendExcelXml(res, {
    filename: `productos_sin_imagen_${new Date().toISOString().slice(0, 10)}.xls`,
    sheets: [{ name: "Sin imagen", columns: qualityColumns(), rows }],
  });
}

async function exportProductosIncompletos(req, res) {
  const rows = await getQualityRows(req.query, req.query.issue || "VISIBLE_INCOMPLETO");

  sendExcelXml(res, {
    filename: `productos_incompletos_${new Date().toISOString().slice(0, 10)}.xls`,
    sheets: [{ name: "Incompletos", columns: qualityColumns(), rows }],
  });
}

async function exportCatalogoCalidad(req, res) {
  const [sinImagen, incompletos, sinCruces, sinAplicaciones] = await Promise.all([
    getQualityRows(req.query, "SIN_IMAGEN"),
    getQualityRows(req.query, "VISIBLE_INCOMPLETO"),
    getQualityRows(req.query, "SIN_CRUCES"),
    getQualityRows(req.query, "SIN_APLICACIONES"),
  ]);

  sendExcelXml(res, {
    filename: `catalogo_calidad_${new Date().toISOString().slice(0, 10)}.xls`,
    sheets: [
      { name: "Sin imagen", columns: qualityColumns(), rows: sinImagen },
      { name: "Incompletos", columns: qualityColumns(), rows: incompletos },
      { name: "Sin cruces", columns: qualityColumns(), rows: sinCruces },
      { name: "Sin aplicaciones", columns: qualityColumns(), rows: sinAplicaciones },
    ],
  });
}

async function exportBusquedasSinResultado(req, res) {
  const range = dateWhere("ae", req.query);
  const limit = parsePositiveInt(req.query.limit, 1000, 10000);

  const [rows] = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO') AS busqueda_normalizada,
      MIN(ae.busqueda_original) AS ejemplo_busqueda,
      COUNT(*) AS total_busquedas,
      COUNT(DISTINCT ae.session_id) AS sesiones,
      MIN(ae.fecha_evento) AS primera_busqueda,
      MAX(ae.fecha_evento) AS ultima_busqueda,
      MAX(ae.marca_vehiculo) AS marca_vehiculo,
      MAX(ae.modelo_vehiculo) AS modelo_vehiculo,
      MAX(ae.anio_vehiculo) AS anio_vehiculo,
      MAX(ae.motor_vehiculo) AS motor_vehiculo
    FROM analytics_eventos ae
    WHERE ${range.sql}
      AND (
        ae.evento IN ('BUSQUEDA_CATALOGO_SIN_RESULTADO', 'BUSQUEDA_IA_SIN_RESULTADO')
        OR ae.resultado_estado = 'SIN_RESULTADO'
      )
    GROUP BY COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO')
    ORDER BY total_busquedas DESC, ultima_busqueda DESC
    LIMIT ?
    `,
    [...range.params, limit]
  );

  sendExcelXml(res, {
    filename: `busquedas_sin_resultado_${range.desde}_${range.hasta}.xls`,
    sheets: [
      {
        name: "Sin resultado",
        columns: [
          { key: "busqueda_normalizada", header: "Búsqueda normalizada", width: 240 },
          { key: "ejemplo_busqueda", header: "Ejemplo", width: 280 },
          { key: "total_busquedas", header: "Total", type: "number", width: 70 },
          { key: "sesiones", header: "Sesiones", type: "number", width: 75 },
          { key: "marca_vehiculo", header: "Marca", width: 120 },
          { key: "modelo_vehiculo", header: "Modelo", width: 140 },
          { key: "anio_vehiculo", header: "Año", width: 70 },
          { key: "motor_vehiculo", header: "Motor", width: 120 },
          { key: "primera_busqueda", header: "Primera", width: 150 },
          { key: "ultima_busqueda", header: "Última", width: 150 },
        ],
        rows,
      },
    ],
  });
}

async function exportProductosConsultados(req, res) {
  const range = dateWhere("ae", req.query);
  const limit = parsePositiveInt(req.query.limit, 1000, 10000);

  const [rows] = await pool.query(
    `
    SELECT
      ae.producto_id,
      ae.codigo_andyfers,
      ae.codigo_importacion,
      ae.categoria_nombre,
      ae.familia,
      COUNT(*) AS total_consultas,
      COUNT(DISTINCT ae.session_id) AS sesiones,
      MIN(ae.fecha_evento) AS primera_consulta,
      MAX(ae.fecha_evento) AS ultima_consulta
    FROM analytics_eventos ae
    WHERE ${range.sql}
      AND ae.evento = 'PRODUCTO_CONSULTADO'
      AND ae.producto_id IS NOT NULL
    GROUP BY
      ae.producto_id,
      ae.codigo_andyfers,
      ae.codigo_importacion,
      ae.categoria_nombre,
      ae.familia
    ORDER BY total_consultas DESC, ultima_consulta DESC
    LIMIT ?
    `,
    [...range.params, limit]
  );

  sendExcelXml(res, {
    filename: `productos_consultados_${range.desde}_${range.hasta}.xls`,
    sheets: [
      {
        name: "Consultados",
        columns: [
          { key: "producto_id", header: "Producto ID", type: "number", width: 80 },
          { key: "codigo_andyfers", header: "Código Andyfers", width: 120 },
          { key: "codigo_importacion", header: "Código importación", width: 130 },
          { key: "categoria_nombre", header: "Categoría", width: 160 },
          { key: "familia", header: "Familia", width: 130 },
          { key: "total_consultas", header: "Consultas", type: "number", width: 80 },
          { key: "sesiones", header: "Sesiones", type: "number", width: 80 },
          { key: "primera_consulta", header: "Primera", width: 150 },
          { key: "ultima_consulta", header: "Última", width: 150 },
        ],
        rows,
      },
    ],
  });
}

async function exportProductosCotizados(req, res) {
  const range = dateWhere("ae", req.query);
  const limit = parsePositiveInt(req.query.limit, 1000, 10000);

  const [rows] = await pool.query(
    `
    SELECT
      ae.producto_id,
      ae.codigo_andyfers,
      ae.codigo_importacion,
      ae.categoria_nombre,
      ae.familia,
      COUNT(*) AS veces_agregado,
      COUNT(DISTINCT ae.cotizacion_id) AS cotizaciones,
      SUM(COALESCE(ae.cantidad, 0)) AS cantidad_total,
      MIN(ae.fecha_evento) AS primera_vez,
      MAX(ae.fecha_evento) AS ultima_vez
    FROM analytics_eventos ae
    WHERE ${range.sql}
      AND ae.evento = 'PRODUCTO_AGREGADO_COTIZACION'
      AND ae.producto_id IS NOT NULL
    GROUP BY
      ae.producto_id,
      ae.codigo_andyfers,
      ae.codigo_importacion,
      ae.categoria_nombre,
      ae.familia
    ORDER BY veces_agregado DESC, ultima_vez DESC
    LIMIT ?
    `,
    [...range.params, limit]
  );

  sendExcelXml(res, {
    filename: `productos_cotizados_${range.desde}_${range.hasta}.xls`,
    sheets: [
      {
        name: "Cotizados",
        columns: [
          { key: "producto_id", header: "Producto ID", type: "number", width: 80 },
          { key: "codigo_andyfers", header: "Código Andyfers", width: 120 },
          { key: "codigo_importacion", header: "Código importación", width: 130 },
          { key: "categoria_nombre", header: "Categoría", width: 160 },
          { key: "familia", header: "Familia", width: 130 },
          { key: "veces_agregado", header: "Veces agregado", type: "number", width: 100 },
          { key: "cotizaciones", header: "Cotizaciones", type: "number", width: 90 },
          { key: "cantidad_total", header: "Cantidad total", type: "number", width: 100 },
          { key: "primera_vez", header: "Primera", width: 150 },
          { key: "ultima_vez", header: "Última", width: 150 },
        ],
        rows,
      },
    ],
  });
}

async function exportAnalyticsEventos(req, res) {
  const range = dateWhere("ae", req.query);
  const limit = parsePositiveInt(req.query.limit, 1000, 10000);
  const evento = cleanString(req.query.evento, 80);
  const q = cleanString(req.query.q, 120);

  const clauses = [range.sql];
  const params = [...range.params];

  if (evento) {
    clauses.push("ae.evento = ?");
    params.push(evento);
  }

  if (q) {
    clauses.push(`
      (
        ae.busqueda_original LIKE ?
        OR ae.busqueda_normalizada LIKE ?
        OR ae.codigo_andyfers LIKE ?
        OR ae.codigo_importacion LIKE ?
        OR ae.familia LIKE ?
        OR ae.marca_vehiculo LIKE ?
        OR ae.modelo_vehiculo LIKE ?
      )
    `);

    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }

  const [rows] = await pool.query(
    `
    SELECT
      ae.id,
      ae.evento,
      ae.origen,
      ae.resultado_estado,
      ae.busqueda_original,
      ae.busqueda_normalizada,
      ae.total_resultados,
      ae.producto_id,
      ae.codigo_andyfers,
      ae.codigo_importacion,
      ae.categoria_nombre,
      ae.familia,
      ae.marca_vehiculo,
      ae.modelo_vehiculo,
      ae.anio_vehiculo,
      ae.motor_vehiculo,
      ae.cotizacion_id,
      ae.cotizacion_folio,
      ae.cantidad,
      ae.fecha_evento
    FROM analytics_eventos ae
    WHERE ${clauses.join(" AND ")}
    ORDER BY ae.fecha_evento DESC, ae.id DESC
    LIMIT ?
    `,
    [...params, limit]
  );

  sendExcelXml(res, {
    filename: `eventos_analytics_${range.desde}_${range.hasta}.xls`,
    sheets: [
      {
        name: "Eventos",
        columns: [
          { key: "id", header: "ID", type: "number", width: 70 },
          { key: "evento", header: "Evento", width: 190 },
          { key: "origen", header: "Origen", width: 120 },
          { key: "resultado_estado", header: "Resultado", width: 120 },
          { key: "busqueda_original", header: "Búsqueda", width: 260 },
          { key: "total_resultados", header: "Resultados", type: "number", width: 90 },
          { key: "codigo_andyfers", header: "Código Andyfers", width: 120 },
          { key: "codigo_importacion", header: "Código importación", width: 130 },
          { key: "familia", header: "Familia", width: 130 },
          { key: "marca_vehiculo", header: "Marca", width: 120 },
          { key: "modelo_vehiculo", header: "Modelo", width: 140 },
          { key: "anio_vehiculo", header: "Año", width: 70 },
          { key: "cotizacion_folio", header: "Folio cotización", width: 130 },
          { key: "fecha_evento", header: "Fecha", width: 160 },
        ],
        rows,
      },
    ],
  });
}

async function exportOportunidadesMercado(req, res) {
  const [rows] = await pool.query(
    `
    SELECT
      id,
      tipo_oportunidad,
      referencia_key,
      titulo,
      descripcion,
      prioridad,
      estado,
      total_eventos,
      score,
      accion_sugerida,
      responsable,
      nota,
      primer_evento,
      ultimo_evento,
      updated_at
    FROM analytics_oportunidades_revision
    ORDER BY
      CASE prioridad
        WHEN 'ALTA' THEN 1
        WHEN 'MEDIA' THEN 2
        WHEN 'BAJA' THEN 3
        ELSE 4
      END,
      score DESC,
      ultimo_evento DESC
    LIMIT ?
    `,
    [parsePositiveInt(req.query.limit, 1000, 10000)]
  );

  sendExcelXml(res, {
    filename: `oportunidades_mercado_${new Date().toISOString().slice(0, 10)}.xls`,
    sheets: [
      {
        name: "Oportunidades",
        columns: [
          { key: "id", header: "ID", type: "number", width: 70 },
          { key: "tipo_oportunidad", header: "Tipo", width: 180 },
          { key: "referencia_key", header: "Referencia", width: 240 },
          { key: "titulo", header: "Título", width: 300 },
          { key: "descripcion", header: "Descripción", width: 420 },
          { key: "prioridad", header: "Prioridad", width: 90 },
          { key: "estado", header: "Estado", width: 120 },
          { key: "total_eventos", header: "Eventos", type: "number", width: 80 },
          { key: "score", header: "Score", type: "number", width: 80 },
          { key: "accion_sugerida", header: "Acción", width: 190 },
          { key: "responsable", header: "Responsable", width: 150 },
          { key: "nota", header: "Nota", width: 300 },
          { key: "ultimo_evento", header: "Último evento", width: 150 },
        ],
        rows,
      },
    ],
  });
}

function buildTaskFilters(query = {}) {
  const clauses = [];
  const params = [];

  const q = cleanString(query.q, 160);
  const estado = normalizeKey(query.estado, 60);
  const prioridad = normalizeKey(query.prioridad, 40);
  const tipoPendiente = normalizeKey(query.tipo_pendiente, 80);
  const categoria = cleanString(query.categoria, 160);
  const familia = cleanString(query.familia, 160);
  const origen = normalizeKey(query.origen, 80);
  const abiertos = parseBooleanFilter(query.abiertos);

  if (q) {
    clauses.push(`
      (
        titulo LIKE ?
        OR descripcion LIKE ?
        OR codigo_andyfers LIKE ?
        OR codigo_importacion LIKE ?
        OR categoria_nombre LIKE ?
        OR familia LIKE ?
        OR armadora LIKE ?
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

  if (tipoPendiente) {
    clauses.push("tipo_pendiente = ?");
    params.push(tipoPendiente);
  }

  if (categoria) {
    clauses.push("categoria_nombre = ?");
    params.push(categoria);
  }

  if (familia) {
    clauses.push("familia = ?");
    params.push(familia);
  }

  if (origen) {
    clauses.push("origen = ?");
    params.push(origen);
  }

  if (abiertos === 1) {
    clauses.push("estado NOT IN ('COMPLETADO', 'DESCARTADO')");
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

async function exportPendientesComerciales(req, res) {
  const filters = buildTaskFilters(req.query);
  const limit = parsePositiveInt(req.query.limit, 1000, 10000);

  const [rows] = await pool.query(
    `
    SELECT
      id,
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
      primer_evento,
      ultimo_evento,
      fecha_limite,
      closed_at,
      updated_at
    FROM catalogo_pendientes_comerciales
    ${filters.sql}
    ORDER BY
      CASE prioridad
        WHEN 'CRITICA' THEN 1
        WHEN 'ALTA' THEN 2
        WHEN 'MEDIA' THEN 3
        WHEN 'BAJA' THEN 4
        ELSE 5
      END,
      score DESC,
      updated_at DESC
    LIMIT ?
    `,
    [...filters.params, limit]
  );

  sendExcelXml(res, {
    filename: `pendientes_comerciales_${new Date().toISOString().slice(0, 10)}.xls`,
    sheets: [
      {
        name: "Pendientes",
        columns: [
          { key: "id", header: "ID", type: "number", width: 70 },
          { key: "estado", header: "Estado", width: 120 },
          { key: "prioridad", header: "Prioridad", width: 90 },
          { key: "tipo_pendiente", header: "Tipo", width: 190 },
          { key: "origen", header: "Origen", width: 150 },
          { key: "codigo_andyfers", header: "Código Andyfers", width: 120 },
          { key: "codigo_importacion", header: "Código importación", width: 130 },
          { key: "categoria_nombre", header: "Categoría", width: 160 },
          { key: "familia", header: "Familia", width: 130 },
          { key: "armadora", header: "Armadora", width: 140 },
          { key: "titulo", header: "Título", width: 300 },
          { key: "descripcion", header: "Descripción", width: 420 },
          { key: "accion_sugerida", header: "Acción sugerida", width: 190 },
          { key: "responsable", header: "Responsable", width: 150 },
          { key: "nota", header: "Nota", width: 300 },
          { key: "score", header: "Score", type: "number", width: 80 },
          { key: "updated_at", header: "Actualizado", width: 150 },
        ],
        rows,
      },
    ],
  });
}

async function exportAnalyticsDashboard(req, res) {
  const range = dateWhere("ae", req.query);

  const [diario] = await pool.query(
    `
    SELECT
      DATE(ae.fecha_evento) AS fecha,
      SUM(CASE WHEN ae.evento IN ('BUSQUEDA_CATALOGO', 'BUSQUEDA_IA') THEN 1 ELSE 0 END) AS busquedas_con_resultado,
      SUM(CASE WHEN ae.evento IN ('BUSQUEDA_CATALOGO_SIN_RESULTADO', 'BUSQUEDA_IA_SIN_RESULTADO') THEN 1 ELSE 0 END) AS busquedas_sin_resultado,
      SUM(CASE WHEN ae.evento = 'PRODUCTO_CONSULTADO' THEN 1 ELSE 0 END) AS productos_consultados,
      SUM(CASE WHEN ae.evento = 'PRODUCTO_AGREGADO_COTIZACION' THEN 1 ELSE 0 END) AS productos_agregados_cotizacion,
      SUM(CASE WHEN ae.evento = 'COTIZACION_GENERADA' THEN 1 ELSE 0 END) AS cotizaciones_generadas,
      SUM(CASE WHEN ae.evento = 'WHATSAPP_CLICK' THEN 1 ELSE 0 END) AS clicks_whatsapp,
      COUNT(DISTINCT ae.session_id) AS sesiones
    FROM analytics_eventos ae
    WHERE ${range.sql}
    GROUP BY DATE(ae.fecha_evento)
    ORDER BY fecha DESC
    `,
    range.params
  );

  const [sinResultado] = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO') AS busqueda_normalizada,
      MIN(ae.busqueda_original) AS ejemplo_busqueda,
      COUNT(*) AS total_busquedas,
      COUNT(DISTINCT ae.session_id) AS sesiones,
      MAX(ae.fecha_evento) AS ultima_busqueda
    FROM analytics_eventos ae
    WHERE ${range.sql}
      AND (
        ae.evento IN ('BUSQUEDA_CATALOGO_SIN_RESULTADO', 'BUSQUEDA_IA_SIN_RESULTADO')
        OR ae.resultado_estado = 'SIN_RESULTADO'
      )
    GROUP BY COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO')
    ORDER BY total_busquedas DESC
    LIMIT 1000
    `,
    range.params
  );

  const [consultados] = await pool.query(
    `
    SELECT
      ae.producto_id,
      ae.codigo_andyfers,
      ae.codigo_importacion,
      ae.categoria_nombre,
      ae.familia,
      COUNT(*) AS total_consultas
    FROM analytics_eventos ae
    WHERE ${range.sql}
      AND ae.evento = 'PRODUCTO_CONSULTADO'
      AND ae.producto_id IS NOT NULL
    GROUP BY ae.producto_id, ae.codigo_andyfers, ae.codigo_importacion, ae.categoria_nombre, ae.familia
    ORDER BY total_consultas DESC
    LIMIT 1000
    `,
    range.params
  );

  const [cotizados] = await pool.query(
    `
    SELECT
      ae.producto_id,
      ae.codigo_andyfers,
      ae.codigo_importacion,
      ae.categoria_nombre,
      ae.familia,
      COUNT(*) AS veces_agregado,
      COUNT(DISTINCT ae.cotizacion_id) AS cotizaciones,
      SUM(COALESCE(ae.cantidad, 0)) AS cantidad_total
    FROM analytics_eventos ae
    WHERE ${range.sql}
      AND ae.evento = 'PRODUCTO_AGREGADO_COTIZACION'
      AND ae.producto_id IS NOT NULL
    GROUP BY ae.producto_id, ae.codigo_andyfers, ae.codigo_importacion, ae.categoria_nombre, ae.familia
    ORDER BY veces_agregado DESC
    LIMIT 1000
    `,
    range.params
  );

  sendExcelXml(res, {
    filename: `analitica_comercial_${range.desde}_${range.hasta}.xls`,
    sheets: [
      {
        name: "Resumen diario",
        columns: [
          { key: "fecha", header: "Fecha", width: 110 },
          { key: "busquedas_con_resultado", header: "Búsquedas con resultado", type: "number", width: 140 },
          { key: "busquedas_sin_resultado", header: "Búsquedas sin resultado", type: "number", width: 140 },
          { key: "productos_consultados", header: "Productos consultados", type: "number", width: 140 },
          { key: "productos_agregados_cotizacion", header: "Agregados cotización", type: "number", width: 150 },
          { key: "cotizaciones_generadas", header: "Cotizaciones", type: "number", width: 110 },
          { key: "clicks_whatsapp", header: "WhatsApp", type: "number", width: 90 },
          { key: "sesiones", header: "Sesiones", type: "number", width: 90 },
        ],
        rows: diario,
      },
      {
        name: "Sin resultado",
        columns: [
          { key: "busqueda_normalizada", header: "Búsqueda", width: 260 },
          { key: "ejemplo_busqueda", header: "Ejemplo", width: 260 },
          { key: "total_busquedas", header: "Total", type: "number", width: 70 },
          { key: "sesiones", header: "Sesiones", type: "number", width: 80 },
          { key: "ultima_busqueda", header: "Última", width: 150 },
        ],
        rows: sinResultado,
      },
      {
        name: "Consultados",
        columns: [
          { key: "codigo_andyfers", header: "Código Andyfers", width: 120 },
          { key: "codigo_importacion", header: "Código importación", width: 130 },
          { key: "categoria_nombre", header: "Categoría", width: 160 },
          { key: "familia", header: "Familia", width: 130 },
          { key: "total_consultas", header: "Consultas", type: "number", width: 90 },
        ],
        rows: consultados,
      },
      {
        name: "Cotizados",
        columns: [
          { key: "codigo_andyfers", header: "Código Andyfers", width: 120 },
          { key: "codigo_importacion", header: "Código importación", width: 130 },
          { key: "categoria_nombre", header: "Categoría", width: 160 },
          { key: "familia", header: "Familia", width: 130 },
          { key: "veces_agregado", header: "Veces", type: "number", width: 90 },
          { key: "cotizaciones", header: "Cotizaciones", type: "number", width: 100 },
          { key: "cantidad_total", header: "Cantidad", type: "number", width: 90 },
        ],
        rows: cotizados,
      },
    ],
  });
}

const EXPORT_HANDLERS = {
  "analytics-dashboard": exportAnalyticsDashboard,
  "busquedas-sin-resultado": exportBusquedasSinResultado,
  "productos-consultados": exportProductosConsultados,
  "productos-cotizados": exportProductosCotizados,
  "analytics-eventos": exportAnalyticsEventos,
  "oportunidades-mercado": exportOportunidadesMercado,
  "catalogo-calidad": exportCatalogoCalidad,
  "productos-sin-imagen": exportProductosSinImagen,
  "productos-incompletos": exportProductosIncompletos,
  "pendientes-comerciales": exportPendientesComerciales,
};

router.get("/admin/exportaciones", exportAccess, async (req, res) => {
  const tipos = Object.keys(EXPORT_HANDLERS).sort();

  res.json({
    ok: true,
    data: tipos.map((tipo) => ({ tipo })),
  });
});

router.get("/admin/exportaciones/:tipo", exportAccess, async (req, res, next) => {
  try {
    const tipo = normalizeKey(req.params.tipo, 120).toLowerCase().replace(/_/g, "-");
    const handler = EXPORT_HANDLERS[tipo];

    if (!handler) {
      return res.status(404).json({
        ok: false,
        error: "Exportación no disponible.",
      });
    }

    await handler(req, res);
  } catch (error) {
    next(error);
  }
});

export default router;
