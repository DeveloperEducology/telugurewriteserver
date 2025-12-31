import { TwitterSource, RSSSource } from "../models/Source.js";
import { loadSources } from "../services/sourceService.js";
import { fetchAndQueueRSS } from "../services/rssService.js";
import { fetchAllTwitterHandles } from "../services/twitterService.js";

// --- HELPERS ---
const handleSourceCRUD = async (Model, req, res, operation) => {
  try {
    const { id } = req.params;
    if (operation === "get") {
      const sources = await Model.find().sort({ addedAt: -1 });
      return res.json({ success: true, sources });
    }
    if (operation === "add") {
      const exists = await Model.findOne(req.body.url ? { url: req.body.url } : { handle: req.body.handle });
      if (exists) return res.status(400).json({ success: false, error: "Source already exists" });
      const source = new Model({ ...req.body, isActive: true });
      await source.save();
      await loadSources();
      return res.json({ success: true, message: "Added successfully", source });
    }
    if (operation === "update") {
      const source = await Model.findById(id);
      if (!source) return res.status(404).json({ success: false, error: "Not found" });
      Object.assign(source, req.body);
      await source.save();
      await loadSources();
      return res.json({ success: true, message: "Updated successfully", source });
    }
    if (operation === "delete") {
      await Model.deleteOne({ _id: id });
      await loadSources();
      return res.json({ success: true, message: "Deleted successfully" });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// --- EXPORTS ---
export const twitterController = {
  getAll: (req, res) => handleSourceCRUD(TwitterSource, req, res, "get"),
  add: (req, res) => {
      req.body.handle = req.body.handle.replace("@", "");
      handleSourceCRUD(TwitterSource, req, res, "add");
  },
  update: (req, res) => handleSourceCRUD(TwitterSource, req, res, "update"),
  delete: (req, res) => handleSourceCRUD(TwitterSource, req, res, "delete"),
};

export const rssController = {
  getAll: (req, res) => handleSourceCRUD(RSSSource, req, res, "get"),
  add: (req, res) => handleSourceCRUD(RSSSource, req, res, "add"),
  update: (req, res) => handleSourceCRUD(RSSSource, req, res, "update"),
  delete: (req, res) => handleSourceCRUD(RSSSource, req, res, "delete"),
};

export const triggerRSS = async (req, res) => {
  const count = await fetchAndQueueRSS();
  res.json({ success: true, queued_count: count });
};

export const triggerTwitter = async (req, res) => {
  const total = await fetchAllTwitterHandles();
  res.json({ success: true, queued_total: total });
};