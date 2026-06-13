const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const { decodeHessianDeflation } = require("./hessianDecoder");

const app = express();

// VERCEL FIX 1: We MUST use the /tmp directory. The rest of Vercel is read-only.
const upload = multer({ dest: "/tmp/" });

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/process-csv", upload.single("csvFile"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: "No CSV file uploaded." });
    }

    const inputFilePath = req.file.path;
    const results = [];

    fs.createReadStream(inputFilePath)
        .pipe(csv())
        .on("data", (row) => {
            let decodedValue = "";
            if (row.info) {
                try {
                    const decodedObj = decodeHessianDeflation(row.info);
                    // Store as object directly in the JSON response
                    decodedValue = decodedObj;
                } catch (error) {
                    decodedValue = "ERROR_DECODING";
                    console.log(error);
                }
            }
            row.decoded_info = decodedValue;
            results.push(row);
        })
        .on("error", (err) => {
            console.error("❌ Error reading CSV:", err);
            try {
                fs.unlinkSync(inputFilePath);
            } catch (unlinkErr) {}
            return res.status(500).json({ success: false, error: "Error parsing the uploaded CSV." });
        })
        .on("end", () => {
            // Always clean up input file from /tmp
            try {
                fs.unlinkSync(inputFilePath);
            } catch (unlinkErr) {}

            if (results.length === 0) {
                return res.status(400).json({ success: false, error: "The uploaded CSV is empty or invalid." });
            }

            res.json({
                success: true,
                filename: req.file.originalname,
                data: results
            });
        });
});

// VERCEL FIX 4: Instead of app.listen(), we export the Express app for Vercel's serverless engine
module.exports = app;