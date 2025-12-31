import mongoose from "mongoose";

const twitterSourceSchema = new mongoose.Schema({
  handle: { type: String, required: true, unique: true },
  isActive: { type: Boolean, default: true },
  addedAt: { type: Date, default: Date.now },
});

const rssSourceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  url: { type: String, required: true, unique: true },
  isActive: { type: Boolean, default: true },
  addedAt: { type: Date, default: Date.now },
});

export const TwitterSource = mongoose.models.TwitterSource || mongoose.model("TwitterSource", twitterSourceSchema);
export const RSSSource = mongoose.models.RSSSource || mongoose.model("RSSSource", rssSourceSchema);