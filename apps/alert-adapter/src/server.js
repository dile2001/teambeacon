const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

async function sendToTeams(alert) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;

    if (!webhookUrl) {
        throw new Error('TEAMS_WEBHOOK_URL is not configured');
    }

    const card = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        {
                            type: 'TextBlock',
                            text: `${alert.status.toUpperCase()}: ${alert.labels.alertname}`,
                            weight: 'Bolder',
                            size: 'Large'
                        },
                        {
                            type: 'TextBlock',
                            text: alert.annotations?.summary || 'No summary',
                            wrap: true
                        },
                        {
                            type: 'TextBlock',
                            text: alert.annotations?.description || 'No description',
                            wrap: true
                        },
                        {
                            type: 'TextBlock',
                            text: `Severity: ${alert.labels?.severity || 'unknown'}`,
                            wrap: true
                        }
                    ]
                }
            }
        ]
    };

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(card)
    });
    const responseBody = await response.text();

    console.log(
        JSON.stringify({
            event: 'teams_webhook_response',
            status: response.status,
            statusText: response.statusText,
            body: responseBody
        })
    );
    if (!response.ok) {
        throw new Error(`Teams webhook returned HTTP ${response.status}`);
    }
}
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});


app.post('/alerts', async (req, res) => {
    const payload = req.body;

    try {
        for (const alert of payload.alerts || []) {
            await sendToTeams(alert);
        }

        console.log(
            JSON.stringify({
                timestamp: new Date().toISOString(),
                event: 'teams_notification_sent',
                status: payload.status,
                receiver: payload.receiver,
                alerts: payload.alerts?.length || 0
            })
        );

        res.sendStatus(200);
    } catch (error) {
        console.error('Failed to send Teams notification:', error);
        res.sendStatus(500);
    }
});
app.listen(PORT, () => {
    console.log(`Alert adapter listening on port ${PORT}`);
});