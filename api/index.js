const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const { createObjectCsvWriter } = require("csv-writer");
const { decodeHessianDeflation } = require("./hessianDecoder");

const app = express();

// VERCEL FIX 1: We MUST use the /tmp directory. The rest of Vercel is read-only.
const upload = multer({ dest: "/tmp/" });

app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Hessian CSV Decoder</title>
            <style>
                body { font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }
                .card { border: 1px solid #ccc; padding: 20px; border-radius: 8px; background: #f9f9f9; }
                button { padding: 10px 15px; background: #000; color: white; border: none; border-radius: 4px; cursor: pointer; }
                button:hover { background: #333; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>Hessian CSV Decoder (Vercel Edition)</h2>
                <p>Select your <b>input.csv</b> file (Max 4.5MB) below.</p>
                <form action="/process-csv" method="POST" enctype="multipart/form-data">
                    <input type="file" name="csvFile" accept=".csv" required />
                    <br><br>
                    <button type="submit">Upload & Decode CSV</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post("/process-csv", upload.single("csvFile"), (req, res) => {
    if (!req.file) {
        return res.status(400).send("No CSV file uploaded.");
    }

    const inputFilePath = req.file.path;
    // VERCEL FIX 2: Output file also needs to be safely stored in /tmp
    const outputFilePath = path.join("/tmp", `${req.file.filename}-processed.csv`);
    const results = [];

    fs.createReadStream(inputFilePath)
        .pipe(csv())
        .on("data", (row) => {
            let decodedValue = "";
            if (row.info) {
                try {
                    const decodedObj = decodeHessianDeflation(row.info);
                    decodedValue = JSON.stringify(decodedObj);
                } catch (error) {
                    decodedValue = "ERROR_DECODING";
                }
            }
            row.decoded_info = decodedValue;
            results.push(row);
        })
        .on("end", async () => {
            if (results.length === 0) {
                fs.unlinkSync(inputFilePath);
                return res.status(400).send("The uploaded CSV is empty or invalid.");
            }

            const headers = Object.keys(results[0]).map((key) => {
                return { id: key, title: key };
            });

            const csvWriter = createObjectCsvWriter({
                path: outputFilePath,
                header: headers,
            });

            try {
                await csvWriter.writeRecords(results);

                res.download(outputFilePath, `processed_${req.file.originalname}`, (err) => {
                    if (err) console.error("❌ Error sending the file:", err);
                    
                    // VERCEL FIX 3: Always clean up /tmp so Vercel doesn't run out of memory
                    fs.unlinkSync(inputFilePath);
                    fs.unlinkSync(outputFilePath);
                });

            } catch (err) {
                console.error("❌ Error writing the CSV file:", err);
                res.status(500).send("Internal server error while writing the CSV.");
            }
        });
});

// VERCEL FIX 4: Instead of app.listen(), we export the Express app for Vercel's serverless engine
module.exports = app;