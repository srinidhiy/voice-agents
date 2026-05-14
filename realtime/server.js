import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'dist')));

app.get('/session', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  }

  try {
    const sessionConfig = JSON.stringify({
      session: {
        type: "realtime",
        model: "gpt-realtime",
        tool_choice: "auto",
        audio: {
          output: {
            voice: "marin",
          },
        },
      },
    });
    
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: sessionConfig,
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/search', async (req, res) => {
  console.log('Searching Google for:', req.query);
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) {
    return res.status(500).json({ error: 'SERPER_API_KEY not set' });
  }

  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter: q' });
  }

  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': serperKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }
    let data = await response.json();
    console.log(JSON.stringify(data));
    res.json(data);
  } catch (err) {
    console.error('Error searching Google:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
