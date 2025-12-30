import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// =====================
// CONFIGURATION CHECK
// =====================
console.log("\n🔍 Checking configuration...");
console.log("CLIENT_ID exists:", !!process.env.CLIENT_ID);
console.log("CLIENT_SECRET exists:", !!process.env.CLIENT_SECRET);
console.log("REDIRECT_URI:", process.env.REDIRECT_URI);

// =====================
// AUTH ENDPOINT
// =====================
app.get("/auth", (req, res) => {
  try {
    if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
      return res.status(500).send("Missing CLIENT_ID or CLIENT_SECRET in .env file");
    }

    const oauth2Client = new OAuth2Client(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      process.env.REDIRECT_URI
    );

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/userinfo.email"
      ],
      prompt: "consent", // Force consent screen to get refresh token
      include_granted_scopes: true
    });

    console.log("\n🔗 Generated auth URL, redirecting user...");
    res.redirect(url);
  } catch (error) {
    console.error("Auth endpoint error:", error);
    res.status(500).send(`Authentication setup failed: ${error.message}`);
  }
});

// =====================
// OAUTH CALLBACK
// =====================
app.get("/oauth2callback", async (req, res) => {
  try {
    console.log("\n🔄 OAuth callback received");
    
    const { code, error } = req.query;
    
    if (error) {
      console.error("OAuth error:", error);
      return res.status(400).send(`Authorization failed: ${error}`);
    }
    
    if (!code) {
      return res.status(400).send("No authorization code provided");
    }

    console.log("Authorization code received, exchanging for tokens...");

    const oauth2Client = new OAuth2Client(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      process.env.REDIRECT_URI
    );

    const { tokens } = await oauth2Client.getToken(code);
    
    // Log token details
    console.log("\n✅ Tokens received:");
    console.log("  Access token:", tokens.access_token ? "✓ Yes" : "✗ No");
    console.log("  Refresh token:", tokens.refresh_token ? "✓ Yes" : "✗ No");
    console.log("  Scope:", tokens.scope || "Not specified");
    console.log("  Expiry:", tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : "Not specified");
    
    if (!tokens.refresh_token) {
      console.warn("⚠️ Warning: No refresh token received!");
      console.warn("This may cause issues when the access token expires.");
    }

    // Save tokens
    fs.writeFileSync(
      path.join(__dirname, "tokens.json"),
      JSON.stringify(tokens, null, 2)
    );

    console.log("💾 Tokens saved to tokens.json");
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Successful</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .success { color: green; font-size: 24px; }
          .box { background: #f5f5f5; padding: 20px; border-radius: 10px; display: inline-block; margin: 20px; }
        </style>
      </head>
      <body>
        <div class="success">✅ Authentication Successful!</div>
        <div class="box">
          <p>Tokens have been saved.</p>
          <p><a href="/check-auth">Check Authentication Status</a></p>
          <p><a href="/upload">Try Uploading a Video</a></p>
          <p><a href="/">Return to Home</a></p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("OAuth callback error:", error);
    res.status(500).send(`
      <html>
      <body>
        <h1>Authentication Failed</h1>
        <p>${error.message}</p>
        <p><a href="/auth">Try Again</a></p>
      </body>
      </html>
    `);
  }
});

// =====================
// CHECK AUTH STATUS
// =====================
app.get("/check-auth", async (req, res) => {
  try {
    console.log("\n🔍 Checking authentication status...");
    
    const tokenPath = path.join(__dirname, "tokens.json");
    
    if (!fs.existsSync(tokenPath)) {
      console.log("No tokens.json file found");
      return res.json({ 
        status: "not_authenticated", 
        message: "No tokens found. Visit /auth first." 
      });
    }

    const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    
    console.log("Tokens found in file:", {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : "None",
      scopes: tokens.scope || "Not specified"
    });

    if (!tokens.access_token) {
      return res.json({
        status: "invalid_tokens",
        message: "Access token missing from tokens.json"
      });
    }

    const oauth2Client = new OAuth2Client(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      process.env.REDIRECT_URI
    );

    oauth2Client.setCredentials(tokens);
    
    // First, try to refresh if expired
    if (tokens.expiry_date && Date.now() > tokens.expiry_date) {
      console.log("Token expired, attempting refresh...");
      
      if (!tokens.refresh_token) {
        return res.json({
          status: "token_expired_no_refresh",
          message: "Token expired and no refresh token available. Please re-authenticate.",
          expiry_date: new Date(tokens.expiry_date).toISOString(),
          current_time: new Date().toISOString()
        });
      }
      
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        console.log("Token refresh successful!");
        
        // Update tokens
        const updatedTokens = {
          ...tokens,
          ...credentials,
          refresh_token: credentials.refresh_token || tokens.refresh_token
        };
        
        fs.writeFileSync(tokenPath, JSON.stringify(updatedTokens, null, 2));
        oauth2Client.setCredentials(updatedTokens);
        
        console.log("Updated tokens saved");
      } catch (refreshError) {
        console.error("Token refresh failed:", refreshError.message);
        return res.json({
          status: "refresh_failed",
          message: "Failed to refresh token: " + refreshError.message,
          solution: "Please re-authenticate at /auth"
        });
      }
    }

    // Test the token by getting user info
    console.log("Testing token validity...");
    const oauth2 = google.oauth2({
      version: "v2",
      auth: oauth2Client
    });

    const userInfo = await oauth2.userinfo.get();
    console.log("✅ Token is valid!");
    console.log("   User email:", userInfo.data.email);
    
    // Also test YouTube API access
    const youtube = google.youtube({
      version: "v3",
      auth: oauth2Client
    });
    
    try {
      const channelResponse = await youtube.channels.list({
        part: ["snippet"],
        mine: true
      });
      
      console.log("✅ YouTube API access confirmed!");
      console.log("   Channel:", channelResponse.data.items?.[0]?.snippet?.title || "No channel found");
    } catch (youtubeError) {
      console.warn("⚠️ YouTube API test failed (but OAuth is working):", youtubeError.message);
    }

    res.json({
      status: "authenticated",
      user: {
        email: userInfo.data.email,
        name: userInfo.data.name,
        picture: userInfo.data.picture
      },
      tokens: {
        has_refresh_token: !!tokens.refresh_token,
        expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        is_expired: tokens.expiry_date ? Date.now() > tokens.expiry_date : false,
        scopes: tokens.scope || "Not specified"
      },
      message: "Authentication successful! You can now upload videos."
    });

  } catch (error) {
    console.error("Auth check error:", error.message);
    
    // Provide more detailed error information
    let errorDetails = {
      status: "authentication_error",
      error: error.message,
      code: error.code || "UNKNOWN"
    };
    
    if (error.response) {
      errorDetails.response = {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      };
    }
    
    res.json(errorDetails);
  }
});

// =====================
// GET AUTHENTICATED CLIENT
// =====================
async function getAuthenticatedClient() {
  console.log("\n🔑 Getting authenticated client...");
  
  const tokenPath = path.join(__dirname, "tokens.json");
  
  if (!fs.existsSync(tokenPath)) {
    throw new Error("No tokens found. Please visit /auth first.");
  }

  let tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
  
  if (!tokens.access_token) {
    throw new Error("No access token found in tokens.json");
  }

  const oauth2Client = new OAuth2Client(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );

  oauth2Client.setCredentials(tokens);
  
  // Refresh token if expired
  if (tokens.expiry_date && Date.now() > tokens.expiry_date) {
    console.log("Token expired, refreshing...");
    
    if (!tokens.refresh_token) {
      throw new Error("Token expired and no refresh token available. Please re-authenticate.");
    }
    
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      console.log("Token refresh successful");
      
      // Update tokens
      tokens = {
        ...tokens,
        ...credentials,
        refresh_token: credentials.refresh_token || tokens.refresh_token
      };
      
      // Save updated tokens
      fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
      console.log("Updated tokens saved");
      
      // Set new credentials
      oauth2Client.setCredentials(tokens);
    } catch (refreshError) {
      console.error("Token refresh failed:", refreshError.message);
      throw new Error(`Token refresh failed: ${refreshError.message}`);
    }
  }
  
  return oauth2Client;
}

// =====================
// UPLOAD VIDEO
// =====================
app.get("/upload", async (req, res) => {
  try {
    console.log("\n🎬 Starting video upload process...");
    
    // 1. Get authenticated client
    const oauth2Client = await getAuthenticatedClient();
    
    // 2. Create YouTube client
    const youtube = google.youtube({
      version: "v3",
      auth: oauth2Client,
    });

    // 3. Check video file
    const videoPath = path.join(__dirname, "video.mp4");
    
    if (!fs.existsSync(videoPath)) {
      console.error("Video file not found!");
      return res.status(400).json({
        error: "Video file not found",
        message: "Please create a video.mp4 file in the project root directory",
        current_directory: __dirname
      });
    }
    
    const fileStats = fs.statSync(videoPath);
    console.log(`✅ Video file found: ${fileStats.size} bytes`);
    
    // 4. Upload video
    console.log("📤 Uploading to YouTube...");
    
    const response = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: `Test Upload ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
          description: `Uploaded via YouTube Data API v3\nDate: ${new Date().toISOString()}`,
          tags: ["api-test", "upload", "youtube-api"]
        },
        status: {
          privacyStatus: "private", // private, public, or unlisted
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        body: fs.createReadStream(videoPath),
        mimeType: "video/mp4"
      },
      // Increase timeout for large files
      timeout: 300000 // 5 minutes
    });

    console.log("✅ Upload successful!");
    console.log("   Video ID:", response.data.id);
    console.log("   Video Title:", response.data.snippet?.title);

    res.json({
      success: true,
      message: "Video uploaded successfully to YouTube!",
      videoId: response.data.id,
      videoUrl: `https://www.youtube.com/watch?v=${response.data.id}`,
      details: {
        title: response.data.snippet?.title,
        description: response.data.snippet?.description,
        privacyStatus: response.data.status?.privacyStatus,
        embeddable: response.data.status?.embeddable
      }
    });

  } catch (error) {
    console.error("\n❌ Upload failed:", error.message);
    
    // Enhanced error handling
    let errorResponse = {
      error: "Upload failed",
      message: error.message
    };
    
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Status Text:", error.response.statusText);
      
      if (error.response.data) {
        console.error("Error Details:", JSON.stringify(error.response.data, null, 2));
        errorResponse.details = error.response.data;
      }
    }
    
    // Specific error handling
    if (error.code === 401 || (error.response && error.response.status === 401)) {
      errorResponse = {
        error: "Authentication Error",
        message: "Your YouTube API credentials are invalid or expired.",
        instructions: [
          "1. Visit /reset to clear old tokens",
          "2. Visit /auth to get new tokens",
          "3. Make sure you grant all permissions",
          "4. Try /upload again"
        ]
      };
    } else if (error.code === 403) {
      errorResponse = {
        error: "Permission Denied",
        message: "Your account doesn't have permission to upload videos.",
        possible_causes: [
          "YouTube channel not created",
          "Account suspended or restricted",
          "API quota exceeded",
          "Missing YouTube channel"
        ]
      };
    }
    
    res.status(error.code === 401 ? 401 : 500).json(errorResponse);
  }
});

// =====================
// RESET ENDPOINT
// =====================
app.get("/reset", (req, res) => {
  const tokenPath = path.join(__dirname, "tokens.json");
  
  if (fs.existsSync(tokenPath)) {
    try {
      const oldTokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
      console.log("\n🗑️ Deleting old tokens...");
      console.log("Had refresh token:", !!oldTokens.refresh_token);
      console.log("Had access token:", !!oldTokens.access_token);
      
      fs.unlinkSync(tokenPath);
      res.send(`
        <html>
        <body>
          <h1>Tokens Deleted</h1>
          <p>All authentication tokens have been removed.</p>
          <p><a href="/auth">Authenticate Again</a></p>
          <p><a href="/">Return to Home</a></p>
        </body>
        </html>
      `);
    } catch (error) {
      res.status(500).send(`Error deleting tokens: ${error.message}`);
    }
  } else {
    res.send(`
      <html>
      <body>
        <h1>No Tokens Found</h1>
        <p>There are no tokens to delete.</p>
        <p><a href="/auth">Authenticate Now</a></p>
      </body>
      </html>
    `);
  }
});

// =====================
// HOME PAGE
// =====================
app.get("/", (req, res) => {
  const tokenPath = path.join(__dirname, "tokens.json");
  const hasTokens = fs.existsSync(tokenPath);
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>YouTube Video Uploader</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          max-width: 900px;
          margin: 0 auto;
          padding: 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 15px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        h1 {
          color: #333;
          text-align: center;
          margin-bottom: 30px;
        }
        .status {
          padding: 15px;
          border-radius: 8px;
          margin: 20px 0;
          text-align: center;
          font-weight: bold;
        }
        .authenticated { background: #d4edda; color: #155724; }
        .not-authenticated { background: #f8d7da; color: #721c24; }
        .steps {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 20px;
          margin: 30px 0;
        }
        .step {
          background: #f8f9fa;
          padding: 20px;
          border-radius: 10px;
          border-left: 4px solid #667eea;
        }
        .step h3 {
          margin-top: 0;
          color: #333;
        }
        .btn {
          display: inline-block;
          padding: 12px 24px;
          background: #667eea;
          color: white;
          text-decoration: none;
          border-radius: 5px;
          margin: 10px 5px;
          transition: all 0.3s ease;
          border: none;
          cursor: pointer;
        }
        .btn:hover {
          background: #5a67d8;
          transform: translateY(-2px);
          box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        .btn-success { background: #38a169; }
        .btn-success:hover { background: #2f855a; }
        .btn-danger { background: #e53e3e; }
        .btn-danger:hover { background: #c53030; }
        .btn-info { background: #4299e1; }
        .btn-info:hover { background: #3182ce; }
        .requirements {
          background: #e8f4fd;
          padding: 20px;
          border-radius: 10px;
          margin-top: 30px;
        }
        .requirements ul {
          line-height: 1.8;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🎬 YouTube Video Uploader</h1>
        
        <div class="status ${hasTokens ? 'authenticated' : 'not-authenticated'}">
          ${hasTokens ? '✅ Authentication tokens found' : '⚠️ Not authenticated'}
        </div>
        
        <div class="steps">
          <div class="step">
            <h3>Step 1: Authenticate</h3>
            <p>Get access to your YouTube account</p>
            <a href="/auth" class="btn">🔐 Authenticate with Google</a>
          </div>
          
          <div class="step">
            <h3>Step 2: Check Status</h3>
            <p>Verify authentication is working</p>
            <a href="/check-auth" class="btn btn-info">🔍 Check Auth Status</a>
          </div>
          
          <div class="step">
            <h3>Step 3: Upload Video</h3>
            <p>Upload video.mp4 to YouTube</p>
            <a href="/upload" class="btn btn-success">📤 Upload Video</a>
          </div>
          
          <div class="step">
            <h3>Troubleshooting</h3>
            <p>Reset authentication if needed</p>
            <a href="/reset" class="btn btn-danger">🔄 Reset Tokens</a>
          </div>
        </div>
        
        <div class="requirements">
          <h3>📋 Requirements:</h3>
          <ul>
            <li><strong>video.mp4</strong> file in project root</li>
            <li><strong>.env file</strong> with CLIENT_ID, CLIENT_SECRET, REDIRECT_URI</li>
            <li>YouTube Data API v3 enabled in <a href="https://console.cloud.google.com/" target="_blank">Google Cloud Console</a></li>
            <li>OAuth consent screen configured with your email added to test users</li>
          </ul>
        </div>
        
        <div style="text-align: center; margin-top: 30px; color: #666;">
          <p>Server running on port ${PORT}</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// =====================
// START SERVER
// =====================
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(50));
  console.log("🚀 YouTube Upload Server Started!");
  console.log("=".repeat(50));
  console.log(`📡 Server URL: http://localhost:${PORT}`);
  console.log("\n🔗 Available Endpoints:");
  console.log(`   🔗 Home:      http://localhost:${PORT}/`);
  console.log(`   🔐 Auth:      http://localhost:${PORT}/auth`);
  console.log(`   🔍 Check:     http://localhost:${PORT}/check-auth`);
  console.log(`   📤 Upload:    http://localhost:${PORT}/upload`);
  console.log(`   🔄 Reset:     http://localhost:${PORT}/reset`);
  console.log("\n⚙️  Prerequisites:");
  console.log("   1. Create video.mp4 in project root");
  console.log("   2. Configure .env file with credentials");
  console.log("   3. Enable YouTube Data API v3 in Google Cloud");
  console.log("=".repeat(50) + "\n");
});