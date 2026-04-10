const admin = require("../config/firebase");
const { Expo } = require("expo-server-sdk");
const pool = require("../config/database");

const expo = new Expo();

/**
 * Helper function to execute database queries
 * Works with both pool and connection objects
 */
const executeQuery = async (db, query, params) => {
  const isConnection = db.execute && typeof db.execute === "function";

  if (isConnection) {
    return await db.execute(query, params);
  } else if (db.query) {
    return await db.query(query, params);
  } else {
    throw new Error("Invalid database object");
  }
};

/**
 * Validate token format (supports both Expo and FCM tokens)
 */
const validatePushToken = (token) => {
  if (!token || typeof token !== "string") {
    return { isValid: false, type: "invalid" };
  }

  if (token.startsWith("ExponentPushToken[") && token.endsWith("]")) {
    return { isValid: true, type: "expo" };
  }

  if (token.length > 100 && token.includes(":")) {
    return { isValid: true, type: "fcm" };
  }

  if (/^[a-f0-9]{64}$/i.test(token)) {
    return { isValid: true, type: "apns" };
  }

  return { isValid: false, type: "invalid" };
};

/**
 * Send notification via Expo Push Notification service
 */
async function sendExpoNotification(expoToken, title, body, data = {}) {
  try {
    if (!Expo.isExpoPushToken(expoToken)) {
      console.error("❌ Invalid Expo push token");
      return {
        success: false,
        error: "Invalid Expo push token",
        shouldRemoveToken: true,
      };
    }

    const messages = [
      {
        to: expoToken,
        sound: "default",
        title: title,
        body: body,
        data: data,
        priority: "high",
        channelId: "default",
      },
    ];

    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];

    for (let chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    }

    const hasError = tickets.some((ticket) => ticket.status === "error");
    if (hasError) {
      const errorTicket = tickets.find((ticket) => ticket.status === "error");
      console.error("❌ Expo notification error:", errorTicket);

      const shouldRemove = errorTicket.details?.error === "DeviceNotRegistered";
      return {
        success: false,
        error: errorTicket.message,
        shouldRemoveToken: shouldRemove,
      };
    }

    return { success: true, tickets };
  } catch (error) {
    console.error("❌ Expo notification error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Send notification via Firebase Cloud Messaging
 */
async function sendFCMNotification(fcmToken, title, body, data = {}) {
  try {
    // Convert all data values to strings (FCM requirement)
    const stringifiedData = {};
    for (const [key, value] of Object.entries(data)) {
      stringifiedData[key] = String(value);
    }

    // CRITICAL: Add title and body to data for foreground handling
    stringifiedData.title = String(title);
    stringifiedData.body = String(body);

    const message = {
      notification: {
        title: title,
        body: body,
      },
      data: {
        ...stringifiedData,
        timestamp: Date.now().toString(),
      },
      token: fcmToken,
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "default",
          priority: "high",
          title: title,
          body: body,
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            alert: {
              title: title,
              body: body,
            },
          },
        },
      },
    };

    const response = await admin.messaging().send(message);
    return { success: true, messageId: response };
  } catch (error) {
    console.error("❌ FCM notification error:", error.message);

    const shouldRemove =
      error.code === "messaging/registration-token-not-registered" ||
      error.code === "messaging/invalid-registration-token";

    return {
      success: false,
      error: error.message,
      shouldRemoveToken: shouldRemove,
    };
  }
}

/**
 * Send push notification to a user by their userId
 */
async function sendPushNotificationToUser(userId, title, body, data = {}) {
  try {
    const [result] = await pool.execute(
      "SELECT push_token, fcm_token, platform FROM users_tbl WHERE id = ? LIMIT 1",
      [userId],
    );

    if (result.length === 0) {
      console.error("❌ User not found");
      return { success: false, error: "User not found" };
    }

    const { push_token: expoToken, fcm_token: fcmToken, platform } = result[0];

    if (!expoToken && !fcmToken) {
      console.error("❌ No push tokens found for user");
      return { success: false, error: "No push tokens found" };
    }

    let notificationResult;

    // Prefer FCM for Android if available
    if (platform === "android" && fcmToken) {
      notificationResult = await sendFCMNotification(
        fcmToken,
        title,
        body,
        data,
      );
    }
    // Use Expo for iOS or as fallback
    else if (expoToken) {
      notificationResult = await sendExpoNotification(
        expoToken,
        title,
        body,
        data,
      );
    } else {
      console.error("❌ No valid push token available");
      return { success: false, error: "No valid push token" };
    }

    return notificationResult;
  } catch (error) {
    console.error("❌ Push notification error:", error.message);
    console.error("Stack trace:", error.stack);
    return { success: false, error: error.message };
  }
}

/**
 * Send push notification directly to a token
 */
async function sendPushNotificationToToken(pushToken, title, body, data = {}) {
  const validation = validatePushToken(pushToken);

  if (!validation.isValid) {
    console.error(`❌ Invalid token format`);
    return {
      success: false,
      error: "Invalid token format",
      shouldRemoveToken: true,
    };
  }

  if (validation.type === "expo") {
    return await sendExpoNotification(pushToken, title, body, data);
  }

  if (validation.type === "fcm" || validation.type === "apns") {
    return await sendFCMNotification(pushToken, title, body, data);
  }

  return { success: false, error: "Unsupported token type" };
}

// ==================== ACCOUNT STATUS CHANGE NOTIFICATION ====================
const STATUS_NAMES = {
  ACT: "Active",
  TAG: "Tagged",
  DEL: "Deleted",
  UNV: "Unverified",
  AFR: "Applying for Resumption",
  FOR_PAYROLL: "Approved – For Payroll Updating",
};

const sendStatusChangeNotification = async (
  db,
  userId,
  oldStatus,
  newStatus,
) => {
  try {
    const [userResult] = await executeQuery(
      db,
      "SELECT push_token, fcm_token, platform, pensioner_ndx FROM users_tbl WHERE id = ?",
      [userId],
    );

    if (userResult.length === 0) {
      return { success: false, error: "User not found" };
    }

    const { push_token, fcm_token, platform, pensioner_ndx } = userResult[0];

    if (!push_token && !fcm_token) {
      return { success: false, error: "No push token" };
    }

    const [pensionerResult] = await executeQuery(
      db,
      "SELECT hero_ndx, source_table FROM pensioners_tbl WHERE id = ?",
      [pensioner_ndx],
    );

    let firstName = "User";
    let lastName = "";

    if (pensionerResult.length > 0) {
      const { hero_ndx, source_table } = pensionerResult[0];
      console.log("source_table:", JSON.stringify(source_table));
      console.log("hero_ndx:", hero_ndx);

      let nameQuery; // ← declare FIRST

      if (source_table === "heroes_tbl") {
        nameQuery =
          "SELECT FIRSTNAME AS firstname, LASTNAME AS lastname FROM heroes_tbl WHERE NDX = ?";
      } else if (source_table === "resumption_table") {
        nameQuery =
          "SELECT FIRSTNAME AS firstname, LASTNAME AS lastname FROM resumption_table WHERE NDX = ?";
      } else if (source_table === "beneficiaries_table") {
        nameQuery =
          "SELECT FIRSTNAME AS firstname, LASTNAME AS lastname FROM beneficiaries_table WHERE NDX = ?";
      }

      console.log("nameQuery:", nameQuery); // ← log AFTER declaration

      if (nameQuery) {
        const [nameResult] = await executeQuery(db, nameQuery, [hero_ndx]);
        console.log("nameResult:", nameResult);
        if (nameResult.length > 0) {
          firstName = nameResult[0].firstname || "User";
          lastName = nameResult[0].lastname || "";
        }
      }
    }

    const oldStatusName = STATUS_NAMES[oldStatus] || oldStatus;
    const newStatusName = STATUS_NAMES[newStatus] || newStatus;

    const title = "Account Status Updated";
    const body = `Hello ${firstName} ${lastName}, your account status has changed from ${oldStatusName} to ${newStatusName}.`;
    const data = {
      type: "status_change",
      userId: String(userId),
      oldStatus,
      newStatus,
      screen: "Profile",
    };

    let pushResult;
    if (platform === "android" && fcm_token) {
      pushResult = await sendFCMNotification(fcm_token, title, body, data);
    } else if (push_token) {
      pushResult = await sendExpoNotification(push_token, title, body, data);
    } else {
      return { success: false, error: "No valid token available" };
    }

    if (pushResult.success) {
    } else {
      console.error("❌ Failed to send notification:", pushResult.error);
      if (pushResult.shouldRemoveToken) {
        const tokenToRemove =
          platform === "android" && fcm_token ? "fcm_token" : "push_token";
        await executeQuery(
          db,
          `UPDATE users_tbl SET ${tokenToRemove} = NULL WHERE id = ?`,
          [userId],
        );
      }
    }

    return pushResult;
  } catch (error) {
    console.error("❌ Error in sendStatusChangeNotification:", error);
    return { success: false, error: error.message };
  }
};

// ==================== FORM NOTIFICATIONS ====================
// Following the same pattern as sendStatusChangeNotification

const sendFormApprovalNotification = async (db, userId, formDetails) => {
  try {
    const formTypeNames = {
      1: "Declaration of Legal Beneficiary",
      2: "Resumption",
      3: "Restoration",
      4: "Transfer of Pension",
      5: "Updating",
    };

    const formName = formTypeNames[formDetails.form_type_id] || "Form";

    // ✅ Use executeQuery helper like status change does
    const [userResult] = await executeQuery(
      db,
      "SELECT push_token, fcm_token, platform FROM users_tbl WHERE id = ?",
      [userId],
    );

    if (userResult.length === 0) {
      return { success: false, error: "User not found" };
    }

    const { push_token, fcm_token, platform } = userResult[0];

    if (!push_token && !fcm_token) {
      return { success: false, error: "No push token" };
    }

    const title = "AFPPGMC";
    const body = `Your ${formName} application has been approved!`;
    const data = {
      type: "form_approval",
      form_id: String(formDetails.form_id),
      form_type_id: String(formDetails.form_type_id),
      screen: "Submissions",
    };

    // ✅ Send notification directly like status change does
    let pushResult;
    if (platform === "android" && fcm_token) {
      pushResult = await sendFCMNotification(fcm_token, title, body, data);
    } else if (push_token) {
      pushResult = await sendExpoNotification(push_token, title, body, data);
    } else {
      return { success: false, error: "No valid token available" };
    }

    if (pushResult.success) {
    } else {
      console.error("❌ Failed to send notification:", pushResult.error);
      if (pushResult.shouldRemoveToken) {
        const tokenToRemove =
          platform === "android" && fcm_token ? "fcm_token" : "push_token";
        await executeQuery(
          db,
          `UPDATE users_tbl SET ${tokenToRemove} = NULL WHERE id = ?`,
          [userId],
        );
      }
    }

    return pushResult;
  } catch (error) {
    console.error("❌ Error in sendFormApprovalNotification:", error);
    return { success: false, error: error.message };
  }
};

const sendFormDenialNotification = async (db, userId, formDetails) => {
  try {
    const formTypeNames = {
      1: "Declaration of Legal Beneficiary",
      2: "Resumption",
      3: "Restoration",
      4: "Transfer of Pension",
      5: "Updating",
    };

    const formName = formTypeNames[formDetails.form_type_id] || "Form";

    // ✅ Use executeQuery helper like status change does
    const [userResult] = await executeQuery(
      db,
      "SELECT push_token, fcm_token, platform FROM users_tbl WHERE id = ?",
      [userId],
    );

    if (userResult.length === 0) {
      return { success: false, error: "User not found" };
    }

    const { push_token, fcm_token, platform } = userResult[0];

    if (!push_token && !fcm_token) {
      return { success: false, error: "No push token" };
    }

    const title = "AFPPGMC";
    const body = `Your ${formName} application has been declined. Please check for details.`;
    const data = {
      type: "form_denial",
      form_id: String(formDetails.form_id),
      form_type_id: String(formDetails.form_type_id),
      screen: "Submissions",
    };

    // ✅ Send notification directly like status change does
    let pushResult;
    if (platform === "android" && fcm_token) {
      pushResult = await sendFCMNotification(fcm_token, title, body, data);
    } else if (push_token) {
      pushResult = await sendExpoNotification(push_token, title, body, data);
    } else {
      return { success: false, error: "No valid token available" };
    }

    if (pushResult.success) {
    } else {
      console.error("❌ Failed to send notification:", pushResult.error);
      if (pushResult.shouldRemoveToken) {
        const tokenToRemove =
          platform === "android" && fcm_token ? "fcm_token" : "push_token";
        await executeQuery(
          db,
          `UPDATE users_tbl SET ${tokenToRemove} = NULL WHERE id = ?`,
          [userId],
        );
      }
    }

    return pushResult;
  } catch (error) {
    console.error("❌ Error in sendFormDenialNotification:", error);
    return { success: false, error: error.message };
  }
};

const sendAdminNotesNotification = async (db, userId, formDetails) => {
  try {
    // ✅ Use executeQuery helper like status change does
    const [userResult] = await executeQuery(
      db,
      "SELECT push_token, fcm_token, platform FROM users_tbl WHERE id = ?",
      [userId],
    );

    if (userResult.length === 0) {
      return { success: false, error: "User not found" };
    }

    const { push_token, fcm_token, platform } = userResult[0];

    if (!push_token && !fcm_token) {
      return { success: false, error: "No push token" };
    }

    const title = "📝 New Admin Note";
    const body = "An administrator has added a note to your form submission.";
    const data = {
      type: "admin_note",
      form_id: String(formDetails.form_id),
      form_type_id: String(formDetails.form_type_id),
      screen: "Submissions",
    };

    // ✅ Send notification directly like status change does
    let pushResult;
    if (platform === "android" && fcm_token) {
      pushResult = await sendFCMNotification(fcm_token, title, body, data);
    } else if (push_token) {
      pushResult = await sendExpoNotification(push_token, title, body, data);
    } else {
      return { success: false, error: "No valid token available" };
    }

    if (pushResult.success) {
    } else {
      console.error("❌ Failed to send notification:", pushResult.error);
      if (pushResult.shouldRemoveToken) {
        const tokenToRemove =
          platform === "android" && fcm_token ? "fcm_token" : "push_token";
        await executeQuery(
          db,
          `UPDATE users_tbl SET ${tokenToRemove} = NULL WHERE id = ?`,
          [userId],
        );
      }
    }

    return pushResult;
  } catch (error) {
    console.error("❌ Error in sendAdminNotesNotification:", error);
    return { success: false, error: error.message };
  }
};

// ==================== ANNOUNCEMENT NOTIFICATION ====================
async function sendAnnouncementNotification(tokens, announcement) {
  if (!tokens || tokens.length === 0) {
    return { success: false, reason: "No tokens provided" };
  }

  const expoTokens = [];
  const fcmTokens = [];
  const invalidTokens = [];

  tokens.forEach((token) => {
    const validation = validatePushToken(token);
    if (validation.isValid) {
      if (validation.type === "expo") {
        expoTokens.push(token);
      } else if (validation.type === "fcm" || validation.type === "apns") {
        fcmTokens.push(token);
      }
    } else {
      invalidTokens.push(token);
    }
  });

  let totalSent = 0;
  let totalFailed = 0;
  const results = [];

  if (expoTokens.length > 0) {
    const expoResult = await sendExpoAnnouncementBatch(
      expoTokens,
      announcement,
    );
    totalSent += expoResult.successCount;
    totalFailed += expoResult.failureCount;
    results.push({ type: "expo", ...expoResult });
  }

  if (fcmTokens.length > 0) {
    const fcmResult = await sendFCMAnnouncementBatch(fcmTokens, announcement);
    totalSent += fcmResult.successCount;
    totalFailed += fcmResult.failureCount;
    results.push({ type: "fcm", ...fcmResult });
  }

  return {
    success: totalSent > 0,
    totalSent,
    totalFailed,
    invalidTokens,
    results,
  };
}

async function sendExpoAnnouncementBatch(tokens, announcement) {
  const messages = tokens.map((token) => ({
    to: token,
    sound: "default",
    title: "📢 New Announcement",
    body: announcement.title || "A new announcement has been posted.",
    data: {
      type: "announcement",
      announcementId: String(announcement.id),
      title: announcement.title || "",
      description: announcement.description || "",
      image_url: announcement.image_url || "",
    },
    badge: 1,
  }));

  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    const results = await response.json();

    let successCount = 0;
    let failureCount = 0;

    if (Array.isArray(results.data)) {
      results.data.forEach((result) => {
        if (result.status === "ok") {
          successCount++;
        } else {
          failureCount++;
        }
      });
    }

    return { successCount, failureCount };
  } catch (error) {
    console.error("❌ Expo batch failed:", error);
    return { successCount: 0, failureCount: tokens.length };
  }
}

async function sendFCMAnnouncementBatch(tokens, announcement) {
  const batchSize = 500;
  const batches = [];

  for (let i = 0; i < tokens.length; i += batchSize) {
    batches.push(tokens.slice(i, i + batchSize));
  }

  const notificationTitle = "📢 New Announcement";
  const notificationBody =
    announcement.title || "A new announcement has been posted.";

  const message = {
    notification: {
      title: notificationTitle,
      body: notificationBody,
    },
    data: {
      type: "announcement",
      announcementId: String(announcement.id),
      title: announcement.title || "",
      body: notificationBody,
      description: announcement.description || "",
      image_url: announcement.image_url || "",
    },
    android: {
      priority: "high",
      notification: {
        channelId: "default",
        sound: "default",
        title: notificationTitle,
        body: notificationBody,
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          badge: 1,
          alert: {
            title: notificationTitle,
            body: notificationBody,
          },
        },
      },
    },
  };

  let totalSent = 0;
  let totalFailed = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    try {
      const response = await admin.messaging().sendEachForMulticast({
        ...message,
        tokens: batch,
      });

      totalSent += response.successCount;
      totalFailed += response.failureCount;
    } catch (error) {
      console.error(`❌ FCM batch ${i + 1} failed:`, error.message);
      totalFailed += batch.length;
    }

    if (i < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return { successCount: totalSent, failureCount: totalFailed };
}

module.exports = {
  sendPushNotificationToUser,
  sendPushNotificationToToken,
  sendFormApprovalNotification,
  sendFormDenialNotification,
  sendAdminNotesNotification,
  sendAnnouncementNotification,
  sendStatusChangeNotification,
  sendFCMAnnouncementBatch,
};
