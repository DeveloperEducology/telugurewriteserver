import mongoose from "mongoose";

const relatedStorySchema = new mongoose.Schema({
  title: { type: String, required: true },
  summary: String,
  imageUrl: String,
  url: String,
}, { _id: false });

const postSchema = new mongoose.Schema({
  postId: { type: Number, unique: true },
  title: { type: String, required: true },
  summary: String,
  text: String,
  url: { type: String, unique: true, sparse: true },
  imageSearchSlug: { type: String, default: "" },
  imageUrl: String,
  videoUrl: String,
  relatedStories: [relatedStorySchema],
  media: [{
    mediaType: { type: String, default: "image" },
    url: String,
    width: Number,
    height: Number,
  }],
  sourceName: String,
  source: { type: String, default: "Manual" },
  sourceType: { type: String, default: "manual" },
  tweetId: { type: String, unique: true, sparse: true },
  twitterUrl: String,
  categories: [{ type: String, default: "General" }],
  tags: [{ type: mongoose.Schema.Types.ObjectId, ref: "Tag" }],
  publishedAt: { type: Date, default: Date.now },
  isPublished: { type: Boolean, default: true },
  isAINews: { type: Boolean, default: false },
  type: { type: String, default: "normal_post" },
  lang: { type: String, default: "te" },
}, { timestamps: true, collection: "posts" });

export const Post = mongoose.models.Post || mongoose.model("Post", postSchema);