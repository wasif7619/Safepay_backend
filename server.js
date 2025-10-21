// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Postgres pool
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ Error acquiring client", err.stack);
  } else {
    console.log("✅ Connected to PostgreSQL database");
    release();
  }
});

// Helper: checkout host by mode
function checkoutHost() {
  if ((process.env.SAFE_PAY_MODE || "").toLowerCase() === "sandbox") {
    return "https://sandbox.safepay.com";
  }
  return "https://safepay.com";
}

// Helper: base URL trimmed
function safepayBaseUrl() {
  return (process.env.SAFE_PAY_BASE_URL || "").replace(/\/$/, "");
}

// Create payment session
app.post("/api/safepay/session", async (req, res) => {
  try {
    const { amount, currency = "PKR", metadata = {} } = req.body;

    // Basic validation
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    if (!process.env.SAFE_PAY_PUBLIC_KEY || !process.env.SAFE_PAY_SECRET_KEY || !process.env.SAFE_PAY_BASE_URL) {
      console.error("❌ Safepay credentials missing");
      return res.status(500).json({ error: "Safepay credentials not configured" });
    }

    // Prepare payload
    const safepayPayload = {
      amount: Math.round(Number(amount) * 100), // amount in paisa (integer)
      currency: (currency || "PKR").toUpperCase(),
      client: process.env.SAFE_PAY_PUBLIC_KEY,
      environment: process.env.SAFE_PAY_MODE || "sandbox",
      redirect_url: metadata.return_url || "http://localhost:3000/payment-success",
      metadata: metadata || {},
    };

    // Authorization header
    const authHeader = `Basic ${Buffer.from(
      `${process.env.SAFE_PAY_PUBLIC_KEY}:${process.env.SAFE_PAY_SECRET_KEY}`
    ).toString("base64")}`;

    console.log("🔐 Calling Safepay init with payload:", JSON.stringify(safepayPayload));

    const spResponse = await axios.post(
      `${safepayBaseUrl()}/order/v1/init`,
      safepayPayload,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Environment": process.env.SAFE_PAY_MODE || "sandbox",
          Authorization: authHeader,
        },
        timeout: 15000,
      }
    );

    const orderData = spResponse.data;
    if (!orderData?.data?.token) {
      console.warn("⚠️ No token in Safepay response:", JSON.stringify(orderData, null, 2));
      return res.status(502).json({
        error: "No token received from Safepay",
        details: orderData,
      });
    }

    const token = orderData.data.token;
    const checkoutUrl = `${checkoutHost()}/checkout/${token}`;

    // Save initial payment row with pending status — card info comes from webhook
    const insertQuery = `
      INSERT INTO payments (amount, currency, transaction_id, status)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;

    const result = await pool.query(insertQuery, [
      Number(amount),
      (currency || "PKR").toUpperCase(),
      token,
      "pending",
    ]);

    const paymentRow = result.rows[0];

    return res.json({
      success: true,
      checkoutUrl,
      paymentId: paymentRow.id,
      transactionId: token,
      safepayRaw: orderData,
    });
  } catch (err) {
    console.error("💥 Payment session creation failed:", err.response?.data || err.message);
    return res.status(500).json({
      error: "Payment session creation failed",
      details: err.response?.data || err.message,
    });
  }
});

// Webhook endpoint — Safepay will call this when payment events occur
app.post("/api/safepay/webhook", async (req, res) => {
  try {
    const payload = req.body;
    console.log("🔔 Safepay webhook received:", JSON.stringify(payload, null, 2));

    const event = payload.event || null;
    const data = payload.data || payload;

    // Extract tracker/token
    const tracker = data?.tracker || data?.token || data?.id || null;

    if (tracker) {
      // Extract card information from webhook response
      const cardType = 
        data?.transaction?.card?.brand || 
        data?.card?.brand || 
        data?.payment_method?.brand || 
        null;
      
      const last4 = 
        data?.transaction?.card?.last4 || 
        data?.card?.last4 || 
        data?.payment_method?.last4 || 
        null;
      
      const masked = last4 ? `****${last4}` : null;
      
      const cardholder = 
        data?.transaction?.card?.holder_name || 
        data?.card?.holder_name || 
        data?.cardholder_name || 
        null;
      
      const statusFromWebhook = 
        data?.state || 
        data?.status || 
        data?.result || 
        event || 
        "unknown";

      console.log(`📝 Extracted card info - Type: ${cardType}, Last4: ${last4}, Holder: ${cardholder}`);

      // Update payment row with card details
      await pool.query(
        `UPDATE payments 
         SET status=$1, 
             card_type=$2, 
             card_number=$3, 
             cardholder_name=$4,
             updated_at=NOW() 
         WHERE transaction_id=$5`,
        [statusFromWebhook, cardType, masked, cardholder, tracker]
      );

      console.log(`✅ Webhook processed for tracker ${tracker} — status: ${statusFromWebhook}`);
    } else {
      console.warn("⚠️ Webhook missing tracker/token");
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook processing failed:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// Status endpoint — query Safepay for status and update DB
app.get("/api/safepay/status/:transactionId", async (req, res) => {
  try {
    const { transactionId } = req.params;
    if (!transactionId) return res.status(400).json({ error: "Missing transactionId" });

    const authHeader = `Basic ${Buffer.from(
      `${process.env.SAFE_PAY_PUBLIC_KEY}:${process.env.SAFE_PAY_SECRET_KEY}`
    ).toString("base64")}`;

    const response = await axios.get(`${safepayBaseUrl()}/order/v1/${transactionId}`, {
      headers: {
        "Content-Type": "application/json",
        "X-Environment": process.env.SAFE_PAY_MODE || "sandbox",
        Authorization: authHeader,
      },
    });

    const data = response.data;
    const state = data?.data?.state || data?.status?.message || "unknown";

    // Extract card information
    const cardType = 
      data?.data?.transaction?.card?.brand || 
      data?.data?.card?.brand || 
      data?.data?.payment_method?.brand || 
      null;
    
    const last4 = 
      data?.data?.transaction?.card?.last4 || 
      data?.data?.card?.last4 || 
      data?.data?.payment_method?.last4 || 
      null;
    
    const masked = last4 ? `****${last4}` : null;
    
    const cardholder = 
      data?.data?.transaction?.card?.holder_name || 
      data?.data?.card?.holder_name || 
      null;

    await pool.query(
      `UPDATE payments 
       SET status=$1, 
           card_type=$2, 
           card_number=$3, 
           cardholder_name=$4,
           updated_at=NOW() 
       WHERE transaction_id=$5`,
      [state, cardType, masked, cardholder, transactionId]
    );

    res.json({ status: state, data });
  } catch (err) {
    console.error("❌ Status check error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// For testing: list payments
app.get("/api/payments", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM payments ORDER BY created_at DESC LIMIT 100");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching payments:", err);
    res.status(500).json({ error: "Failed to fetch payments" });
  }
});

const port = process.env.PORT || 3500;
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  console.log(`📊 Database: ${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT}`);
});