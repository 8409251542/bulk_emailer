// backend/server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const fastcsv = require("fast-csv");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const path = require("path");
const XLSX = require("xlsx");
const JSZip = require("jszip");
const NumlookupapiModule = require("@everapi/numlookupapi-js");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const Numlookupapi = NumlookupapiModule.default;
const client = new Numlookupapi(process.env.NUMLOOKUP_API_KEY);

const SUPABASE_URL = "https://fnnurbqyyhabwmquntlm.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Storage for uploaded files
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 5000;

// In-memory store for active sessions (in production, use Redis)
const activeSessions = new Map(); // userId -> { sessionId, deviceInfo, loginTime }

// ======================================================
// 🔹 HELPER FUNCTIONS (defined before usage)
// ======================================================
async function isAdmin(userId) {
  const { data, error } = await supabase
    .from("admins")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  return !!data && !error;
}

async function isVendor(userId) {
  const { data, error } = await supabase
    .from("vendors")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  return !!data && !error;
}

function generateSessionId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

async function hasActiveReportSubscription(userId) {
  const { data, error } = await supabase
    .from("report_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return !error && !!data;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const day = d.getDate().toString().padStart(2, "0");
  const month = d.toLocaleString("en-GB", { month: "short" });
  return day + month;
}

app.post("/add-user", async (req, res) => {
  const { requesterId, email, password, max_limit } = req.body;
console.log("👉 /add-user request body:", req.body);
  // 1️⃣ Check if requester is admin
  const { data: admin, error: adminError } = await supabase
    .from("admins")
    .select("id")
    .eq("id", requesterId)
    .maybeSingle();
      console.log("👉 Admin lookup result:", { admin, adminError });

  if (adminError || !admin) {
    return res.status(403).json({ message: "Only admin can add users" });
  }

  // 2️⃣ Create user in Supabase Auth
  const { data: user, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  console.log("👉 Supabase auth.createUser result:", { user, error });
  if (error) {
    return res.status(400).json({ message: error.message });
  }


  // 3️⃣ Insert into user_limits
  const { error: dbError } = await supabase.from("user_limits").insert({
    id: user.user.id,
    max_limit: max_limit || 10000, // default 10k if not passed
    used: 0,
  });
console.log("👉 Insert into user_limits:", { dbError });
  if (dbError) {
    return res.status(500).json({ message: dbError.message });
  }

  // 4️⃣ Return updated users list
  const { data: users, error: usersError } = await supabase
    .from("user_limits")
    .select("id, max_limit, used");
console.log("👉 Users fetch:", { users, usersError });

  if (usersError) {
    return res.status(500).json({ message: usersError.message });
  }

  res.json({ message: "User added successfully", users });
});


app.post("/get-users", async (req, res) => {
  const { requesterId } = req.body;
  if (!(await isAdmin(requesterId))) {
    return res.status(403).json({ message: "Only admin can add users" });
  }
  const { data, error } = await supabase
    .from("user_limits")
    .select("id, max_limit, used");

  if (error) return res.status(400).json({ message: error.message });
  res.json({ users: data });
});

// ======================================================
// 🔹 AUTH & SESSION ROUTES
// ======================================================

// Register user with extra fields
app.post("/register", async (req, res) => {
  const { name, mobile, email, company, password } = req.body;

  // 1️⃣ Create Supabase Auth user
  const { data: user, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) return res.status(400).json({ message: error.message });

  const userId = user.user.id;

  // 2️⃣ Insert into profiles table
  const { error: profileError } = await supabase.from("profiles").insert({
    id: userId,
    name,
    mobile,
    company,
  });

  if (profileError) return res.status(500).json({ message: profileError.message });

  // 3️⃣ Insert into user_limits table
  const { error: limitError } = await supabase.from("user_limits").insert({
    id: userId,
    max_limit: 10, // default limit
    used: 0,
  });

  if (limitError) return res.status(500).json({ message: limitError.message });

  res.json({
    message: "User registered successfully",
    user: {
      id: userId,
      name,
      mobile,
      email,
      company,
    },
  });
});

app.post("/login", async (req, res) => {
  const { username, password, deviceInfo } = req.body;
  const email = username;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ message: error.message });

  const user = data.user;
  const userId = user.id;

  if (activeSessions.has(userId)) {
    const existingSession = activeSessions.get(userId);
    return res.status(409).json({
      message: "User already logged in from another device",
      existingDevice: existingSession.deviceInfo,
      loginTime: existingSession.loginTime,
    });
  }

  const sessionId = generateSessionId();
  activeSessions.set(userId, {
    sessionId,
    deviceInfo: deviceInfo || "Unknown Device",
    loginTime: new Date().toISOString(),
  });

  const { data: adminData } = await supabase.from("admins").select("email").eq("id", userId).single();
  const { data: vendorData } = await supabase.from("vendors").select("email").eq("id", userId).single();

  let role = "user";
  if (adminData) role = "admin";
  else if (vendorData) role = "vendor";

  res.json({
    role,
    token: data.session.access_token,
    sessionId,
    user,
    userId
  });
});

app.post("/logout", async (req, res) => {
  const { userId } = req.body;
  if (activeSessions.has(userId)) activeSessions.delete(userId);
  res.json({ message: "Logged out successfully" });
});

// ======================================================
// 🔹 MS TEAMS SERVICE ROUTES
// ======================================================
app.post("/request-ms-teams", upload.single("screenshot"), async (req, res) => {
  try {
    const { userId, sessionId, companyName, teamSize, purpose, contactPerson, phoneNumber, txHash, network, amount } = req.body;
    
    // Validate session
    if (!activeSessions.has(userId) || activeSessions.get(userId).sessionId !== sessionId) {
      return res.status(401).json({ message: "Session invalid. Please login again." });
    }

    if (!txHash || !amount) {
      return res.status(400).json({ message: "Payment transaction hash and amount are required" });
    }

    // Upload payment screenshot
    let screenshotUrl = null;
    if (req.file) {
      try {
        const buffer = fs.readFileSync(req.file.path);
        const storageFileName = `ms-teams-${Date.now()}-${req.file.originalname}`;

        const { error: uploadError } = await supabase.storage
          .from("ms-teams-screenshots")
          .upload(storageFileName, buffer, {
            contentType: req.file.mimetype,
            upsert: true,
          });

        if (!uploadError) {
          const { data: signedUrl } = await supabase.storage
            .from("ms-teams-screenshots")
            .createSignedUrl(storageFileName, 60 * 60 * 24 * 7);
          screenshotUrl = signedUrl?.signedUrl;
        }
      } catch (err) {
        console.error("File handling error:", err);
      }
    }

    // Save request to database (combines application + payment)
    const { data, error } = await supabase
      .from("ms_teams_requests")
      .insert({
        user_id: userId,
        company_name: companyName,
        team_size: teamSize,
        purpose: purpose,
        contact_person: contactPerson,
        phone_number: phoneNumber,
        tx_hash: txHash,
        network: network || "TRC20",
        amount: parseFloat(amount),
        payment_screenshot: screenshotUrl,
        status: "pending", // pending -> approved -> credentials_provided -> completed
      })
      .select();

    if (error) {
      return res.status(400).json({ message: error.message });
    }

    res.json({ 
      message: "MS Teams service request submitted successfully. Payment will be verified by admin.", 
      request: data[0] 
    });

  } catch (err) {
    console.error("MS Teams request error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get MS Teams Requests (Admin only)
app.post("/get-ms-teams-requests", async (req, res) => {
  const { requesterId } = req.body;
  
  if (!(await isAdmin(requesterId))) {
    return res.status(403).json({ message: "Only admin can view requests" });
  }

  const { data, error } = await supabase
    .from("ms_teams_requests")
    .select(`
      *,
      profiles(name, email, company)
    `)
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(400).json({ message: error.message });
  }

  res.json({ requests: data });
});

// Approve MS Teams Request and assign to vendor (Admin only)
app.post("/approve-ms-teams-request", async (req, res) => {
  const { requestId, adminId, vendorId } = req.body;
  
  if (!(await isAdmin(adminId))) {
    return res.status(403).json({ message: "Only admin can approve requests" });
  }

  // Verify vendor exists if provided
  if (vendorId && !(await isVendor(vendorId))) {
    return res.status(400).json({ message: "Invalid vendor ID" });
  }

  // Get request details
  const { data: request, error: reqError } = await supabase
    .from("ms_teams_requests")
    .select("*")
    .eq("id", requestId)
    .single();

  if (reqError || !request) {
    return res.status(404).json({ message: "Request not found" });
  }

  if (request.status !== "pending") {
    return res.status(400).json({ message: "Request already processed" });
  }

  // Update request status
  const { error: updateError } = await supabase
    .from("ms_teams_requests")
    .update({ 
      status: vendorId ? "assigned_to_vendor" : "approved",
      assigned_vendor: vendorId,
      approved_at: new Date().toISOString(),
      approved_by: adminId
    })
    .eq("id", requestId);

  if (updateError) {
    return res.status(500).json({ message: updateError.message });
  }

  res.json({ 
    message: vendorId ? "Request approved and assigned to vendor" : "Request approved. Waiting for vendor assignment."
  });
});

// Vendor provides MS Teams credentials (Vendor only)
app.post("/provide-ms-teams-credentials", async (req, res) => {
  const { vendorId, sessionId, requestId, credentials } = req.body;
  
  // Validate session
  if (!activeSessions.has(vendorId) || activeSessions.get(vendorId).sessionId !== sessionId) {
    return res.status(401).json({ message: "Session invalid. Please login again." });
  }

  if (!(await isVendor(vendorId))) {
    return res.status(403).json({ message: "Only vendors can provide credentials" });
  }

  // Verify request is assigned to this vendor
  const { data: request, error: reqError } = await supabase
    .from("ms_teams_requests")
    .select("*")
    .eq("id", requestId)
    .eq("assigned_vendor", vendorId)
    .eq("status", "assigned_to_vendor")
    .single();

  if (reqError || !request) {
    return res.status(404).json({ message: "Request not found or not assigned to you" });
  }

  // Save credentials
  const { error: credError } = await supabase
    .from("ms_teams_credentials")
    .insert({
      request_id: requestId,
      user_id: request.user_id,
      vendor_id: vendorId,
      email: credentials.email,
      password: credentials.password,
      additional_info: credentials.additionalInfo || "",
      provided_at: new Date().toISOString()
    });

  if (credError) {
    return res.status(400).json({ message: credError.message });
  }

  // Update request status
  await supabase
    .from("ms_teams_requests")
    .update({ status: "credentials_provided" })
    .eq("id", requestId);

  res.json({ message: "Credentials provided successfully" });
});

// Get vendor assignments (Vendor only)
app.post("/get-vendor-assignments", async (req, res) => {
  const { vendorId, sessionId } = req.body;
  
  // Validate session
  if (!activeSessions.has(vendorId) || activeSessions.get(vendorId).sessionId !== sessionId) {
    return res.status(401).json({ message: "Session invalid. Please login again." });
  }

  if (!(await isVendor(vendorId))) {
    return res.status(403).json({ message: "Only vendors can view assignments" });
  }

  const { data, error } = await supabase
    .from("ms_teams_requests")
    .select(`
      *,
      profiles(name, email, company),
      ms_teams_credentials(email, password, additional_info, provided_at)
    `)
    .eq("assigned_vendor", vendorId)
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(400).json({ message: error.message });
  }

  res.json({ assignments: data });
});

// Get user's MS Teams service requests and credentials
app.post("/get-user-ms-teams", async (req, res) => {
  const { userId, sessionId } = req.body;
  
  // Validate session
  if (!activeSessions.has(userId) || activeSessions.get(userId).sessionId !== sessionId) {
    return res.status(401).json({ message: "Session invalid. Please login again." });
  }

  const { data, error } = await supabase
    .from("ms_teams_requests")
    .select(`
      *,
      ms_teams_credentials(email, password, additional_info, provided_at)
    `)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(400).json({ message: error.message });
  }

  res.json({ requests: data });
});
// ======================================================

// ======================================================
// 🔹 REPORT SUBSCRIPTION ROUTES
// ======================================================
app.post("/subscribe-reports", upload.single("screenshot"), async (req, res) => {
  try {
    const { userId, sessionId, txHash, network } = req.body;

    if (!activeSessions.has(userId) || activeSessions.get(userId).sessionId !== sessionId) {
      return res.status(401).json({ message: "Session invalid. Please login again." });
    }
    if (!txHash) return res.status(400).json({ message: "Payment transaction hash is required" });

    let screenshotUrl = null;
    if (req.file) {
      try {
        const buffer = fs.readFileSync(req.file.path);
        const storageFileName = `report-subscription-${Date.now()}-${req.file.originalname}`;

        const { error: uploadError } = await supabase.storage
          .from("report-subscription-screenshots")
          .upload(storageFileName, buffer, { contentType: req.file.mimetype, upsert: true });

        if (!uploadError) {
          const { data: signedUrl } = await supabase.storage
            .from("report-subscription-screenshots")
            .createSignedUrl(storageFileName, 60 * 60 * 24 * 7);
          screenshotUrl = signedUrl?.signedUrl;
        }
      } catch (err) {
        console.error("File handling error:", err);
      }
    }

    const { data, error } = await supabase
      .from("report_subscriptions")
      .insert({
        user_id: userId,
        tx_hash: txHash,
        network: network || "TRC20",
        amount: 30.0,
        payment_screenshot: screenshotUrl,
        status: "pending",
      })
      .select();

    if (error) return res.status(400).json({ message: error.message });

    res.json({
      message: "Report generation subscription request submitted. Payment will be verified by admin.",
      subscription: data[0],
    });
  } catch (err) {
    console.error("Report subscription error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/approve-report-subscription", async (req, res) => {
  const { subscriptionId, adminId } = req.body;
  
  if (!(await isAdmin(adminId))) {
    return res.status(403).json({ message: "Only admin can approve subscriptions" });
  }

  // Get subscription details
  const { data: subscription, error: subError } = await supabase
    .from("report_subscriptions")
    .select("*")
    .eq("id", subscriptionId)
    .single();

  if (subError || !subscription) {
    return res.status(404).json({ message: "Subscription not found" });
  }

  if (subscription.status !== "pending") {
    return res.status(400).json({ message: "Subscription already processed" });
  }

  const now = new Date();
  const expiryDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

  // Update subscription status
  const { error: updateError } = await supabase
    .from("report_subscriptions")
    .update({ 
      status: "active",
      approved_at: now.toISOString(),
      approved_by: adminId,
      starts_at: now.toISOString(),
      expires_at: expiryDate.toISOString()
    })
    .eq("id", subscriptionId);

  if (updateError) {
    return res.status(500).json({ message: updateError.message });
  }

  res.json({ 
    message: "Report subscription approved and activated",
    expiresAt: expiryDate.toISOString()
  });
});

// ======================================================
// 🔹 REPORT GENERATION ROUTE (correct version only!)
// ======================================================
app.post("/api/generate-report", upload.single("file"), async (req, res) => {
  try {
    const { userId, sessionId, reportDate } = req.body;
    const filePath = req.file.path;

    if (!activeSessions.has(userId) || activeSessions.get(userId).sessionId !== sessionId) {
      return res.status(401).json({ message: "Session invalid. Please login again." });
    }
    if (!reportDate) return res.status(400).json({ message: "Report date required" });

    const hasSubscription = await hasActiveReportSubscription(userId);
    if (!hasSubscription) {
      return res.status(403).json({
        message: "Report generation requires active subscription ($30/month). Please subscribe first.",
      });
    }

       const buyers = {};
       dataRows.forEach(row => {
         const buyer = row[buyerIdx];
         if (!buyer) return;
         if (!buyers[buyer]) buyers[buyer] = [];
         buyers[buyer].push(row);
       });
   
       const zip = new JSZip();
       const masterSummary = [];
   
       function excelSerialToJSDate(serial) {
         const utc_days = Math.floor(serial - 25569);
         const utc_value = utc_days * 86400;
         const date_info = new Date(utc_value * 1000);
         const fractional_day = serial - Math.floor(serial) + 0.0000001;
         let total_seconds = Math.floor(86400 * fractional_day);
         const seconds = total_seconds % 60;
         total_seconds -= seconds;
         const hours = Math.floor(total_seconds / (60 * 60));
         const minutes = Math.floor(total_seconds / 60) % 60;
         date_info.setHours(hours, minutes, seconds);
         return date_info;
       }
   
       function formatDT(dt) {
         const d = dt.getDate().toString().padStart(2, '0');
         const m = (dt.getMonth() + 1).toString().padStart(2, '0');
         const y = dt.getFullYear();
         const hh = dt.getHours().toString().padStart(2, '0');
         const mm = dt.getMinutes().toString().padStart(2, '0');
         const ss = dt.getSeconds().toString().padStart(2, '0');
         return `${d}/${m}/${y} ${hh}:${mm}:${ss}`;
       }
   
       const campIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes("camp"));
       const dateCols = headers
         .map((h, i) => (h && h.toString().toLowerCase().includes("call_start") ? i : -1))
         .filter(i => i >= 0);
   
       for (const buyer in buyers) {
         let calls = buyers[buyer];
   
         // Remove duplicates by caller
         const seen = new Set();
         calls = calls.filter(row => {
           const caller = row[callerIdx];
           if (seen.has(caller)) return false;
           seen.add(caller);
           return true;
         });
   
         // Convert call_start columns
         calls = calls.map(row => {
           for (const dc of dateCols) {
             const v = row[dc];
             if (v !== null && v !== undefined && v !== "") {
               if (!isNaN(Number(v)) && Number(v) > 30000) {
                 const dt = excelSerialToJSDate(Number(v));
                 row[dc] = formatDT(dt);
               } else {
                 const dtStr = new Date(v);
                 if (!isNaN(dtStr.getTime())) {
                   row[dc] = formatDT(dtStr);
                 }
               }
             }
           }
           return row;
         });
   
         const uniqueCalls = calls.length;
         const sampleFwd = calls.length ? String(calls[0][fwdIdx]) : "";
         const suffix = sampleFwd.slice(-4);
         const prefix = buyer.split(" ")[0];
   
         let camp = calls.length && campIdx >= 0 ? String(calls[0][campIdx]) : "";
         if (camp.length > 10) {
           camp = camp.split(" ").map(w => w.slice(0, 3)).join("");
         }
   
         const fileName = `${prefix} ${dateStr} ${suffix} - (${uniqueCalls}) ${camp}.xlsx`;
   
         const sheetData = [headers, ...calls];
         const ws = XLSX.utils.aoa_to_sheet(sheetData);
         const wb = XLSX.utils.book_new();
         XLSX.utils.book_append_sheet(wb, ws, "Calls");
   
         const wbout = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
         zip.file(fileName, wbout);
   
         masterSummary.push({ buyer, uniqueCalls, fileName });
       }
   
       const summarySheet = [["Buyer Name", "Unique Calls", "File Name"]];
       masterSummary.forEach(s => summarySheet.push([s.buyer, s.uniqueCalls, s.fileName]));
       const totalCalls = masterSummary.reduce((a, b) => a + b.uniqueCalls, 0);
       summarySheet.push(["TOTAL", totalCalls, ""]);
   
       const wsSummary = XLSX.utils.aoa_to_sheet(summarySheet);
       const wbSummary = XLSX.utils.book_new();
       XLSX.utils.book_append_sheet(wbSummary, wsSummary, "Summary");
       const summaryOut = XLSX.write(wbSummary, { type: "buffer", bookType: "xlsx" });
       zip.file("Master_Report.xlsx", summaryOut);
   
       const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
   
       // Save ZIP permanently
       const reportsDir = path.join(__dirname, "uploads/reports");
       if (!fs.existsSync(reportsDir)) {
         fs.mkdirSync(reportsDir, { recursive: true });
       }
   
       const fileName = `buyer_reports_${Date.now()}.zip`;
       const outputPath = path.join(reportsDir, fileName);
       fs.writeFileSync(outputPath, zipBuffer);
   
       // Save metadata in DB
       await supabase.from("report_history").insert([
         {
           user_id: userId,
           file_name: fileName,
           file_path: `/uploads/reports/${fileName}`,
           subscription_based: true,
           created_at: new Date(),
         },
       ]);
   
       res.json({
         message: "✅ Report generated successfully",
         downloadUrl: `http://16.16.67.128:5000/uploads/reports/${fileName}`,
         subscription_used: true,
       });

  } catch (err) {
    console.error("❌ Report generation failed:", err);
    res.status(500).json({ message: "Report generation failed", error: err.message });
  }
});

// ======================================================
// 🔹 NUMBER VERIFICATION ROUTES
// ======================================================
app.post("/upload-csv", upload.single("file"), async (req, res) => {
  const { userId } = req.body;
  const filePath = req.file.path;
  const ext = req.file.originalname.split(".").pop().toLowerCase();

  console.log("👉 Upload request:", req.file.originalname);

  // 1️⃣ Validate user
  const { data: userData, error } = await supabase
    .from("user_limits")
    .select("*")
    .eq("id", userId)
    .single();

  if (error || !userData) return res.status(404).json({ message: "User not found" });
  if (userData.used >= userData.max_limit) return res.status(403).json({ message: "Limit exceeded" });

  // 2️⃣ Parse file into numbers
  let numbers = [];

  if (ext === "csv") {
    numbers = await new Promise((resolve, reject) => {
      const arr = [];
      fs.createReadStream(filePath)
        .pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase() }))
        .on("data", row => arr.push(row["phone"]))
        .on("end", () => resolve(arr))
        .on("error", reject);
    });
  } else if (ext === "xlsx" || ext === "xls") {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    numbers = sheet.map(row => row["phone"]);
  } else if (ext === "txt") {
    const content = fs.readFileSync(filePath, "utf8");
    numbers = content.split(/\r?\n/).map(line => line.trim());
  } else {
    return res.status(400).json({ message: "Unsupported file type. Use CSV, XLSX, or TXT." });
  }

  // 3️⃣ Deduplicate
  const uniqueNumbers = [...new Set(numbers.filter(Boolean))];
  const duplicates = numbers.length - uniqueNumbers.length;

  let verifiedRows = [];
  let processed = 0;
// numverify
  // for (let phone of uniqueNumbers) {
  //   if (!phone) continue;
  //   if (userData.used + processed >= userData.max_limit) break;

  //   try {
  //     const url = `http://apilayer.net/api/validate?access_key=${process.env.NUMVERIFY_API_KEY}&number=${phone}`;
  //     const apiRes = await axios.get(url);

  //     if (apiRes.data.valid) {
  //       processed++;
  //       verifiedRows.push({
  //         valid: apiRes.data.valid || false,
  //         local_format: apiRes.data.local_format || "",
  //         country_code: apiRes.data.country_code || "",
  //         country_name: apiRes.data.country_name || "",
  //         location: apiRes.data.location || "",
  //         carrier: apiRes.data.carrier || "",
  //         line_type: apiRes.data.line_type || "",
  //       });
  //     }
  //   } catch (err) {
  //     console.error("❌ Error verifying", phone, err.message);
  //   }
  //   await new Promise(r => setTimeout(r, 1000)); // throttle API
  // }
// numlook
 for (let phone of uniqueNumbers) {
  if (!phone) continue;
  if (userData.used + processed >= userData.max_limit) break;

  try {
    // Use EverAPI's numlookup client
    const apiRes = await client.validate(phone); // phone should be in international format

    if (apiRes.valid) {
      processed++;
      verifiedRows.push({
        valid: apiRes.valid || false,
        local_format: apiRes.local_format || "",
        country_code: apiRes.country_code || "",
        country_name: apiRes.country_name || "",
        location: apiRes.location || "",
        carrier: apiRes.carrier || "",
        line_type: apiRes.line_type || "",
      });
    }
  } catch (err) {
    console.error("❌ Error verifying", phone, err.message);
  }
  await new Promise(r => setTimeout(r, 0)); // throttle API if needed
}
  // 4️⃣ Update DB usage
  await supabase
    .from("user_limits")
    .update({ used: userData.used + processed })
    .eq("id", userId);

  // 5️⃣ Save history
  const { data: saved } = await supabase.from("verification_history").insert([
    {
      user_id: userId,
      total_uploaded: numbers.length,
      duplicates,
      unique_count: uniqueNumbers.length,
      verified_count: processed,
      created_at: new Date(),
    },
  ]).select("id");

  // 6️⃣ Save CSV output locally
  const fileName = `output-${Date.now()}.csv`;   // 👈 define fileName
const outputPath = path.join(__dirname, "uploads/verified-data", fileName);

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outputPath);
    fastcsv.write(verifiedRows, { headers: true }).pipe(ws).on("finish", resolve).on("error", reject);
  });

  const fileUrl = `http://16.16.67.128:5000/uploads/verified-data/${fileName}`;

// 8️⃣ Update DB with direct URL
await supabase
  .from("verification_history")
  .update({ file_path: fileUrl })
  .eq("id", saved[0].id);

  res.json({
    message: "Verification completed",
    total_uploaded: numbers.length,
    duplicates,
    unique_count: uniqueNumbers.length,
    verified_count: processed,
    fileUrl,
  });
});
// ======================================================

// ======================================================
// 🔹 PURCHASE & ADMIN ROUTES
// ======================================================
app.post("/purchase", upload.single("screenshot"), async (req, res) => {
  try {
    console.log("👉 Incoming purchase:", req.body);
    console.log("👉 File received:", req.file);

    const { userId, network, usdt_amount, tx_hash } = req.body;
    if (!userId || !usdt_amount || !tx_hash) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Upload file to Supabase Storage
    let screenshotUrl = null;
    if (req.file) {
      try {
        const buffer = fs.readFileSync(req.file.path);
        const storageFileName = `${Date.now()}-${req.file.originalname}`;

        console.log("📂 Uploading file:", storageFileName);

        const { error: uploadError } = await supabase.storage
          .from("purchase-screenshots")
          .upload(storageFileName, buffer, {
            contentType: req.file.mimetype,
            upsert: true,
          });

        if (uploadError) {
          console.error("❌ Storage upload error:", uploadError);
          return res.status(500).json({ message: "Failed to upload screenshot" });
        }

        const { data: signedUrl, error: signedError } = await supabase.storage
          .from("purchase-screenshots")
          .createSignedUrl(storageFileName, 60 * 60 * 24 * 7);

        if (signedError) {
          console.error("❌ Signed URL error:", signedError);
        } else {
          screenshotUrl = signedUrl?.signedUrl;
        }
      } catch (err) {
        console.error("🔥 File handling error:", err);
      }
    } else {
      console.warn("⚠️ No file uploaded in request");
    }

    // Save to DB
    const { data, error } = await supabase
      .from("purchases")
      .insert({
        user_id: userId,
        network,
        usdt_amount,
        tx_hash,
        screenshot: screenshotUrl,
        status: "pending",
      })
      .select();

    if (error) {
      console.error("❌ DB insert error:", error);
      return res.status(400).json({ message: error.message });
    }

    res.json({ message: "✅ Purchase submitted", purchase: data[0] });
  } catch (err) {
    console.error("🔥 Purchase error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get all purchases (admin only)
app.get("/purchases", async (req, res) => {
  let { data, error } = await supabase
    .from("purchases")
    .select("id, user_id, network, usdt_amount, tx_hash, screenshot, status, created_at");

  if (error) return res.status(400).json({ message: error.message });

  // If screenshot stored as path, generate signed URLs
  data = await Promise.all(
    data.map(async (p) => {
      if (p.screenshot && !p.screenshot.startsWith("http")) {
        const { data: signed } = await supabase.storage
          .from("purchase-screenshots")
          .createSignedUrl(p.screenshot, 60 * 60);
        p.screenshot = signed?.signedUrl || null;
      }
      return p;
    })
  );

  res.json({ purchases: data });
});
// Approve a purchase (admin)
app.post("/approve-purchase", async (req, res) => {
  const { purchaseId,adminId } = req.body;
if (!(await isAdmin(adminId))) {
    return res.status(403).json({ message: "Only admin can add users" });
  }
  // 1️⃣ Fetch purchase
  const { data: purchase, error: fetchError } = await supabase
    .from("purchases")
    .select("*")
    .eq("id", purchaseId)
    .maybeSingle();

  if (fetchError || !purchase) {
    return res.status(404).json({ message: "Purchase not found" });
  }

  if (purchase.status !== "pending") {
    return res.status(400).json({ message: "Already processed" });
  }

  // 2️⃣ Match plan based on amount
  let tokensToAdd = 0;
  if (purchase.usdt_amount == 75) tokensToAdd = 60000;
  else if (purchase.usdt_amount == 100) tokensToAdd = 125000;
  else if (purchase.usdt_amount == 180) tokensToAdd = 250000;
  else {
    return res.status(400).json({ message: "Invalid plan amount" });
  }

  // 3️⃣ Increase user's max_limit in user_limits
  const { data: userLimit, error: fetchLimitError } = await supabase
    .from("user_limits")
    .select("max_limit")
    .eq("id", purchase.user_id)
    .single();

  if (fetchLimitError || !userLimit) {
    return res.status(404).json({ message: "User limit record not found" });
  }

  const newLimit = userLimit.max_limit + tokensToAdd;

  const { error: updateError } = await supabase
    .from("user_limits")
    .update({ max_limit: newLimit })
    .eq("id", purchase.user_id);

  if (updateError) {
    return res.status(500).json({ message: updateError.message });
  }

  // 4️⃣ Mark purchase approved
  const { error: updatePurchaseError } = await supabase
    .from("purchases")
    .update({ status: "approved" })
    .eq("id", purchaseId);

  if (updatePurchaseError) {
    return res.status(500).json({ message: updatePurchaseError.message });
  }

  res.json({ message: "✅ Purchase approved", tokensAdded: tokensToAdd, newLimit });
});

// Reject a purchase (admin)
app.post("/reject-purchase", async (req, res) => {
  const { purchaseId, reason } = req.body;

  const { data: purchase, error: fetchError } = await supabase
    .from("purchases")
    .select("*")
    .eq("id", purchaseId)
    .maybeSingle();

  if (fetchError || !purchase) {
    return res.status(404).json({ message: "Purchase not found" });
  }

  if (purchase.status !== "pending") {
    return res.status(400).json({ message: "Already processed" });
  }

  const { error: updateError } = await supabase
    .from("purchases")
    .update({ status: "rejected", rejection_reason: reason || "No reason provided" })
    .eq("id", purchaseId);

  if (updateError) {
    return res.status(500).json({ message: updateError.message });
  }

  res.json({ message: "❌ Purchase rejected" });
});
// 📌 Get User Details by ID
app.post("/get-user-details", async (req, res) => {
  const { userId } = req.body;
  console.log("👉 /get-user-details request:", userId);

  if (!userId) {
    return res.status(400).json({ message: "userId is required" });
  }

  try {
    // 1️⃣ Get user from Auth
    const { data: user, error: userError } = await supabase.auth.admin.getUserById(userId);
    if (userError) {
      console.error("❌ Error fetching user:", userError.message);
      return res.status(400).json({ message: userError.message });
    }

    // 2️⃣ Get user limits
    const { data: limits, error: limitError } = await supabase
      .from("user_limits")
      .select("max_limit, used")
      .eq("id", userId)
      .maybeSingle();

    if (limitError) {
      console.error("❌ Error fetching limits:", limitError.message);
      return res.status(400).json({ message: limitError.message });
    }

    // 3️⃣ Get last recharge
    const { data: purchases, error: purchaseError } = await supabase
      .from("purchases")
      .select("usdt_amount, created_at, status")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (purchaseError) {
      console.error("❌ Error fetching purchases:", purchaseError.message);
      return res.status(400).json({ message: purchaseError.message });
    }

    res.json({
      email: user.user.email,
      tokens_left: (limits?.max_limit || 0) - (limits?.used || 0),
      max_limit: limits?.max_limit || 0,
      used: limits?.used || 0,
      last_recharge: purchases?.length > 0 ? purchases[0] : null,
    });
  } catch (err) {
    console.error("🔥 Server error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/admin/history", async (req, res) => {
  const { requesterId, start, end } = req.query;

  // 1️⃣ Verify requester is an admin
  const { data: admin, error: adminError } = await supabase
    .from("admins")
    .select("id")
    .eq("id", requesterId)
    .maybeSingle();

  if (adminError || !admin) {
    console.warn("❌ Unauthorized access attempt to /admin/history");
    return res.status(403).json({ message: "Only admin can access history" });
  }

  // 2️⃣ Fetch history
  let query = supabase
    .from("verification_history")
    .select("*")
    .order("created_at", { ascending: false });

  if (start && end) {
    query = query.gte("created_at", start).lte("created_at", end);
  }

  const { data, error } = await query;

  if (error) {
    console.error("❌ Error fetching history:", error.message);
    return res.status(500).json({ message: error.message });
  }

  // 3️⃣ Attach direct file URL (no signed URL logic)
  const enhanced = data.map(item => ({
    ...item,
    downloadUrl: item.file_url || item.file_path || null, // use whichever column you have
  }));

  res.json(enhanced);
});


app.get("/user-history", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ message: "userId is required" });

  try {
    // Fetch verification history including file_path
    const { data, error } = await supabase
      .from("verification_history")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });

    // Directly use file_path as downloadUrl
    const results = data.map(item => ({
      ...item,
      downloadUrl: item.file_path || null,
    }));

    res.json(results);
  } catch (err) {
    console.error("🔥 /user-history error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const day = d.getDate().toString().padStart(2, "0");
  const month = d.toLocaleString("en-GB", { month: "short" });
  return day + month;
}

app.post("/api/generate-report", upload.single("file"), async (req, res) => {
  try {
    const { userId, reportDate } = req.body;
    const filePath = req.file.path;

    if (!reportDate) {
      return res.status(400).json({ message: "Report date required" });
    }

    // 1️⃣ Token check (2000 per report)
    const { data: userData, error: userError } = await supabase
      .from("user_limits")
      .select("max_limit, used")
      .eq("id", userId)
      .maybeSingle();

    if (userError || !userData) {
      return res.status(404).json({ message: "User not found" });
    }

    const tokensLeft = userData.max_limit - userData.used;
    if (tokensLeft < 2000) {
      return res.status(403).json({ message: "Not enough tokens. Requires 2000 tokens." });
    }

    // Deduct 2000 upfront
    await supabase
      .from("user_limits")
      .update({ used: userData.used + 2000 })
      .eq("id", userId);

    const dateStr = formatDate(reportDate);
    if (!dateStr) {
      return res.status(400).json({ message: "Invalid date" });
    }

    // 2️⃣ Generate report (existing logic)
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const headers = rows[0];
    const dataRows = rows.slice(1);

    const callerIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes("caller"));
    const fwdIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes("forward"));
    const buyerIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes("buyer"));

    if (callerIdx === -1 || buyerIdx === -1 || fwdIdx === -1) {
      return res.status(400).json({ message: "Required columns missing (CallerID, BuyerName, ForwardedNumber)" });
    }

    const buyers = {};
    dataRows.forEach(row => {
      const buyer = row[buyerIdx];
      if (!buyer) return;
      if (!buyers[buyer]) buyers[buyer] = [];
      buyers[buyer].push(row);
    });

    const zip = new JSZip();
    const masterSummary = [];

   function excelSerialToJSDate(serial) {
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  const date_info = new Date(utc_value * 1000);
  const fractional_day = serial - Math.floor(serial) + 0.0000001;
  let total_seconds = Math.floor(86400 * fractional_day);
  const seconds = total_seconds % 60;
  total_seconds -= seconds;
  const hours = Math.floor(total_seconds / (60 * 60));
  const minutes = Math.floor(total_seconds / 60) % 60;
  date_info.setHours(hours, minutes, seconds);
  return date_info;
}

function formatDT(dt) {
  const d = dt.getDate().toString().padStart(2, '0');
  const m = (dt.getMonth() + 1).toString().padStart(2, '0');
  const y = dt.getFullYear();
  const hh = dt.getHours().toString().padStart(2, '0');
  const mm = dt.getMinutes().toString().padStart(2, '0');
  const ss = dt.getSeconds().toString().padStart(2, '0');
  return `${d}/${m}/${y} ${hh}:${mm}:${ss}`;
}

const campIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes("camp"));
const dateCols = headers
  .map((h, i) => (h && h.toString().toLowerCase().includes("call_start") ? i : -1))
  .filter(i => i >= 0);

for (const buyer in buyers) {
  let calls = buyers[buyer];

  // Remove duplicates by caller
  const seen = new Set();
  calls = calls.filter(row => {
    const caller = row[callerIdx];
    if (seen.has(caller)) return false;
    seen.add(caller);
    return true;
  });

  // Convert call_start columns
  calls = calls.map(row => {
    for (const dc of dateCols) {
      const v = row[dc];
      if (v !== null && v !== undefined && v !== "") {
        if (!isNaN(Number(v)) && Number(v) > 30000) {
          const dt = excelSerialToJSDate(Number(v));
          row[dc] = formatDT(dt);
        } else {
          const dtStr = new Date(v);
          if (!isNaN(dtStr.getTime())) {
            row[dc] = formatDT(dtStr);
          }
        }
      }
    }
    return row;
  });

  const uniqueCalls = calls.length;
  const sampleFwd = calls.length ? String(calls[0][fwdIdx]) : "";
  const suffix = sampleFwd.slice(-4);
  const prefix = buyer.split(" ")[0];

  let camp = calls.length && campIdx >= 0 ? String(calls[0][campIdx]) : "";
  if (camp.length > 10) {
    camp = camp.split(" ").map(w => w.slice(0, 3)).join("");
  }

  const fileName = `${prefix} ${dateStr} ${suffix} - (${uniqueCalls}) ${camp}.xlsx`;

  const sheetData = [headers, ...calls];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Calls");

  const wbout = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  zip.file(fileName, wbout);

  masterSummary.push({ buyer, uniqueCalls, fileName });
}


    const summarySheet = [["Buyer Name", "Unique Calls", "File Name"]];
    masterSummary.forEach(s => summarySheet.push([s.buyer, s.uniqueCalls, s.fileName]));
    const totalCalls = masterSummary.reduce((a, b) => a + b.uniqueCalls, 0);
    summarySheet.push(["TOTAL", totalCalls, ""]);

    const wsSummary = XLSX.utils.aoa_to_sheet(summarySheet);
    const wbSummary = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbSummary, wsSummary, "Summary");
    const summaryOut = XLSX.write(wbSummary, { type: "buffer", bookType: "xlsx" });
    zip.file("Master_Report.xlsx", summaryOut);

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    // 3️⃣ Save ZIP permanently
    const reportsDir = path.join(__dirname, "uploads/reports");
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const fileName = `buyer_reports_${Date.now()}.zip`;
    const outputPath = path.join(reportsDir, fileName);
    fs.writeFileSync(outputPath, zipBuffer);

    // 4️⃣ Save metadata in DB (optional, for history)
    await supabase.from("report_history").insert([
      {
        user_id: userId,
        file_name: fileName,
        file_path: `/uploads/reports/${fileName}`,
        tokens_used: 2000,
        created_at: new Date(),
      },
    ]);

    // 5️⃣ Respond with file link instead of deleting
    res.json({
      message: "✅ Report generated successfully",
      downloadUrl: `http://16.16.67.128:5000/uploads/reports/${fileName}`,
      tokens_used: 2000,
    });
  } catch (err) {
    console.error("❌ Report generation failed:", err);
    res.status(500).json({ message: "Report generation failed", error: err.message });
  }
});
// ======================================================

// ======================================================
// 🔹 FRONTEND & STATIC FILES
// ======================================================
app.use("/uploads/screenshots", express.static(path.join(__dirname, "uploads/ScreenShots")));
app.use("/uploads/verified-data", express.static(path.join(__dirname, "uploads/verified-data")));
app.use("/uploads/reports", express.static(path.join(__dirname, "uploads/reports")));
app.use("/reports", express.static(path.join(__dirname, "uploads/reports")));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});