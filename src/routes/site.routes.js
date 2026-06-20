import { Router } from "express";
import { pool } from "../config/db.js";

const router = Router();

function parseJsonSafe(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanRowMetadata(row) {
  const next = {
    ...row,
    metadata: parseJsonSafe(row.metadata_json, {}),
  };

  delete next.metadata_json;

  return next;
}

async function getHomeHeroSlides() {
  try {
    const [rows] = await pool.query(`
      SELECT
        id,
        titulo,
        subtitulo,
        etiqueta,
        texto_boton,
        url_boton,
        cloudinary_public_id,
        secure_url,
        thumbnail_url,
        orden,
        activo,
        fecha_inicio,
        fecha_fin,
        updated_at
      FROM home_hero_slides
      WHERE activo = 1
        AND (fecha_inicio IS NULL OR fecha_inicio <= NOW())
        AND (fecha_fin IS NULL OR fecha_fin >= NOW())
      ORDER BY orden ASC, id ASC
    `);

    return rows;
  } catch {
    return [];
  }
}

async function getContentBlocksByPage(pagina = "HOME") {
  const [rows] = await pool.query(
    `
    SELECT
      id,
      content_key,
      pagina,
      bloque,
      tipo,
      etiqueta,
      titulo,
      subtitulo,
      contenido,
      cta_texto,
      cta_url,
      media_tipo,
      media_url,
      media_public_id,
      metadata_json,
      orden,
      activo,
      updated_at
    FROM site_content_blocks
    WHERE activo = 1
      AND pagina IN ('GLOBAL', ?)
    ORDER BY
      CASE WHEN pagina = 'GLOBAL' THEN 0 ELSE 1 END ASC,
      bloque ASC,
      orden ASC,
      id ASC
    `,
    [pagina]
  );

  return rows.map(cleanRowMetadata);
}

async function getBannersByPage(pagina = "HOME") {
  const [rows] = await pool.query(
    `
    SELECT
      id,
      banner_key,
      pagina,
      posicion,
      titulo,
      subtitulo,
      descripcion,
      texto_boton,
      url_boton,
      media_tipo,
      media_url,
      thumbnail_url,
      cloudinary_public_id,
      color_fondo,
      color_texto,
      fecha_inicio,
      fecha_fin,
      orden,
      activo,
      updated_at
    FROM site_banners
    WHERE activo = 1
      AND pagina IN ('GLOBAL', ?)
      AND (fecha_inicio IS NULL OR fecha_inicio <= NOW())
      AND (fecha_fin IS NULL OR fecha_fin >= NOW())
    ORDER BY
      CASE WHEN pagina = 'GLOBAL' THEN 0 ELSE 1 END ASC,
      posicion ASC,
      orden ASC,
      id ASC
    `,
    [pagina]
  );

  return rows.map(cleanRowMetadata);
}

async function getCommercialLines() {
  const [rows] = await pool.query(`
    SELECT
      id,
      line_key,
      nombre,
      slug,
      descripcion_corta,
      descripcion_larga,
      icono,
      color,
      imagen_url,
      thumbnail_url,
      cloudinary_public_id,
      url_destino,
      visible_home,
      orden,
      activo,
      updated_at
    FROM site_commercial_lines
    WHERE activo = 1
    ORDER BY orden ASC, id ASC
  `);

  return rows.map(cleanRowMetadata);
}

async function getFeaturedSectionsByPage(pagina = "HOME") {
  const [rows] = await pool.query(
    `
    SELECT
      id,
      section_key,
      pagina,
      titulo,
      subtitulo,
      descripcion,
      layout,
      source_type,
      filtro_familia,
      filtro_categoria_id,
      limite_productos,
      cta_texto,
      cta_url,
      metadata_json,
      orden,
      activo,
      updated_at
    FROM site_featured_sections
    WHERE activo = 1
      AND pagina = ?
    ORDER BY orden ASC, id ASC
    `,
    [pagina]
  );

  return rows.map(cleanRowMetadata);
}

async function getContactChannels() {
  const [rows] = await pool.query(`
    SELECT
      id,
      channel_key,
      tipo,
      etiqueta,
      valor,
      url,
      icono,
      descripcion,
      metadata_json,
      orden,
      activo,
      updated_at
    FROM site_contact_channels
    WHERE activo = 1
    ORDER BY orden ASC, id ASC
  `);

  return rows.map(cleanRowMetadata);
}

router.get("/site/home", async (req, res, next) => {
  try {
    const [
      heroSlides,
      contentBlocks,
      banners,
      commercialLines,
      featuredSections,
      contactChannels,
    ] = await Promise.all([
      getHomeHeroSlides(),
      getContentBlocksByPage("HOME"),
      getBannersByPage("HOME"),
      getCommercialLines(),
      getFeaturedSectionsByPage("HOME"),
      getContactChannels(),
    ]);

    res.json({
      ok: true,
      data: {
        hero_slides: heroSlides,
        content_blocks: contentBlocks,
        banners,
        commercial_lines: commercialLines,
        featured_sections: featuredSections,
        contact_channels: contactChannels,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/site/content", async (req, res, next) => {
  try {
    const pagina = String(req.query.pagina || "HOME").trim().toUpperCase();

    const data = await getContentBlocksByPage(pagina);

    res.json({
      ok: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/site/banners", async (req, res, next) => {
  try {
    const pagina = String(req.query.pagina || "HOME").trim().toUpperCase();

    const data = await getBannersByPage(pagina);

    res.json({
      ok: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/site/lineas-comerciales", async (req, res, next) => {
  try {
    const data = await getCommercialLines();

    res.json({
      ok: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/site/secciones-destacadas", async (req, res, next) => {
  try {
    const pagina = String(req.query.pagina || "HOME").trim().toUpperCase();

    const data = await getFeaturedSectionsByPage(pagina);

    res.json({
      ok: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/site/contacto", async (req, res, next) => {
  try {
    const data = await getContactChannels();

    res.json({
      ok: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

export default router;