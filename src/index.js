import { verifySignature } from './crypto.js';
import settingsHtml from './settings.html';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Basic Auth Check Helper
    const checkBasicAuth = (req) => {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Basic ")) {
        return false;
      }
      try {
        const credential = atob(authHeader.split(" ")[1]);
        const [username, password] = credential.split(":");
        
        // Retrieve credentials from environment. Fallback to admin/admin if not set.
        const expectedUser = env.ADMIN_USERNAME || "admin";
        const expectedPass = env.ADMIN_PASSWORD || "admin";

        return username === expectedUser && password === expectedPass;
      } catch (err) {
        return false;
      }
    };

    // Unauthorized Response Helper
    const unauthorizedResponse = () => {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Admin Panel", charset="UTF-8"'
        }
      });
    };

    // Route: GET /admin
    if (url.pathname === "/admin" && request.method === "GET") {
      if (!checkBasicAuth(request)) {
        return unauthorizedResponse();
      }

      // Fetch dynamic settings from KV
      let geminiInstructions = "";
      let pastMessagesLimit = 10;
      
      if (env.CRISP_CHAT_KV) {
        geminiInstructions = (await env.CRISP_CHAT_KV.get("GEMINI_INSTRUCTIONS")) || "";
        const savedLimit = await env.CRISP_CHAT_KV.get("PAST_MESSAGES_LIMIT");
        if (savedLimit) pastMessagesLimit = parseInt(savedLimit, 10);
      } else {
        console.warn("CRISP_CHAT_KV namespace is not bound!");
      }

      // Determine env variables status
      const envStatus = {
        geminiKeySet: !!env.GEMINI_API_KEY,
        crispWebsiteIdSet: !!env.CRISP_WEBSITE_ID,
        crispIdentifierSet: !!env.CRISP_API_IDENTIFIER,
        crispKeySet: !!env.CRISP_API_KEY,
        crispWebhookSecretSet: !!env.CRISP_WEBHOOK_SECRET,
        adminAuthSet: !!env.ADMIN_PASSWORD
      };

      // Substitute dynamic settings template tags in settingsHtml
      const html = settingsHtml
        .replace("{{GEMINI_INSTRUCTIONS}}", geminiInstructions || "")
        .replace("{{PAST_MESSAGES_LIMIT}}", String(pastMessagesLimit))
        .replace("{{ENV_STATUS}}", JSON.stringify(envStatus));

      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // Route: GET /api/settings
    if (url.pathname === "/api/settings" && request.method === "GET") {
      if (!checkBasicAuth(request)) {
        return unauthorizedResponse();
      }

      let geminiInstructions = "";
      let pastMessagesLimit = 10;

      if (env.CRISP_CHAT_KV) {
        geminiInstructions = (await env.CRISP_CHAT_KV.get("GEMINI_INSTRUCTIONS")) || "";
        const savedLimit = await env.CRISP_CHAT_KV.get("PAST_MESSAGES_LIMIT");
        if (savedLimit) pastMessagesLimit = parseInt(savedLimit, 10);
      }

      return new Response(JSON.stringify({ geminiInstructions, pastMessagesLimit }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Route: POST /api/settings
    if (url.pathname === "/api/settings" && request.method === "POST") {
      if (!checkBasicAuth(request)) {
        return unauthorizedResponse();
      }

      if (!env.CRISP_CHAT_KV) {
        return new Response("KV namespace not bound", { status: 500 });
      }

      try {
        const body = await request.json();
        const { geminiInstructions, pastMessagesLimit } = body;

        await env.CRISP_CHAT_KV.put("GEMINI_INSTRUCTIONS", geminiInstructions || "");
        await env.CRISP_CHAT_KV.put("PAST_MESSAGES_LIMIT", String(pastMessagesLimit || 10));

        // Invalidate Google context cache on instruction update
        await env.CRISP_CHAT_KV.delete("GEMINI_CACHE_NAME");
        await env.CRISP_CHAT_KV.delete("GEMINI_CACHE_EXPIRE");

        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response("Invalid request data: " + err.message, { status: 400 });
      }
    }

    // Route: POST /webhook (Crisp webhook)
    if (url.pathname === "/webhook" && request.method === "POST") {
      const rawBody = await request.text();
      const signature = request.headers.get("X-Crisp-Signature");

      // Verify Crisp signature if secret is configured
      const isVerified = await verifySignature(rawBody, signature, env.CRISP_WEBHOOK_SECRET);
      if (!isVerified) {
        console.error("Signature verification failed!");
        return new Response("Invalid Webhook Signature", { status: 401 });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        return new Response("Malformed JSON payload", { status: 400 });
      }

      // Check if event is message:send
      if (payload.event !== "message:send") {
        console.log(`Ignoring event type: ${payload.event}`);
        return new Response(`Acknowledged event: ${payload.event}`, { status: 200 });
      }

      const messageData = payload.data;
      if (!messageData) {
        return new Response("No data inside payload", { status: 400 });
      }

      const websiteId = messageData.website_id;
      const sessionId = messageData.session_id;

      // Loop prevention: Only respond to messages sent by the client.
      // Ignore operator, website, or system messages.
      if (messageData.from !== "client") {
        console.log(`Ignoring loop-prevention message from: ${messageData.from}`);
        return new Response("Ignoring message not sent by client", { status: 200 });
      }

      // Ensure API keys are present
      if (!env.GEMINI_API_KEY) {
        console.error("Missing GEMINI_API_KEY environment variable!");
        return new Response("Bot configuration error", { status: 500 });
      }
      if (!env.CRISP_API_IDENTIFIER || !env.CRISP_API_KEY || !env.CRISP_WEBSITE_ID) {
        console.error("Missing Crisp API integration variables!");
        return new Response("Bot configuration error", { status: 500 });
      }

      // Start asynchronous reply generation to complete the webhook response quickly (Cloudflare Worker holds context until microtask completes)
      ctx.waitUntil((async () => {
        try {
          console.log(`Processing Crisp webhook for website: ${websiteId}, session: ${sessionId}`);

          // Fetch dynamic configuration
          let geminiInstructions = "";
          let pastMessagesLimit = 10;
          let cacheName = null;
          let cacheExpire = null;

          if (env.CRISP_CHAT_KV) {
            geminiInstructions = (await env.CRISP_CHAT_KV.get("GEMINI_INSTRUCTIONS")) || "";
            const savedLimit = await env.CRISP_CHAT_KV.get("PAST_MESSAGES_LIMIT");
            if (savedLimit) pastMessagesLimit = parseInt(savedLimit, 10);
            
            // Read context caching variables
            cacheName = await env.CRISP_CHAT_KV.get("GEMINI_CACHE_NAME");
            cacheExpire = await env.CRISP_CHAT_KV.get("GEMINI_CACHE_EXPIRE");
          }

          // Evaluate if we can use an existing Google context cache
          let useGoogleCache = false;
          const nowIso = new Date().toISOString();
          
          if (cacheName && cacheExpire && cacheExpire > nowIso) {
            useGoogleCache = true;
            console.log(`Using active Google context cache: ${cacheName}`);
          } else if (geminiInstructions && geminiInstructions.trim() !== "") {
            // Attempt to create a new Google-side Context Cache
            console.log("No valid cache found. Requesting new Google-side context cache creation...");
            try {
              const createCacheUrl = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${env.GEMINI_API_KEY}`;
              const cacheResponse = await fetch(createCacheUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "models/gemini-2.5-flash",
                  displayName: "crisp_chatbot_instructions",
                  systemInstruction: {
                    parts: [{ text: geminiInstructions }]
                  },
                  ttl: "1800s" // 30 minutes
                })
              });

              if (cacheResponse.ok) {
                const cacheData = await cacheResponse.json();
                cacheName = cacheData.name;
                cacheExpire = cacheData.expireTime;

                if (env.CRISP_CHAT_KV) {
                  await env.CRISP_CHAT_KV.put("GEMINI_CACHE_NAME", cacheName);
                  await env.CRISP_CHAT_KV.put("GEMINI_CACHE_EXPIRE", cacheExpire);
                }
                useGoogleCache = true;
                console.log(`Google Context Cache created: ${cacheName} (expires: ${cacheExpire})`);
              } else {
                const cacheErrText = await cacheResponse.text();
                console.warn(`Could not create Google cache (likely size is under 32k token threshold): ${cacheResponse.status} ${cacheErrText}`);
                console.log("Gracefully falling back to in-line instructions on every request.");
              }
            } catch (cacheErr) {
              console.error("Error attempting to construct Google context cache:", cacheErr.message);
            }
          }

          // Fetch conversation history from Crisp
          const crispAuth = btoa(`${env.CRISP_API_IDENTIFIER}:${env.CRISP_API_KEY}`);
          const historyUrl = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/messages`;
          
          console.log(`Fetching history from Crisp API: ${historyUrl}`);
          const historyResponse = await fetch(historyUrl, {
            method: "GET",
            headers: {
              "Authorization": `Basic ${crispAuth}`,
              "X-Crisp-Tier": "plugin",
              "Accept": "application/json"
            }
          });

          if (!historyResponse.ok) {
            const errText = await historyResponse.text();
            throw new Error(`Failed to fetch Crisp history: ${historyResponse.status} ${errText}`);
          }

          const historyData = await historyResponse.json();
          let messages = historyData.data || [];

          // Sort chronologically (oldest first)
          messages.sort((a, b) => a.timestamp - b.timestamp);

          // Keep only the last N messages
          if (messages.length > pastMessagesLimit) {
            messages = messages.slice(-pastMessagesLimit);
          }

          // Format Crisp messages to match Gemini conversation format
          const formattedContents = [];
          for (const msg of messages) {
            if (msg.type !== "text") continue; // Skip files, images, etc. for now

            const role = msg.from === "client" ? "user" : "model";
            const text = msg.content;

            if (formattedContents.length > 0 && formattedContents[formattedContents.length - 1].role === role) {
              // Merge consecutive messages from same role to satisfy Gemini's alternating roles requirement
              formattedContents[formattedContents.length - 1].parts[0].text += "\n" + text;
            } else {
              formattedContents.push({
                role: role,
                parts: [{ text: text }]
              });
            }
          }

          // Ensure conversation starts with 'user'
          while (formattedContents.length > 0 && formattedContents[0].role !== "user") {
            formattedContents.shift();
          }

          if (formattedContents.length === 0) {
            console.log("No text messages in history to answer.");
            return;
          }

          // Call Gemini API (gemini-2.5-flash)
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
          
          const geminiPayload = {
            contents: formattedContents
          };

          if (useGoogleCache && cacheName) {
            geminiPayload.cachedContent = cacheName;
          } else if (geminiInstructions && geminiInstructions.trim() !== "") {
            geminiPayload.systemInstruction = {
              parts: [{ text: geminiInstructions }]
            };
          }

          console.log(`Sending context to Gemini API (messages count: ${formattedContents.length}, cache active: ${useGoogleCache})...`);
          const geminiResponse = await fetch(geminiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(geminiPayload)
          });

          if (!geminiResponse.ok) {
            const errText = await geminiResponse.text();
            throw new Error(`Gemini API Error: ${geminiResponse.status} ${errText}`);
          }

          const geminiData = await geminiResponse.json();
          const replyText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

          if (!replyText || replyText.trim() === "") {
            console.warn("Gemini did not return any reply text.");
            return;
          }

          console.log(`Generated reply: "${replyText.substring(0, 50)}..."`);

          // Send reply back to Crisp
          const replyUrl = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/message`;
          console.log(`Posting reply back to Crisp: ${replyUrl}`);
          const replyResponse = await fetch(replyUrl, {
            method: "POST",
            headers: {
              "Authorization": `Basic ${crispAuth}`,
              "X-Crisp-Tier": "plugin",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              type: "text",
              from: "operator",
              origin: "chat",
              content: replyText
            })
          });

          if (!replyResponse.ok) {
            const errText = await replyResponse.text();
            throw new Error(`Failed to send message to Crisp: ${replyResponse.status} ${errText}`);
          }

          console.log("Auto-reply successfully posted to Crisp!");

        } catch (error) {
          console.error("Async webhook task error:", error.message, error.stack);
        }
      })());

      // Instantly acknowledge the Crisp webhook to avoid timeouts
      return new Response("Webhook received, processing auto-reply...", { status: 200 });
    }

    // Default route
    return new Response("Not Found", { status: 404 });
  }
};
