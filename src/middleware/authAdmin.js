import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";

export async function requireAdminAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        ok: false,
        error: "Token no proporcionado.",
      });
    }

    const token = authHeader.replace("Bearer ", "").trim();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [rows] = await pool.query(
      `
      SELECT
        id,
        nombre,
        correo,
        rol,
        activo
      FROM usuarios_admin
      WHERE id = ?
      LIMIT 1
      `,
      [decoded.id]
    );

    const user = rows?.[0];

    if (!user || Number(user.activo) !== 1) {
      return res.status(401).json({
        ok: false,
        error: "Usuario no autorizado.",
      });
    }

    req.admin = user;

    next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "Sesión inválida o expirada.",
    });
  }
}

export function requireRole(roles = []) {
  return (req, res, next) => {
    if (!req.admin || !roles.includes(req.admin.rol)) {
      return res.status(403).json({
        ok: false,
        error: "No tienes permisos para esta acción.",
      });
    }

    next();
  };
}