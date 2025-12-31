import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

router.get("/", (req, res) => res.redirect("/dashboard"));

router.get("/dashboard", (req, res) => {
  // Navigate up from /src/routes to /src/views
  res.sendFile(path.join(__dirname, "../views/dashboard.html"));
});

export default router;