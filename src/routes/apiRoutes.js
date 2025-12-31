import express from "express";
import * as dashboardCtrl from "../controllers/dashboardController.js";
import * as postCtrl from "../controllers/postController.js";
import * as queueCtrl from "../controllers/queueController.js";
import * as sourceCtrl from "../controllers/sourceController.js";

const router = express.Router();

// Dashboard Stats
router.get("/dashboard-stats", dashboardCtrl.getDashboardStats);

// Posts CRUD
router.get("/posts", postCtrl.getPosts);
router.get("/posts/:id", postCtrl.getPostById);
router.put("/posts/:id", postCtrl.updatePost);
router.delete("/posts/:id", postCtrl.deletePost);
router.post("/posts/:id/toggle-publish", postCtrl.togglePublish);
router.post("/posts/bulk-update", postCtrl.bulkUpdatePosts);
router.post("/create-manual-posts", postCtrl.createManualPosts);

// Queue
router.get("/queue", queueCtrl.getQueue);
router.post("/clear-queue", queueCtrl.clearQueue);
router.delete("/queue/:id", queueCtrl.deleteQueueItem);
router.post("/add-text-to-queue", queueCtrl.addToQueue);
router.post("/add-content-to-queue", queueCtrl.addUrlToQueue);

// Twitter Sources
router.get("/twitter-sources", sourceCtrl.twitterController.getAll);
router.post("/twitter-sources", sourceCtrl.twitterController.add);
router.put("/twitter-sources/:id", sourceCtrl.twitterController.update);
router.delete("/twitter-sources/:id", sourceCtrl.twitterController.delete);
router.get("/trigger-auto-fetch", sourceCtrl.triggerTwitter);

// RSS Sources
router.get("/rss-sources", sourceCtrl.rssController.getAll);
router.post("/rss-sources", sourceCtrl.rssController.add);
router.put("/rss-sources/:id", sourceCtrl.rssController.update);
router.delete("/rss-sources/:id", sourceCtrl.rssController.delete);
router.get("/trigger-rss-fetch", sourceCtrl.triggerRSS);

export default router;