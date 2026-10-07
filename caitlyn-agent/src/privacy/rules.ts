/**
 * CAITLYN privacy detection rules.
 *
 * The rule list follows GemFilter's developer-secret and identifier
 * catalog, then splits each hit the way Prεεmpt does:
 *   format — reversible format-preserving transform
 *   secret — one-way typed placeholder, because a format-preserving
 *            API key would still be a usable credential
 *   metric — noisy number, not reversed
 *
 * KEYPOINT-REVIEW: IPv4, URLs, passport numbers, and bare 16-19 digit
 * strings are omitted. GemFilter ships several of those disabled because
 * they rewrite ordinary code. Credit cards still require a Luhn check.
 */

export type PrivacyClass = "format" | "secret" | "metric";

export interface MetricSpec {
  unit: number;
  min: number;
  max: number;
  epsilon: number;
}

export interface PrivacyRule {
  name: string;
  pattern: RegExp;
  priority: number;
  klass: PrivacyClass;
  /** Capture group that is rewritten. 0 is the whole match. */
  valueGroup: number;
  label?: string;
  domain?: string;
  metric?: MetricSpec;
  accept?: (value: string) => boolean;
}

/**
 * Return true when the digits of a card number satisfy the Luhn check.
 */
export function passesLuhn(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Built-in rules, lowest priority number first.
 */
export function builtinPrivacyRules(): PrivacyRule[] {
  return [
    {
      name: "private_key",
      pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gd,
      priority: 1,
      klass: "secret",
      valueGroup: 0,
      label: "PRIVATE_KEY",
    },
    {
      name: "anthropic_api_key",
      pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/gd,
      priority: 1,
      klass: "secret",
      valueGroup: 0,
      label: "ANTHROPIC_KEY",
    },
    {
      name: "openai_api_key",
      pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gd,
      priority: 1,
      klass: "secret",
      valueGroup: 0,
      label: "OPENAI_KEY",
    },
    {
      name: "github_token",
      pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,255}\b/gd,
      priority: 1,
      klass: "secret",
      valueGroup: 0,
      label: "GITHUB_TOKEN",
    },
    {
      name: "npm_token",
      pattern: /\bnpm_[A-Za-z0-9]{30,}\b/gd,
      priority: 1,
      klass: "secret",
      valueGroup: 0,
      label: "NPM_TOKEN",
    },
    {
      name: "pypi_token",
      pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/gd,
      priority: 1,
      klass: "secret",
      valueGroup: 0,
      label: "PYPI_TOKEN",
    },
    {
      name: "aws_access_key",
      pattern: /\bAKIA[0-9A-Z]{16}\b/gd,
      priority: 1,
      klass: "secret",
      valueGroup: 0,
      label: "AWS_ACCESS_KEY",
    },
    {
      name: "jwt",
      pattern: /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gd,
      priority: 1,
      klass: "secret",
      valueGroup: 0,
      label: "JWT",
    },
    {
      name: "aws_secret_key",
      pattern: /(?:aws[_-]?secret[_-]?access[_-]?key|aws_secret_key)\s*[=:]\s*([A-Za-z0-9/+=]{40})/gid,
      priority: 1,
      klass: "secret",
      valueGroup: 1,
      label: "AWS_SECRET",
    },
    {
      name: "password",
      pattern: /(?:password|passwd|pwd)\s*[=:]\s*([^\s]{4,})/gid,
      priority: 1,
      klass: "secret",
      valueGroup: 1,
      label: "PASSWORD",
    },
    {
      name: "api_key",
      pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*([A-Za-z0-9_-]{20,})/gid,
      priority: 1,
      klass: "secret",
      valueGroup: 1,
      label: "SECRET",
    },
    {
      name: "id_card_cn",
      pattern: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/gd,
      priority: 2,
      klass: "format",
      valueGroup: 0,
      domain: "id-cn",
    },
    {
      name: "database_url",
      pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s<>'"`]+/gd,
      priority: 2,
      klass: "secret",
      valueGroup: 0,
      label: "DATABASE_URL",
    },
    {
      name: "credit_card",
      pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/gd,
      priority: 3,
      klass: "format",
      valueGroup: 0,
      domain: "credit-card",
      accept: passesLuhn,
    },
    {
      name: "ssn_us",
      pattern: /\b\d{3}-\d{2}-\d{4}\b/gd,
      priority: 3,
      klass: "format",
      valueGroup: 0,
      domain: "ssn",
    },
    {
      name: "dotenv_secret",
      pattern: /\b[A-Z0-9_]*(?:SECRET|TOKEN|API[_-]?KEY|PASSWORD|PASS|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*\s*=\s*["']?([^"'\s#]{8,})["']?/gid,
      priority: 5,
      klass: "secret",
      valueGroup: 1,
      label: "SECRET",
    },
    {
      name: "email",
      pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/gd,
      priority: 10,
      klass: "format",
      valueGroup: 0,
      domain: "email",
    },
    {
      name: "phone_cn",
      pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/gd,
      priority: 11,
      klass: "format",
      valueGroup: 0,
      domain: "phone-cn",
    },
    {
      name: "phone_us",
      pattern: /(?<!\d)\+?1?[-.\s]?\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/gd,
      priority: 12,
      klass: "format",
      valueGroup: 0,
      domain: "phone-us",
    },
    {
      name: "age",
      pattern: /(?<![A-Za-z])(?:age|年龄)\s*[:=：]\s*(\d{1,3})(?!\d)/gdiu,
      priority: 20,
      klass: "metric",
      valueGroup: 1,
      metric: { unit: 1, min: 0, max: 120, epsilon: 1 },
    },
    {
      name: "money",
      pattern: /(?<![A-Za-z])(?:salary|income|wage|balance|工资|薪资|余额)\s*[:=：]\s*\$?(\d+(?:\.\d+)?)(?!\d)/gdiu,
      priority: 20,
      klass: "metric",
      valueGroup: 1,
      metric: { unit: 1000, min: 0, max: 1e12, epsilon: 1 },
    },
  ];
}
