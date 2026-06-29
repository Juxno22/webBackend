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
} from "./middleware/adminSecurity.js";

import healthRoutes from "./routes/health.routes.js";
import catalogoRoutes from "./routes/catalog.routes.js";
import quoteRoutes from "./routes/quotes.routes.js";
import homeRoutes from "./routes/home.routes.js";
import salesRoutes from "./routes/sales.routes.js";
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
import { buildCorsOptions, getProductionHelmetOptions } from "./config/productionConfig.js";
import adminEcommerceRoutes from "./routes/adminEcommerce.routes.js";
import adminSalesRoutes from "./routes/adminSales.routes.js";
import adminOperationsRoutes from "./routes/adminOperations.routes.js";

const app = express();
const PORT = process.env.PORT || 4000;
const TRUST_PROXY = process.env.TRUST_PROXY || (process.env.NODE_ENV === "production" ? "1" : "0");

app.set("trust proxy", TRUST_PROXY === "true" ? true : Number(TRUST_PROXY) || false);

app.use(helmet(getProductionHelmetOptions()));
app.use(cors(buildCorsOptions()));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: 'Andyfers API',
    status: 'runnig',
    health: '/api/health',
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/admin", adminSecurityHeaders);
app.use("/api/admin/login", adminLoginRateLimit);
app.use("/api/admin", adminApiRateLimit);
app.use("/api/admin", adminMutatingRateLimit);
app.use("/api/admin", auditAdminMutations);
app.use("/api", adminSecurityRoutes);
app.use("/api", adminEcommerceRoutes);
app.use("/api", adminSalesRoutes);
app.use("/api", adminOperationsRoutes);

app.use("/api", healthRoutes);
app.use("/api", catalogoRoutes);
app.use("/api", quoteRoutes);
app.use("/api", homeRoutes);
app.use("/api", salesRoutes);
app.use("/api", siteRoutes);
app.use("/api", adminRoutes);
app.use("/api", analyticsRoutes);
app.use("/api", catalogQualityRoutes);
app.use("/api", commercialTasksRoutes);
app.use("/api", commercialExportsRoutes);
app.use("/api", multimediaReviewRoutes);
app.use("/api", seoRoutes);
app.use("/api", seoLandingRoutes);
app.use("/api", aiRoutes);
app.use("/api", performanceRoutes);
app.use("/api", productionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Andyfers Backend API corriendo en http://localhost:${PORT}`);
});
