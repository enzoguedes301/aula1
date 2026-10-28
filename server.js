require("dotenv").config({ path: ".env.local" });
require("dotenv").config({ path: ".env", override: false });
const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Adapts Netlify Function handler signature to Express
function netlifyAdapter(handler) {
  return async (req, res) => {
    const rawBody =
      req.body && typeof req.body === "object"
        ? JSON.stringify(req.body)
        : req.body || null;

    const event = {
      httpMethod: req.method,
      path: req.path,
      queryStringParameters: req.query || {},
      headers: req.headers || {},
      body: rawBody,
    };

    try {
      const result = await handler(event);
      if (result.headers) {
        Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v));
      }
      res.status(result.statusCode).send(result.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

// API routes (same paths the frontend expects)
const pix = require("./functions/pix");
const checkPayment = require("./functions/check-payment");
const notifyApproved = require("./functions/notify-approved");
const comprovanteUpload = require("./functions/comprovantes-upload");
const comprovantesListar = require("./functions/comprovantes-listar");
const logAccess = require("./functions/log-access");
const consulta = require("./functions/consulta");
const track = require("./functions/track");
const admin = require("./functions/admin");

// Rastreio (público, sempre 204) e painel (protegido por ADMIN_TOKEN).
app.all("/api/track", netlifyAdapter(track.handler));
app.all("/api/track/*", netlifyAdapter(track.handler));
app.all("/api/admin", netlifyAdapter(admin.handler));
app.all("/api/admin/*", netlifyAdapter(admin.handler));

app.all("/api/pix", netlifyAdapter(pix.handler));
app.all("/api/check-payment", netlifyAdapter(checkPayment.handler));
app.all("/api/notify-approved", netlifyAdapter(notifyApproved.handler));
app.all("/api/comprovantes/upload.php", netlifyAdapter(comprovanteUpload.handler));
app.all("/api/comprovantes", netlifyAdapter(comprovantesListar.handler));
app.all("/api/log-access", netlifyAdapter(logAccess.handler));
app.all("/api/consulta.php", netlifyAdapter(consulta.handler));

// ---------------------------------------------------------------------------
// PAINEL /admin — build do Vite em admin-dist/ (npm run build:admin)
//
// Vem ANTES do static da raiz: senão o fallback de SPA do funil engoliria
// /admin e devolveria o index.html da oferta no lugar do painel.
// ---------------------------------------------------------------------------
const ADMIN_DIST = path.join(__dirname, "admin-dist");

app.use("/admin/assets", express.static(path.join(ADMIN_DIST, "assets")));

app.get(["/admin", "/admin/*"], (_req, res) => {
  const page = path.join(ADMIN_DIST, "admin.html");
  if (!require("fs").existsSync(page)) {
    return res
      .status(503)
      .type("text/plain; charset=utf-8")
      .send("Painel não compilado. Rode: npm run build:admin");
  }
  res.sendFile(page);
});

// Serve static files (HTML, CSS, JS, fonts, img etc.)
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    if (/\.(js|css|html)$/i.test(filePath)) {
      res.setHeader("Content-Type", `${getContentType(filePath)}; charset=utf-8`);
    }
  }
}));

function getContentType(filePath) {
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

// SPA fallback — all unknown routes return index.html
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
