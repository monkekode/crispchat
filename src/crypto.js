/**
 * Constant-time comparison to prevent timing attacks.
 * @param {string} a 
 * @param {string} b 
 * @returns {boolean}
 */
function constantTimeCompare(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verifies the Crisp.chat webhook signature using Web Crypto HMAC-SHA256.
 * @param {string} bodyText - Raw request body text
 * @param {string|null} signature - Hex-encoded signature from X-Crisp-Signature header
 * @param {string|undefined} secret - The configured CRISP_WEBHOOK_SECRET
 * @returns {Promise<boolean>} - True if signature is valid or if secret is not configured
 */
export async function verifySignature(bodyText, signature, secret) {
  // If no secret is configured, signature verification is bypassed.
  if (!secret) return true;
  if (!signature) return false;

  const encoder = new TextEncoder();
  const secretKeyData = encoder.encode(secret);
  const bodyData = encoder.encode(bodyText);

  try {
    // Import the HMAC secret key
    const key = await crypto.subtle.importKey(
      "raw",
      secretKeyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    // Compute the signature
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      bodyData
    );

    // Convert the computed signature to a hex string
    const computedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    return constantTimeCompare(signature.toLowerCase(), computedSignature);
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}
