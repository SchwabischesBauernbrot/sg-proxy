require("dotenv").config();

const express = require('express');
const axios = require('axios');
const app = express();
const StringDecoder = require('string_decoder').StringDecoder;

const https = require('https');

// HOW DID YOU EVEN THINK ABOUT CHECKING FOR THIS, SG DEVS??!?! Taking gatekeeping lessons from /aicg/?
// Not that it matters much though.
const agent = new https.Agent({
  ciphers: 'TLS_AES_256_GCM_SHA384'
});

axios.defaults.httpsAgent = agent;

const bodyParser = require('body-parser');
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({limit: '100mb', extended: true}));

const API_TOKEN = process.env.API_TOKEN;

function handleError(res, isStream, errMsg = "\n**Received an error during the request, please check sg-proxy logs!**") {
  // If the request hasn't finished, notify the user that there was an error and finish
  // the request properly, so that ST isn't left hanging.
  let jsonResp = {completion: errMsg, stop_reason: "stop_sequence"};
  if (!res.writableEnded) {
    if (isStream) {
      res.write(`event: completion\r\ndata: ${JSON.stringify(jsonResp)}\r\n\r\n`);
    } else {
      // This is unlikely to trigger, but can happen if the error was caught
      // before the request was sent (without streaming)
      res.json(jsonResp);
    }
    res.end();
  }
}

app.post('/v1/complete', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();
  
  //console.log(req.body);
  // Those are required and must always be present
  const model = req.body.model;
  const maxTokens = req.body.max_tokens_to_sample;
  const prompt = req.body.prompt;

  const temp = req.body.temperature || 1.0;
  const top_p = req.body.top_p || null;
  const top_k = req.body.top_k || null;
  const stopSequences = req.body.stop_sequences || null;
  const isStream = req.body.stream || false;

  console.log(`Doing a request with stream = ${isStream}.`)
  // Set up axios instance for SSE
  const sourcegraph = axios.create({
    baseURL: 'https://sourcegraph.com/.api/completions/stream',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `token ${API_TOKEN}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      'X-Requested-With': 'Sourcegraph',
      'X-Sourcegraph-Client': 'https://sourcegraph.com',
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
    // GPT-4 told me to use a StringDecoder so that multi-byte characters are correctly handled across chunks
    let decoder = new StringDecoder('utf8');
    let buffer = ""; // Buffer to hold incomplete lines

    response.data.on('data', (chunk) => {
      buffer += decoder.write(chunk);
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
              // We can use .length because StringDecoder correctly handles multi-byte characters
              const newPart = parsedData.completion.substring(previousCompletion.length); 
              previousCompletion = parsedData.completion;
              let resp = { completion: newPart, stop_reason: null };
              res.write(`event: completion\r\ndata: ${JSON.stringify(resp)}\r\n\r\n`);
            }
            else {
              fullContent = parsedData.completion;
            }
          }
        } catch (error) {
          console.log("Invalid JSON chunk: ", chunk);
          // do nothing, the JSON chunk is incomplete
      }})
    });

    response.data.on('end', () => {
      // Since the last char will be a newline char and not a multi-byte one, we're sure that
      // the decoder will be empty, so we can just end it.
      decoder.end();
      
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
    if (error.response && error.response.status === 429) {
      console.error("Got a 429 (Too Many Requests), seems like you've hit your ratelimit for the day.");
      handleError(res, isStream, "\n**You've hit your ratelimit for the day, use a different account or wait.**")
    }
    else {
      console.error("Got an error in the main route:\n", error);
      handleError(res, isStream);
    }
  }
});

app.use((err, req, res, next) => {
  console.log("Got an unhandled exception:\n", err);
  handleError(res, req.body && req.body.stream || false);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection:', reason);
});

async function checkToken(token) {
  const data = {
    query: 'query { currentUser { username } }'
  };

  const config = {
    method: 'post',
    url: 'https://sourcegraph.com/.api/graphql',
    headers: { 
      'Authorization': `token ${token}`
    },
    data: data
  };

  try {
    const response = await axios(config);
    if(response.data && response.data.data && response.data.data.currentUser) {
      console.log(`Token works, username: ${response.data.data.currentUser.username}`);
      return true;
    } else {
      return false;
    }
  } catch (error) {
    return false;
  }
}

// Two basic checks
if (!API_TOKEN) {
  console.error("SourceGraph API token not found! Create a file named '.env' and put your token there as an API_TOKEN. See .env.example for an example.");
  process.exit(1);
}
else if (API_TOKEN.indexOf("sgp_") == -1) {
  console.error("Invalid SourceGraph API token! Make sure you copied the whole token starting with sgp_, like 'sgp_blablabla'.");
  process.exit(1);
}

// Check token validity
checkToken(API_TOKEN).then(isValid => {
  if (!isValid) {
    console.error("Invalid SourceGraph API token! Make sure you copied the whole token and that the token is not revoked.");
    process.exit(1);
  }

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server listening on port ${port}`));
});