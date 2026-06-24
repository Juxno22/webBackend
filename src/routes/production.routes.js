import express from "express";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";
import {
  cleanOldProductionBackups,
  createManualDatabaseBackup,
  createProductionDeployRun,
  getProductionBackupPolicy,
  getProductionDeployReadiness,
  getProductionDeployRun,
  getProductionDeployTemplate,
  getProductionEnvSnapshot,
  listProductionBackups,
  listProductionDeployRuns,
  markProductionBackupRestoreTested,
  runProductionChecks,
  updateProductionDeployItem,
  updateProductionDeployRunStatus,
  validateProductionBackup,
} from "../services/production.service.js";

const router = express.Router();

const productionAccess = [requireAdminAuth, requireRole(["ADMIN"])]

router.get("/admin/produccion/resumen", productionAccess, async (req, res, next) => {
  try {
    const [checks, backups, deploys, readiness] = await Promise.all([
      runProductionChecks({ admin: req.admin, persist: false }),
      listProductionBackups({ limit: 12 }),
      listProductionDeployRuns({ limit: 8 }),
      getProductionDeployReadiness(),
    ]);

    res.json({
      ok: true,
      resumen: {
        status: checks.status,
        total_checks: checks.total_checks,
        ok_checks: checks.ok_checks,
        warning_checks: checks.warning_checks,
        critical_checks: checks.critical_checks,
        last_backup: backups?.[0] || null,
        last_deploy: deploys?.[0] || null,
        deploy_ready: readiness.ready,
        generated_at: checks.generated_at,
      },
      checks: checks.checks,
      backups,
      deploys,
      deploy_readiness: readiness,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/produccion/checks", productionAccess, async (req, res, next) => {
  try {
    const result = await runProductionChecks({ admin: req.admin, persist: false });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/produccion/checks/recalcular", productionAccess, async (req, res, next) => {
  try {
    const result = await runProductionChecks({ admin: req.admin, persist: true });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/produccion/env", productionAccess, async (req, res, next) => {
  try {
    res.json({ ok: true, env: getProductionEnvSnapshot() });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/produccion/backups", productionAccess, async (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 50);
    const backups = await listProductionBackups({ limit });
    res.json({ ok: true, backups, policy: getProductionBackupPolicy() });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/produccion/backups/politica", productionAccess, async (req, res, next) => {
  try {
    res.json({ ok: true, policy: getProductionBackupPolicy() });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/produccion/backups/manual", productionAccess, async (req, res, next) => {
  try {
    const confirmacion = String(req.body?.confirmacion || "").trim().toUpperCase();

    if (confirmacion !== "RESPALDAR") {
      return res.status(400).json({
        ok: false,
        error: "Confirmación inválida. Escribe RESPALDAR para generar el respaldo.",
      });
    }

    const backup = await createManualDatabaseBackup({ admin: req.admin });
    res.json({ ok: true, backup });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/produccion/backups/validar", productionAccess, async (req, res, next) => {
  try {
    const result = await validateProductionBackup({
      id: req.body?.id,
      filename: req.body?.filename,
    });
    res.json({ ok: true, validation: result });
  } catch (error) {
    next(error);
  }
});

router.patch("/admin/produccion/backups/:id/restauracion-probada", productionAccess, async (req, res, next) => {
  try {
    const result = await markProductionBackupRestoreTested({
      id: req.params.id,
      payload: req.body || {},
      admin: req.admin,
    });
    res.json({ ok: true, restore_test: result });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/produccion/backups/limpiar", productionAccess, async (req, res, next) => {
  try {
    const confirmacion = String(req.body?.confirmacion || "").trim().toUpperCase();

    if (confirmacion !== "LIMPIAR") {
      return res.status(400).json({
        ok: false,
        error: "Confirmación inválida. Escribe LIMPIAR para borrar respaldos antiguos.",
      });
    }

    const keep = Number(req.body?.keep || 15);
    const result = await cleanOldProductionBackups({ keep });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/produccion/deploys/template", productionAccess, async (req, res, next) => {
  try {
    res.json({ ok: true, items: getProductionDeployTemplate() });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/produccion/deploys/readiness", productionAccess, async (req, res, next) => {
  try {
    const readiness = await getProductionDeployReadiness();
    res.json({ ok: true, readiness });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/produccion/deploys", productionAccess, async (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 40);
    const deploys = await listProductionDeployRuns({ limit });
    res.json({ ok: true, deploys });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/produccion/deploys", productionAccess, async (req, res, next) => {
  try {
    const deploy = await createProductionDeployRun({ payload: req.body || {}, admin: req.admin });
    res.status(201).json({ ok: true, deploy });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/produccion/deploys/:id", productionAccess, async (req, res, next) => {
  try {
    const deploy = await getProductionDeployRun({ id: req.params.id });
    if (!deploy) {
      return res.status(404).json({ ok: false, error: "Despliegue no encontrado." });
    }
    res.json({ ok: true, deploy });
  } catch (error) {
    next(error);
  }
});

router.patch("/admin/produccion/deploys/:id/status", productionAccess, async (req, res, next) => {
  try {
    const deploy = await updateProductionDeployRunStatus({
      id: req.params.id,
      payload: req.body || {},
      admin: req.admin,
    });
    res.json({ ok: true, deploy });
  } catch (error) {
    next(error);
  }
});

router.patch("/admin/produccion/deploys/:id/items/:itemId", productionAccess, async (req, res, next) => {
  try {
    const deploy = await updateProductionDeployItem({
      deployId: req.params.id,
      itemId: req.params.itemId,
      payload: req.body || {},
      admin: req.admin,
    });
    res.json({ ok: true, deploy });
  } catch (error) {
    next(error);
  }
});

export default router;
