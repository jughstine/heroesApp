// Characters allowed in a password: letters, digits, and a fixed set of symbols.
// No whitespace, quotes, backslashes or angle brackets.
const ALLOWED_CHARS = /[^A-Za-z0-9!@#$%^&*()_+\-=\[\]{};:,.?~]/g;

const MIN_LENGTH = 8;
const MAX_LENGTH = 64;

/**
 * Strips any character that isn't allowed. Callers compare the result to
 * the original: if they differ, the password contained invalid characters.
 */
function filterPassword(password) {
  if (typeof password !== "string") return "";
  return password.replace(ALLOWED_CHARS, "");
}

/**
 * @returns {{ isValid: boolean, errors: string[] }}
 */
function validatePasswordStrength(password) {
  const errors = [];

  if (typeof password !== "string" || password.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters`);
  }
  if (typeof password === "string" && password.length > MAX_LENGTH) {
    errors.push(`Password must be at most ${MAX_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(password)) errors.push("Must contain an uppercase letter");
  if (!/[a-z]/.test(password)) errors.push("Must contain a lowercase letter");
  if (!/[0-9]/.test(password)) errors.push("Must contain a number");
  if (!/[!@#$%^&*()_+\-=\[\]{};:,.?~]/.test(password)) {
    errors.push("Must contain a special character");
  }
  if (/(.)\1{3,}/.test(password)) {
    errors.push("Must not repeat the same character 4 or more times in a row");
  }

  return { isValid: errors.length === 0, errors };
}

module.exports = { filterPassword, validatePasswordStrength };
