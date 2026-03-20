import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import cookieSession from "cookie-session";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.set("trust proxy", 1);
  app.use(
    cookieSession({
      name: "github_dashboard_session",
      // Use a very stable key for the session
      keys: [process.env.SESSION_SECRET || "a-very-stable-and-long-default-secret-key-12345"],
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      secure: true,
      sameSite: "none",
      httpOnly: true,
      signed: true,
      overwrite: true
    })
  );

  // Debug middleware
  app.use((req, res, next) => {
    const hasToken = !!req.session?.github_token;
    console.log(`${req.method} ${req.url} - Session exists: ${hasToken} - Host: ${req.headers.host}`);
    next();
  });

  // GitHub OAuth Routes
  app.get("/api/auth/github/url", (req, res) => {
    const client_id = process.env.GITHUB_CLIENT_ID;
    if (!client_id) {
      return res.status(500).json({ error: "GITHUB_CLIENT_ID not configured" });
    }

    // Prioritize the current request host to ensure the cookie is set for the correct domain
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const baseUrl = `${protocol}://${host}`;
    const redirect_uri = `${baseUrl}/api/auth/github/callback`;
    
    const scope = "read:user repo";
    const url = `https://github.com/login/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(
      redirect_uri
    )}&scope=${scope}`;

    console.log(`[OAuth] Generating URL. Base: ${baseUrl}, Redirect: ${redirect_uri}`);
    res.json({ url });
  });

  app.get("/api/auth/github/callback", async (req, res) => {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send("No code provided");
    }

    try {
      const response = await axios.post(
        "https://github.com/login/oauth/access_token",
        {
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
        },
        {
          headers: {
            Accept: "application/json",
            'User-Agent': 'GitHub-Dashboard-App'
          },
        }
      );

      if (response.data.error) {
        console.error("GitHub OAuth Token Error:", response.data.error_description || response.data.error);
        return res.status(400).send(`Auth failed: ${response.data.error_description || response.data.error}`);
      }

      const { access_token } = response.data;
      if (!access_token) {
        throw new Error("Failed to get access token from GitHub");
      }

      // Verify the token immediately
      try {
        await axios.get("https://api.github.com/user", {
          headers: { 
            Authorization: `Bearer ${access_token}`,
            'User-Agent': 'GitHub-Dashboard-App'
          }
        });
      } catch (verifyError: any) {
        console.error("Token verification failed:", verifyError.response?.data || verifyError.message);
        return res.status(401).send("GitHub returned an invalid token. Please check your Client ID and Secret.");
      }

      if (req.session) {
        req.session.github_token = access_token;
        console.log(`[OAuth] Success. Token stored for host: ${req.headers.host}`);
      }

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("OAuth error:", error);
      res.status(500).send("Authentication failed");
    }
  });

  app.get("/api/auth/status", (req, res) => {
    res.json({ isAuthenticated: !!req.session?.github_token });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session = null;
    res.json({ success: true });
  });

  // GitHub Data Routes
  app.get("/api/github/user", async (req, res) => {
    const token = req.session?.github_token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const response = await axios.get("https://api.github.com/user", {
        headers: { 
          Authorization: `Bearer ${token}`,
          'User-Agent': 'GitHub-Dashboard-App'
        },
      });
      res.json(response.data);
    } catch (error: any) {
      console.error("GitHub API Error (User):", error.response?.data || error.message);
      res.status(error.response?.status || 500).json({ error: "Failed to fetch user" });
    }
  });

  // Fetch a specific public repository or private if token exists
  app.get("/api/github/repo/:owner/:repo", async (req, res) => {
    const { owner, repo } = req.params;
    const token = req.session?.github_token;
    const headers: any = { 'User-Agent': 'GitHub-Dashboard-App' };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      res.json(response.data);
    } catch (error: any) {
      console.error(`GitHub API Error (Repo ${owner}/${repo}):`, error.response?.data || error.message);
      res.status(error.response?.status || 500).json({ error: "Failed to fetch repository" });
    }
  });

  // Fetch contents of a repository
  app.get("/api/github/repo/:owner/:repo/contents/*", async (req, res) => {
    const { owner, repo } = req.params;
    const path = req.params[0] || "";
    const token = req.session?.github_token;
    const headers: any = { 'User-Agent': 'GitHub-Dashboard-App' };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, { headers });
      res.json(response.data);
    } catch (error: any) {
      console.error(`GitHub API Error (Contents ${owner}/${repo}/${path}):`, error.response?.data || error.message);
      res.status(error.response?.status || 500).json({ error: "Failed to fetch contents" });
    }
  });

  // Upload/Update a file in a repository
  app.put("/api/github/repo/:owner/:repo/contents/*", async (req, res) => {
    const { owner, repo } = req.params;
    const path = req.params[0];
    const { message, content, sha } = req.body;
    const token = req.session?.github_token;

    if (!token) return res.status(401).json({ error: "Unauthorized" });
    if (!path) return res.status(400).json({ error: "Path is required" });
    if (!message || !content) return res.status(400).json({ error: "Message and content are required" });

    try {
      const response = await axios.put(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        { message, content, sha },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'GitHub-Dashboard-App',
            Accept: 'application/vnd.github.v3+json'
          },
        }
      );
      res.json(response.data);
    } catch (error: any) {
      console.error(`GitHub API Error (Upload ${owner}/${repo}/${path}):`, error.response?.data || error.message);
      res.status(error.response?.status || 500).json({ error: error.response?.data?.message || "Failed to upload file" });
    }
  });

  app.get("/api/github/repos", async (req, res) => {
    const token = req.session?.github_token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const response = await axios.get("https://api.github.com/user/repos?sort=updated&per_page=10", {
        headers: { 
          Authorization: `Bearer ${token}`,
          'User-Agent': 'GitHub-Dashboard-App'
        },
      });
      res.json(response.data);
    } catch (error: any) {
      console.error("GitHub API Error (Repos):", error.response?.data || error.message);
      res.status(error.response?.status || 500).json({ error: "Failed to fetch repos" });
    }
  });

  app.get("/api/config/status", (req, res) => {
    res.json({
      isConfigured: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
