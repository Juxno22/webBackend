import express from "express";
import {
  auditAdminAction,
  getAdminAuditLogs,
  getAdminSecurityEvents,
  getAdminSecuritySummary,
  recordSecurityEvent,
  updateSecurityEventStatus,
} from "../services/adminAudit.service.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";
import { getCriticalActionLogs, getCriticalActionSummary } from "../services/adminCriticalAction.service.js";

const router = express.Router();

const adminGuard = [requireAdminAuth, requireRole(["ADMIN"])] ;

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error("Error en seguridad admin:", error);
      res.status(error.status || 500).json({
        ok: false,
        error: error.message || "Error interno en seguridad admin.",
      });
    }
  };
}

router.get(
  "/admin/seguridad/resumen",
  adminGuard,
  asyncRoute(async (req, res) => {
    const data = await getAdminSecuritySummary(req.query || {});
    res.json({ ok: true, data });
  })
);

router.get(
  "/admin/seguridad/auditoria",
  adminGuard,
  asyncRoute(async (req, res) => {
    const rows = await getAdminAuditLogs(req.query || {});
    res.json({ ok: true, data: rows });
  })
);

router.get(
  "/admin/seguridad/eventos",
  adminGuard,
  asyncRoute(async (req, res) => {
    const rows = await getAdminSecurityEvents(req.query || {});
    res.json({ ok: true, data: rows });
  })
);


router.get(
  "/admin/seguridad/acciones-criticas/resumen",
  adminGuard,
  asyncRoute(async (req, res) => {
    const data = await getCriticalActionSummary(req.query || {});
    res.json({ ok: true, data });
  })
);

router.get(
  "/admin/seguridad/acciones-criticas",
  adminGuard,
  asyncRoute(async (req, res) => {
    const rows = await getCriticalActionLogs(req.query || {});
    res.json({ ok: true, data: rows });
  })
);

router.patch(
  "/admin/seguridad/eventos/:id/estado",
  adminGuard,
  asyncRoute(async (req, res) => {
    const result = await updateSecurityEventStatus(req.params.id, req.body?.estado);

    await auditAdminAction(req, {
      action: "ADMIN_SECURITY_EVENT_STATUS_UPDATE",
      resource_type: "admin_security_events",
      resource_id: req.params.id,
      metadata: { estado: req.body?.estado },
    });

    res.json({ ok: true, data: result });
  })
);

router.post(
  "/admin/seguridad/eventos/manual",
  adminGuard,
  asyncRoute(async (req, res) => {
    await recordSecurityEvent(req, {
      tipo: req.body?.tipo || "ADMIN_SECURITY_MANUAL_NOTE",
      severidad: req.body?.severidad || "MEDIA",
      detalle: req.body?.detalle || "Evento manual registrado desde admin.",
      metadata: req.body?.metadata || null,
    });

    await auditAdminAction(req, {
      action: "ADMIN_SECURITY_MANUAL_EVENT_CREATE",
      metadata: { tipo: req.body?.tipo, severidad: req.body?.severidad },
    });

    res.json({ ok: true });
  })
);

export default router;
