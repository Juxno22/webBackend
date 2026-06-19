import { Router } from "express";
import { pool } from "../config/db.js";

const router = Router();

router.get("/home/hero-slides", async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `
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
      `
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
