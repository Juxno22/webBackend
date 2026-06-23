import { Router } from "express";
import { pool } from "../config/db.js";

const router = Router();

function clampNumber(value, min = 1, max = 60, fallback = 12) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(min, Math.min(max, parsed));
}

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;

  return String(value).replace(/\s+/g, " ").trim() || fallback;
}

function slugify(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " y ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function normalizeSlug(value) {
  return slugify(String(value || ""));
}

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

function publicProductBaseWhere(alias = "p") {
  return `
    ${alias}.activo = 1
    AND ${alias}.activo_web = 1
    AND ${alias}.visible_catalogo = 1
    AND ${buildValidPublicCodeCondition(alias)}
  `;
}

function buildLandingDescription({ tipo, nombre, totalProductos = 0, familias = [], categorias = [] }) {
  const cleanName = cleanText(nombre);
  const total = Number(totalProductos || 0);
  const totalText = total === 1 ? "1 producto" : `${total} productos`;

  if (tipo === "categoria") {
    const familiasText = familias.slice(0, 4).map((item) => item.familia).filter(Boolean).join(", ");

    return `Consulta ${totalText} de ${cleanName} en Andyfers${familiasText ? `: ${familiasText}` : ""}. Revisa compatibilidad, disponibilidad y solicita cotización.`;
  }

  const categoriasText = categorias.slice(0, 4).map((item) => item.categoria).filter(Boolean).join(", ");

  return `Encuentra ${totalText} de la línea ${cleanName} en Andyfers${categoriasText ? ` dentro de ${categoriasText}` : ""}. Catálogo técnico para cotización y compatibilidad.`;
}

async function getAllCategoryLandings() {
  const [rows] = await pool.query(`
    SELECT
      c.id,
      c.nombre,
      c.nombre_normalizado,
      COUNT(DISTINCT p.id) AS total_productos,
      MAX(p.updated_at) AS updated_at,
      (
        SELECT pm.secure_url
        FROM productos p2
        JOIN producto_multimedia pm ON pm.producto_id = p2.id
        WHERE p2.categoria_id = c.id
          AND ${publicProductBaseWhere("p2")}
          AND pm.tipo = 'IMAGEN'
          AND pm.activo = 1
        ORDER BY
          p2.destacado DESC,
          p2.nuevo_web DESC,
          CASE pm.rol
            WHEN 'PRINCIPAL' THEN 0
            WHEN 'GALERIA' THEN 1
            ELSE 2
          END,
          pm.orden ASC,
          pm.id ASC
        LIMIT 1
      ) AS imagen_url
    FROM categorias c
    JOIN productos p ON p.categoria_id = c.id
    WHERE c.activo = 1
      AND ${publicProductBaseWhere("p")}
    GROUP BY c.id, c.nombre, c.nombre_normalizado
    HAVING total_productos > 0
    ORDER BY c.nombre ASC
  `);

  return rows.map((row) => ({
    ...row,
    tipo: "categoria",
    slug: slugify(row.nombre),
  }));
}

async function getAllFamilyLandings() {
  const [rows] = await pool.query(`
    SELECT
      p.familia,
      COUNT(DISTINCT p.id) AS total_productos,
      MAX(p.updated_at) AS updated_at,
      (
        SELECT pm.secure_url
        FROM productos p2
        JOIN producto_multimedia pm ON pm.producto_id = p2.id
        WHERE p2.familia = p.familia
          AND ${publicProductBaseWhere("p2")}
          AND pm.tipo = 'IMAGEN'
          AND pm.activo = 1
        ORDER BY
          p2.destacado DESC,
          p2.nuevo_web DESC,
          CASE pm.rol
            WHEN 'PRINCIPAL' THEN 0
            WHEN 'GALERIA' THEN 1
            ELSE 2
          END,
          pm.orden ASC,
          pm.id ASC
        LIMIT 1
      ) AS imagen_url
    FROM productos p
    WHERE ${publicProductBaseWhere("p")}
      AND p.familia IS NOT NULL
      AND TRIM(p.familia) <> ''
    GROUP BY p.familia
    HAVING total_productos > 0
    ORDER BY p.familia ASC
  `);

  return rows.map((row) => ({
    ...row,
    nombre: row.familia,
    tipo: "familia",
    slug: slugify(row.familia),
  }));
}

async function findCategoryBySlug(slug) {
  const normalizedSlug = normalizeSlug(slug);
  const categories = await getAllCategoryLandings();

  return categories.find((item) => item.slug === normalizedSlug) || null;
}

async function findFamilyBySlug(slug) {
  const normalizedSlug = normalizeSlug(slug);
  const families = await getAllFamilyLandings();

  return families.find((item) => item.slug === normalizedSlug) || null;
}

function buildPagination(page, limit, total) {
  return {
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getLandingProducts({ tipo, value, page, limit }) {
  const offset = (page - 1) * limit;
  const filterSql = tipo === "categoria" ? "c.id = ?" : "p.familia = ?";

  const [countRows] = await pool.query(
    `
    SELECT COUNT(DISTINCT p.id) AS total
    FROM productos p
    JOIN categorias c ON c.id = p.categoria_id
    WHERE ${publicProductBaseWhere("p")}
      AND ${filterSql}
    `,
    [value]
  );

  const total = Number(countRows?.[0]?.total || 0);

  const [rows] = await pool.query(
    `
    SELECT
      p.id,
      ${buildVisibleProductCodeSql("p")} AS codigo_publico,
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
      COALESCE(SUM(CASE WHEN i.disponible_web = 1 THEN i.stock ELSE 0 END), 0) AS stock_total_web,
      MIN(i.precio) AS precio_minimo,
      COUNT(DISTINCT pc.id) AS total_cruces,
      COUNT(DISTINCT pa.id) AS total_aplicaciones,
      ${buildProductoMultimediaSelectSql("p")}
    FROM productos p
    JOIN categorias c ON c.id = p.categoria_id
    LEFT JOIN inventario i ON i.producto_id = p.id
    LEFT JOIN producto_cruces pc ON pc.producto_id = p.id
    LEFT JOIN producto_aplicaciones pa ON pa.producto_id = p.id
    WHERE ${publicProductBaseWhere("p")}
      AND ${filterSql}
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
      p.destacado DESC,
      p.nuevo_web DESC,
      p.prioridad_ia DESC,
      p.id ASC
    LIMIT ? OFFSET ?
    `,
    [value, limit, offset]
  );

  return {
    productos: rows,
    pagination: buildPagination(page, limit, total),
  };
}

async function getLandingFacets({ tipo, value }) {
  const filterSql = tipo === "categoria" ? "c.id = ?" : "p.familia = ?";

  const [familias] = await pool.query(
    `
    SELECT p.familia, COUNT(DISTINCT p.id) AS total_productos
    FROM productos p
    JOIN categorias c ON c.id = p.categoria_id
    WHERE ${publicProductBaseWhere("p")}
      AND ${filterSql}
      AND p.familia IS NOT NULL
      AND TRIM(p.familia) <> ''
    GROUP BY p.familia
    ORDER BY total_productos DESC, p.familia ASC
    LIMIT 12
    `,
    [value]
  );

  const [categorias] = await pool.query(
    `
    SELECT c.id, c.nombre AS categoria, COUNT(DISTINCT p.id) AS total_productos
    FROM productos p
    JOIN categorias c ON c.id = p.categoria_id
    WHERE ${publicProductBaseWhere("p")}
      AND ${filterSql}
    GROUP BY c.id, c.nombre
    ORDER BY total_productos DESC, c.nombre ASC
    LIMIT 12
    `,
    [value]
  );

  const [armadoras] = await pool.query(
    `
    SELECT p.armadora, COUNT(DISTINCT p.id) AS total_productos
    FROM productos p
    JOIN categorias c ON c.id = p.categoria_id
    WHERE ${publicProductBaseWhere("p")}
      AND ${filterSql}
      AND p.armadora IS NOT NULL
      AND TRIM(p.armadora) <> ''
    GROUP BY p.armadora
    ORDER BY total_productos DESC, p.armadora ASC
    LIMIT 16
    `,
    [value]
  );

  return { familias, categorias, armadoras };
}

async function getLandingData({ tipo, item, page, limit }) {
  const value = tipo === "categoria" ? item.id : item.familia;
  const [{ productos, pagination }, facets] = await Promise.all([
    getLandingProducts({ tipo, value, page, limit }),
    getLandingFacets({ tipo, value }),
  ]);

  const titleBase = tipo === "categoria" ? item.nombre : item.familia;
  const description = buildLandingDescription({
    tipo,
    nombre: titleBase,
    totalProductos: pagination.total,
    familias: facets.familias,
    categorias: facets.categorias,
  });

  return {
    tipo,
    landing: {
      ...item,
      nombre: titleBase,
      slug: item.slug || slugify(titleBase),
      total_productos: pagination.total,
      descripcion_seo: description,
      titulo_seo:
        tipo === "categoria"
          ? `${titleBase} Andyfers | Catálogo y cotización`
          : `${titleBase} Andyfers | Refacciones y compatibilidad`,
    },
    productos,
    pagination,
    facets,
  };
}

router.get("/seo/landings", async (req, res, next) => {
  try {
    const [categorias, familias] = await Promise.all([
      getAllCategoryLandings(),
      getAllFamilyLandings(),
    ]);

    res.json({
      ok: true,
      data: {
        categorias,
        familias,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/seo/landings/categorias", async (req, res, next) => {
  try {
    const data = await getAllCategoryLandings();

    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

router.get("/seo/landings/familias", async (req, res, next) => {
  try {
    const data = await getAllFamilyLandings();

    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

router.get("/seo/landings/categoria/:slug", async (req, res, next) => {
  try {
    const page = clampNumber(req.query.page, 1, 10000, 1);
    const limit = clampNumber(req.query.limit, 1, 60, 12);
    const item = await findCategoryBySlug(req.params.slug);

    if (!item) {
      return res.status(404).json({
        ok: false,
        error: "Categoría pública no encontrada.",
      });
    }

    const data = await getLandingData({ tipo: "categoria", item, page, limit });

    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

router.get("/seo/landings/familia/:slug", async (req, res, next) => {
  try {
    const page = clampNumber(req.query.page, 1, 10000, 1);
    const limit = clampNumber(req.query.limit, 1, 60, 12);
    const item = await findFamilyBySlug(req.params.slug);

    if (!item) {
      return res.status(404).json({
        ok: false,
        error: "Familia pública no encontrada.",
      });
    }

    const data = await getLandingData({ tipo: "familia", item, page, limit });

    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

export default router;
