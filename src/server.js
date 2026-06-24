import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import adminSecurityRoutes from "./routes/adminSecurity.routes.js";
import {
  adminSecurityHeaders,
  adminLoginRateLimit,
  adminApiRateLimit,
  adminMutatingRateLimit,
  auditAdminMutations,
  createFixedWindowRateLimit,
} from "./middleware/adminSecurity.js";

import healthRoutes from "./routes/health.routes.js";
import catalogoRoutes from "./routes/catalog.routes.js";
import quoteRoutes from "./routes/quotes.routes.js";
import homeRoutes from "./routes/home.routes.js";
import siteRoutes from "./routes/site.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import catalogQualityRoutes from "./routes/catalogQuality.routes.js";
import commercialTasksRoutes from "./routes/commercialTasks.routes.js";
import commercialExportsRoutes from "./routes/commercialExports.routes.js";
import multimediaReviewRoutes from "./routes/multimediaReview.routes.js";
import seoRoutes from "./routes/seo.routes.js";
import seoLandingRoutes from "./routes/seoLanding.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import performanceRoutes from "./routes/performance.routes.js";
import productionRoutes from "./routes/production.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { pool } from "./config/db.js";

const app = express();
const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "img-src": ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
      },
    },
  })
);

app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Andyfers Backend API funcionando",
    endpoints: {
      health: "/api/health",
      dbHealth: "/api/db-health",
      dbInfo: "/api/db-info",
      seoLandings: "/api/seo/landings",
    },
  });
});

app.use("/api/admin", adminSecurityHeaders);
app.use("/api/admin/login", adminLoginRateLimit);
app.use("/api/admin", adminApiRateLimit);
app.use("/api/admin", adminMutatingRateLimit);
app.use("/api/admin", auditAdminMutations);
app.use("/api", adminSecurityRoutes);

app.use("/api", healthRoutes);
app.use("/api", catalogoRoutes);
app.use("/api", quoteRoutes);
app.use("/api", homeRoutes);
app.use("/api", siteRoutes);
app.use("/api", adminRoutes);
app.use("/api", analyticsRoutes);
app.use("/api", catalogQualityRoutes);
app.use("/api", commercialTasksRoutes);
app.use("/api", commercialExportsRoutes);
app.use("/api", multimediaReviewRoutes);
app.use("/api", seoRoutes);
app.use("/api", seoLandingRoutes);

const publicAiRateLimit = createFixedWindowRateLimit({
  windowMs: 60_000,
  max: Number(process.env.PUBLIC_AI_RATE_LIMIT_MAX || 15),
  message: "Demasiadas consultas al asistente. Espera un momento.",
  eventType: "PUBLIC_AI_RATE_LIMIT",
  severidad: "MEDIA",
  keyGenerator: (req) => {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      req.ip ||
      "unknown";
    const sessionId = String(req.body?.session_id || "no-session").slice(0, 80);
    return `ai:${ip}:${sessionId}`;
  },
});

app.use("/api/ia", publicAiRateLimit);
app.use("/api", aiRoutes);
app.use("/api", performanceRoutes);
app.use("/api", productionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`Andyfers Backend API corriendo en http://localhost:${PORT}`);
});

process.on("SIGTERM", async () => {
  try {
    server.close();
    await pool.end();
  } finally {
    process.exit(0);
  }
});
