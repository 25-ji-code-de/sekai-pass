// SPDX-License-Identifier: Apache-2.0

function base64UrlToBuffer(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function credentialDescriptorToNative(descriptor) {
  return {
    ...descriptor,
    id: base64UrlToBuffer(descriptor.id),
  };
}

export function isPasskeySupported() {
  return window.isSecureContext === true &&
    typeof window.PublicKeyCredential === 'function' &&
    !!navigator.credentials;
}

export async function startPasskeyRegistration(optionsJSON) {
  if (!isPasskeySupported()) throw new Error('当前浏览器不支持通行密钥');
  const publicKey = {
    ...optionsJSON,
    challenge: base64UrlToBuffer(optionsJSON.challenge),
    user: {
      ...optionsJSON.user,
      id: base64UrlToBuffer(optionsJSON.user.id),
    },
    excludeCredentials: optionsJSON.excludeCredentials?.map(credentialDescriptorToNative),
  };
  const credential = await navigator.credentials.create({ publicKey });
  if (!credential) throw new Error('通行密钥注册未完成');
  const response = credential.response;
  const registrationResponse = {
    clientDataJSON: bufferToBase64Url(response.clientDataJSON),
    attestationObject: bufferToBase64Url(response.attestationObject),
  };
  if (typeof response.getTransports === 'function') {
    registrationResponse.transports = response.getTransports();
  }
  if (typeof response.getPublicKeyAlgorithm === 'function') {
    registrationResponse.publicKeyAlgorithm = response.getPublicKeyAlgorithm();
  }
  if (typeof response.getPublicKey === 'function') {
    const publicKeyBuffer = response.getPublicKey();
    if (publicKeyBuffer) registrationResponse.publicKey = bufferToBase64Url(publicKeyBuffer);
  }
  if (typeof response.getAuthenticatorData === 'function') {
    registrationResponse.authenticatorData = bufferToBase64Url(response.getAuthenticatorData());
  }
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: registrationResponse,
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
  };
}

export async function startPasskeyAuthentication(optionsJSON) {
  if (!isPasskeySupported()) throw new Error('当前浏览器不支持通行密钥');
  const publicKey = {
    ...optionsJSON,
    challenge: base64UrlToBuffer(optionsJSON.challenge),
    allowCredentials: optionsJSON.allowCredentials?.map(credentialDescriptorToNative),
  };
  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) throw new Error('通行密钥登录未完成');
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : undefined,
    },
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
  };
}
