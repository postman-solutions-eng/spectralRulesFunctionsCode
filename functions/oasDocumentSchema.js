module.exports = function oasDocumentSchema(input, _opts, context) {
  const formats = detectSchema(context && context.document && context.document.data);
  if (!formats) return [];

  const validators = getValidators(); // <-- wire your compiled AJV validators here
  const validator = validators[formats.schema];
  if (typeof validator !== "function") {
    // If no validator is available for the detected schema, return no findings.
    // (You can throw instead if you'd prefer to fail hard.)
    return [];
  }

  // Run AJV validator over the whole document (same as the original code).
  validator(input);
  const ajvErrors = validator.errors || null;

  if (!ajvErrors || ajvErrors.length === 0) return [];

  return ajvErrors.reduce((acc, e) => processError(acc, input, formats.schema, e), []);
};

/* ------------------------------- Helpers ---------------------------------- */

// Replace this with your real validators map (e.g., globalThis.validators or a local require).
function getValidators() {
  // Example:
  // return globalThis.validators || {};
  return {};
}

function detectSchema(doc) {
  if (!doc || typeof doc !== "object") return null;

  // Prefer explicit fields in the document to avoid relying on Spectral format symbols.
  // OAS 2.0 => swagger: "2.0"
  // OAS 3.x => openapi: "3.0.x" or "3.1.x"
  if (typeof doc.swagger === "string" && doc.swagger.trim().startsWith("2.0")) {
    return { schema: "oas2_0" };
  }

  if (typeof doc.openapi === "string") {
    const v = doc.openapi.trim();
    if (v.startsWith("3.1")) return { schema: "oas3_1" };
    if (v.startsWith("3.0")) return { schema: "oas3_0" };
  }

  // Fallback to 3.0 if not clearly specified
  return { schema: "oas3_0" };
}

// AJV ErrorObject .keyword we want to ignore
function isRelevantError(error) {
  return error && error.keyword !== "if";
}

function processError(errors, input, schema, error) {
  if (!isRelevantError(error)) return errors;

  const instancePath = typeof error.instancePath === "string" ? error.instancePath : "";
  const path = instancePath === "" ? [] : instancePath.slice(1).split("/");
  const property = path.length === 0 ? null : path[path.length - 1];

  let message;

  switch (error.keyword) {
    case "additionalProperties": {
      const additionalProperty = error.params && error.params.additionalProperty;
      if (typeof additionalProperty === "string") {
        path.push(additionalProperty);
        message = `Property "${additionalProperty}" is not expected to be here`;
      } else {
        message = cleanAjvMessage(property, error.message);
      }
      break;
    }

    case "enum": {
      const allowedValues = (error.params && error.params.allowedValues) || [];
      const printedValues = allowedValues.map((v) => JSON.stringify(v)).join(", ");

      let suggestion = "";
      const value = resolveInlineRefLocal(input, "#" + instancePath);
      if (typeof value === "string") {
        const bestMatch = findBestMatch(value, allowedValues);
        if (bestMatch !== null) {
          suggestion = `. Did you mean "${bestMatch}"?`;
        }
      }

      message = `${cleanAjvMessage(property, error.message)}: ${printedValues}${suggestion}`;
      break;
    }

    case "errorMessage":
      message = String(error.message || "");
      break;

    default:
      message = cleanAjvMessage(property, error.message);
  }

  errors.push({ message, path });
  return errors;
}

/** Minimal JSON Pointer resolver for inline refs like "#/path/to/node" */
function resolveInlineRefLocal(root, pointer) {
  if (pointer === "#" || pointer === "") return root;
  if (typeof pointer !== "string" || !pointer.startsWith("#/")) return undefined;

  const parts = pointer.slice(2).split("/").map(unescapePointer);
  let cur = root;
  for (const key of parts) {
    if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, key)) {
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;

  function unescapePointer(s) {
    // RFC 6901
    return s.replace(/~1/g, "/").replace(/~0/g, "~");
  }
}

/** Inlined Levenshtein distance + best match logic */
function findBestMatch(value, allowedValues) {
  const candidates = allowedValues
    .filter((v) => typeof v === "string")
    .map((allowedValue) => ({
      value: allowedValue,
      weight: levenshtein(value, allowedValue),
    }))
    .sort((a, b) => a.weight - b.weight);

  if (candidates.length === 0) return null;
  const best = candidates[0];

  // If there's only one allowed value, suggest it; otherwise require distance < length
  return allowedValues.length === 1 || best.weight < best.value.length ? best.value : null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const dp = Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,        // deletion
        dp[j - 1] + 1,    // insertion
        prev + cost       // substitution
      );
      prev = temp;
    }
  }
  return dp[b.length];
}

const QUOTES = /['"]/g;
const NOT = /NOT/g;

function cleanAjvMessage(prop, message) {
  if (typeof message !== "string") return "";
  const cleanedMessage = message.replace(QUOTES, '"').replace(NOT, "not");
  return prop == null ? cleanedMessage : `"${prop}" property ${cleanedMessage}`;
}
