// JWT Implementation using Web Crypto API
// Supports ES256 (ECDSA with P-256 and SHA-256) and RS256 (RSA with SHA-256)

export type JWTAlgorithm = "ES256" | "RS256";

/**
 * Base64URL encode (RFC 4648)
 */
export function base64URLEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Base64URL decode
 */
export function base64URLDecode(str: string): ArrayBuffer {
  // Add padding if needed
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) {
    str += '=';
  }

  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Sign JWT using ES256 or RS256
 */
export async function signJWT(
  payload: Record<string, any>,
  privateKeyJWK: JsonWebKey,
  kid: string,
  algorithm: JWTAlgorithm = "ES256"
): Promise<string> {
  // Import private key based on algorithm
  let privateKey: CryptoKey;
  let signAlgorithm: any;

  if (algorithm === "ES256") {
    privateKey = await crypto.subtle.importKey(
      "jwk",
      privateKeyJWK,
      {
        name: "ECDSA",
        namedCurve: "P-256"
      },
      false,
      ["sign"]
    );
    signAlgorithm = {
      name: "ECDSA",
      hash: { name: "SHA-256" }
    };
  } else if (algorithm === "RS256") {
    privateKey = await crypto.subtle.importKey(
      "jwk",
      privateKeyJWK,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );
    signAlgorithm = {
      name: "RSASSA-PKCS1-v1_5"
    };
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  // Create header
  const header = {
    alg: algorithm,
    typ: "JWT",
    kid: kid
  };

  // Encode header and payload
  const encodedHeader = base64URLEncode(
    new TextEncoder().encode(JSON.stringify(header))
  );
  const encodedPayload = base64URLEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  );

  // Create signing input
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signingInputBuffer = new TextEncoder().encode(signingInput);

  // Sign
  const signature = await crypto.subtle.sign(
    signAlgorithm,
    privateKey,
    signingInputBuffer
  );

  // Encode signature
  const encodedSignature = base64URLEncode(signature);

  return `${signingInput}.${encodedSignature}`;
}

/**
 * Verify JWT signature using ES256 or RS256
 * If algorithm is not provided, it will be auto-detected from JWT header
 */
export async function verifyJWT(
  token: string,
  publicKeyJWK: JsonWebKey,
  algorithm?: JWTAlgorithm
): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    // Auto-detect algorithm from header if not provided
    if (!algorithm) {
      const header = JSON.parse(
        new TextDecoder().decode(base64URLDecode(encodedHeader))
      );
      algorithm = header.alg as JWTAlgorithm;
    }

    // Import public key based on algorithm
    let publicKey: CryptoKey;
    let verifyAlgorithm: any;

    if (algorithm === "ES256") {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        publicKeyJWK,
        {
          name: "ECDSA",
          namedCurve: "P-256"
        },
        false,
        ["verify"]
      );
      verifyAlgorithm = {
        name: "ECDSA",
        hash: { name: "SHA-256" }
      };
    } else if (algorithm === "RS256") {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        publicKeyJWK,
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: "SHA-256"
        },
        false,
        ["verify"]
      );
      verifyAlgorithm = {
        name: "RSASSA-PKCS1-v1_5"
      };
    } else {
      console.error(`Unsupported algorithm: ${algorithm}`);
      return false;
    }

    // Decode signature
    const signature = base64URLDecode(encodedSignature);

    // Create signing input
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signingInputBuffer = new TextEncoder().encode(signingInput);

    // Verify signature
    return await crypto.subtle.verify(
      verifyAlgorithm,
      publicKey,
      signature,
      signingInputBuffer
    );
  } catch (error) {
    console.error("JWT verification error:", error);
    return false;
  }
}

/**
 * Decode JWT without verification (for inspection)
 */
export function decodeJWT(token: string): {
  header: any;
  payload: any;
  signature: string;
} | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const header = JSON.parse(
      new TextDecoder().decode(base64URLDecode(encodedHeader))
    );
    const payload = JSON.parse(
      new TextDecoder().decode(base64URLDecode(encodedPayload))
    );

    return {
      header,
      payload,
      signature: encodedSignature
    };
  } catch (error) {
    console.error("JWT decode error:", error);
    return null;
  }
}
