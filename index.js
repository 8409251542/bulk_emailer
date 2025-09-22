const express = require("express");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const JSZip = require("jszip");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const session = require("express-session");
const crypto = require("crypto");
const fetch = require("node-fetch");


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: true,
}));

const upload = multer({ dest: "uploads/" });

// Simple login middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ ok: false, message: "Unauthorized" });
}

// Simple login route (demo). Replace with real user store as needed.
// Replace current login route with this:
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const pairs = (process.env.USERS || "").split(","); // split by comma
  const userMap = {};
  pairs.forEach(p => {
    const [u, pw] = p.split(":");
    if (u && pw) userMap[u] = pw;
  });

  if (userMap[username] && userMap[username] === password) {
    req.session.user = { username };
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: "Invalid credentials" });
});


app.post("/api/logout", (req, res) => {
  req.session.destroy(()=> res.json({ ok: true }));
});

// Helper: compute Sign header = MD5(ApiKey + ApiSecret + timestamp)
function computeSign(apiKey, apiSecret, timestampSeconds) {
  const raw = `${apiKey}${apiSecret}${timestampSeconds}`;
  const md5 = crypto.createHash("md5").update(raw, "utf8").digest("hex");
  return md5;
}

// Helper: extract numbers from uploaded file or text
async function extractNumbersFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const text = fs.readFileSync(filePath, "utf8");

  let numbers = [];
  if (ext === ".txt") {
    // any whitespace/comma/newline separated tokens that look like digits
    numbers = text.split(/[\s,;]+/).map(s=>s.trim()).filter(Boolean);
  } else if (ext === ".csv") {
    numbers = text.split(/[\r\n]+/).flatMap(line => line.split(/[,;]+/)).map(s=>s.trim()).filter(Boolean);
  } else if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const arr = XLSX.utils.sheet_to_json(sheet, { header:1, defval:"" });
    arr.forEach(row => {
      row.forEach(cell => {
        if (cell !== null && String(cell).trim() !== "") numbers.push(String(cell).trim());
      });
    });
  } else {
    // fallback: parse as text
    numbers = text.split(/[\s,;]+/).map(s=>s.trim()).filter(Boolean);
  }
  // remove empty and maybe sanitize to E.164 if needed by user
  numbers = numbers.filter(n=>n.length>0);
  return numbers;
}

// Route to accept numbers (paste or file) + attachments and send MMS via OnBuka
// form-data fields expected:
// - numbers (text area) OR fileNumbers (file input)
// - message, appId, mmsType (optional), mmsTitle (optional)
// - attachments[] (files to upload to mmsUpload)
app.post("/api/send", requireAuth, upload.fields([
  { name: "fileNumbers", maxCount: 1 },
  { name: "attachments", maxCount: 10 }
]), async (req, res) => {
  try {
    const { numbers, message, appId, mmsType = "1", mmsTitle = "title" } = req.body;
    let allNumbers = [];

    // 1) parse numbers from textarea
    if (numbers && numbers.trim()) {
      allNumbers = allNumbers.concat(numbers.split(/[\s,;]+/).map(s=>s.trim()).filter(Boolean));
    }

    // 2) parse numbers from uploaded file
    if (req.files && req.files.fileNumbers && req.files.fileNumbers[0]) {
      const file = req.files.fileNumbers[0];
      const parsed = await extractNumbersFromFile(file.path, file.originalname);
      allNumbers = allNumbers.concat(parsed);
      fs.unlinkSync(file.path);
    }

    // dedupe
    allNumbers = Array.from(new Set(allNumbers));

    if (!allNumbers.length) return res.status(400).json({ ok:false, message:"No recipient numbers provided." });

    // 3) If attachments provided, upload each to OnBuka mmsUpload
    const apiKey = process.env.ONBUKA_API_KEY;
    const apiSecret = process.env.ONBUKA_API_SECRET;
    if (!apiKey || !apiSecret) return res.status(500).json({ ok:false, message:"Server missing OnBuka API credentials." });

    const ts = Math.floor(Date.now() / 1000);
    const sign = computeSign(apiKey, apiSecret, String(ts));
    const headers = {
      "Content-Type": "application/json;charset=UTF-8",
      "Sign": sign,
      "Timestamp": String(ts),
      "Api-Key": apiKey
    };

    let mmsFiles = []; // will collect names returned by mmsUpload

    if (req.files && req.files.attachments) {
      for (const f of req.files.attachments) {
        const buffer = fs.readFileSync(f.path);
        const ext = path.extname(f.originalname).replace(".", "").toLowerCase();
        const b64 = buffer.toString("base64");
        // fileType expected like "png" or "txt"
        const payload = { fileType: ext || "txt", fileData: b64 };

        // call OnBuka mmsUpload
        const uploadResp = await fetch("https://api.onbuka.com/v3/mmsUpload", {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        });
        const uploadJson = await uploadResp.json();
        // response varies — many OnBuka endpoints return "data" with file name — adjust if needed
        // For robustness, try multiple keys
        let returnedName = uploadJson?.data?.fileName || uploadJson?.fileName || uploadJson?.result || uploadJson?.filename;
        if (!returnedName && typeof uploadJson === "string") returnedName = uploadJson;
        if (!returnedName) {
          // fallback: assume OnBuka returns something like {"code":0,"data":"57_3_1727...txt"}
          if (uploadJson && Object.values(uploadJson).some(v=>typeof v === "string" && v.includes("_"))) {
            for (const v of Object.values(uploadJson)) {
              if (typeof v === "string" && v.includes("_")) { returnedName = v; break; }
            }
          }
        }

        if (returnedName) mmsFiles.push(returnedName);
        // cleanup upload file
        fs.unlinkSync(f.path);
      }
    }

    // 4) Prepare mmsSend payload
    const sendPayload = {
      appId: appId || process.env.ONBUKA_APP_ID || "",
      numbers: allNumbers.join(","),
      content: message || "",
      mmsType: mmsType,
      mmsFiles: mmsFiles.join(","),
      mmsTitle: mmsTitle
    };

    // Recompute timestamp+sign for the send call (fresh)
    const ts2 = Math.floor(Date.now() / 1000);
    const sign2 = computeSign(apiKey, apiSecret, String(ts2));
    const headers2 = {
      "Content-Type": "application/json;charset=UTF-8",
      "Sign": sign2,
      "Timestamp": String(ts2),
      "Api-Key": apiKey
    };

    const resp = await fetch("https://api.onbuka.com/v3/mmsSend", {
      method: "POST",
      headers: headers2,
      body: JSON.stringify(sendPayload)
    });

    const json = await resp.json();
    return res.json({ ok: true, onbuka: json, sentTo: allNumbers.length, numbersPreview: allNumbers.slice(0,20) });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});