import { pool } from "../../config/db.js";
import { cleanString } from "./catalogUtils.service.js";

export async function logAiSearch({
  question,
  intent,
  candidates,
  recommended,
  service,
  response,
  origen,
}) {
  try {
    await pool.query(
      `
      INSERT INTO ia_consultas_log
        (
          pregunta_usuario,
          intencion_json,
          productos_contexto_json,
          servicio_ia,
          respuesta,
          total_candidatos,
          total_recomendados,
          origen,
          productos_contexto,
          productos_recomendados
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        question,
        JSON.stringify(intent),
        JSON.stringify(candidates.slice(0, 15)),
        service,
        response,
        candidates.length,
        recommended.length,
        origen,
        JSON.stringify(candidates.slice(0, 15)),
        JSON.stringify(recommended),
      ]
    );
  } catch (error) {
    console.error("No se pudo guardar ia_consultas_log:", error.message);
  }
}

