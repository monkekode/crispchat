# Crisp Chatbot AI Integration (Powered by Gemini & Cloudflare Workers)

A self-contained, enterprise-grade chatbot system that automatically replies to user messages on **Crisp.chat** using Google's modern **Gemini 2.5 Flash** model. 

It features an admin dashboard served directly by the Cloudflare Worker under `/admin` protected by HTTP Basic Auth. The dashboard allows dynamically setting your chatbot's grounding rules (stored as system instructions in Cloudflare KV) and controlling the conversational memory length.

---

## 🚀 Key Features

* **Instant Webhook Handler**: High-speed handler acknowledging Crisp webhooks instantly while running generation in the background (`ctx.waitUntil`) to guarantee zero Crisp webhook timeouts.
* **Alternating Conversation Memory**: Smart parser that aggregates consecutive user or operator responses and filters out media, presenting a clean alternating transcript that adheres to Gemini API's strict conversation format.
* **Premium Admin UI**: Translucent glassmorphic control dashboard served directly from the Worker to edit bot guidelines and memory depth on the fly.
* **Timing-Attack Resilient Webhook Verification**: Implements native HMAC-SHA256 signature checks using Web Crypto to safeguard your endpoint.
* **Loop Prevention**: Active sender verification to ignore operators, system updates, and our own chatbot's responses.

---

## 🛠️ Prerequisites & Setup

You will need accounts and credentials for the following platforms:
1. **Google AI Studio**: A Gemini API Key ([Get one here](https://aistudio.google.com/)).
2. **Crisp.chat**:
   * **Website ID**: Found under *Settings > Website Settings > Select Website > Setup Instructions > Website ID*.
   * **API Token Credentials**: Obtain a **Plugin Identifier** and **Plugin Key** by registering a private plugin under *Settings > Developer > Plugins > Add Plugin*. Enable the following permissions for your plugin:
     * `read:website:conversation:messages`
     * `write:website:conversation:messages`
   * **Webhook Secret** (Optional): A custom secret to sign webhook payloads (configured inside your Crisp Developer plugin setup under "Webhooks").
3. **Cloudflare**: A Cloudflare account with a Workers KV namespace.

---

## 📁 Repository Structure

```
├── package.json               # NPM script definitions and Wrangler dev dependencies
├── wrangler.toml              # Worker bindings, namespaces, and variables configuration
└── src/
    ├── index.js               # Router, Webhook handling, and Gemini pipeline
    ├── settings.html          # Premium-styled Glassmorphic Admin HTML template
    └── crypto.js              # Native HMAC-SHA256 signature verification helper
```

---

## 💻 Local Development

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Create a Workers KV Namespace**:
   Run the following wrangler command to create your production KV namespace:
   ```bash
   npx wrangler kv:namespace create CRISP_CHAT_KV
   ```
   *Copy the outputted namespace `id` and paste it inside your `wrangler.toml` file under `[[kv_namespaces]]`.*

3. **Set Up Local Environment File**:
   Create a `.dev.vars` file in the root directory of your project to mock local environment variables and secrets during local development:
   ```env
   ADMIN_USERNAME="admin"
   ADMIN_PASSWORD="ChooseSecureAdminPassword"
   GEMINI_API_KEY="AIzaSyYourGeminiAPIKey..."
   CRISP_WEBSITE_ID="your-crisp-website-uuid"
   CRISP_API_IDENTIFIER="plugin-identifier-uuid"
   CRISP_API_KEY="plugin-secret-key"
   # CRISP_WEBHOOK_SECRET="your_webhook_signing_secret" (optional)
   ```

4. **Launch Local Server**:
   ```bash
   npm run dev
   ```
   Your server will start locally (typically at `http://localhost:8787`). 
   * Navigate to `http://localhost:8787/admin` and log in with your chosen `ADMIN_USERNAME` and `ADMIN_PASSWORD` to configure your bot's system instructions!

---

## 🌐 Production Deployment

1. **Deploy to Cloudflare Workers**:
   ```bash
   npm run deploy
   ```

2. **Register Secrets in Cloudflare**:
   To secure your credentials, upload your keys as Cloudflare Worker Secrets:
   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put CRISP_WEBSITE_ID
   npx wrangler secret put CRISP_API_IDENTIFIER
   npx wrangler secret put CRISP_API_KEY
   npx wrangler secret put CRISP_WEBHOOK_SECRET # (Optional)
   ```

3. **Configure Crisp Webhook**:
   * Go to your **Crisp Plugin settings** (*Developer > Plugins > Select your Plugin > Webhooks*).
   * Set the **Webhook URL** to:
     ```
     https://<your-worker-name>.<your-subdomain>.workers.dev/webhook
     ```
   * Select and subscribe to the event: **`message:send`**.
   * If you configure a signing secret, enter it in both the Crisp dashboard and upload it to your worker secrets as `CRISP_WEBHOOK_SECRET`.

---

## 🔒 Managing Chatbot Instructions & Settings

Once deployed, visit your admin panel at:
```
https://<your-worker-domain>/admin
```
1. Authenticate using your `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Write your chatbot's **grounding rules** and knowledge base under **Gemini Cached System Instructions** (e.g. *"You are a helpful customer support agent for Acme Corp. Here is our FAQ list..."*).
3. Set the **Past Messages Limit** (the size of conversation history to retrieve from Crisp).
4. Save the configuration. Settings are immediately persisted inside your Cloudflare KV namespace and applied to all subsequent incoming webhook inquiries instantly!

---

## 🧑‍💻 Security and Webhook Verification details

If `CRISP_WEBHOOK_SECRET` is set, the worker reads the raw incoming request body and uses the Native Web Crypto API to compute the HMAC-SHA256 signature using the secret key. The result is compared against the `X-Crisp-Signature` header in **constant-time** to mitigate timing attacks, ensuring that only genuine requests originating from Crisp's servers can trigger AI processing.
