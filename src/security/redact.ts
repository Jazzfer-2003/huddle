// Layer 3 of the security model: secret redaction.
// Anything written to the bus passes through here first —
// a leaked API key in a shared transcript is a shared API key.

const PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:key]"],
  [/AKIA[A-Z0-9]{16}/g, "[REDACTED:aws]"],
  [/ghp_[A-Za-z0-9]{36,}/g, "[REDACTED:github]"],
  [/gho_[A-Za-z0-9]{36,}/g, "[REDACTED:github]"],
  [/ABSKT[A-Za-z0-9=+/]{40,}/g, "[REDACTED:aws]"],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [REDACTED:token]"],
  [/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
];

// env-style assignments anywhere in text: PASSWORD=..., SECRET=..., TOKEN=..., API_KEY=...
const ENV_LINE = /\b(password|secret|token|api_?key)\b[ \t]*=[ \t]*[^\s,;]+/gi;

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement);
  }
  out = out.replace(ENV_LINE, "[REDACTED:env]");
  return out;
}
