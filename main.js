const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  shell,
  nativeImage,
} = require("electron");
const path = require("path");
const url = require("url");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const bodyParser = require("body-parser");
const http = require("http");
const socketIo = require("socket.io");
const fs = require("fs");
const os = require("os");
const zlib = require('zlib');

// Add this near the top with other constants
const USER_DATA_PATH = path.join(os.homedir(), ".ttpg-twitch-helper");
const AUTH_FILE_PATH = path.join(USER_DATA_PATH, "auth-data.json");

// Prevent garbage collection of the tray icon
let tray = null;

// Configuration
const PORT = 8080;
const CLIENT_ID = "gaod8qeh6v1bhu46nzvo4fmrqqvvrf"; // Fill this in when creating the extension
const JWT_SIGNING_URL =
  "https://v0-serverless-jwt-signing.vercel.app/api/sign-jwt";
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const VERSION = "1.0.0";

// Store auth data (in-memory only)
let authData = {
  token: null,
  channelId: null,
  isAuthenticated: false,
};

// Load saved auth data if exists
function loadSavedAuthData() {
  try {
    if (!fs.existsSync(USER_DATA_PATH)) {
      fs.mkdirSync(USER_DATA_PATH, { recursive: true });
      return false;
    }

    if (fs.existsSync(AUTH_FILE_PATH)) {
      const savedData = JSON.parse(fs.readFileSync(AUTH_FILE_PATH, "utf8"));
      if (savedData && savedData.token && savedData.channelId) {
        authData = savedData;
        console.log("Loaded saved authentication data");
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error("Error loading saved auth data:", error.message);
    return false;
  }
}

// Save auth data to file
function saveAuthData() {
  try {
    if (!fs.existsSync(USER_DATA_PATH)) {
      fs.mkdirSync(USER_DATA_PATH, { recursive: true });
    }
    fs.writeFileSync(AUTH_FILE_PATH, JSON.stringify(authData, null, 2));
    console.log("Authentication data saved");
  } catch (error) {
    console.error("Error saving auth data:", error.message);
  }
}

// Store the last received game data
let lastGameData = null;

// Configuration settings
let config = {
  autoReconnect: true,
  debugMode: false,
  refreshInterval: 5,
  minimizeToTray: true,
  startMinimized: false,
  autoLaunch: false,
};

// Electron Window and App Setup
let mainWindow;
let expressApp;
let server;
let io;
let startTime;
let signedJwt = "";

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Continue with app initialization
  app.whenReady().then(createWindow);
}

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    // No external icon file needed
  });

  // Start the Express server
  startExpressServer();

  // Load the local URL once the server is ready
  setTimeout(() => {
    mainWindow.loadURL(`http://localhost:${PORT}`);
  }, 1000);

  // Create tray icon
  createTray();

  // Set up event handlers
  mainWindow.on("closed", function () {
    mainWindow = null;
  });

  mainWindow.on("close", function (event) {
    if (config.minimizeToTray && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  // If start minimized is enabled
  if (config.startMinimized) {
    mainWindow.minimize();
  }
}

function createTray() {
  try {
    // Create the tray icon
    const image = nativeImage.createFromPath(
      path.join(__dirname, "assets", "icon.png")
    );

    // Create the tray with the icon
    tray = new Tray(image);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Open Dashboard",
        click: () => {
          mainWindow.show();
        },
      },
      {
        label: "Twitch Authentication",
        click: () => {
          // Open in a new window
          const authWindow = new BrowserWindow({
            width: 800,
            height: 700,
            parent: mainWindow,
            modal: true,
          });

          // First load the auth URL which will redirect to Twitch
          authWindow.loadURL(`http://localhost:${PORT}/auth`);

          // Handle window close
          authWindow.on("closed", () => {
            // Refresh the main window when auth window is closed
            if (mainWindow) {
              mainWindow.webContents.reload();
            }
          });
        },
      },
      { type: "separator" },
      {
        label: "Debug Mode",
        type: "checkbox",
        checked: config.debugMode,
        click: (menuItem) => {
          config.debugMode = menuItem.checked;
          io.emit("config_updated", config);
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setToolTip("TTPG Twitch Extension Helper");
    tray.setContextMenu(contextMenu);

    tray.on("click", () => {
      mainWindow.show();
    });
  } catch (error) {
    // If tray creation fails, log the error but don't crash the app
    console.error("Failed to create tray icon:", error.message);
    console.log("The application will continue without a tray icon");
  }
}

function startExpressServer() {
  startTime = Date.now();

  // Create the Express app
  expressApp = express();
  server = http.createServer(expressApp);
  io = socketIo(server);

  // Load saved auth data if available
  const authLoaded = loadSavedAuthData();

  // Middleware
  expressApp.use(cors());
  expressApp.use(bodyParser.json({ limit: "5mb" })); // Increased limit for larger game data
  expressApp.use(express.static(path.join(__dirname, "public")));

  // Routes
  expressApp.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // Start Twitch authentication
  expressApp.get("/auth", (req, res) => {
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
      REDIRECT_URI
    )}&response_type=token&scope=channel:read:subscriptions`;

    // Directly redirect to Twitch auth
    res.redirect(authUrl);
  });

  // Auth callback page
  expressApp.get("/auth/callback", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "callback.html"));
  });

  // API to receive auth data from the callback page
  expressApp.post("/auth/complete", (req, res) => {
    const { access_token } = req.body;

    if (!access_token) {
      return res.status(400).json({ error: "No access token provided" });
    }

    // Get the channel ID using the token
    axios
      .get("https://api.twitch.tv/helix/users", {
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Client-ID": CLIENT_ID,
        },
      })
      .then((response) => {
        const userData = response.data.data[0];

        authData = {
          token: access_token,
          channelId: userData.id,
          username: userData.login,
          displayName: userData.display_name,
          isAuthenticated: true,
        };

        // Save auth data to file
        saveAuthData();

        console.log(
          "Authentication successful for user:",
          userData.display_name
        );
        io.emit("auth_status", {
          authenticated: true,
          channelId: userData.id,
          username: userData.login,
          displayName: userData.display_name,
        });

        res.json({ success: true });
      })
      .catch((err) => {
        console.error("Error getting user data:", err.message);
        res.status(500).json({ error: "Failed to get user data" });
      });
  });

  // Add a logout endpoint
  expressApp.post("/auth/logout", (req, res) => {
    authData = {
      token: null,
      channelId: null,
      isAuthenticated: false,
    };

    // Delete the saved auth file
    try {
      if (fs.existsSync(AUTH_FILE_PATH)) {
        fs.unlinkSync(AUTH_FILE_PATH);
      }
    } catch (error) {
      console.error("Error removing auth file:", error.message);
    }

    io.emit("auth_status", {
      authenticated: false,
      channelId: null,
      username: null,
      displayName: null,
    });

    res.json({ success: true });
  });

  // Endpoint to receive data from TTPG
  expressApp.post("/postkey_ttpg", async (req, res) => {
    const preprocessedGameData = req.body;

    // Store the game data
    const gameData = transformTTPGtoAppV2(preprocessedGameData);
    lastGameData = gameData;

    // console.log("old DATA");
    // console.log(JSON.stringify(preprocessedGameData));
    // console.log("TRANSFORMED DATA");
    // console.log(JSON.stringify(gameData));

    // Log the received data (for debugging)
    if (config.debugMode) {
      console.log(
        "Received game data:",
        JSON.stringify(gameData).substring(0, 100) + "..."
      );
    }

    // Emit to all connected clients
    io.emit("ttpg_data", gameData);

    if (!authData.isAuthenticated) {
      return res.status(401).json({ error: "Not authenticated with Twitch" });
    }

    try {
      // Prepare the JWT payload
      if (signedJwt === "") {
        signedJwt = await getNewSignedJWT();
      }

      // Send to Twitch PubSub
      const pubsubResult = await sendToPubSub(signedJwt, gameData);

      // Emit PubSub status to all connected clients
      io.emit("pubsub_status", { success: true });

      res.json({ success: true });
    } catch (err) {
      console.error("Error processing game data:", err.message);

      // Emit error to all connected clients
      io.emit("pubsub_status", {
        success: false,
        error: err.message,
        details: err.details,
      });

      res
        .status(500)
        .json({ error: "Error processing game data: " + err.message });
    }
  });

  async function getNewSignedJWT() {
    try {
      console.log("Attempting to sign JWT...");
      const jwtPayload = {
        // exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // Expires in 60 seconds
        user_id: authData.channelId,
        role: "external",
        channel_id: authData.channelId,
        pubsub_perms: {
          send: ["broadcast"],
        },
      };

      // Get the JWT signed by the serverless function
      const signResponse = await axios.post(JWT_SIGNING_URL, jwtPayload);
      const newSignedJwt = signResponse.data.token;
      console.log("JWT signed successfully.");

      return newSignedJwt;
    } catch {
      throw new Error("Failed to sign JWT");
    }
  }

  // API endpoint to get server status
  expressApp.get("/api/status", (req, res) => {
    const status = {
      version: VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      authenticated: authData.isAuthenticated,
      channelId: authData.channelId,
      lastDataReceived: lastGameData ? new Date().toISOString() : null,
      config: config,
      system: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        memory: {
          total: Math.floor(os.totalmem() / (1024 * 1024)),
          free: Math.floor(os.freemem() / (1024 * 1024)),
        },
      },
    };

    res.json(status);
  });

  // API endpoint to update configuration
  expressApp.post("/api/config", (req, res) => {
    const newConfig = req.body;

    if (!newConfig) {
      return res.status(400).json({ error: "Invalid configuration" });
    }

    // Update the configuration
    config = {
      ...config,
      ...newConfig,
    };

    // Broadcast the updated configuration to all connected clients
    io.emit("config_updated", config);

    res.json({ success: true, config });
  });

  // Socket.IO for UI updates
  io.on("connection", (socket) => {
    console.log("UI client connected");

    // Send initial data to the new client
    socket.emit("auth_status", {
      authenticated: authData.isAuthenticated,
      channelId: authData.channelId,
      username: authData.username,
      displayName: authData.displayName,
    });

    socket.emit("config_updated", config);

    if (lastGameData) {
      socket.emit("ttpg_data", lastGameData);
    }

    // Handle events from the client
    socket.on("request_status", () => {
      socket.emit("auth_status", {
        authenticated: authData.isAuthenticated,
        channelId: authData.channelId,
        username: authData.username,
        displayName: authData.displayName,
      });

      if (lastGameData) {
        socket.emit("ttpg_data", lastGameData);
      }
    });

    socket.on("update_config", (newConfig) => {
      if (newConfig) {
        // Update the configuration
        config = {
          ...config,
          ...newConfig,
        };

        // Broadcast the updated configuration to all connected clients
        io.emit("config_updated", config);
      }
    });

    socket.on("disconnect", () => {
      console.log("UI client disconnected");
    });
  });

  // Start the server
  server.listen(PORT, () => {
    const networkInterfaces = os.networkInterfaces();
    let localIp = "localhost";

    // Try to find the local IP address
    Object.keys(networkInterfaces).forEach((ifname) => {
      networkInterfaces[ifname].forEach((iface) => {
        if (iface.family === "IPv4" && !iface.internal) {
          localIp = iface.address;
        }
      });
    });

    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Or access via local network: http://${localIp}:${PORT}`);
    console.log(
      `To authenticate with Twitch, visit http://localhost:${PORT}/auth`
    );
  });
}

// Function to send data to Twitch PubSub with improved error logging
async function sendToPubSub(jwt, data) {
  try {
    const endpoint = `https://api.twitch.tv/helix/extensions/pubsub`;
    
    // Compress the data using gzip
    const jsonString = JSON.stringify(data);
    const compressedData = zlib.gzipSync(jsonString).toString('base64');
    
    // Add compression flag to the payload so frontend knows to decompress
    const payload = {
      broadcaster_id: authData.channelId,
      message: JSON.stringify({
        compressed: true,
        data: compressedData
      }),
      target: ["broadcast"],
    };
    
    // Log compression stats in debug mode
    if (config.debugMode) {
      const originalSize = Buffer.byteLength(jsonString, 'utf8') / 1024;
      const compressedSize = Buffer.byteLength(JSON.stringify(payload.message), 'utf8') / 1024;
      console.log(`Compression: ${originalSize.toFixed(2)}KB → ${compressedSize.toFixed(2)}KB (${(compressedSize/originalSize*100).toFixed(2)}%)`);
    }
    
    const headers = {
      Authorization: `Bearer ${jwt}`,
      "Client-ID": "7t2yby9rut597oiqidb2cu7hvzwwuv",
      "Content-Type": "application/json",
    };

    // Log the request details (only in debug mode)
    if (config.debugMode) {
      console.log("PubSub Request:", {
        endpoint,
        headers: { ...headers, Authorization: "Bearer [TOKEN HIDDEN]" },
        payload: {
          ...payload,
          message: `[COMPRESSED: ${compressedSize.toFixed(2)}KB]`
        },
      });
    }

    const response = await axios.post(endpoint, payload, { headers });

    process.stdout.write("\rData sent to PubSub successfully");
    return response.data;
  } catch (err) {
    // Enhanced error logging
    console.error("=== PubSub Error Details ===");
    console.error(`Status: ${err.response?.status || "Unknown"}`);
    console.error(`Message: ${err.message}`);

    // Log detailed error response if available
    if (err.response) {
      console.error(
        "Response data:",
        JSON.stringify(err.response.data, null, 2)
      );
      console.error(
        "Response headers:",
        JSON.stringify(err.response.headers, null, 2)
      );
    }

    // Log JWT details (expiration only, not the token itself)
    try {
      const tokenParts = jwt.split(".");
      if (tokenParts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(tokenParts[1], "base64").toString()
        );
        console.error(
          "JWT expiration:",
          new Date(payload.exp * 1000).toISOString()
        );
        console.error("Current time:", new Date().toISOString());
        console.error("JWT expired:", payload.exp * 1000 < Date.now());
      }
    } catch (tokenErr) {
      console.error("Could not parse JWT for debugging:", tokenErr.message);
    }

    // Log channel ID
    console.error("Channel ID:", authData.channelId);
    console.error("==========================");

    // Enrich the error object with more context for the UI
    const enhancedError = new Error(`PubSub Error: ${err.message}`);
    enhancedError.status = err.response?.status;
    enhancedError.details = err.response?.data;

    throw enhancedError;
  }
}

// Make sure Express server closes when app quits
app.on("will-quit", () => {
  if (server) {
    server.close();
  }
});

// On macOS it's common to re-create a window when dock icon is clicked
app.on("activate", function () {
  if (mainWindow === null) createWindow();
});

// Quit when all windows are closed
app.on("window-all-closed", function () {
  // On macOS applications should keep open until the user quits explicitly
  if (process.platform !== "darwin") app.quit();
});

const COLOR_NAME_TO_HEX = {
  white: "#FFFFFF",
  blue: "#00a8cc", //"#6EC1E4",
  purple: "#c147e9", //"#9161a8",
  yellow: "#ffde17",
  red: "#e94f64", //"#e46d72",
  green: "#00a14b",
  orange: "#FF781F",
  pink: "#FF69B4",
  "-": "unset",
};
const ALT_COLOR_NAME_TO_HEX = {
  white: "#BBBBBB",
  blue: "#07B2FF",
  purple: "#7400B7",
  yellow: "#D6B700",
  red: "#CB0000",
  green: "#007306",
  orange: "#F3631C",
  pink: "#F46FCD",
};
const UNKNOWN_COLOR_NAME = "-";
const UNKNOWN_COLOR_HEX = "#ffffff";

const FACTION_WHITELIST = new Set([
  "arborec",
  "argent",
  "bobert",
  "creuss",
  "empyrean",
  "hacan",
  "jolnar",
  "keleres",
  "l1z1x",
  "letnev",
  "mahact",
  "mentak",
  "muaat",
  "naalu",
  "naazrokha",
  "nekro",
  "nomad",
  "norr",
  "saar",
  "sol",
  "ul",
  "vuilraith",
  "winnu",
  "xxcha",
  "yin",
  "yssaril",
]);
const UNKNOWN_FACTION = "cat";

const OBJECTIVE_NAME_ABBREVIATIONS = {
  // Public
  "Diversify Research": "2 TECH 2 COLORS",
  "Develop Weaponry": "2 UNIT UPGRADES",
  "Sway the Council": "8 INFLUENCE",
  "Erect a Monument": "8 RESOURCES",
  "Negotiate Trade Routes": "5 TRADE GOODS",
  "Lead From the Front": "3 COMMAND TOKENS",
  "Intimidate Council": "2 SYS ADJ TO MR",
  "Corner the Market": "4 PLANET SAME TRAIT",
  "Found Research Outposts": "3 TECH SPECIALTY",
  "Expand Borders": "6 NON-HOME PLANET",
  "Amass Wealth": "3 INF 3 RES 3 TG",
  "Build Defenses": "4 STRUCTURES",
  "Discover Lost Outposts": "2 ATTACHMENTS",
  "Engineer a Marvel": "FLAG/WAR SUN",
  "Explore Deep Space": "3 EMPTY SYS",
  "Improve Infrastructure": "3 STRUCT NOT HOME",
  "Make History": "2 LGND/MR/ANOM",
  "Populate the Outer Rim": "3 EDGE SYS",
  "Push Boundaries": "> 2 NGHBRS",
  "Raise a Fleet": "5 NON-FGTR SHIPS",
  "Master the Sciences": "2 TECH 4 COLORS",
  "Revolutionize Warfare": "3 UNIT UPGRADES",
  "Manipulate Galactic Law": "16 INFLUENCE",
  "Found a Golden Age": "16 RESOURCES",
  "Centralize Galactic Trade": "10 TRADE GOODS",
  "Galvanize the People": "6 COMMAND TOKENS",
  "Conquer the Weak": "1 OPPONENT HOME",
  "Unify the Colonies": "6 PLANET SAME TRAIT",
  "Form Galactic Brain Trust": "5 TECH SPECIALTY",
  "Subdue the Galaxy": "11 NON-HOME PLANET",
  "Achieve Supremacy": "FLAG/WS ON MR/HS",
  "Become a Legend": "4 LGND/MR/ANOM",
  "Command an Armada": "8 NON-FGTR SHIPS",
  "Construct Massive Cities": "7 STRUCTURES",
  "Control the Borderlands": "5 EDGE SYS",
  "Hold Vast Reserves": "6 INF 6 RES 6 TG",
  "Patrol Vast Territories": "5 EMPTY SYS",
  "Protect the Border": "5 STRUCT NOT HOME",
  "Reclaim Ancient Monuments": "3 ATTACHMENTS",
  "Rule Distant Lands": "2 IN/ADJ OTHER HS",

  // Secrets
  "Become the Gatekeeper": "ALPHA AND BETA",
  "Mine Rare Minerals": "4 HAZARDOUS",
  "Forge an Alliance": "4 CULTURAL",
  "Monopolize Production": "4 INDUSTRIAL",
  "Cut Supply Lines": "BLOCKADE SD",
  "Occupy the Seat of the Empire": "MR W/ 3 SHIPS",
  "Learn the Secrets of the Cosmos": "3 ADJ TO ANOMALY",
  "Control the Region": "6 SYSTEMS",
  "Threaten Enemies": "SYS ADJ TO HOME",
  "Adapt New Strategies": "2 FACTION TECH",
  "Master the Laws of Physics": "4 TECH 1 COLOR",
  "Gather a Mighty Fleet": "5 DREADNOUGHTS",
  "Form a Spy Network": "5 ACTION CARDS",
  "Fuel the War Machine": "3 SPACE DOCKS",
  "Establish a Perimeter": "4 PDS",
  "Make an Example of Their World": "BOMBARD LAST GF",
  "Turn Their Fleets to Dust": "SPC LAST SHIP",
  "Destroy Their Greatest Ship": "DESTORY WS/FLAG",
  "Unveil Flagship": "WIN W/ FLAGSHIP",
  "Spark a Rebellion": "WIN VS LEADER",
  "Become a Martyr": "LOSE IN HOME",
  "Betray a Friend": "WIN VS PROM NOTE",
  "Brave the Void": "WIN IN ANOMALY",
  "Darken the Skies": "WIN IN HOME",
  "Defy Space and Time": "WORMHOLE NEXUS",
  "Demonstrate Your Power": "3 SHIPS SURVIVE",
  "Destroy Heretical Works": "PURGE 2 FRAGMENTS",
  "Dictate Policy": "3 LAWS IN PLAY",
  "Drive the Debate": "ELECTED AGENDA",
  "Establish Hegemony": "12 INFLUENCE",
  "Fight with Precision": "AFB LAST FIGHTER",
  "Foster Cohesion": "NEIGHBOR W / ALL",
  "Hoard Raw Materials": "12 RESOURCES",
  "Mechanize the Military": "4 PLANETS W/ MECH",
  "Occupy the Fringe": "9 GROUND FORCES",
  "Produce en Masse": "8 PROD VALUE",
  "Prove Endurance": "PASS LAST",
  "Seize an Icon": "LEGENDARY PLANET",
  "Stake Your Claim": "SHARE SYSTEM",
  "Strengthen Bonds": "PROM NOTE",
};

const LAW_ABBREVIATIONS = {
  "Anti-Intellectual Revolution": "Anti-Int Revolution",
  "Classified Document Leaks": "Classified Doc Leaks",
  "Committee Formation": "Committee Formation",
  "Conventions of War": "Conv's of War",
  "Core Mining": "Core Mining",
  "Demilitarized Zone": "Demil'zd Zone",
  "Enforced Travel Ban": "Enforced Travel Ban",
  "Executive Sanctions": "Exec Sanctions",
  "Fleet Regulations": "Fleet Regs",
  "Holy Planet of Ixth": "Holy Planet of Ixth",
  "Homeland Defense Act": "Homeland Def Act",
  "Imperial Arbiter": "Imperial Arbiter",
  "Minister of Commerce": "Min of Commerce",
  "Minister of Exploration": "Min of Exploration",
  "Minister of Industry": "Min of Industry",
  "Minister of Peace": "Min of Peace",
  "Minister of Policy": "Min of Policy",
  "Minister of Sciences": "Min of Sciences",
  "Minister of War": "Min of War",
  "Prophecy of Ixth": "Proph of Ixth",
  "Publicize Weapon Schematics": "Pub Weapon Schematics",
  "Regulated Conscription": "Reg Conscription",
  "Representative Government": "Rep Gov't",
  "Research Team: Biotic": "Res Team: Biotic",
  "Research Team: Cybernetic": "Res Team: Cybernetic",
  "Research Team: Propulsion": "Res Team: Propulsion",
  "Research Team: Warfare": "Res Team: Warfare",
  "Senate Sanctuary": "Senate Sanct'y",
  "Shard of the Throne": "Shard of the Throne",
  "Shared Research": "Shared Research",
  "Terraforming Initiative": "Terrafor Initiative",
  "The Crown of Emphidia": "Crown of Emphidia",
  "The Crown of Thalnos": "Crown of Thalnos",
  "Wormhole Reconstruction": "Wormhole Reconstruct",
  "Articles of War": "Articles of War",
  "Checks and Balances": "Checks and Bal's",
  "Nexus Sovereignty": "Nexus Sovereignty",
  "Political Censure": "Pol Censure",
  "Search Warrant": "Search Warrant",
};

const SECRET_OBJECTIVES = [
  "Become the Gatekeeper",
  "Mine Rare Minerals",
  "Forge an Alliance",
  "Monopolize Production",
  "Cut Supply Lines",
  "Occupy the Seat of the Empire",
  "Learn the Secrets of the Cosmos",
  "Control the Region",
  "Threaten Enemies",
  "Adapt New Strategies",
  "Master the Laws of Physics",
  "Gather a Mighty Fleet",
  "Form a Spy Network",
  "Fuel the War Machine",
  "Establish a Perimeter",
  "Make an Example of Their World",
  "Turn Their Fleets to Dust",
  "Destroy Their Greatest Ship",
  "Unveil Flagship",
  "Spark a Rebellion",
  "Become a Martyr",
  "Betray a Friend",
  "Brave the Void",
  "Defy Space and Time",
  "Demonstrate Your Power",
  "Destroy Heretical Works",
  "Dictate Policy",
  "Drive the Debate",
  "Establish Hegemony",
  "Fight with Precision",
  "Foster Cohesion",
  "Hoard Raw Materials",
  "Mechanize the Military",
  "Occupy the Fringe",
  "Produce en Masse",
  "Prove Endurance",
  "Seize an Icon",
  "Stake Your Claim",
  "Strengthen Bonds",
];

const RELIC_POINTS = ["Shard of the Throne (PoK)", "The Crown of Emphidia"];

const AGENDA_POINTS = ["Mutiny", "Seed of an Empire"];

const TECHNOLOGY_COLOR = {
  "Agency Supply Network": "yellow",
  "AI Development Algorithm": "red",
  "Advanced Carrier II": "white",
  "Aerie Hololattice": "yellow",
  Aetherstream: "blue",
  "Antimass Deflectors": "blue",
  "Assault Cannon": "red",
  "Bio-Stims": "green",
  Bioplasmosis: "green",
  "Carrier II": "white",
  "Chaos Mapping": "blue",
  "Crimson Legionnaire II": "white",
  "Cruiser II": "white",
  "Dacxive Animators": "green",
  "Dark Energy Tap": "blue",
  "Destroyer II": "white",
  "Dimensional Splicer": "red",
  "Dimensional Tear II": "white",
  "Dreadnought II": "white",
  "Duranium Armor": "red",
  "E-res Siphons": "yellow",
  "Exotrireme II": "white",
  "Fighter II": "white",
  "Fleet Logistics": "blue",
  "Floating Factory II": "white",
  "Genetic Recombination": "green",
  "Graviton Laser System": "yellow",
  "Gravity Drive": "blue",
  "Hegemonic Trade Policy": "yellow",
  "Hel-Titan II": "white",
  "Hybrid Crystal Fighter II": "white",
  "Hyper Metabolism": "green",
  "I.I.H.Q. Modernization": "yellow",
  "Impulse Core": "yellow",
  "Infantry II": "white",
  "Inheritance Systems": "yellow",
  "Instinct Training": "green",
  "Integrated Economy": "yellow",
  "L4 Disruptors": "yellow",
  "Lazax Gate Folding": "blue",
  "Letani Warrior II": "white",
  "Light-Wave Deflector": "blue",
  "Magen Defense Grid": "red",
  "Mageon Implants": "green",
  "Magmus Reactor": "red",
  "Memoria II": "white",
  "Mirror Computing": "yellow",
  "Neural Motivator": "green",
  Neuroglaive: "green",
  "Non-Euclidean Shielding": "red",
  "Nullification Field": "yellow",
  "PDS II": "white",
  "Plasma Scoring": "red",
  "Pre-Fab Arcologies": "green",
  "Predictive Intelligence": "yellow",
  "Production Biomes": "green",
  "Prototype War Sun II": "white",
  Psychoarchaeology: "green",
  "Quantum Datahub Node": "yellow",
  "Salvage Operations": "yellow",
  "Sarween Tools": "yellow",
  "Saturn Engine II": "white",
  "Scanlink Drone Network": "yellow",
  "Self Assembly Routines": "red",
  "Sling Relay": "blue",
  "Space Dock II": "white",
  "Spacial Conduit Cylinder": "blue",
  "Spec Ops II": "white",
  "Strike Wing Alpha II": "white",
  "Super-Dreadnought II": "white",
  Supercharge: "red",
  "Temporal Command Suite": "yellow",
  "Transit Diodes": "yellow",
  "Transparasteel Plating": "green",
  "Valefar Assimilator X": "white",
  "Valefar Assimilator Y": "white",
  "Valkyrie Particle Weave": "red",
  Voidwatch: "green",
  Vortex: "red",
  "Wormhole Generator": "blue",
  "X-89 Bacterial Weapon": "green",
  "Yin Spinner": "green",
  "War Sun": "white",
};

const IS_FACTION_TECHNOLOGY = [
  "Agency Supply Network",
  "Aerie Hololattice",
  "Aetherstream",
  "Bioplasmosis",
  "Chaos Mapping",
  "Crimson Legionnaire II",
  "Dimensional Splicer",
  "Dimensional Tear II",
  "E-res Siphons",
  "Exotrireme II",
  "Floating Factory II",
  "Genetic Recombination",
  "Hegemonic Trade Policy",
  "Hel-Titan II",
  "Hybrid Crystal Fighter II",
  "I.I.H.Q. Modernization",
  "Impulse Core",
  "Inheritance Systems",
  "Instinct Training",
  "L4 Disruptors",
  "Lazax Gate Folding",
  "Letani Warrior II",
  "Mageon Implants",
  "Magmus Reactor",
  "Memoria II",
  "Mirror Computing",
  "Neuroglaive",
  "Nullification Field",
  "Pre-Fab Arcologies",
  "Prototype War Sun II",
  "Quantum Datahub Node",
  "Salvage Operations",
  "Saturn Engine II",
  "Spacial Conduit Cylinder",
  "Supercharge",
  "Temporal Command Suite",
  "Transparasteel Plating",
  "Valefar Assimilator X",
  "Valefar Assimilator Y",
  "Valkyrie Particle Weave",
  "Voidwatch",
  "Vortex",
  "Wormhole Generator",
  "Yin Spinner",
];
 const TECH_TREE = {
  blue: [
    "Antimass Deflectors",
    "Dark Energy Tap",
    "Gravity Drive",
    "Sling Relay",
    "Fleet Logistics",
    "Light-Wave Deflector",
  ],
  red: [
    "Plasma Scoring",
    "AI Development Algorithm",
    "Magen Defense Grid",
    "Self Assembly Routines",
    "Duranium Armor",
    "Assault Cannon",
  ],
  yellow: [
    "Sarween Tools",
    "Scanlink Drone Network",
    "Graviton Laser System",
    "Predictive Intelligence",
    "Transit Diodes",
    "Integrated Economy",
  ],
  green: [
    "Neural Motivator",
    "Psychoarchaeology",
    "Dacxive Animators",
    "Bio-Stims",
    "Hyper Metabolism",
    "X-89 Bacterial Weapon",
  ],
  unit: [
    "Advanced Carrier II",
    "Carrier II",
    "Crimson Legionnaire II",
    "Cruiser II",
    "Destroyer II",
    "Dimensional Tear II",
    "Dreadnought II",
    "Exotrireme II",
    "Fighter II",
    "Floating Factory II",
    "Hel-Titan II",
    "Hybrid Crystal Fighter II",
    "Infantry II",
    "Letani Warrior II",
    "Memoria II",
    "PDS II",
    "Prototype War Sun II",
    "Saturn Engine II",
    "Space Dock II",
    "Spec Ops II",
    "Strike Wing Alpha II",
    "Super-Dreadnought II",
    "War Sun",
  ],
  faction: [
    "Agency Supply Network",
    "Advanced Carrier II",
    "Aerie Hololattice",
    "Aetherstream",
    "Bioplasmosis",
    "Chaos Mapping",
    "Crimson Legionnaire II",
    "Dimensional Splicer",
    "Dimensional Tear II",
    "E-res Siphons",
    "Exotrireme II",
    "Floating Factory II",
    "Genetic Recombination",
    "Hegemonic Trade Policy",
    "Hel-Titan II",
    "Hybrid Crystal Fighter II",
    "I.I.H.Q. Modernization",
    "Impulse Core",
    "Inheritance Systems",
    "Instinct Training",
    "L4 Disruptors",
    "Lazax Gate Folding",
    "Letani Warrior II",
    "Mageon Implants",
    "Magmus Reactor",
    "Memoria II",
    "Mirror Computing",
    "Neural Motivator",
    "Neuroglaive",
    "Non-Euclidean Shielding",
    "Nullification Field",
    "Pre-Fab Arcologies",
    "Predictive Intelligence",
    "Production Biomes",
    "Prototype War Sun II",
    "Quantum Datahub Node",
    "Salvage Operations",
    "Saturn Engine II",
    "Spacial Conduit Cylinder",
    "Spec Ops II",
    "Strike Wing Alpha II",
    "Super-Dreadnought II",
    "Supercharge",
    "Temporal Command Suite",
    "Transparasteel Plating",
    "Valefar Assimilator X",
    "Valefar Assimilator Y",
    "Valkyrie Particle Weave",
    "Voidwatch",
    "Vortex",
    "Wormhole Generator",
    "Yin Spinner",
  ],
};

function transformTTPGtoAppV2(data) {
  return {
    playerData: getPlayersV2(data),
    objectives: getObjectives(data),
    laws: getLaws(data),
    general: getGeneral(data),
  };
}

function getPlayersV2(data) {
  let playerArray = {
    name: [],
    faction: [],
    color: [],
    victoryPoints: [],
    strategyCard: [],
    strategyCardsFaceDown: [],
    technologies: {
      blue: [[], [], [], [], [], []],
      red: [[], [], [], [], [], []],
      yellow: [[], [], [], [], [], []],
      green: [[], [], [], [], [], []],
      unit: [[], [], [], [], [], []],
      faction: [[], [], [], [], [], []],
    },
    secretObjectives: [],
    commandCounters: {
      tactics: [],
      fleet: [],
      strategy: [],
    },
    commodities: [],
    tradeGoods: [],
    maxCommodities: [],
    actionCards: [],
    promissoryNotes: [],
    leaders: {
      agent: [],
      commander: [],
      hero: [],
    },
    active: 0,
    speaker: 0,
  };

  data.players.forEach((player, index) => {
    playerArray.name[index] = player.steamName;
    playerArray.faction[index] = player.factionShort;
    playerArray.color[index] = player.color;
    playerArray.victoryPoints[index] = player.score;
    playerArray.strategyCard[index] = player.strategyCards[0];
    playerArray.strategyCardsFaceDown[index] = player.strategyCardsFaceDown[0] || "";
    playerArray.technologies.blue[index] = TECH_TREE.blue.map((tech) =>
      player.technologies.includes(tech)
    );
    playerArray.technologies.red[index] = TECH_TREE.red.map((tech) =>
      player.technologies.includes(tech)
    );
    playerArray.technologies.yellow[index] = TECH_TREE.yellow.map((tech) =>
      player.technologies.includes(tech)
    );
    playerArray.technologies.green[index] = TECH_TREE.green.map((tech) =>
      player.technologies.includes(tech)
    );
    playerArray.technologies.unit[index] = TECH_TREE.unit.map((tech) =>
      player.technologies.includes(tech)
    );
    playerArray.technologies.faction[index] = TECH_TREE.faction.map((tech) =>
      player.technologies.includes(tech)
    );
    playerArray.secretObjectives[index] = player.objectives.filter((objective) =>
      SECRET_OBJECTIVES.includes(objective)
    );
    playerArray.commandCounters.tactics[index] = player.commandTokens.tactics;
    playerArray.commandCounters.fleet[index] = player.commandTokens.fleet;
    playerArray.commandCounters.strategy[index] = player.commandTokens.strategy;
    playerArray.commodities[index] = player.commodities;
    playerArray.tradeGoods[index] = player.tradeGoods;
    playerArray.maxCommodities[index] = player.maxCommodities;
    playerArray.actionCards[index] = player.handSummary.hasOwnProperty("Action")
      ? player.handSummary.Actions
      : 0;
    playerArray.promissoryNotes[index] = player.handSummary.hasOwnProperty(
      "Promissory"
    )
      ? player.handSummary.Promissory
      : 0;
    playerArray.leaders.agent[index] = player.leaders.agent === "unlocked";
    playerArray.leaders.commander[index] =
      player.leaders.commander === "unlocked";
    playerArray.leaders.hero[index] = player.leaders.hero === "unlocked";

    if (player.active) {
      playerArray.active = index;
    }

    if (data.speaker === player.color) {
      playerArray.speaker = index;
    }
  });

  return playerArray;
}

function getObjectives(data) {
  // TODO player id, secret parse, speakre parse from color

  function formatPublicIObjectives() {
    return data.objectives["Public Objectives I"].map((objective) => {
      let newObjective = {
        id: 0,
        name: objective,
        description:
          OBJECTIVE_NAME_ABBREVIATIONS[objective] || "Unknown Objective",
        points: 1,
        scored: [],
        progress: [],
      };

      data.players.forEach((player, index) => {
        const playerObjectives = player?.objectives || [];
        if (playerObjectives.includes(objective)) {
          newObjective.scored[index] = 1;
        } else {
          newObjective.scored[index] = 0;
        }
      });

      data.objectivesProgress.forEach((objectiveProgress) => {
        if (
          objectiveProgress.name === objective &&
          objectiveProgress.stage === 1
        ) {
          newObjective.progress = objectiveProgress.progress.values.map((o) =>
            o.value.toString()
          );
        }
      });

      return newObjective;
    });
  }

  function formatPublicIIObjectives() {
    return data.objectives["Public Objectives II"].map((objective) => {
      let newObjective = {
        id: 0,
        name: objective,
        description:
          OBJECTIVE_NAME_ABBREVIATIONS[objective] || "Unknown Objective",
        points: 2,
        scored: [],
        progress: [],
      };

      data.players.forEach((player, index) => {
        const playerObjectives = player?.objectives || [];
        if (playerObjectives.includes(objective)) {
          newObjective.scored[index] = 1;
        } else {
          newObjective.scored[index] = 0;
        }
      });

      // TODO uncomment when TTPG has progress data
      data.objectivesProgress.forEach((objectiveProgress) => {
        if (
          objectiveProgress.name === objective &&
          objectiveProgress.stage === 2
        ) {
          newObjective.progress = objectiveProgress.progress.values.map((o) =>
            o.value.toString()
          );
        }
      });

      return newObjective;
      console.log(objective);
    });
  }

  function formatSecretObjectives() {
    let newObjective = {
      name: "Secret Objectives",
      description: "",
      points: 1,
      scored: [],
    };

    data.players.forEach((player, index) => {
      let score = 0;

      player.objectives.forEach((objective) => {
        if (SECRET_OBJECTIVES.includes(objective)) {
          score += 1;
        }
      });

      newObjective.scored[index] = score;
    });

    return newObjective;
  }

  function formatAgendaObjectives() {
    let newObjective = {
      name: "Agenda",
      description: "",
      points: 1,
      scored: [0, 0, 0, 0, 0, 0],
    };

    AGENDA_POINTS.forEach((objective) => {
      if (data.laws.includes(objective)) {

        data.players.forEach((player, index) => {
          if (player.laws.includes(objective)) {
            newObjective.scored[index] += 1;
          }
        });

      }
    });

    return newObjective;
  }

  function formatCrown() {
    let newObjective = {
      name: "The Crown of Emphidia",
      description: "",
      points: 1,
      scored: [],
    };

    data.players.forEach((player, index) => {
      if (player.objectives.includes("The Crown of Emphidia")) {
        newObjective.scored[index] = 1;
      } else {
        newObjective.scored[index] = 0;
      }
    });

    return newObjective;
  }

  function formatShard() {
    let newObjective = {
      name: "Shard of the Throne",
      description: "",
      points: 1,
      scored: [],
    };

    data.players.forEach((player, index) => {
      if (player.relicCards.includes("Shard of the Throne (PoK)")) {
        newObjective.scored[index] = 1;
      } else {
        newObjective.scored[index] = 0;
      }
    });

    return newObjective;
  }

  function formatCustodiansPoints() {
    return {
      name: "Custodians Points",
      description: "",
      points: 1,
      scored: data.players.map((player) => {
        return player.custodiansPoints;
      }),
    };
  }

  let relics = [];

  if (data.objectives["Relics"].includes("Shard of the Throne")) {
    relics.push(formatShard());
  }

  if (data.objectives["Relics"].includes("The Crown of Emphidia")) {
    relics.push(formatCrown());
  }

  return {
    public1: formatPublicIObjectives(),
    public2: formatPublicIIObjectives(),
    secret: formatSecretObjectives(),
    mecatol: formatCustodiansPoints(),
    agenda: formatAgendaObjectives(),
    relics: relics,
  };
}

function getGeneral(data) {
  return {
    round: data.round,
    speaker: data.speaker,
    activePlayer: data.turn,
    time: data.timer.seconds.toString(),
  };
}

function getLaws(gameData) {
  const laws = gameData?.laws || [];

  return laws.map((law) => {
    let tempLaw = {
      name: law,
      description: LAW_ABBREVIATIONS[law] || law,
    };

    for (const player of gameData.players) {
      if (player.laws.includes(law.name)) {
        return {
          ...tempLaw,
          electedPlayer: player.steamName,
        };
      }
    }

    return tempLaw;
  });
}

function getGeneral(data) {
  return {
    round: data.round,
    speaker: data.speaker,
    activePlayer: data.turn,
    time: data.timer.seconds.toString(),
  };
}

function getLaws(gameData) {
  const laws = gameData?.laws || [];

  return laws.map((law) => {
    let tempLaw = {
      name: law,
      description: LAW_ABBREVIATIONS[law] || law,
    };

    for (const player of gameData.players) {
      if (player.laws.includes(law.name)) {
        return {
          ...tempLaw,
          electedPlayer: player.steamName,
        };
      }
    }

    return tempLaw;
  });
}
