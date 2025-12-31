import mongoose from "mongoose";

const relatedStorySchema = new mongoose.Schema({
  title: { type: String, required: true },
  summary: String,
  imageUrl: String,
  url: String,
}, { _id: false });

const queueSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  text: String,
  url: String,
  media: Array,
  imageUrl: String,
  extendedEntities: Object,
  relatedStories: [relatedStorySchema],
  source: { type: String, default: "Manual" },
  user: Object,
  postType: { type: String, default: "normal_post" },
  promptType: { type: String, default: "DETAILED" },
  useAuthorContext: { type: Boolean, default: true },
  originalDbId: { type: mongoose.Schema.Types.ObjectId, default: null },
  queuedAt: { type: Date, default: Date.now },
});

export const Queue = mongoose.models.Queue || mongoose.model("Queue", queueSchema);