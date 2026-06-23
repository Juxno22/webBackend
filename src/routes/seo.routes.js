import { Router } from "express";
import { pool } from "../config/db.js";

const router = Router();

function clampNumber(value, min = 1, max = 50000, fallback = 50000) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(min, Math.min(max, parsed));
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

router.get("/seo/sitemap-productos", async (req, res, next) => {
  try {
    const limit = clampNumber(req.query.limit, 1, 50000, 50000);

    const [rows] = await pool.query(
      `
      SELECT
        p.id,
        ${buildVisibleProductCodeSql("p")} AS codigo_publico,
        p.codigo_andyfers,
        p.codigo_importacion,
        p.descripcion,
        p.familia,
        c.nombre AS categoria,
        p.updated_at,
        p.created_at,
        p.nuevo_web,
        p.destacado,
        (
          SELECT pm.secure_url
          FROM producto_multimedia pm
          WHERE pm.producto_id = p.id
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
        ) AS imagen_url
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND p.visible_catalogo = 1
        AND ${buildValidPublicCodeCondition("p")}
      ORDER BY
        p.updated_at DESC,
        p.id DESC
      LIMIT ?
      `,
      [limit]
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/seo/catalogo-resumen", async (req, res, next) => {
  try {
    const [categorias] = await pool.query(
      `
      SELECT
        c.id,
        c.nombre,
        COUNT(p.id) AS total_productos
      FROM categorias c
      LEFT JOIN productos p
        ON p.categoria_id = c.id
       AND p.activo = 1
       AND p.activo_web = 1
       AND p.visible_catalogo = 1
       AND ${buildValidPublicCodeCondition("p")}
      WHERE c.activo = 1
      GROUP BY c.id, c.nombre
      ORDER BY c.nombre ASC
      `
    );

    const [familias] = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(TRIM(p.familia), ''), 'SIN_FAMILIA') AS familia,
        COUNT(*) AS total_productos
      FROM productos p
      WHERE p.activo = 1
        AND p.activo_web = 1
        AND p.visible_catalogo = 1
        AND ${buildValidPublicCodeCondition("p")}
      GROUP BY COALESCE(NULLIF(TRIM(p.familia), ''), 'SIN_FAMILIA')
      ORDER BY total_productos DESC, familia ASC
      LIMIT 50
      `
    );

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

export default router;
