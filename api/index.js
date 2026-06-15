const express = require("express");
const path = require("path");
const { decodeHessianDeflation } = require("./hessianDecoder");

const app = express();

// Accept JSON payloads up to 4MB (Vercel's limit is 4.5MB)
app.use(express.json({ limit: "4mb" }));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "page.html"));
});

app.post("/process-batch", (req, res) => {
    const rows = req.body;
    
    if (!Array.isArray(rows)) {
        return res.status(400).json({ success: false, error: "Invalid payload format. Expected a JSON array of rows." });
    }

    const results = rows.map((row) => {
        let decodedValue = "";
        if (row.info) {
            try {
                const decodedObj = decodeHessianDeflation(row.info);
                decodedValue = decodedObj;
            } catch (error) {
                decodedValue = "ERROR_DECODING";
                console.error("Decoding error:", error);
            }
        }
        row.decoded_info = decodedValue;
        return row;
    });

    res.json({
        success: true,
        data: results
    });
});

// VERCEL FIX: Instead of app.listen(), we export the Express app for Vercel's serverless engine
module.exports = app;