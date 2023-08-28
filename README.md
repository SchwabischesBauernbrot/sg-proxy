# SG-proxy
1) Create a SourceGraph account
2) Go to https://sourcegraph.com/, click your profile icon in upper-right, then Settings, then go to Account->Access tokens, and generate a new token
3) Create a `.env` and put your token there
4) `npm install`
5) `node main.js`
6) Change completion to Claude in ST, set any API key, then set the proxy URL as `http://localhost:3000/v1` and set any password.

Enjoy.