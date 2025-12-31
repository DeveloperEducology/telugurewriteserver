import { Queue } from "../models/Queue.js";
import mongoose from "mongoose";

export const getQueue = async (req, res) => {
  try {
    const queueItems = await Queue.find().sort({ queuedAt: 1 });
    res.json({ success: true, queue: queueItems });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const addToQueue = async (req, res) => {
  try {
    const { text, title, source } = req.body;
    if (!text) return res.status(400).json({ success: false, error: "Text content is required" });

    const queueItem = new Queue({
      id: new mongoose.Types.ObjectId().toString(),
      text: title ? `Title: ${title}\nContent: ${text}` : text,
      source: source || "Manual Text",
      user: { name: "Manual", screen_name: "manual_text" },
      postType: "normal_post",
      promptType: "DETAILED",
      queuedAt: new Date(),
    });

    await queueItem.save();
    res.json({ success: true, message: "Text added to queue successfully", queueId: queueItem.id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const addUrlToQueue = async (req, res) => {
  try {
    const { content, url, title, imageUrl, source } = req.body;
    if (!content && !url) return res.status(400).json({ error: "No content/url" });

    const queueItem = {
      id: new mongoose.Types.ObjectId().toString(),
      text: title ? `Title: ${title}\nContent: ${content || ""}` : content || `Article from ${url}`,
      url: url || "",
      imageUrl: imageUrl || null,
      relatedStories: [],
      media: imageUrl ? [{ type: "photo", media_url_https: imageUrl, url: imageUrl }] : [],
      extendedEntities: imageUrl ? { media: [{ media_url_https: imageUrl }] } : {},
      source: source || "Manual Paste",
      user: { name: source || "Admin", screen_name: "admin_direct" },
      postType: "normal_post",
      promptType: "DETAILED",
      queuedAt: new Date(),
    };

    await Queue.create(queueItem);
    res.json({ success: true, queueId: queueItem.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const clearQueue = async (req, res) => {
  try {
    await Queue.deleteMany({});
    res.json({ success: true, message: "Queue cleared" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const deleteQueueItem = async (req, res) => {
  try {
    await Queue.deleteOne({ id: req.params.id });
    res.json({ success: true, message: "Item removed from queue" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};