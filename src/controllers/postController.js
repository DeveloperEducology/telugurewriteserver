import { Post } from "../models/Post.js";
import { generatePostId } from "../utils/helpers.js";

export const getPosts = async (req, res) => {
  try {
    const { page = 1, limit = 20, category, search, status } = req.query;
    const skip = (page - 1) * limit;

    const filter = {};
    if (category && category !== "all") {
      filter.categories = category;
    }

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { summary: { $regex: search, $options: "i" } },
        { sourceName: { $regex: search, $options: "i" } },
      ];
    }

    if (status === "published") {
      filter.isPublished = true;
    } else if (status === "unpublished") {
      filter.isPublished = false;
    }

    const posts = await Post.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select("title summary imageUrl categories publishedAt sourceName isPublished postId");

    const total = await Post.countDocuments(filter);

    res.json({
      success: true,
      posts,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getPostById = async (req, res) => {
  try {
    const post = await Post.findOne({ postId: req.params.id });
    if (!post) {
      return res.status(404).json({ success: false, error: "Post not found" });
    }
    res.json({ success: true, post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const updatePost = async (req, res) => {
  try {
    const { title, summary, categories, isPublished, imageUrl, sourceName } = req.body;
    const post = await Post.findOne({ postId: req.params.id });
    if (!post) return res.status(404).json({ success: false, error: "Post not found" });

    if (title !== undefined) post.title = title;
    if (summary !== undefined) post.summary = summary;
    if (categories !== undefined) post.categories = categories;
    if (isPublished !== undefined) post.isPublished = isPublished;
    if (imageUrl !== undefined) post.imageUrl = imageUrl;
    if (sourceName !== undefined) post.sourceName = sourceName;

    await post.save();
    res.json({ success: true, message: "Post updated successfully", post: { postId: post.postId, title: post.title, isPublished: post.isPublished } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const deletePost = async (req, res) => {
  try {
    const result = await Post.deleteOne({ postId: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: "Post not found" });
    res.json({ success: true, message: "Post deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const togglePublish = async (req, res) => {
  try {
    const post = await Post.findOne({ postId: req.params.id });
    if (!post) return res.status(404).json({ success: false, error: "Post not found" });

    post.isPublished = !post.isPublished;
    await post.save();
    res.json({ success: true, message: `Post ${post.isPublished ? "published" : "unpublished"} successfully`, isPublished: post.isPublished });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const createManualPosts = async (req, res) => {
  try {
    const posts = Array.isArray(req.body) ? req.body : [req.body];
    if (!posts || posts.length === 0) return res.status(400).json({ success: false, error: "No posts data provided" });

    const createdPosts = [];
    for (const postData of posts) {
      const { title, summary, imageUrl, source, sourceName, sourceType, categories, relatedStories } = postData;
      if (!title || !summary) continue;

      const existingPost = await Post.findOne({ title: title, summary: { $regex: new RegExp(summary.substring(0, 50), "i") } });
      if (existingPost) continue;

      const newPost = new Post({
        postId: generatePostId(),
        title,
        summary,
        text: summary,
        imageUrl: imageUrl || null,
        source: source || "Manual",
        sourceName: sourceName || "Manual Parser",
        sourceType: sourceType || "manual",
        categories: categories || ["General"],
        relatedStories: relatedStories || [],
        isPublished: true,
        type: "normal_post",
        lang: "te",
        publishedAt: new Date(),
      });

      await newPost.save();
      createdPosts.push({ postId: newPost.postId, title: newPost.title });
    }

    res.json({ success: true, message: `Created ${createdPosts.length} posts successfully`, count: createdPosts.length, posts: createdPosts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const bulkUpdatePosts = async (req, res) => {
  try {
    const { postIds, action } = req.body;
    if (!Array.isArray(postIds) || postIds.length === 0) return res.status(400).json({ success: false, error: "No post IDs provided" });

    let update = {};
    let message = "";

    if (action === "publish") {
      update = { isPublished: true };
      message = "published";
    } else if (action === "unpublish") {
      update = { isPublished: false };
      message = "unpublished";
    } else if (action === "delete") {
      await Post.deleteMany({ postId: { $in: postIds } });
      return res.json({ success: true, message: `${postIds.length} posts deleted successfully` });
    } else {
      return res.status(400).json({ success: false, error: "Invalid action" });
    }

    await Post.updateMany({ postId: { $in: postIds } }, { $set: update });
    res.json({ success: true, message: `${postIds.length} posts ${message} successfully` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};