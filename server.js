const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { Parser } = require('json2csv');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'queue_data.json');

let queues = {
    Charging: [],
    Releasing: [],
    Extraction: []
};

let currentServing = {
    Charging: null,
    Releasing: null,
    Extraction: null
};

let lastServed = {
    Charging: null,
    Releasing: null,
    Extraction: null
};

let queueNumbers = {
    Charging: 0,
    Releasing: 0,
    Extraction: 0
};

let servedHistory = [];
let totalServed = 0;
let totalWaitTime = 0;
let currentAnnouncement = "";

let settings = {
    averageServiceTime: 5,
    maxQueueLength: 100
};

function saveState() {
    const state = {
        queues,
        currentServing,
        lastServed,
        queueNumbers,
        servedHistory,
        totalServed,
        totalWaitTime,
        currentAnnouncement
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
    if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        queues = data.queues || queues;
        currentServing = data.currentServing || currentServing;
        lastServed = data.lastServed || lastServed;
        queueNumbers = data.queueNumbers || queueNumbers;
        servedHistory = data.servedHistory || [];
        totalServed = data.totalServed || 0;
        totalWaitTime = data.totalWaitTime || 0;
        currentAnnouncement = data.currentAnnouncement || "";
        console.log("Queue state loaded from file.");
    }
}

loadState();

const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', (ws) => {
    console.log('Client connected');
});

function notifyClients(message) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function generateQueueNumber(service) {
    const prefix = service.charAt(0).toUpperCase();
    return `${prefix}${++queueNumbers[service]}`;
}

function addToQueue(service, user) {
    if (queues[service]) {
        if (queues[service].length < settings.maxQueueLength) {
            queues[service].push(user);
            saveState();
        } else {
            console.error(`Queue for ${service} is full.`);
        }
    }
}

function callNextNumber(service) {
    let nextUser = queues[service].shift();
    if (nextUser) {
        currentServing[service] = nextUser;
        lastServed[service] = nextUser;
        servedHistory.push(nextUser);
        totalServed++;
        totalWaitTime += settings.averageServiceTime;
        notifyClients(`Now serving number ${nextUser.number} at ${service}`);
        saveState();
        return nextUser;
    }
    return null;
}

app.get('/queue', (req, res) => {
    const status = {};
    for (const service in queues) {
        const waitingUsers = queues[service];
        const estimatedWaitTime = (waitingUsers.length * settings.averageServiceTime);
        status[service] = {
            current: currentServing[service] ? { number: currentServing[service].number } : null,
            waiting: waitingUsers.map(user => user.number),
            estimatedWaitTime: estimatedWaitTime
        };
    }
    res.json(status);
});

app.post('/queue', (req, res) => {
    const { service } = req.body;
    if (!queues[service]) {
        return res.status(400).json({ error: "Invalid service" });
    }
    const user = { number: generateQueueNumber(service), service, timestamp: Date.now() };
    addToQueue(service, user);
    res.json({ number: user.number });
});

app.post('/call', (req, res) => {
    const { service } = req.body;
    const currentUser = callNextNumber(service);
    if (currentUser) {
        res.json({ current: currentUser.number });
    } else {
        res.json({ current: null });
    }
});

app.post('/recall', (req, res) => {
    const { service } = req.body;

    if (!lastServed[service]) {
        return res.status(400).json({ message: 'Nothing to recall.' });
    }

    const lastUser = lastServed[service];
    currentServing[service] = lastUser;
    const message = `Now serving number ${lastUser.number} at ${service}`;
    notifyClients(message);
    saveState();

    res.json({ lastNumber: lastUser.number });
});

app.post('/announcement', (req, res) => {
    const { announcement } = req.body;
    currentAnnouncement = announcement;
    notifyClients(`New Announcement: ${announcement}`);
    saveState();
    res.status(200).send();
});

app.get('/announcement', (req, res) => {
    res.json({ announcement: currentAnnouncement });
});

app.post('/reset-queue', (req, res) => {
    try {
        queues = {
            Charging: [],
            Releasing: [],
            Extraction: []
        };
        currentServing = {
            Charging: null,
            Releasing: null,
            Extraction: null
        };
        queueNumbers = {
            Charging: 0,
            Releasing: 0,
            Extraction: 0
        };
        lastServed = {
            Charging: null,
            Releasing: null,
            Extraction: null
        };
        servedHistory = [];
        totalServed = 0;
        totalWaitTime = 0;
        currentAnnouncement = "";

        fs.unlink(DATA_FILE, (err) => {
            if (err) console.error("Failed to remove saved queue file:", err);
        });

        console.log("Queue has been reset.");
        res.status(200).json({ message: "Queue reset successfully" });
    } catch (error) {
        console.error("Error resetting queue:", error);
        res.status(500).json({ error: "Failed to reset queue" });
    }
});

app.get('/export', (req, res) => {
    const csvData = [];
    for (const service in queues) {
        queues[service].forEach(user => {
            csvData.push({ service, number: user.number });
        });
    }

    if (csvData.length === 0) {
        return res.status(400).send('No data available to export.');
    }

    const parser = new Parser();
    const csv = parser.parse(csvData);

    res.header('Content-Type', 'text/csv');
    res.attachment('queue_data.csv');
    res.send(csv);
});

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
