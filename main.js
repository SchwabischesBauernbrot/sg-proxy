require("dotenv").config();

const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN;

app.post('/v1/complete', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();
  
  //console.log(req.body);
  const model = req.body.model;
  const temp = req.body.temperature || 1.0;
  const top_p = req.body.top_p || null;
  const top_k = req.body.top_k || null;
  const maxTokens = req.body.max_tokens_to_sample;
  const stopSequences = req.body.stop_sequences || null;
  const isStream = req.body.stream || false;
  const prompt = req.body.prompt;

  console.log(`Doing a request with stream = ${isStream}.`)

  // Set up axios instance for SSE
  const sourcegraph = axios.create({
    baseURL: 'https://sourcegraph.com/.api/completions/stream',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `token ${API_TOKEN}`
    },
    responseType: 'stream',
    timeout: 180000,
  });

  let fullContent = "";

  try {
    let postData = {
      model: model,
      prompt: prompt,
      maxTokensToSample: maxTokens
    };
    
    if (temp) postData.temperature = temp;
    if (stopSequences) postData.stop_sequences = stopSequences;
    if (top_p) postData.top_p = top_p;
    if (top_k) postData.top_k = top_k;
    const response = await sourcegraph.post('', postData);

    let previousCompletion = "";
    let buffer = ""; // Buffer to hold incomplete lines

    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      let lines = buffer.split("\n");
      buffer = lines.pop(); // Keep the last (potentially incomplete) line in the buffer

      const data = lines.filter(line => line.startsWith('data: ')).map(line => line.replace(/^data: /, ''));

      data.forEach((chunk) => {
        try {
          const parsedData = JSON.parse(chunk);
          if ('completion' in parsedData) {
            //console.log(resp);
            if (isStream) {
              // SourceGraph API always returns the full string, but we need the diff
              const newPart = parsedData.completion.replace(previousCompletion, '');
              previousCompletion = parsedData.completion;
              let resp = { completion: newPart, stop_reason: null };
              res.write(`event: completion\r\ndata: ${JSON.stringify(resp)}\r\n\r\n`);
            }
            else {
              fullContent = parsedData.completion;
            }
          }
        } catch (error) {
          // If an error is thrown, the JSON is not valid
          console.error('Invalid JSON:', chunk);
      }})
    });

    response.data.on('end', () => {
      if (isStream) {
        let finalResp = {completion: "", stop_reason: "stop_sequence"};
        res.write(`event: completion\r\ndata: ${JSON.stringify(finalResp)}\r\n\r\n`);
      }
      else {
        res.write(JSON.stringify({completion: fullContent, stop_reason: "stop_sequence"}));
      }
      res.end();
      console.log(`Request done.`)
    });

  } catch (error) {
    console.error("Got an error: ", error);
    res.status(500).send('An error occurred while making the request.');
  }
});

app.use((err, req, res, next) => {
  console.log(err);
  res.status(500).json({"error": true});
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection:', reason);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));