const express = require("express");
const router = express.Router();
const { getPool } = require("../config/database");

// ============================================================
// CONSTANTS
// ============================================================

const FORM_TYPE_IDS = { DLB: 1, RSM: 2, RST: 3, TOP: 4, UPD: 5 };

const FORM_PREFIXES = { 1: "DLB", 2: "RSM", 3: "RST", 4: "TOP", 5: "UPD" };

const DLB_TABLE_ALLOWLIST = new Set([
  "dlb_spouse_requirements",
  "dlb_child_requirements",
  "dlb_sibling_requirements",
  "dlb_parent_requirements",
]);

const RST_TABLE_ALLOWLIST = new Set([
  "rst_widow_requirements",
  "rst_bi_principal_requirements",
  "rst_bi_bene_requirements",
  "rst_re_entitle_requirements",
  "rst_principal_requirements",
]);

/** Throws if name is not in the provided Set — never interpolate without this. */
function safeTable(name, allowlist) {
  if (!allowlist.has(name)) {
    throw Object.assign(new Error(`Invalid table name: ${name}`), {
      code: "INVALID_TABLE",
      statusCode: 400,
    });
  }
  return name;
}

// DLB applicant-type → requirements table (validated via DLB_TABLE_ALLOWLIST before use)
const DLB_TABLE_MAP = {
  spouse: "dlb_spouse_requirements",
  child: "dlb_child_requirements",
  sibling: "dlb_sibling_requirements",
  parent: "dlb_parent_requirements",
};

// ============================================================
// HELPERS
// ============================================================

function parseCoordinates(longitude, latitude) {
  let lon = null;
  let lat = null;

  if (longitude != null && longitude !== "") {
    lon = Number(longitude);
    if (isNaN(lon))
      return {
        ok: false,
        error: "Invalid longitude value",
        code: "INVALID_LONGITUDE",
      };
    if (lon < -180 || lon > 180)
      return {
        ok: false,
        error: "Invalid longitude value. Must be between -180 and 180",
        code: "LONGITUDE_OUT_OF_RANGE",
      };
  }

  if (latitude != null && latitude !== "") {
    lat = Number(latitude);
    if (isNaN(lat))
      return {
        ok: false,
        error: "Invalid latitude value",
        code: "INVALID_LATITUDE",
      };
    if (lat < -90 || lat > 90)
      return {
        ok: false,
        error: "Invalid latitude value. Must be between -90 and 90",
        code: "LATITUDE_OUT_OF_RANGE",
      };
  }

  return { ok: true, lon, lat };
}

/**
 * Returns the integer or null.
 */
function parseId(param) {
  const n = parseInt(param, 10);
  return !param || isNaN(n) || n < 1 ? null : n;
}

/** Generates a form reference string from a type and the new submission ID. */
function generateFormReference(formTypeId, formId) {
  const prefix = FORM_PREFIXES[formTypeId] || "FRM";
  return `${prefix}-${new Date().getFullYear()}-${String(formId).padStart(6, "0")}`;
}

const requireDatabase = async (req, res, next) => {
  try {
    const pool = getPool();
    const conn = await pool.getConnection();
    conn.release();
    next();
  } catch {
    res.status(503).json({
      success: false,
      error:
        "Database service temporarily unavailable. Please try again later.",
      code: "DB_UNAVAILABLE",
    });
  }
};

function handleSubmissionError(res, error, startTime, formName = "Form") {
  const pt = `${Date.now() - startTime}ms`;
  console.error(`❌ Error submitting ${formName}:`, error.message);
  console.error("❌ Stack:", error.stack);

  if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
    return res.status(503).json({
      success: false,
      error: "Database connection failed. Please try again later.",
      code: "DB_CONNECTION_ERROR",
      processingTime: pt,
    });
  }
  if (error.code === "ER_ACCESS_DENIED_ERROR") {
    return res.status(503).json({
      success: false,
      error: "Database access denied. Please contact system administrator.",
      code: "DB_ACCESS_ERROR",
      processingTime: pt,
    });
  }
  if (error.code === "ER_NO_SUCH_TABLE") {
    return res.status(500).json({
      success: false,
      error:
        "Database table configuration error. Please contact system administrator.",
      code: "TABLE_NOT_FOUND",
      processingTime: pt,
    });
  }
  if (error.code === "INVALID_TABLE") {
    return res.status(400).json({
      success: false,
      error: error.message,
      code: "INVALID_TABLE",
      processingTime: pt,
    });
  }
  return res.status(500).json({
    success: false,
    error: `${formName} submission failed due to a server error.`,
    code: "SERVER_ERROR",
    processingTime: pt,
  });
}

function makeSubmitHandler(config) {
  return async (req, res) => {
    const startTime = Date.now();
    const pool = getPool();
    let conn = null;

    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      const { user_id, longitude, latitude, requirements, location_metadata } =
        req.body;

      // Basic field validation
      if (!user_id || !requirements || !Array.isArray(requirements)) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          error: "Missing required fields: user_id and requirements array",
          code: "MISSING_FIELDS",
          processingTime: `${Date.now() - startTime}ms`,
        });
      }

      const coords = parseCoordinates(longitude, latitude);
      if (!coords.ok) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          error: coords.error,
          code: coords.code,
          processingTime: `${Date.now() - startTime}ms`,
        });
      }

      // Determine location status
      let locationStatus;
      if (config.locationMode === "fixed_loc") locationStatus = "loc";
      else if (config.locationMode === "fixed_abr") locationStatus = "abr";
      else if (config.locationMode === "abroad_flag")
        locationStatus = req.body.abroad_status ? "abr" : "loc";
      else {
        // "param" — validate applies_to_location
        const atl = req.body.applies_to_location;
        if (!atl || !["loc", "abr", "both"].includes(atl)) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            error:
              'Invalid applies_to_location. Must be "loc", "abr", or "both"',
            code: "INVALID_LOCATION",
            processingTime: `${Date.now() - startTime}ms`,
          });
        }
        locationStatus = atl;
      }

      // Route-specific body validation
      if (config.validateBody) {
        const validationError = await config.validateBody(req.body, conn);
        if (validationError) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            ...validationError,
            processingTime: `${Date.now() - startTime}ms`,
          });
        }
      }

      const [result] = await conn.execute(
        "INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, location, status, submitted_at) VALUES (?,?,?,?,?,?,NOW())",
        [
          user_id,
          config.formTypeId,
          coords.lon,
          coords.lat,
          locationStatus,
          "p",
        ],
      );
      const formSubmissionId = result.insertId;
      const formReference = generateFormReference(
        config.formTypeId,
        formSubmissionId,
      );
      await conn.execute(
        "UPDATE form_submission SET form_reference=? WHERE id=?",
        [formReference, formSubmissionId],
      );

      // Get the requirements table (may be dynamic, e.g. DLB applicant type)
      const requirementsTable = await config.getRequirementsTable(req.body);

      // Insert each requirement row
      for (const req_row of requirements) {
        if (!req_row.requirement_type)
          throw new Error("requirement_type is required for all requirements");
        await config.insertRequirement(
          conn,
          req_row,
          formSubmissionId,
          req.body,
          requirementsTable,
          locationStatus,
        );
      }

      await conn.commit();

      const base = {
        form_id: formSubmissionId,
        form_reference: formReference,
        form_type_id: config.formTypeId,
        form_type: config.formType,
        location_status: locationStatus,
        location: {
          longitude: coords.lon,
          latitude: coords.lat,
          accuracy: location_metadata?.accuracy,
          timestamp: location_metadata?.timestamp,
          was_recorded: coords.lon !== null && coords.lat !== null,
        },
      };

      return res.json({
        success: true,
        message: `${config.formName} submitted successfully`,
        data: {
          ...base,
          ...(config.buildResponseData
            ? config.buildResponseData(req.body)
            : {}),
        },
        meta: {
          processingTime: `${Date.now() - startTime}ms`,
          submissionTime: new Date().toISOString(),
        },
      });
    } catch (error) {
      if (conn) {
        try {
          await conn.rollback();
        } catch {}
      }
      return handleSubmissionError(res, error, startTime, config.formName);
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch {}
      }
    }
  };
}
let formTypeCache = null;

// ============================================================
// HEALTH + TYPES
// ============================================================

router.get("/health", async (req, res) => {
  const t = Date.now();
  try {
    const pool = getPool();
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    res.json({
      success: true,
      status: "healthy",
      services: { database: "healthy", forms: "operational" },
      meta: {
        processingTime: `${Date.now() - t}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch {
    res.status(500).json({
      success: false,
      status: "unhealthy",
      error: "Health check failed",
      meta: {
        processingTime: `${Date.now() - t}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  }
});

router.get("/types", async (req, res) => {
  const t = Date.now();
  try {
    if (!formTypeCache) {
      const pool = getPool();
      const [rows] = await pool.execute("SELECT * FROM form_type");
      formTypeCache = rows;
    }
    res.json({
      success: true,
      data: formTypeCache,
      meta: { processingTime: `${Date.now() - t}ms` },
    });
  } catch (error) {
    console.error("Error fetching form types:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch form types",
      code: "SERVER_ERROR",
    });
  }
});

// ============================================================
// SUBMISSION ROUTES — all via makeSubmitHandler()
// ============================================================

// ── UPD: Updating ──────────────────────────────────────────
router.post(
  "/submit",
  requireDatabase,
  makeSubmitHandler({
    formTypeId: FORM_TYPE_IDS.UPD,
    formName: "Updating form",
    formType: "updating",
    locationMode: "abroad_flag",

    getRequirementsTable: async () => "upd_requirements",

    insertRequirement: async (
      conn,
      row,
      formId,
      body,
      table,
      locationStatus,
    ) => {
      const { requirement_type, value, file_url, file_key, file_type } = row;
      let applies_to_location = "both";
      if (
        ["passport", "oath_of_allegiance", "cert_of_naturalization"].includes(
          requirement_type,
        )
      ) {
        applies_to_location = "abr";
      } else if (["unified_id", "photo_2x2"].includes(requirement_type)) {
        applies_to_location = body.abroad_status ? "abr" : "loc";
      }
      await conn.execute(
        "INSERT INTO upd_requirements (form_id,requirement_type,value,file_url,file_key,file_type,applies_to_location) VALUES (?,?,?,?,?,?,?)",
        [
          formId,
          requirement_type,
          value || null,
          file_url || null,
          file_key || null,
          file_type || null,
          applies_to_location,
        ],
      );
    },

    buildResponseData: (body) => ({ abroad_status: body.abroad_status }),
  }),
);

// ── TOP: Transfer of Pension ────────────────────────────────
router.post(
  "/transfer-of-pension/submit",
  requireDatabase,
  makeSubmitHandler({
    formTypeId: FORM_TYPE_IDS.TOP,
    formName: "Transfer of pension form",
    formType: "transfer_of_pension",
    locationMode: "fixed_loc",

    getRequirementsTable: async () => "top_requirements",

    insertRequirement: async (conn, row, formId) => {
      const { requirement_type, value, file_url, file_key, file_type } = row;
      await conn.execute(
        "INSERT INTO top_requirements (form_id,requirement_type,value,file_url,file_key,file_type) VALUES (?,?,?,?,?,?)",
        [
          formId,
          requirement_type,
          value || null,
          file_url || null,
          file_key || null,
          file_type || null,
        ],
      );
    },
  }),
);

// ── RSM: Resumption ─────────────────────────────────────────
router.post(
  "/submit-resumption",
  requireDatabase,
  makeSubmitHandler({
    formTypeId: FORM_TYPE_IDS.RSM,
    formName: "Resumption form",
    formType: "resumption",
    locationMode: "fixed_loc",

    getRequirementsTable: async () => "rsm_requirements",

    insertRequirement: async (conn, row, formId) => {
      const { requirement_type, value, file_url, file_key, file_type } = row;
      await conn.execute(
        "INSERT INTO rsm_requirements (form_id,requirement_type,value,file_url,file_key,file_type) VALUES (?,?,?,?,?,?)",
        [
          formId,
          requirement_type,
          value || null,
          file_url || null,
          file_key || null,
          file_type || null,
        ],
      );
    },

    buildResponseData: (body) => ({
      late_filing_status: body.late_filing_status || false,
    }),
  }),
);

// ── Shared RST insert helper ─────────────────────────────────
const makeRstInsert =
  (table) => async (conn, row, formId, body, _table, locationStatus) => {
    const { requirement_type, value, file_url, file_key, file_type } = row;
    await conn.execute(
      `INSERT INTO ${table} (form_id,requirement_type,value,file_url,file_key,file_type,applies_to_location) VALUES (?,?,?,?,?,?,?)`,
      [
        formId,
        requirement_type,
        value || null,
        file_url || null,
        file_key || null,
        file_type || null,
        body.applies_to_location,
      ],
    );
  };

// ── RST: Widow Restoration ───────────────────────────────────
const WIDOW_REQUIRED = [
  "video_submission",
  "home_address",
  "mobile_number",
  "puf",
  "jago_declaration",
  "afp_id",
  "pension_acc",
];
const WIDOW_VALID = [...WIDOW_REQUIRED, "psa_crs5", "affidavit_late_filing"];

router.post(
  "/widow-restoration/submit",
  requireDatabase,
  makeSubmitHandler({
    formTypeId: FORM_TYPE_IDS.RST,
    formName: "Widow restoration form",
    formType: "widow_restoration",
    locationMode: "param",

    validateBody: (body) => {
      const provided = body.requirements.map((r) => r.requirement_type);
      const missing = WIDOW_REQUIRED.filter((t) => !provided.includes(t));
      if (missing.length)
        return {
          error: `Missing required documents: ${missing.join(", ")}`,
          code: "MISSING_REQUIREMENTS",
        };
      const invalid = body.requirements.find(
        (r) => !WIDOW_VALID.includes(r.requirement_type),
      );
      if (invalid)
        return {
          error: `Invalid requirement_type: ${invalid.requirement_type}`,
          code: "INVALID_REQUIREMENT_TYPE",
        };
      return null;
    },

    getRequirementsTable: async () => "rst_widow_requirements",
    insertRequirement: makeRstInsert("rst_widow_requirements"),
    buildResponseData: (body) => ({
      video_metadata: body.video_metadata || null,
    }),
  }),
);

// ── RST: Principal Restoration ──────────────────────────────
const PRINCIPAL_REQUIRED = [
  "video_submission",
  "home_address",
  "mobile_number",
  "puf",
  "afp_id",
  "pension_acc",
];
const PRINCIPAL_VALID = [...PRINCIPAL_REQUIRED, "affidavit_late_filing"];

router.post(
  "/principal-restoration/submit",
  requireDatabase,
  makeSubmitHandler({
    formTypeId: FORM_TYPE_IDS.RST,
    formName: "Principal restoration form",
    formType: "principal_restoration",
    locationMode: "param",

    validateBody: (body) => {
      const provided = body.requirements.map((r) => r.requirement_type);
      const missing = PRINCIPAL_REQUIRED.filter((t) => !provided.includes(t));
      if (missing.length)
        return {
          error: `Missing required documents: ${missing.join(", ")}`,
          code: "MISSING_REQUIREMENTS",
        };
      const invalid = body.requirements.find(
        (r) => !PRINCIPAL_VALID.includes(r.requirement_type),
      );
      if (invalid)
        return {
          error: `Invalid requirement_type: ${invalid.requirement_type}`,
          code: "INVALID_REQUIREMENT_TYPE",
        };
      return null;
    },

    getRequirementsTable: async () => "rst_principal_requirements",
    insertRequirement: makeRstInsert("rst_principal_requirements"),
    buildResponseData: (body) => ({
      video_metadata: body.video_metadata || null,
    }),
  }),
);

// ── RST: Bi-Principal Restoration ──────────────────────────
const BIPRINCIPAL_REQUIRED = [
  "video_submission",
  "home_address",
  "mobile_number",
  "puf",
  "affidavit_late_filing",
  "birth_cert",
  "brgy_clear",
  "police_clear",
  "nbi_clear",
  "afp_id",
  "pen_account",
];
const BIPRINCIPAL_VALID = BIPRINCIPAL_REQUIRED;

router.post(
  "/biprincipal-restoration/submit",
  requireDatabase,
  makeSubmitHandler({
    formTypeId: FORM_TYPE_IDS.RST,
    formName: "Bi-principal restoration form",
    formType: "biprincipal_restoration",
    locationMode: "param",

    validateBody: (body) => {
      const provided = body.requirements.map((r) => r.requirement_type);
      const missing = BIPRINCIPAL_REQUIRED.filter((t) => !provided.includes(t));
      if (missing.length)
        return {
          error: `Missing required documents: ${missing.join(", ")}`,
          code: "MISSING_REQUIREMENTS",
        };
      const invalid = body.requirements.find(
        (r) => !BIPRINCIPAL_VALID.includes(r.requirement_type),
      );
      if (invalid)
        return {
          error: `Invalid requirement_type: ${invalid.requirement_type}`,
          code: "INVALID_REQUIREMENT_TYPE",
        };
      return null;
    },

    getRequirementsTable: async () => "rst_bi_principal_requirements",
    insertRequirement: makeRstInsert("rst_bi_principal_requirements"),
    buildResponseData: (body) => ({
      video_metadata: body.video_metadata || null,
    }),
  }),
);

// ── RST: Re-entitlement Restoration ────────────────────────
const REENTITLE_REQUIRED = [
  "video_submission",
  "home_address",
  "mobile_number",
  "cert_of_naturalization",
  "oath_of_allegiance",
  "order_approval",
  "identif_cert",
  "afp_id",
  "atm_account",
  "puf",
  "affidavit_late_filing",
];
const REENTITLE_VALID = REENTITLE_REQUIRED;

router.post(
  "/reentitlement-restoration/submit",
  requireDatabase,
  makeSubmitHandler({
    formTypeId: FORM_TYPE_IDS.RST,
    formName: "Re-entitlement restoration form",
    formType: "reentitlement_restoration",
    locationMode: "param",

    validateBody: (body) => {
      const provided = body.requirements.map((r) => r.requirement_type);
      const missing = REENTITLE_REQUIRED.filter((t) => !provided.includes(t));
      if (missing.length)
        return {
          error: `Missing required documents: ${missing.join(", ")}`,
          code: "MISSING_REQUIREMENTS",
        };
      const invalid = body.requirements.find(
        (r) => !REENTITLE_VALID.includes(r.requirement_type),
      );
      if (invalid)
        return {
          error: `Invalid requirement_type: ${invalid.requirement_type}`,
          code: "INVALID_REQUIREMENT_TYPE",
        };
      return null;
    },

    getRequirementsTable: async () => "rst_re_entitle_requirements",
    insertRequirement: makeRstInsert("rst_re_entitle_requirements"),
    buildResponseData: (body) => ({
      video_metadata: body.video_metadata || null,
    }),
  }),
);

// ── RST: Bi-Beneficiary Restoration ────────────────────────
const BIBENE_REQUIRED = [
  "video_submission",
  "home_address",
  "mobile_number",
  "puf",
  "affidavit_late_filing",
  "birth_cert",
  "psa_crs5_h",
  "psa_crs5_w",
  "brgy_clear",
  "police_clear",
  "nbi_clear",
  "jago_declaration",
  "atm_account",
  "afp_id",
  "valid_id_1",
  "valid_id_2",
];
const BIBENE_VALID = BIBENE_REQUIRED;

router.post(
  "/bibeneficiary-restoration/submit",
  requireDatabase,
  makeSubmitHandler({
    formTypeId: FORM_TYPE_IDS.RST,
    formName: "Bi-beneficiary restoration form",
    formType: "bibeneficiary_restoration",
    locationMode: "param",

    validateBody: (body) => {
      const provided = body.requirements.map((r) => r.requirement_type);
      const missing = BIBENE_REQUIRED.filter((t) => !provided.includes(t));
      if (missing.length)
        return {
          error: `Missing required documents: ${missing.join(", ")}`,
          code: "MISSING_REQUIREMENTS",
        };
      const invalid = body.requirements.find(
        (r) => !BIBENE_VALID.includes(r.requirement_type),
      );
      if (invalid)
        return {
          error: `Invalid requirement_type: ${invalid.requirement_type}`,
          code: "INVALID_REQUIREMENT_TYPE",
        };
      return null;
    },

    getRequirementsTable: async () => "rst_bi_bene_requirements",
    insertRequirement: makeRstInsert("rst_bi_bene_requirements"),
    buildResponseData: (body) => ({
      video_metadata: body.video_metadata || null,
    }),
  }),
);

// ── DLB: Legal Beneficiary ──────────────────────────────────
router.post(
  "/legal-beneficiary/submit",
  requireDatabase,
  makeSubmitHandler({
    formTypeId: FORM_TYPE_IDS.DLB,
    formName: "Legal Beneficiary form",
    formType: "legal_beneficiary",
    locationMode: "fixed_loc",

    validateBody: (body) => {
      const applicantTypeReq = body.requirements?.find(
        (r) => r.requirement_type === "applicant_type",
      );
      if (!applicantTypeReq?.value)
        return {
          error: "Missing required field: applicant_type",
          code: "MISSING_APPLICANT_TYPE",
        };
      if (
        !["spouse", "child", "sibling", "parent"].includes(
          applicantTypeReq.value,
        )
      ) {
        return {
          error:
            "Invalid applicant_type. Must be one of: spouse, child, sibling, parent",
          code: "INVALID_APPLICANT_TYPE",
        };
      }
      return null;
    },

    getRequirementsTable: async (body) => {
      const applicantType = body.requirements.find(
        (r) => r.requirement_type === "applicant_type",
      )?.value;
      const tableName = DLB_TABLE_MAP[applicantType];
      return safeTable(tableName, DLB_TABLE_ALLOWLIST);
    },

    insertRequirement: async (conn, row, formId, body, table) => {
      // Skip the applicant_type meta-row
      if (row.requirement_type === "applicant_type") return;
      const { requirement_type, value, file_url, file_key, file_type } = row;
      await conn.execute(
        `INSERT INTO ${table} (form_id,requirement_type,value,file_url,file_key,file_type) VALUES (?,?,?,?,?,?)`,
        [
          formId,
          requirement_type,
          value || null,
          file_url || null,
          file_key || null,
          file_type || null,
        ],
      );
    },

    buildResponseData: (body) => {
      const applicantType = body.requirements?.find(
        (r) => r.requirement_type === "applicant_type",
      )?.value;
      return { requirements_table: DLB_TABLE_MAP[applicantType] };
    },
  }),
);

// ============================================================
// GET ROUTES — read-only, use pool.execute() directly
// ============================================================

router.get("/user/:user_id", async (req, res) => {
  const t = Date.now();
  const userId = parseId(req.params.user_id);
  if (!userId)
    return res
      .status(400)
      .json({ success: false, error: "Invalid user ID", code: "INVALID_ID" });

  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      "SELECT fs.*, ft.name AS form_type_name, fs.location AS location_status FROM form_submission fs JOIN form_type ft ON fs.form_type_id=ft.id WHERE fs.user_id=? ORDER BY fs.submitted_at DESC",
      [userId],
    );
    res.json({
      success: true,
      data: rows,
      meta: { processingTime: `${Date.now() - t}ms` },
    });
  } catch (error) {
    console.error("Error fetching user submissions:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch submissions",
      code: "SERVER_ERROR",
      processingTime: `${Date.now() - t}ms`,
    });
  }
});

router.get("/:form_id", async (req, res) => {
  const t = Date.now();
  const formId = parseId(req.params.form_id);
  if (!formId)
    return res
      .status(400)
      .json({ success: false, error: "Invalid form ID", code: "INVALID_ID" });

  try {
    const pool = getPool();
    const [[submission]] = await pool.execute(
      "SELECT fs.*, ft.name AS form_type_name, u.email AS user_email, fs.location AS location_status FROM form_submission fs JOIN form_type ft ON fs.form_type_id=ft.id JOIN users_tbl u ON fs.user_id=u.id WHERE fs.id=?",
      [formId],
    );

    if (!submission) {
      return res.status(404).json({
        success: false,
        error: "Form submission not found",
        code: "NOT_FOUND",
      });
    }

    let requirementRows = [];
    try {
      const reqTableMap = {
        [FORM_TYPE_IDS.UPD]: "upd_requirements",
        [FORM_TYPE_IDS.TOP]: "top_requirements",
        [FORM_TYPE_IDS.RSM]: "rsm_requirements",
      };
      const reqTable = reqTableMap[submission.form_type_id];
      if (reqTable) {
        [requirementRows] = await pool.execute(
          `SELECT * FROM ${reqTable} WHERE form_id=? ORDER BY requirement_type`,
          [formId],
        );
      }
      // RST and DLB have sub-types — skip for now; the admin forms.js handles those with getFormRequirements()
    } catch (e) {
      console.warn(
        "Could not fetch requirements for form_type_id",
        submission.form_type_id,
        e.message,
      );
    }

    res.json({
      success: true,
      data: {
        ...submission,
        requirements: requirementRows,
        location: {
          longitude: submission.longitude,
          latitude: submission.latitude,
          status: submission.location_status,
        },
      },
      meta: { processingTime: `${Date.now() - t}ms` },
    });
  } catch (error) {
    console.error("Error fetching form submission:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch form submission",
      code: "SERVER_ERROR",
      processingTime: `${Date.now() - t}ms`,
    });
  }
});

router.get("/location/nearby", async (req, res) => {
  const t = Date.now();
  const { longitude, latitude, radius = 10 } = req.query;

  if (!longitude || !latitude) {
    return res.status(400).json({
      success: false,
      error: "longitude and latitude parameters are required",
      code: "MISSING_COORDINATES",
    });
  }

  const lng = parseFloat(longitude);
  const lat = parseFloat(latitude);
  const radiusKm = parseFloat(radius);

  if (isNaN(lng) || isNaN(lat) || isNaN(radiusKm)) {
    return res.status(400).json({
      success: false,
      error: "Invalid coordinate or radius values",
      code: "INVALID_COORDINATES",
    });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT fs.*, ft.name AS form_type_name, fs.location AS location_status,
              (6371 * acos(cos(radians(?)) * cos(radians(fs.latitude)) * cos(radians(fs.longitude) - radians(?)) + sin(radians(?)) * sin(radians(fs.latitude)))) AS distance_km
       FROM form_submission fs JOIN form_type ft ON fs.form_type_id=ft.id
       WHERE fs.longitude IS NOT NULL AND fs.latitude IS NOT NULL
       HAVING distance_km <= ?
       ORDER BY distance_km ASC LIMIT 100`,
      [lat, lng, lat, radiusKm],
    );
    res.json({
      success: true,
      data: {
        center: { longitude: lng, latitude: lat },
        radius_km: radiusKm,
        results: rows,
      },
      meta: { processingTime: `${Date.now() - t}ms` },
    });
  } catch (error) {
    console.error("Error fetching nearby forms:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch nearby forms",
      code: "SERVER_ERROR",
      processingTime: `${Date.now() - t}ms`,
    });
  }
});

router.get("/location/:location_status", async (req, res) => {
  const t = Date.now();
  const { location_status } = req.params;

  if (!["loc", "abr"].includes(location_status)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid location_status. Must be "loc" (local) or "abr" (abroad)',
      code: "INVALID_LOCATION_STATUS",
    });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      "SELECT fs.*, ft.name AS form_type_name, fs.location AS location_status FROM form_submission fs JOIN form_type ft ON fs.form_type_id=ft.id WHERE fs.location=? ORDER BY fs.submitted_at DESC",
      [location_status],
    );
    res.json({
      success: true,
      data: { location_status, count: rows.length, submissions: rows },
      meta: { processingTime: `${Date.now() - t}ms` },
    });
  } catch (error) {
    console.error("Error fetching forms by location:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch forms by location",
      code: "SERVER_ERROR",
      processingTime: `${Date.now() - t}ms`,
    });
  }
});

router.get("/analytics/location-stats", async (req, res) => {
  const t = Date.now();
  try {
    const pool = getPool();
    const [[locationStats], [requirementStats], [boundingBox]] =
      await Promise.all([
        pool.execute(`
        SELECT location AS location_status,
               COUNT(*) AS total_submissions,
               COUNT(CASE WHEN status='a' THEN 1 END) AS approved_count,
               COUNT(CASE WHEN status='p' THEN 1 END) AS pending_count,
               COUNT(CASE WHEN status='d' THEN 1 END) AS denied_count,
               AVG(longitude) AS avg_longitude, AVG(latitude) AS avg_latitude,
               MIN(submitted_at) AS earliest_submission, MAX(submitted_at) AS latest_submission
        FROM form_submission GROUP BY location
      `),
        pool.execute(`
        SELECT fr.applies_to_location, fr.requirement_type, COUNT(*) AS count
        FROM upd_requirements fr
        JOIN form_submission fs ON fr.form_id=fs.id
        GROUP BY fr.applies_to_location, fr.requirement_type
        ORDER BY fr.applies_to_location, fr.requirement_type
      `),
        pool.execute(`
        SELECT MIN(longitude) AS min_lng, MAX(longitude) AS max_lng,
               MIN(latitude) AS min_lat,  MAX(latitude) AS max_lat
        FROM form_submission WHERE longitude IS NOT NULL AND latitude IS NOT NULL
      `),
      ]);

    res.json({
      success: true,
      data: {
        location_statistics: locationStats,
        requirement_statistics: requirementStats,
        bounding_box: boundingBox[0] || null,
      },
      meta: { processingTime: `${Date.now() - t}ms` },
    });
  } catch (error) {
    console.error("Error fetching location stats:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch location statistics",
      code: "SERVER_ERROR",
      processingTime: `${Date.now() - t}ms`,
    });
  }
});

// ============================================================
// STATUS UPDATE
// ============================================================

// Minimal RST table resolver (inline — does not depend on the admin forms helper)
const RST_TABLES_ORDERED = [
  "rst_widow_requirements",
  "rst_bi_principal_requirements",
  "rst_bi_bene_requirements",
  "rst_re_entitle_requirements",
  "rst_principal_requirements",
];

async function resolveRstTable(pool, formId) {
  for (const tbl of RST_TABLES_ORDERED) {
    const [[{ cnt }]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM ${tbl} WHERE form_id=?`,
      [formId],
    );
    if (cnt > 0) return safeTable(tbl, RST_TABLE_ALLOWLIST);
  }
  return "rst_principal_requirements";
}

router.put("/:form_id/status", async (req, res) => {
  const pool = getPool();
  let conn = null;

  try {
    const formId = parseId(req.params.form_id);
    if (!formId)
      return res.status(400).json({ success: false, error: "Invalid form ID" });

    const { status, admin_notes } = req.body;
    const adminId = req.admin?.adminId;
    if (!adminId)
      return res
        .status(401)
        .json({ success: false, error: "Admin authentication required" });

    if (!status || !["p", "a", "d"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid status. Must be p, a, or d" });
    }
    if (admin_notes && admin_notes.length > 1000) {
      return res.status(400).json({
        success: false,
        error: "Admin notes cannot exceed 1000 characters",
      });
    }

    const [[existingForm]] = await pool.execute(
      "SELECT id, status, form_type_id, user_id FROM form_submission WHERE id=?",
      [formId],
    );
    if (!existingForm)
      return res
        .status(404)
        .json({ success: false, error: "Form submission not found" });

    const { form_type_id: formTypeId, user_id: userId } = existingForm;

    // Pre-resolve RST table before opening the transaction
    let rstTable = null;
    if (status === "d" && formTypeId === FORM_TYPE_IDS.RST) {
      rstTable = await resolveRstTable(pool, formId);
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    try {
      const updateSql =
        admin_notes !== undefined
          ? "UPDATE form_submission SET status=?, admin_notes=?, reviewed_at=NOW() WHERE id=?"
          : "UPDATE form_submission SET status=?, reviewed_at=NOW() WHERE id=?";
      const updateVals =
        admin_notes !== undefined
          ? [status, admin_notes, formId]
          : [status, formId];
      await conn.execute(updateSql, updateVals);

      if (formTypeId === FORM_TYPE_IDS.RST && status === "a") {
        await conn.execute(
          "UPDATE users_tbl SET status='ACT', approved_at=NOW() WHERE id=?",
          [userId],
        );
      }

      if (status === "d") {
        if (formTypeId === FORM_TYPE_IDS.RSM)
          await conn.execute("DELETE FROM rsm_requirements WHERE form_id=?", [
            formId,
          ]);
        else if (formTypeId === FORM_TYPE_IDS.RST)
          await conn.execute(`DELETE FROM ${rstTable} WHERE form_id=?`, [
            formId,
          ]);
        else
          await conn.execute("DELETE FROM upd_requirements WHERE form_id=?", [
            formId,
          ]);
      }

      await conn.commit();

      const response = {
        success: true,
        message: "Form status updated successfully",
        requirements_deleted: status === "d",
        form_type_id: formTypeId,
        updated_by: {
          admin_id: adminId,
          admin_email: req.admin.email,
          admin_name: req.admin.name,
        },
      };
      if (formTypeId === FORM_TYPE_IDS.RST && status === "a") {
        response.user_status_updated = true;
        response.new_user_status = "ACT";
      }

      res.json(response);
    } catch (txError) {
      try {
        await conn.rollback();
      } catch {}
      throw txError;
    }
  } catch (error) {
    console.error("Error updating form status:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to update form status" });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch {}
    }
  }
});

module.exports = router;
