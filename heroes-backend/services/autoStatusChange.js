const cron = require("node-cron");
const { executeQuery, logger, getPool } = require("../config/database");
const {
  sendPushNotificationToUser,
  sendStatusChangeNotification,
} = require("./pushNotificationService");

const QUARTERLY_CYCLES = [
  {
    cycle: 1,
    activePeriod: { start: "01-01", end: "03-15" },
    tagPeriod: { start: "03-16", end: "03-20" },
    delPeriod: { start: "03-21", end: "03-31" },
    name: "Quarter 1 (Jan-Mar)",
  },
  {
    cycle: 2,
    activePeriod: { start: "04-01", end: "06-15" },
    tagPeriod: { start: "06-16", end: "06-20" },
    delPeriod: { start: "06-21", end: "06-30" },
    name: "Quarter 2 (Apr-Jun)",
  },
  {
    cycle: 3,
    activePeriod: { start: "07-01", end: "09-15" },
    tagPeriod: { start: "09-16", end: "09-20" },
    delPeriod: { start: "09-21", end: "09-30" },
    name: "Quarter 3 (Jul-Sep)",
  },
  {
    cycle: 4,
    activePeriod: { start: "10-01", end: "12-15" },
    tagPeriod: { start: "12-16", end: "12-20" },
    delPeriod: { start: "12-21", end: "12-31" },
    name: "Quarter 4 (Oct-Dec)",
  },
];

const QUARTERLY_SOUND = "afppgmc.wav";
const QUARTERLY_CHANNEL = "quarterly-cycle";

const autoStatusChangeService = {
  dateToDayOfYear(dateStr, year) {
    try {
      const [month, day] = dateStr.split("-").map(Number);
      const date = new Date(year, month - 1, day);
      const start = new Date(year, 0, 0);
      const diff = date - start;
      const oneDay = 1000 * 60 * 60 * 24;
      return Math.floor(diff / oneDay);
    } catch (error) {
      logger.error(`Error converting date ${dateStr} to day of year:`, error);
      return null;
    }
  },

  getDayOfYear(date = new Date()) {
    try {
      const start = new Date(date.getFullYear(), 0, 0);
      const diff = date - start;
      const oneDay = 1000 * 60 * 60 * 24;
      return Math.floor(diff / oneDay);
    } catch (error) {
      logger.error("Error calculating day of year:", error);
      return null;
    }
  },

  getCurrentCycleInfo(date = new Date()) {
    try {
      const year = date.getFullYear();
      const dayOfYear = this.getDayOfYear(date);

      if (!dayOfYear) {
        logger.error("Could not calculate day of year");
        return null;
      }

      for (const cycle of QUARTERLY_CYCLES) {
        const activeStart = this.dateToDayOfYear(
          cycle.activePeriod.start,
          year,
        );
        const activeEnd = this.dateToDayOfYear(cycle.activePeriod.end, year);
        const tagStart = this.dateToDayOfYear(cycle.tagPeriod.start, year);
        const tagEnd = this.dateToDayOfYear(cycle.tagPeriod.end, year);
        const delStart = this.dateToDayOfYear(cycle.delPeriod.start, year);
        const delEnd = this.dateToDayOfYear(cycle.delPeriod.end, year);

        if (dayOfYear >= activeStart && dayOfYear <= activeEnd) {
          return {
            cycle: cycle.cycle,
            name: cycle.name,
            period: "ACTIVE",
            periodStart: activeStart,
            periodEnd: activeEnd,
            daysLeftInPeriod: activeEnd - dayOfYear,
            nextPeriod: "TAG",
            nextPeriodStart: tagStart,
          };
        }

        if (dayOfYear >= tagStart && dayOfYear <= tagEnd) {
          return {
            cycle: cycle.cycle,
            name: cycle.name,
            period: "TAG_TRANSITION",
            periodStart: tagStart,
            periodEnd: tagEnd,
            daysLeftInPeriod: tagEnd - dayOfYear,
            nextPeriod: "DEL",
            nextPeriodStart: delStart,
          };
        }

        if (dayOfYear >= delStart && dayOfYear <= delEnd) {
          return {
            cycle: cycle.cycle,
            name: cycle.name,
            period: "DEL_TRANSITION",
            periodStart: delStart,
            periodEnd: delEnd,
            daysLeftInPeriod: delEnd - dayOfYear,
            nextPeriod: cycle.cycle === 4 ? "Q1_ACTIVE" : "NEXT_Q_ACTIVE",
            nextPeriodStart: null,
          };
        }
      }

      logger.warn(
        `Day ${dayOfYear} does not fall within any defined cycle period`,
      );
      return null;
    } catch (error) {
      logger.error("Error getting current cycle info:", error);
      return null;
    }
  },

  getActivePeriodStartDate(cycleInfo, referenceDate = new Date()) {
    if (!cycleInfo) return null;
    const year = referenceDate.getFullYear();
    const cycle = QUARTERLY_CYCLES.find((c) => c.cycle === cycleInfo.cycle);
    if (!cycle) return null;
    const [month, day] = cycle.activePeriod.start.split("-").map(Number);
    return new Date(year, month - 1, day);
  },

  hasSubmittedInActivePeriod(lastSubmissionDate, cycleInfo) {
    if (!lastSubmissionDate || !cycleInfo) return false;
    const lastSubmission = new Date(lastSubmissionDate);
    const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);
    if (!activePeriodStart) return false;
    return lastSubmission >= activePeriodStart;
  },

  // ─── NOTIFICATIONS ────────────────────────────────────────────────────────

  async sendStatusChangeWarningNotifications() {
    try {
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) {
        logger.warn("Could not determine current cycle");
        return { sent: 0, failed: 0 };
      }

      const daysLeft = cycleInfo.daysLeftInPeriod;
      let notificationsSent = 0;
      let notificationsFailed = 0;

      const sendNotif = async (userId, title, body, data) => {
        try {
          const result = await sendPushNotificationToUser(
            userId,
            title,
            body,
            data,
            QUARTERLY_SOUND,
            QUARTERLY_CHANNEL,
          );
          if (result.success) {
            notificationsSent++;
          } else {
            notificationsFailed++;
            logger.warn(`Failed to notify user ${userId}: ${result.error}`);
          }
        } catch (err) {
          notificationsFailed++;
          logger.error(`Error notifying user ${userId}:`, err);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      };

      // SCENARIO 0: First few days of a NEW ACTIVE period
      // Notify users who submitted last cycle that they're eligible again
      if (
        cycleInfo.period === "ACTIVE" &&
        cycleInfo.daysLeftInPeriod >=
          cycleInfo.periodEnd - cycleInfo.periodStart - 2
      ) {
        const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);

        // Find users who submitted during the *previous* cycle's active period
        // (i.e. they submitted before this new active period started, but are still ACT)
        const eligibleUsers = await executeQuery(
          `
    SELECT id, email
    FROM users_tbl
    WHERE status = 'ACT'
      AND COALESCE(form_submitted_at, approved_at, created_at) < ?
      AND COALESCE(form_submitted_at, approved_at, created_at) >= DATE_SUB(?, INTERVAL 4 MONTH)
    `,
          [activePeriodStart, activePeriodStart],
        );

        logger.info(
          `Notifying ${eligibleUsers.length} users that ${cycleInfo.name} is now open`,
        );

        for (const user of eligibleUsers) {
          await sendNotif(
            user.id,
            "Time to Submit Updating",
            `A new quarter has started ${cycleInfo.name}. Please submit your update form before the deadline to keep your account active.`,
            {
              type: "new_cycle_active",
              cycleName: cycleInfo.name,
              cycleNumber: String(cycleInfo.cycle),
              screen: "Forms",
            },
          );
        }
      }

      // SCENARIO 1: ACTIVE period — warn at 30 days AND 15 days remaining
      if (cycleInfo.period === "ACTIVE" && daysLeft <= 30) {
        const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);

        // Only send at the 30-day and 15-day thresholds, not every day
        // We track this by checking if today crosses one of the thresholds
        const shouldNotify =
          (daysLeft <= 30 && daysLeft > 15) || daysLeft <= 15;
        // Narrow it: send once per threshold window using a 3-day grace window
        // so a server restart within 3 days of the threshold still fires
        const inThreshold =
          (daysLeft <= 30 && daysLeft >= 28) ||
          (daysLeft <= 15 && daysLeft >= 13);

        if (inThreshold) {
          const inactiveUsers = await executeQuery(
            `
            SELECT id, email 
            FROM users_tbl 
            WHERE status = 'ACT'
              AND COALESCE(form_submitted_at, approved_at, created_at) < ?
          `,
            [activePeriodStart],
          );

          logger.info(
            `Sending ${daysLeft}-day warning to ${inactiveUsers.length} inactive users`,
          );

          for (const user of inactiveUsers) {
            await sendNotif(
              user.id,
              "Account Status Warning",
              `You have about ${daysLeft} days left to submit a form. Without a submission, your account will be tagged for deletion.`,
              {
                type: "status_warning",
                daysLeft: String(daysLeft),
                currentStatus: "ACT",
                nextStatus: "TAG",
                screen: "Home",
              },
            );
          }
        }
      }

      // SCENARIO 2: First day (or first few days) of TAG period — notify tagged users
      if (
        cycleInfo.period === "TAG_TRANSITION" &&
        daysLeft >= cycleInfo.periodEnd - cycleInfo.periodStart - 2
      ) {
        const taggedUsers = await executeQuery(`
          SELECT id, email 
          FROM users_tbl 
          WHERE status = 'TAG'
            AND tagged_at >= DATE_SUB(NOW(), INTERVAL 3 DAY)
        `);

        logger.info(`Notifying ${taggedUsers.length} newly tagged users`);

        for (const user of taggedUsers) {
          await sendNotif(
            user.id,
            "Account Tagged for Deletion",
            "Your account has been tagged for deletion because you have not submitted an Updating form. Please submit an Updating form within the next few days to restore your active status.",
            {
              type: "status_changed",
              currentStatus: "TAG",
              nextStatus: "DEL",
              screen: "Profile",
            },
          );
        }
      }

      // SCENARIO 3: First day (or first few days) of DEL period — notify deleted users
      if (
        cycleInfo.period === "DEL_TRANSITION" &&
        daysLeft >= cycleInfo.periodEnd - cycleInfo.periodStart - 2
      ) {
        const deletedUsers = await executeQuery(`
          SELECT id, email 
          FROM users_tbl 
          WHERE status = 'DEL'
            AND deleted_at >= DATE_SUB(NOW(), INTERVAL 3 DAY)
        `);

        logger.info(`Notifying ${deletedUsers.length} newly deleted users`);

        for (const user of deletedUsers) {
          await sendNotif(
            user.id,
            "Account Deleted",
            "Your account status has been changed to Deleted due to inactivity. To regain access, please submit a Restoration Form.",
            { type: "status_changed", currentStatus: "DEL", screen: "Profile" },
          );
        }
      }

      return {
        sent: notificationsSent,
        failed: notificationsFailed,
        daysLeft,
        period: cycleInfo.period,
      };
    } catch (error) {
      logger.error("Error sending status change warning notifications:", error);
      throw error;
    }
  },

  // ─── MANUAL FALLBACK NOTIFICATIONS ─────────────────────────────────────────

  async sendManualReminderToUser(userId) {
    try {
      const users = await executeQuery(
        `SELECT id, email, status FROM users_tbl WHERE id = ?`,
        [userId],
      );

      if (!users.length) {
        return { success: false, error: "User not found" };
      }

      const user = users[0];
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) {
        return { success: false, error: "Could not determine current cycle" };
      }

      let title, body, data;

      if (user.status === "ACT") {
        const daysLeft =
          cycleInfo.period === "ACTIVE" ? cycleInfo.daysLeftInPeriod : 0;
        title = "Account Status Warning";
        body =
          cycleInfo.period === "ACTIVE"
            ? `You have about ${daysLeft} days left to submit a form for ${cycleInfo.name}. Without a submission, your account will be tagged for deletion.`
            : `Please submit your update form as soon as possible to avoid your account being tagged for deletion.`;
        data = {
          type: "status_warning",
          daysLeft: String(daysLeft),
          currentStatus: "ACT",
          nextStatus: "TAG",
          screen: "Home",
          manualTrigger: "true",
        };
      } else if (user.status === "TAG") {
        title = "Account Tagged for Deletion";
        body =
          "Your account is tagged for deletion because you have not submitted an Updating form. Please submit one as soon as possible to restore your active status.";
        data = {
          type: "status_changed",
          currentStatus: "TAG",
          nextStatus: "DEL",
          screen: "Profile",
          manualTrigger: "true",
        };
      } else if (user.status === "DEL") {
        title = "Account Deleted";
        body =
          "Your account status is Deleted due to inactivity. To regain access, please submit a Restoration Form.";
        data = {
          type: "status_changed",
          currentStatus: "DEL",
          screen: "Profile",
          manualTrigger: "true",
        };
      } else {
        return {
          success: false,
          error: `No reminder defined for status "${user.status}"`,
        };
      }

      const result = await sendPushNotificationToUser(
        userId,
        title,
        body,
        data,
        QUARTERLY_SOUND,
        QUARTERLY_CHANNEL,
      );
      return { ...result, title, body, cycleName: cycleInfo.name };
    } catch (error) {
      logger.error(`Error sending manual reminder to user ${userId}:`, error);
      return { success: false, error: error.message };
    }
  },

  async sendManualReminderBulk() {
    try {
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) {
        return { success: false, error: "Could not determine current cycle" };
      }

      const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);
      let targetUsers = [];
      let title, body, buildData;

      if (cycleInfo.period === "ACTIVE") {
        targetUsers = await executeQuery(
          `SELECT id, email FROM users_tbl
         WHERE status = 'ACT'
           AND COALESCE(form_submitted_at, approved_at, created_at) < ?`,
          [activePeriodStart],
        );
        title = "Account Status Warning";
        body = `You have ${cycleInfo.daysLeftInPeriod} days left to submit a form for ${cycleInfo.name}. Without updating, your account will be tagged for deletion.`;
        buildData = () => ({
          type: "status_warning",
          daysLeft: String(cycleInfo.daysLeftInPeriod),
          currentStatus: "ACT",
          nextStatus: "TAG",
          screen: "Home",
          manualTrigger: "true",
        });
      } else if (cycleInfo.period === "TAG_TRANSITION") {
        targetUsers = await executeQuery(
          `SELECT id, email FROM users_tbl WHERE status = 'TAG'`,
        );
        title = "Account Tagged for Deletion";
        body =
          "Your account is tagged for deletion for not submitted an Updating form. Please submit as soon as possible to restore your active status.";
        buildData = () => ({
          type: "status_changed",
          currentStatus: "TAG",
          nextStatus: "DEL",
          screen: "Profile",
          manualTrigger: "true",
        });
      } else {
        return {
          success: false,
          error: `No bulk reminder defined for period "${cycleInfo.period}"`,
        };
      }

      let sent = 0,
        failed = 0;
      const failures = [];

      for (const user of targetUsers) {
        const result = await sendPushNotificationToUser(
          user.id,
          title,
          body,
          QUARTERLY_SOUND,
          QUARTERLY_CHANNEL,
          buildData(),
        );
        if (result.success) {
          sent++;
        } else {
          failed++;
          failures.push({ userId: user.id, error: result.error });
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      return {
        success: true,
        cycleName: cycleInfo.name,
        period: cycleInfo.period,
        totalUsers: targetUsers.length,
        sent,
        failed,
        failures,
        title,
        body,
      };
    } catch (error) {
      logger.error("Error sending bulk manual reminder:", error);
      return { success: false, error: error.message };
    }
  },

  // ─── STATUS UPDATES ───────────────────────────────────────────────────────

  async updateInactiveTAGUsers(overrideCycleInfo = null) {
    try {
      const cycleInfo = overrideCycleInfo || this.getCurrentCycleInfo();
      if (!cycleInfo) {
        logger.warn("Could not determine current cycle");
        return 0;
      }

      if (cycleInfo.period !== "DEL_TRANSITION") {
        logger.info(
          `Skipping DEL update — current period is ${cycleInfo.period}`,
        );
        return 0;
      }

      const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);

      const result = await executeQuery(
        `
        UPDATE users_tbl 
        SET status = 'DEL', status_updated_at = NOW(), deleted_at = NOW()
        WHERE status = 'TAG'
          AND COALESCE(status_updated_at, tagged_at, created_at) < ?
      `,
        [activePeriodStart],
      );

      if (result.affectedRows > 0) {
        const deletedUsers = await executeQuery(`
          SELECT id, email FROM users_tbl 
          WHERE status = 'DEL' AND deleted_at >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)
        `);
        logger.info(
          `DEL update: ${result.affectedRows} users deleted`,
          deletedUsers.map((u) => u.email),
        );

        const BATCH_SIZE = 10;
        for (let i = 0; i < deletedUsers.length; i += BATCH_SIZE) {
          const batch = deletedUsers.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.map((user) =>
              sendStatusChangeNotification(
                getPool(),
                user.id,
                "TAG",
                "DEL",
              ).catch((err) =>
                logger.error(`Failed to notify user ${user.id}:`, err),
              ),
            ),
          );
          await new Promise((r) => setTimeout(r, 100));
        }
      } else {
        logger.info("DEL update: no eligible TAG users found");
      }

      return result.affectedRows;
    } catch (error) {
      logger.error("Error updating TAG users to DEL:", error);
      throw error;
    }
  },

  async updateInactiveACTUsers(overrideCycleInfo = null) {
    try {
      const cycleInfo = overrideCycleInfo || this.getCurrentCycleInfo();
      if (!cycleInfo) {
        logger.warn("Could not determine current cycle");
        return 0;
      }

      if (cycleInfo.period !== "TAG_TRANSITION") {
        logger.info(
          `Skipping TAG update — current period is ${cycleInfo.period}`,
        );
        return 0;
      }

      const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);

      const result = await executeQuery(
        `
        UPDATE users_tbl 
        SET status = 'TAG', status_updated_at = NOW(), tagged_at = NOW()
        WHERE status = 'ACT'
          AND COALESCE(form_submitted_at, approved_at, created_at) < ?
      `,
        [activePeriodStart],
      );

      // In updateInactiveACTUsers(), after the UPDATE:
      if (result.affectedRows > 0) {
        const taggedUsers = await executeQuery(`
          SELECT id, email FROM users_tbl 
          WHERE status = 'TAG' AND tagged_at >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)
        `);
        logger.info(
          `TAG update: ${result.affectedRows} users tagged`,
          taggedUsers.map((u) => u.email),
        );

        // Concurrent batches (what you want)
        const BATCH_SIZE = 10;

        for (let i = 0; i < taggedUsers.length; i += BATCH_SIZE) {
          const batch = taggedUsers.slice(i, i + BATCH_SIZE); // grab 10 users

          await Promise.all(
            // fire all 10 at the same time
            batch.map((user) =>
              sendStatusChangeNotification(
                getPool(),
                user.id,
                "ACT",
                "TAG",
              ).catch((err) =>
                logger.error(`Failed to notify user ${user.id}:`, err),
              ),
            ),
          );

          await new Promise((r) => setTimeout(r, 100)); // wait 100ms before next batch
        }
      } else {
        logger.info("TAG update: no eligible ACT users found");
      }

      return result.affectedRows;
    } catch (error) {
      logger.error("Error updating ACT users to TAG:", error);
      throw error;
    }
  },

  async runStatusUpdates() {
    const startTime = Date.now();
    const cycleInfo = this.getCurrentCycleInfo();

    logger.info(
      `=== Running status updates | Period: ${cycleInfo?.period || "UNKNOWN"} | Cycle: ${cycleInfo?.name || "N/A"} ===`,
    );

    try {
      let tagToDelCount = 0;
      let actToTagCount = 0;

      if (cycleInfo?.period === "TAG_TRANSITION") {
        actToTagCount = await this.updateInactiveACTUsers();
      } else if (cycleInfo?.period === "DEL_TRANSITION") {
        tagToDelCount = await this.updateInactiveTAGUsers();
      } else {
        logger.info(
          `No status updates needed during ${cycleInfo?.period} period`,
        );
      }

      const notificationResult =
        await this.sendStatusChangeWarningNotifications();
      const processingTime = Date.now() - startTime;

      logger.info(
        `=== Status update complete in ${processingTime}ms | TAG: ${actToTagCount} | DEL: ${tagToDelCount} | Notifs: ${notificationResult.sent} ===`,
      );

      return {
        success: true,
        currentCycle: cycleInfo?.cycle,
        cycleName: cycleInfo?.name,
        period: cycleInfo?.period,
        tagToDelCount,
        actToTagCount,
        notificationsSent: notificationResult.sent,
        notificationsFailed: notificationResult.failed,
        processingTime,
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      logger.error(
        `=== Status update FAILED after ${processingTime}ms ===`,
        error,
      );
      return { success: false, error: error.message, processingTime };
    }
  },

  async getUsersApproachingStatusChange() {
    try {
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) {
        return {
          tagUsersNearDeletion: [],
          actUsersNearTagging: [],
          message: "Could not determine current cycle",
        };
      }

      const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);
      let tagUsersNearDeletion = [];
      let actUsersNearTagging = [];

      if (cycleInfo.period === "ACTIVE" && cycleInfo.daysLeftInPeriod <= 7) {
        actUsersNearTagging = await executeQuery(
          `
          SELECT id, email, status,
            COALESCE(form_submitted_at, approved_at, created_at) as last_activity,
            ? as days_until_tagging, ? as cycle_number, ? as cycle_name
          FROM users_tbl 
          WHERE status = 'ACT'
            AND COALESCE(form_submitted_at, approved_at, created_at) < ?
          ORDER BY last_activity ASC
        `,
          [
            cycleInfo.daysLeftInPeriod,
            cycleInfo.cycle,
            cycleInfo.name,
            activePeriodStart,
          ],
        );
      }

      if (cycleInfo.period === "TAG_TRANSITION") {
        tagUsersNearDeletion = await executeQuery(
          `
          SELECT id, email, status,
            COALESCE(status_updated_at, tagged_at, created_at) as last_activity,
            ? as days_until_deletion, ? as cycle_number, ? as cycle_name
          FROM users_tbl 
          WHERE status = 'TAG'
            AND COALESCE(status_updated_at, tagged_at, created_at) < ?
          ORDER BY last_activity ASC
        `,
          [
            cycleInfo.daysLeftInPeriod,
            cycleInfo.cycle,
            cycleInfo.name,
            activePeriodStart,
          ],
        );
      }

      return {
        currentCycle: cycleInfo.cycle,
        cycleName: cycleInfo.name,
        currentPeriod: cycleInfo.period,
        daysLeftInPeriod: cycleInfo.daysLeftInPeriod,
        tagUsersNearDeletion,
        actUsersNearTagging,
      };
    } catch (error) {
      logger.error("Error fetching users approaching status change:", error);
      throw error;
    }
  },

  async getCycleStatistics() {
    try {
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) return null;

      const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);

      const stats = await executeQuery(
        `
        SELECT 
          status,
          COUNT(*) as total,
          SUM(CASE WHEN COALESCE(form_submitted_at, approved_at, created_at) >= ? THEN 1 ELSE 0 END) as submitted_in_active_period,
          SUM(CASE WHEN COALESCE(form_submitted_at, approved_at, created_at) < ?  THEN 1 ELSE 0 END) as not_submitted_in_active_period
        FROM users_tbl
        WHERE status IN ('ACT', 'TAG', 'DEL')
        GROUP BY status
      `,
        [activePeriodStart, activePeriodStart],
      );

      return {
        currentCycle: cycleInfo.cycle,
        cycleName: cycleInfo.name,
        currentPeriod: cycleInfo.period,
        dayOfYear: this.getDayOfYear(),
        daysLeftInPeriod: cycleInfo.daysLeftInPeriod,
        statistics: stats,
      };
    } catch (error) {
      logger.error("Error fetching cycle statistics:", error);
      throw error;
    }
  },
};

// ─── CRON SCHEDULE ────────────────────────────────────────────────────────────

const scheduleStatusUpdates = () => {
  // Run every day at 2:00 AM Manila time
  cron.schedule(
    "0 2 * * *",
    async () => {
      logger.info("Cron: running scheduled status updates");
      await autoStatusChangeService.runStatusUpdates();
    },
    { timezone: "Asia/Manila" },
  );

  logger.info("Status update cron scheduled (daily 2:00 AM Asia/Manila)");
};

// ─── ROUTES ───────────────────────────────────────────────────────────────────

const createManualTriggerRoute = (router) => {
  // Normal cron trigger (respects current period)
  router.post("/admin/trigger-status-update", async (req, res) => {
    try {
      const result = await autoStatusChangeService.runStatusUpdates();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to run status update",
        details: error.message,
      });
    }
  });

  /**
   * MANUAL OVERRIDE — bypasses current period check
   *
   * Body params:
   *   forcePeriod  {string}  "TAG_TRANSITION" or "DEL_TRANSITION"  ← which update to run
   *   dryRun       {boolean} true = preview only, no DB writes (default: true for safety)
   *
   * Examples:
   *   { "forcePeriod": "TAG_TRANSITION", "dryRun": true }   ← preview who gets tagged
   *   { "forcePeriod": "TAG_TRANSITION", "dryRun": false }  ← actually tag them
   *   { "forcePeriod": "DEL_TRANSITION", "dryRun": false }  ← actually delete TAG users
   *
   * IMPORTANT: Run TAG_TRANSITION first, then DEL_TRANSITION
   */
  router.post("/admin/manual-status-update", async (req, res) => {
    try {
      const { forcePeriod, dryRun = true } = req.body;

      if (
        !forcePeriod ||
        !["TAG_TRANSITION", "DEL_TRANSITION"].includes(forcePeriod)
      ) {
        return res.status(400).json({
          success: false,
          error:
            'forcePeriod is required and must be "TAG_TRANSITION" or "DEL_TRANSITION"',
        });
      }

      // Find the most recently completed cycle to use as reference
      // Since Q1 2026 just passed, cycle 1 is the right reference
      const realCycleInfo = autoStatusChangeService.getCurrentCycleInfo();
      const previousCycleNumber = realCycleInfo
        ? realCycleInfo.cycle === 1
          ? 4
          : realCycleInfo.cycle - 1
        : 1;
      const previousCycle = QUARTERLY_CYCLES.find(
        (c) => c.cycle === previousCycleNumber,
      );

      const forcedCycleInfo = {
        cycle: previousCycleNumber,
        name: previousCycle.name,
        period: forcePeriod,
        periodStart: 0,
        periodEnd: 0,
        daysLeftInPeriod: 0,
        nextPeriod: forcePeriod === "TAG_TRANSITION" ? "DEL" : "NEXT_Q_ACTIVE",
        nextPeriodStart: null,
      };

      const activePeriodStart =
        autoStatusChangeService.getActivePeriodStartDate(forcedCycleInfo);

      // Always preview first regardless of dryRun
      const wouldTagUsers = await executeQuery(
        `
        SELECT id, email, COALESCE(form_submitted_at, approved_at, created_at) as last_activity
        FROM users_tbl
        WHERE status = 'ACT'
          AND COALESCE(form_submitted_at, approved_at, created_at) < ?
      `,
        [activePeriodStart],
      );

      const wouldDeleteUsers = await executeQuery(
        `
        SELECT id, email, COALESCE(status_updated_at, tagged_at, created_at) as last_activity
        FROM users_tbl
        WHERE status = 'TAG'
          AND COALESCE(status_updated_at, tagged_at, created_at) < ?
      `,
        [activePeriodStart],
      );

      if (dryRun) {
        return res.json({
          success: true,
          dryRun: true,
          forcedCycle: forcedCycleInfo.name,
          forcedPeriod: forcePeriod,
          activePeriodStart,
          preview: {
            wouldTag: forcePeriod === "TAG_TRANSITION" ? wouldTagUsers : [],
            wouldDelete:
              forcePeriod === "DEL_TRANSITION" ? wouldDeleteUsers : [],
            wouldTagCount:
              forcePeriod === "TAG_TRANSITION" ? wouldTagUsers.length : 0,
            wouldDeleteCount:
              forcePeriod === "DEL_TRANSITION" ? wouldDeleteUsers.length : 0,
          },
          message: "Dry run complete. Set dryRun: false to apply changes.",
        });
      }

      // Apply changes
      let actToTagCount = 0;
      let tagToDelCount = 0;

      if (forcePeriod === "TAG_TRANSITION") {
        const result = await executeQuery(
          `
          UPDATE users_tbl
          SET status = 'TAG', status_updated_at = NOW(), tagged_at = NOW()
          WHERE status = 'ACT'
            AND COALESCE(form_submitted_at, approved_at, created_at) < ?
        `,
          [activePeriodStart],
        );
        actToTagCount = result.affectedRows;
        logger.info(
          `Manual TAG update: ${actToTagCount} users tagged (cycle ${forcedCycleInfo.name})`,
        );
      }

      if (forcePeriod === "DEL_TRANSITION") {
        const result = await executeQuery(
          `
          UPDATE users_tbl
          SET status = 'DEL', status_updated_at = NOW(), deleted_at = NOW()
          WHERE status = 'TAG'
            AND COALESCE(status_updated_at, tagged_at, created_at) < ?
        `,
          [activePeriodStart],
        );
        tagToDelCount = result.affectedRows;
        logger.info(
          `Manual DEL update: ${tagToDelCount} users deleted (cycle ${forcedCycleInfo.name})`,
        );
      }

      res.json({
        success: true,
        dryRun: false,
        forcedCycle: forcedCycleInfo.name,
        forcedPeriod: forcePeriod,
        activePeriodStart,
        actToTagCount,
        tagToDelCount,
        taggedUsers:
          forcePeriod === "TAG_TRANSITION"
            ? wouldTagUsers.map((u) => ({ id: u.id, email: u.email }))
            : [],
        deletedUsers:
          forcePeriod === "DEL_TRANSITION"
            ? wouldDeleteUsers.map((u) => ({ id: u.id, email: u.email }))
            : [],
      });
    } catch (error) {
      logger.error("Manual status update failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Users at risk
  router.get("/admin/users-at-risk", async (req, res) => {
    try {
      const usersAtRisk =
        await autoStatusChangeService.getUsersApproachingStatusChange();
      res.json({ success: true, data: usersAtRisk });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to fetch at-risk users",
        details: error.message,
      });
    }
  });

  // Cycle statistics
  router.get("/admin/cycle-statistics", async (req, res) => {
    try {
      const stats = await autoStatusChangeService.getCycleStatistics();
      res.json({ success: true, data: stats });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to fetch cycle statistics",
        details: error.message,
      });
    }
  });

  // Current cycle info
  router.get("/admin/current-cycle", async (req, res) => {
    try {
      const cycleInfo = autoStatusChangeService.getCurrentCycleInfo();
      res.json({
        success: true,
        data: {
          cycle: cycleInfo?.cycle,
          cycleName: cycleInfo?.name,
          period: cycleInfo?.period,
          dayOfYear: autoStatusChangeService.getDayOfYear(),
          daysLeftInPeriod: cycleInfo?.daysLeftInPeriod,
          nextPeriod: cycleInfo?.nextPeriod,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to fetch current cycle info",
        details: error.message,
      });
    }
  });
};

module.exports = {
  autoStatusChangeService,
  scheduleStatusUpdates,
  createManualTriggerRoute,
  QUARTERLY_CYCLES,
};
