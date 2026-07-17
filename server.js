const express = require("express");
const { MongoClient } = require("mongodb");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

const cors = require("cors");
app.use(cors({ origin: "*" }));

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const REPORT_SECRET = process.env.REPORT_SECRET; // secret used by whatever posts Grow a Garden 2 stats
const MONGODB_URI = process.env.MONGODB_URI;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const MAX_FREE_KEYS = 0;
const FREE_KEY_HOURS = 12;

let db;

const mainScript = fs.readFileSync('./main.lua', 'utf8');
const freeScript = fs.readFileSync('./main.lua', 'utf8');

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

async function connectDB() {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db("azrahub");
    console.log("✅ Connected to MongoDB");
}

async function resolveKey(key) {
    if (!key) return null;
    const paid = await db.collection("keys").findOne({ key });
    if (paid) return { type: "paid", data: paid };
    const free = await db.collection("freekeys").findOne({ key });
    if (free) return { type: "free", data: free };
    return null;
}

function isAdmin(req) {
    return req.query.secret === ADMIN_SECRET || req.headers["x-admin-secret"] === ADMIN_SECRET;
}

function isReporter(req) {
    if (!REPORT_SECRET) return false; // reporting disabled until REPORT_SECRET is set
    return req.headers["x-report-secret"] === REPORT_SECRET || req.query.secret === REPORT_SECRET;
}

// ============================================================
//  VALIDATE & AUTHENTICATION ENDPOINTS (HWID LOCKED)
// ============================================================

app.post("/validate", async (req, res) => {
    try {
        const { key, userId, username, hwid } = req.body;

        if (!hwid || hwid === "Not Provided") return res.send("INVALID");

        const result = await resolveKey(key);
        if (!result) return res.send("INVALID");

        if (result.type === "paid") {
            const keyDoc = result.data;
            const maxAccounts = keyDoc.maxAccounts || 30;
            const users = keyDoc.users || [];

            if (!keyDoc.lockedHwid) {
                await db.collection("keys").updateOne(
                    { key },
                    { $set: { lockedHwid: String(hwid) } }
                );
            } else if (keyDoc.lockedHwid !== String(hwid)) {
                return res.send("INVALID");
            }

            const existingUserAccount = users.find(u => u.userId === String(userId));

            if (!existingUserAccount) {
                if (users.length >= maxAccounts) return res.send("INVALID");

                // Fixed: Now saving hwid, userId, username, and timestamp
                await db.collection("keys").updateOne(
                    { key },
                    { $push: { users: {
                        userId: String(userId),
                        username: username || "Unknown",
                        hwid: String(hwid),
                        loggedAt: new Date().toISOString()
                    } } }
                );
            }
        }

        if (result.type === "free") {
            const keyDoc = result.data;
            if (keyDoc.claimedAt) {
                const hoursPassed = (new Date() - new Date(keyDoc.claimedAt)) / (1000 * 60 * 60);
                if (hoursPassed >= FREE_KEY_HOURS) {
                    await db.collection("freekeys").deleteOne({ key });
                    return res.send("EXPIRED");
                }
            }

            if (!keyDoc.lockedHwid) {
                await db.collection("freekeys").updateOne(
                    { key },
                    { $set: { lockedHwid: String(hwid), lockedUserId: String(userId), lockedUsername: username || "Unknown", firstUsed: new Date().toISOString() } }
                );
            } else if (keyDoc.lockedHwid !== String(hwid) || keyDoc.lockedUserId !== String(userId)) {
                return res.send("INVALID");
            }
        }

        if (WEBHOOK_URL) {
            const axios = require("axios");
            const embed = {
                title: "✾ Ashh Logs", color: 16711680,
                fields: [
                    { name: "👤 Username", value: username || "Unknown", inline: true },
                    { name: "ⓘ UserId", value: String(userId || "N/A"), inline: true },
                    { name: "🔑 Key", value: key, inline: true },
                    { name: "⚙️ HWID", value: hwid, inline: false },
                    { name: "🏷️ Type", value: result.type.toUpperCase(), inline: true }
                ],
                footer: { text: "Ashleng on top" }, timestamp: new Date().toISOString()
            };
            axios.post(WEBHOOK_URL, { embeds: [embed] }).catch(() => {});
        }

        return res.send(result.type === "free" ? freeScript : mainScript);
    } catch (err) {
        console.error("Validate error:", err);
        res.status(500).send("INVALID");
    }
});

app.post("/free/validate", async (req, res) => {
    try {
        const { key, userId, username, hwid } = req.body;
        if (!key || !hwid || hwid === "Not Provided") return res.send("INVALID");

        const result = await db.collection("freekeys").findOne({ key });
        if (!result) return res.send("INVALID");

        if (result.claimedAt) {
            const hoursPassed = (new Date() - new Date(result.claimedAt)) / (1000 * 60 * 60);
            if (hoursPassed >= FREE_KEY_HOURS) { await db.collection("freekeys").deleteOne({ key }); return res.send("EXPIRED"); }
        }

        if (!result.lockedHwid) {
            await db.collection("freekeys").updateOne({ key }, { $set: { lockedHwid: String(hwid), lockedUserId: String(userId), lockedUsername: username || "Unknown", firstUsed: new Date().toISOString() } });
        } else if (result.lockedHwid !== String(hwid)) {
            return res.send("INVALID");
        }

        if (WEBHOOK_URL) {
            const axios = require("axios");
            const embed = { title: "🆓 Free Key Used", color: 65280, fields: [{ name: "👤 Username", value: username || "Unknown", inline: true }, { name: "ⓘ UserId", value: String(userId || "N/A"), inline: true }, { name: "🔑 Key", value: key, inline: true }, { name: "⚙️ HWID", value: hwid, inline: false }], footer: { text: "Ashleng on top" }, timestamp: new Date().toISOString() };
            axios.post(WEBHOOK_URL, { embeds: [embed] }).catch(() => {});
        }
        return res.send(freeScript);
    } catch (err) {
        console.error("Free validate error:", err);
        res.status(500).send("INVALID");
    }
});

app.post("/free/claim", async (req, res) => {
    try {
        const { discord } = req.body;
        if (!discord) return res.json({ success: false, message: "Discord ID required" });
        const existing = await db.collection("freekeys").findOne({ discord });
        if (existing) {
            if (existing.claimedAt) {
                const hoursPassed = (new Date() - new Date(existing.claimedAt)) / (1000 * 60 * 60);
                if (hoursPassed >= FREE_KEY_HOURS) {
                    await db.collection("freekeys").deleteOne({ discord });
                } else {
                    return res.json({ success: false, message: "Already claimed", key: existing.key });
                }
            } else {
                return res.json({ success: false, message: "Already claimed", key: existing.key });
            }
        }
        const claimed = await db.collection("freekeys").countDocuments();
        if (claimed >= MAX_FREE_KEYS) return res.json({ success: false, message: "NO_KEYS_LEFT" });
        const newKey = "FREE-" + Math.random().toString(36).substring(2, 10).toUpperCase();
        await db.collection("freekeys").insertOne({ key: newKey, discord, claimedAt: new Date().toISOString(), lockedHwid: null, lockedUserId: null, lockedUsername: null, firstUsed: null });
        return res.json({ success: true, key: newKey });
    } catch (err) {
        console.error("Free claim error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.post("/free/waitlist", async (req, res) => {
    try {
        const { discord } = req.body;
        if (!discord) return res.json({ success: false, message: "Discord ID required" });
        const existing = await db.collection("waitlist").findOne({ discord });
        if (existing) return res.json({ success: false, message: "Already on waitlist" });
        await db.collection("waitlist").insertOne({ discord, addedAt: new Date().toISOString() });
        return res.json({ success: true, message: "Added to waitlist" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.get("/free/status", async (req, res) => {
    try {
        const allFreeKeys = await db.collection("freekeys").find().toArray();
        for (const k of allFreeKeys) {
            if (k.claimedAt) {
                const hoursPassed = (new Date() - new Date(k.claimedAt)) / (1000 * 60 * 60);
                if (hoursPassed >= FREE_KEY_HOURS) await db.collection("freekeys").deleteOne({ _id: k._id });
            }
        }
        const claimed = await db.collection("freekeys").countDocuments();
        return res.json({ success: true, freeKeys: Math.max(0, MAX_FREE_KEYS - claimed), total: MAX_FREE_KEYS });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.get("/user/key/:key", async (req, res) => {
    try {
        const result = await resolveKey(req.params.key);
        if (!result) return res.json({ success: false, message: "Key not found" });
        const d = result.data;
        return res.json({
            success: true,
            type: result.type,
            data: {
                key: d.key,
                maxAccounts: d.maxAccounts || 30,
                users: d.users || [],
                expiresAt: d.expiresAt || null,
                claimedAt: d.claimedAt || null,
                lastResetAt: d.lastResetAt || null
            }
        });
    } catch (err) {
        console.error("User key lookup error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

const RESET_COOLDOWN_DAYS = 3;

app.post("/user/resetaccounts", async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.json({ success: false, message: "key required" });
        const existing = await db.collection("keys").findOne({ key });
        if (!existing) return res.json({ success: false, message: "Key not found" });

        if (existing.lastResetAt) {
            const daysPassed = (new Date() - new Date(existing.lastResetAt)) / (1000 * 60 * 60 * 24);
            if (daysPassed < RESET_COOLDOWN_DAYS) {
                const hoursLeft = Math.ceil((RESET_COOLDOWN_DAYS - daysPassed) * 24);
                const daysLeft = Math.floor(hoursLeft / 24);
                const hrsLeft = hoursLeft % 24;
                const timeMsg = daysLeft > 0 ? `${daysLeft}d ${hrsLeft}h` : `${hrsLeft}h`;
                return res.json({ success: false, cooldown: true, message: `You can reset again in ${timeMsg}.` });
            }
        }

        await db.collection("keys").updateOne(
            { key },
            { $set: { users: [], lastResetAt: new Date().toISOString() } }
        );
        return res.json({ success: true, message: "All linked HWIDs reset" });
    } catch (err) {
        console.error("User reset error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ============================================================
//  GROW A GARDEN 2 — STATS INGEST & READ
// ============================================================

app.post("/report/growstats", async (req, res) => {
    try {

        const {
    key,
    userId,
    username,
    sheckles,
    totalInventoryValue,
    fruits,
    seeds,
    gears,
    pets
} = req.body;
        if (!key || !userId) return res.json({ success: false, message: "key and userId required" });

        const keyResult = await resolveKey(key);
        if (!keyResult) return res.json({ success: false, message: "Invalid key" });

        const knownUser = (keyResult.data.users || []).find(u => u.userId === String(userId));
        if (!knownUser) return res.json({ success: false, message: "userId is not linked to this key" });

        const cleanFruits = Array.isArray(fruits) ? fruits.map(f => {
            const quantity = Math.max(0, parseInt(f.quantity) || 0);
            const unitValue = Math.max(0, Number(f.unitValue) || 0);
            return { name: String(f.name || "Unknown"), quantity, unitValue, totalValue: quantity * unitValue };
        }) : [];

        const cleanItemList = (arr) => Array.isArray(arr) ? arr.map(i => ({
            name: String(i.name || "Unknown"),
            quantity: Math.max(0, parseInt(i.quantity) || 0)
        })) : [];
        const cleanSeeds = cleanItemList(seeds);
        const cleanGears = cleanItemList(gears);
        const cleanPets = cleanItemList(pets);

        const totalFruits = cleanFruits.reduce((s, f) => s + f.quantity, 0);
        const totalValue = cleanFruits.reduce((s, f) => s + f.totalValue, 0);

        await db.collection("growstats").updateOne(
    { key, userId: String(userId) },
    {
        $set: {
            key,
            userId: String(userId),
            username: username || knownUser.username || "Unknown",

            sheckles: Math.max(0, Number(sheckles) || 0),

            fruits: cleanFruits,
            seeds: cleanSeeds,
            gears: cleanGears,
            pets: cleanPets,

            totalFruits,
            totalValue,

            inventoryValue: Math.max(0, Number(totalInventoryValue) || 0),

            lastSynced: new Date().toISOString()
        }
    },
    { upsert: true }
);

        return res.json({ success: true, message: "Stats saved" });
    } catch (err) {
        console.error("Report growstats error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.get("/user/growstats/:key", async (req, res) => {
    try {
        const { key } = req.params;
        const keyResult = await resolveKey(key);
        if (!keyResult) return res.json({ success: false, message: "Key not found" });
        
        // This is the updated portion to return an array for drill-down functionality
        const docs = await db.collection("growstats").find({ key }).toArray();
        const data = docs.map(d => ({
            userId: d.userId,
            username: d.username,
            sheckles: d.sheckles,
            fruits: d.fruits || [],
            seeds: d.seeds || [],
            gears: d.gears || [],
            pets: d.pets || [],
            inventoryValue: d.inventoryValue || 0
        }));
        
        return res.json({ success: true, data });
    } catch (err) {
        console.error("Bulk growstats error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.get("/user/growstats/:key/total", async (req, res) => {
    try {
        const { key } = req.params;
        const keyResult = await resolveKey(key);
        if (!keyResult) return res.json({ success: false, message: "Key not found" });
        const docs = await db.collection("growstats").find({ key }).toArray();

        const merge = (field) => {
            const totals = {};
            docs.forEach(d => (d[field] || []).forEach(item => {
                totals[item.name] = (totals[item.name] || 0) + (item.quantity || 0);
            }));
            return Object.entries(totals)
                .map(([name, quantity]) => ({ name, quantity }))
                .sort((a, b) => b.quantity - a.quantity);
        };

        const totalFruitsValue = docs.reduce((sum, d) => sum + (d.inventoryValue || d.totalValue || 0), 0);

        return res.json({ success: true, data: {
            seeds: merge("seeds"),
            gears: merge("gears"),
            pets: merge("pets"),
            totalFruitsValue,
            accountsSynced: docs.length
        } });
    } catch (err) {
        console.error("Total inventory error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.get("/user/growstats/:key/:userId", async (req, res) => {
    try {
        const { key, userId } = req.params;
        const doc = await db.collection("growstats").findOne({ key, userId: String(userId) });
        if (!doc) return res.status(404).json({ success: false, message: "No stats synced for this account yet" });
        return res.json({
    success: true,
    data: {
        username: doc.username,
        userId: doc.userId,

        sheckles: doc.sheckles,

        fruits: doc.fruits,
        seeds: doc.seeds || [],
        gears: doc.gears || [],
        pets: doc.pets || [],

        totalFruits: doc.totalFruits,
        totalValue: doc.totalValue,
        inventoryValue: doc.inventoryValue || 0,

        lastSynced: doc.lastSynced
    }
});
    } catch (err) {
        console.error("Single growstats error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.get("/admin/key/:key", async (req, res) => {
    if (!isAdmin(req)) return res.json({ success: false, message: "Unauthorized" });
    const result = await resolveKey(req.params.key);
    if (!result) return res.json({ success: false, message: "Key not found" });
    return res.json({ success: true, type: result.type, data: result.data });
});

app.get("/free/admin", async (req, res) => {
    if (!isAdmin(req)) return res.json({ success: false, message: "Unauthorized" });
    const keys = await db.collection("freekeys").find().toArray();
    const waitlist = await db.collection("waitlist").find().toArray();
    return res.json({ success: true, keys, waitlist });
});

app.get("/free/keys", async (req, res) => {
    if (!isAdmin(req)) return res.json({ success: false, message: "Unauthorized" });
    const keys = await db.collection("freekeys").find().toArray();
    const keysWithExpiry = keys.map(k => {
        const hoursPassed = k.claimedAt ? (new Date() - new Date(k.claimedAt)) / (1000 * 60 * 60) : 0;
        return { ...k, hoursLeft: Math.max(0, FREE_KEY_HOURS - hoursPassed).toFixed(1) };
    });
    return res.json({ success: true, keys: keysWithExpiry });
});

app.post("/admin/addkey", async (req, res) => {
    if (!isAdmin(req)) return res.json({ success: false, message: "Unauthorized" });
    const { key, discord, note, maxAccounts } = req.body;
    if (!key) return res.json({ success: false, message: "Key required" });
    const existing = await db.collection("keys").findOne({ key });
    if (existing) return res.json({ success: false, message: "Key already exists" });
    await db.collection("keys").insertOne({ key, discord: discord || "", note: note || "", maxAccounts: parseInt(maxAccounts) || 10, users: [], addedAt: new Date().toISOString() });
    return res.json({ success: true, message: "Key added" });
});

app.get("/admin/keys", async (req, res) => {
    if (!isAdmin(req)) return res.json({ success: false, message: "Unauthorized" });
    const keys = await db.collection("keys").find().toArray();
    return res.json({ success: true, keys });
});

app.post("/admin/editkey", async (req, res) => {
    if (!isAdmin(req)) return res.json({ success: false, message: "Unauthorized" });
    const { originalKey, key, maxAccounts, discord, note } = req.body;
    if (!originalKey || !key) return res.json({ success: false, message: "originalKey and key are required" });
    const existing = await db.collection("keys").findOne({ key: originalKey });
    if (!existing) return res.json({ success: false, message: "Key not found" });
    if (key !== originalKey) {
        const conflict = await db.collection("keys").findOne({ key });
        if (conflict) return res.json({ success: false, message: "New key string already exists" });
    }
    await db.collection("keys").updateOne(
        { key: originalKey },
        { $set: { key, maxAccounts: parseInt(maxAccounts) || existing.maxAccounts || 10, discord: discord || "", note: note || "" } }
    );
    return res.json({ success: true, message: "Key updated" });
});

app.post("/admin/removeaccount", async (req, res) => {
    if (!isAdmin(req)) return res.json({ success: false, message: "Unauthorized" });
    const { key, hwid } = req.body;
    if (!key || !hwid) return res.json({ success: false, message: "key and hwid required" });
    const existing = await db.collection("keys").findOne({ key });
    if (!existing) return res.json({ success: false, message: "Key not found" });
    await db.collection("keys").updateOne({ key }, { $pull: { users: { hwid: String(hwid) } } });
    return res.json({ success: true, message: "HWID removed successfully" });
});

app.post("/admin/resetaccounts", async (req, res) => {
    if (!isAdmin(req)) return res.json({ success: false, message: "Unauthorized" });
    const { key } = req.body;
    if (!key) return res.json({ success: false, message: "key required" });
    const existing = await db.collection("keys").findOne({ key });
    if (!existing) return res.json({ success: false, message: "Key not found" });
    await db.collection("keys").updateOne({ key }, { $set: { users: [] } });
    return res.json({ success: true, message: "All HWIDs cleared" });
});

app.post("/config/save", async (req, res) => {
    try {
        const { key, configData } = req.body;
        if (!key || !configData) return res.json({ success: false, message: "Missing key or configData" });
        const keyResult = await resolveKey(key);
        if (!keyResult) return res.json({ success: false, message: "Invalid key" });
        await db.collection("configs").updateOne({ key }, { $set: { key, configData, savedAt: new Date().toISOString() } }, { upsert: true });
        return res.json({ success: true, message: "Config saved" });
    } catch (err) {
        console.error("Config save error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.get("/config/get", async (req, res) => {
    try {
        const { key } = req.query;
        if (!key) return res.json({ success: false, message: "Key required" });
        const keyResult = await resolveKey(key);
        if (!keyResult) return res.json({ success: false, message: "Invalid key" });
        const config = await db.collection("configs").findOne({ key });
        if (!config) return res.json({ success: false, message: "No config saved yet" });
        return res.json({ success: true, configData: config.configData });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ============================================================
//  INVENTORY TRACKER (flat-file, no keys/HWID — separate from
//  the Mongo-backed growstats system above)
// ============================================================

const TRACKER_DATA_FILE = path.join(__dirname, "tracker-data.json");
const TRACKER_CATEGORY_ORDER = ["crops", "seeds", "gears", "pets", "other"];

function loadTrackerData() {
    if (!fs.existsSync(TRACKER_DATA_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(TRACKER_DATA_FILE, "utf8"));
    } catch (err) {
        console.error("Failed to read tracker-data.json:", err);
        return {};
    }
}

function saveTrackerData(data) {
    fs.writeFileSync(TRACKER_DATA_FILE, JSON.stringify(data, null, 2));
}

app.post("/api/inventory", (req, res) => {
    const { userId, username, inventory } = req.body || {};
    if (!userId || !username || !inventory) {
        return res.status(400).json({ error: "userId, username, and inventory are required" });
    }
    const data = loadTrackerData();
    data[userId] = {
        username,
        userId,
        inventory,
        updatedAt: new Date().toISOString(),
    };
    saveTrackerData(data);
    res.json({ ok: true });
});

app.get("/api/inventory", (req, res) => {
    const data = loadTrackerData();
    const list = Object.values(data).map(({ userId, username, updatedAt }) => ({
        userId,
        username,
        updatedAt,
    }));
    res.json(list);
});

app.get("/api/inventory/total", (req, res) => {
    const data = loadTrackerData();
    const total = {};
    for (const key of TRACKER_CATEGORY_ORDER) total[key] = {};
    for (const account of Object.values(data)) {
        for (const key of TRACKER_CATEGORY_ORDER) {
            const bucket = account.inventory[key] || {};
            for (const [name, count] of Object.entries(bucket)) {
                total[key][name] = (total[key][name] || 0) + count;
            }
        }
    }
    res.json({ inventory: total, accountCount: Object.keys(data).length });
});

app.get("/api/inventory/:userId", (req, res) => {
    const data = loadTrackerData();
    const account = data[req.params.userId];
    if (!account) return res.status(404).json({ error: "No data synced for this account yet" });
    res.json(account);
});

// Serves public/tracker.html and any other static assets in ./public.
// Registered after the explicit "/" route above, so it won't override it.
app.use(express.static(path.join(__dirname, "public")));

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}).catch(err => {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
});
