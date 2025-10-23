const cron = require('node-cron');
const { executeQuery, logger } = require('../config/database');
const { sendPushNotificationToUser } = require('./pushNotificationService');

/**
 * Automatic Status Change System - Quarterly Cycles
 * Each cycle has 3 periods: Active, TAG transition, DEL transition
 */

const QUARTERLY_CYCLES = [
  {
    cycle: 1,
    activePeriod: { start: '01-01', end: '03-15' },
    tagPeriod: { start: '03-16', end: '03-20' },
    delPeriod: { start: '03-21', end: '03-31' },
    name: 'Q1 (Jan-Mar)'
  },
  {
    cycle: 2,
    activePeriod: { start: '04-01', end: '06-15' },
    tagPeriod: { start: '06-16', end: '06-20' },
    delPeriod: { start: '06-21', end: '06-30' },
    name: 'Q2 (Apr-Jun)'
  },
  {
    cycle: 3,
    activePeriod: { start: '07-01', end: '09-15' },
    tagPeriod: { start: '09-16', end: '09-20' },
    delPeriod: { start: '09-21', end: '09-30' },
    name: 'Q3 (Jul-Sep)'
  },
  {
    cycle: 4,
    activePeriod: { start: '10-01', end: '12-15' },
    tagPeriod: { start: '12-16', end: '12-20' },
    delPeriod: { start: '12-21', end: '12-31' },
    name: 'Q4 (Oct-Dec)'
  }
];

const autoStatusChangeService = {
  
  /**
   * Parse MM-DD format to day of year
   */
  dateToDayOfYear(dateStr, year) {
    try {
      const [month, day] = dateStr.split('-').map(Number);
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
      logger.error('Error calculating day of year:', error);
      return null;
    }
  },

  /**
   * Get current cycle and period information
   */
  getCurrentCycleInfo(date = new Date()) {
    try {
      const year = date.getFullYear();
      const dayOfYear = this.getDayOfYear(date);

      if (!dayOfYear) {
        logger.error('Could not calculate day of year');
        return null;
      }

      for (const cycle of QUARTERLY_CYCLES) {
        const activeStart = this.dateToDayOfYear(cycle.activePeriod.start, year);
        const activeEnd = this.dateToDayOfYear(cycle.activePeriod.end, year);
        const tagStart = this.dateToDayOfYear(cycle.tagPeriod.start, year);
        const tagEnd = this.dateToDayOfYear(cycle.tagPeriod.end, year);
        const delStart = this.dateToDayOfYear(cycle.delPeriod.start, year);
        const delEnd = this.dateToDayOfYear(cycle.delPeriod.end, year);

        // Check ACTIVE period
        if (dayOfYear >= activeStart && dayOfYear <= activeEnd) {
          return {
            cycle: cycle.cycle,
            name: cycle.name,
            period: 'ACTIVE',
            periodStart: activeStart,
            periodEnd: activeEnd,
            daysLeftInPeriod: activeEnd - dayOfYear,
            nextPeriod: 'TAG',
            nextPeriodStart: tagStart
          };
        }

        // Check TAG period
        if (dayOfYear >= tagStart && dayOfYear <= tagEnd) {
          return {
            cycle: cycle.cycle,
            name: cycle.name,
            period: 'TAG_TRANSITION',
            periodStart: tagStart,
            periodEnd: tagEnd,
            daysLeftInPeriod: tagEnd - dayOfYear,
            nextPeriod: 'DEL',
            nextPeriodStart: delStart
          };
        }

        // Check DEL period
        if (dayOfYear >= delStart && dayOfYear <= delEnd) {
          return {
            cycle: cycle.cycle,
            name: cycle.name,
            period: 'DEL_TRANSITION',
            periodStart: delStart,
            periodEnd: delEnd,
            daysLeftInPeriod: delEnd - dayOfYear,
            nextPeriod: cycle.cycle === 4 ? 'Q1_ACTIVE' : 'NEXT_Q_ACTIVE',
            nextPeriodStart: null
          };
        }
      }

      logger.warn(`Day ${dayOfYear} does not fall within any defined cycle period`);
      return null;
    } catch (error) {
      logger.error('Error getting current cycle info:', error);
      return null;
    }
  },

  /**
   * Get the active period start date for current cycle
   */
  getActivePeriodStartDate(cycleInfo) {
    if (!cycleInfo) return null;
    const year = new Date().getFullYear();
    const cycle = QUARTERLY_CYCLES.find(c => c.cycle === cycleInfo.cycle);
    if (!cycle) return null;

    const [month, day] = cycle.activePeriod.start.split('-').map(Number);
    return new Date(year, month - 1, day);
  },

  /**
   * Check if user has submitted during active period of current cycle
   */
  hasSubmittedInActivePeriod(lastSubmissionDate, cycleInfo) {
    if (!lastSubmissionDate || !cycleInfo) return false;
    
    const lastSubmission = new Date(lastSubmissionDate);
    const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);
    
    if (!activePeriodStart) return false;

    // Check if submission was during this cycle's active period
    return lastSubmission >= activePeriodStart;
  },

  /**
   * 🔔 NEW: Send notifications to users about upcoming status changes
   */
  async sendStatusChangeWarningNotifications() {
    try {
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) {
        logger.warn('Could not determine current cycle');
        return { sent: 0, failed: 0 };
      }

      const daysLeft = cycleInfo.daysLeftInPeriod;

      let notificationsSent = 0;
      let notificationsFailed = 0;

      // SCENARIO 1: During ACTIVE period - Warn ACT users at 30 and 15 days before tagging
      if (cycleInfo.period === 'ACTIVE' && (daysLeft === 30 || daysLeft === 15)) {        
        const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);
        const inactiveUsers = await executeQuery(`
          SELECT id, email 
          FROM users_tbl 
          WHERE status = 'ACT'
            AND COALESCE(form_submitted_at, approved_at, created_at) < ?
        `, [activePeriodStart]);

        for (const user of inactiveUsers) {
          const title = '⚠️ Account Status Warning';
          const body = `You have ${daysLeft} days left to submit a form to keep your account active. Without submission, your account will be tagged for deletion.`;
          const data = {
            type: 'status_warning',
            daysLeft: String(daysLeft),
            currentStatus: 'ACT',
            nextStatus: 'TAG',
            screen: 'Home'
          };

          try {
            const result = await sendPushNotificationToUser(user.id, title, body, data);
            if (result.success) {
              notificationsSent++;
            } else {
              notificationsFailed++;
              logger.warn(`❌ Failed to send warning to user ${user.id}: ${result.error}`);
            }
          } catch (error) {
            notificationsFailed++;
            logger.error(`❌ Error sending notification to user ${user.id}:`, error);
          }

          // Small delay to avoid overwhelming the notification service
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // SCENARIO 2: First day of TAG period - Notify users they've been tagged
      if (cycleInfo.period === 'TAG_TRANSITION' && daysLeft === (cycleInfo.periodEnd - cycleInfo.periodStart)) {

        const taggedUsers = await executeQuery(`
          SELECT id, email 
          FROM users_tbl 
          WHERE status = 'TAG'
            AND DATE(tagged_at) = CURDATE()
        `);

        for (const user of taggedUsers) {
          const title = '🏷️ Account Tagged for Deletion';
          const body = 'Your account has been tagged for deletion due to inactivity. Submit a form within the next few days to restore your active status.';
          const data = {
            type: 'status_changed',
            currentStatus: 'TAG',
            nextStatus: 'DEL',
            screen: 'Profile'
          };

          try {
            const result = await sendPushNotificationToUser(user.id, title, body, data);
            if (result.success) {
              notificationsSent++;
            } else {
              notificationsFailed++;
            }
          } catch (error) {
            notificationsFailed++;
            logger.error(`❌ Error sending TAG notification to user ${user.id}:`, error);
          }

          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // SCENARIO 3: First day of DEL period - Notify users they've been deleted
      if (cycleInfo.period === 'DEL_TRANSITION' && daysLeft === (cycleInfo.periodEnd - cycleInfo.periodStart)) {

        const deletedUsers = await executeQuery(`
          SELECT id, email 
          FROM users_tbl 
          WHERE status = 'DEL'
            AND DATE(deleted_at) = CURDATE()
        `);

        for (const user of deletedUsers) {
          const title = '🗑️ Account Deleted';
          const body = 'Your account has been deleted due to inactivity. You may contact support to restore your account.';
          const data = {
            type: 'status_changed',
            currentStatus: 'DEL',
            screen: 'Profile'
          };

          try {
            const result = await sendPushNotificationToUser(user.id, title, body, data);
            if (result.success) {
              notificationsSent++;
            } else {
              notificationsFailed++;
            }
          } catch (error) {
            notificationsFailed++;
            logger.error(`❌ Error sending DEL notification to user ${user.id}:`, error);
          }

          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      return {
        sent: notificationsSent,
        failed: notificationsFailed,
        daysLeft,
        period: cycleInfo.period
      };

    } catch (error) {
      logger.error('Error sending status change warning notifications:', error);
      throw error;
    }
  },

  /**
   * Update TAG users to DEL during DEL transition periods
   */
  async updateInactiveTAGUsers() {
    try {
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) {
        logger.warn('Could not determine current cycle');
        return 0;
      }

      // Only process during DEL transition periods
      if (cycleInfo.period !== 'DEL_TRANSITION') {
        return 0;
      }

      const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);

      const result = await executeQuery(`
        UPDATE users_tbl 
        SET 
          status = 'DEL',
          status_updated_at = NOW(),
          deleted_at = NOW()
        WHERE status = 'TAG'
          AND (
            -- No activity during active period of current cycle
            COALESCE(status_updated_at, tagged_at, created_at) < ?
          )
      `, [activePeriodStart]);

      if (result.affectedRows > 0) {        
        const deletedUsers = await executeQuery(`
          SELECT id, email, status_updated_at, tagged_at, created_at
          FROM users_tbl 
          WHERE status = 'DEL' 
            AND deleted_at >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)
        `);
        
        logger.info('Deleted users:', deletedUsers.map(u => ({
          id: u.id,
          email: u.email,
          lastActivity: u.status_updated_at || u.tagged_at || u.created_at
        })));
      } else {
      }

      return result.affectedRows;
    } catch (error) {
      logger.error('Error updating TAG users to DEL:', error);
      throw error;
    }
  },

  /**
   * Update ACT users to TAG during TAG transition periods
   */
  async updateInactiveACTUsers() {
    try {
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) {
        logger.warn('Could not determine current cycle');
        return 0;
      }


      // Only process during TAG transition periods
      if (cycleInfo.period !== 'TAG_TRANSITION') {
        return 0;
      }

      const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);

      const result = await executeQuery(`
        UPDATE users_tbl 
        SET 
          status = 'TAG',
          status_updated_at = NOW(),
          tagged_at = NOW()
        WHERE status = 'ACT'
          AND (
            -- No form submission during active period of current cycle
            COALESCE(form_submitted_at, approved_at, created_at) < ?
          )
      `, [activePeriodStart]);

      if (result.affectedRows > 0) {
        
        const taggedUsers = await executeQuery(`
          SELECT id, email, form_submitted_at, approved_at, created_at
          FROM users_tbl 
          WHERE status = 'TAG' 
            AND tagged_at >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)
        `);
        
        logger.info('Tagged users:', taggedUsers.map(u => ({
          id: u.id,
          email: u.email,
          lastActivity: u.form_submitted_at || u.approved_at || u.created_at
        })));
      } else {
      }

      return result.affectedRows;
    } catch (error) {
      logger.error('Error updating ACT users to TAG:', error);
      throw error;
    }
  },

  async runStatusUpdates() {
    const startTime = Date.now();
    const cycleInfo = this.getCurrentCycleInfo();
    try {
      let tagToDelCount = 0;
      let actToTagCount = 0;

      // Run appropriate updates based on current period
      if (cycleInfo?.period === 'TAG_TRANSITION') {
        actToTagCount = await this.updateInactiveACTUsers();
      } else if (cycleInfo?.period === 'DEL_TRANSITION') {
        tagToDelCount = await this.updateInactiveTAGUsers();
      } else {
      }

      // 🔔 NEW: Send warning notifications
      const notificationResult = await this.sendStatusChangeWarningNotifications();

      const processingTime = Date.now() - startTime;
      return {
        success: true,
        currentCycle: cycleInfo?.cycle,
        cycleName: cycleInfo?.name,
        period: cycleInfo?.period,
        tagToDelCount,
        actToTagCount,
        notificationsSent: notificationResult.sent,
        notificationsFailed: notificationResult.failed,
        processingTime
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      logger.error(`=== Status Update Job Failed after ${processingTime}ms ===`);
      logger.error(error);
      
      return {
        success: false,
        error: error.message,
        processingTime
      };
    }
  },

  async getUsersApproachingStatusChange() {
    try {
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) {
        return { 
          tagUsersNearDeletion: [], 
          actUsersNearTagging: [],
          message: 'Could not determine current cycle'
        };
      }

      const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);
      let tagUsersNearDeletion = [];
      let actUsersNearTagging = [];

      // During ACTIVE period, show ACT users who will be tagged soon
      if (cycleInfo.period === 'ACTIVE' && cycleInfo.daysLeftInPeriod <= 7) {
        actUsersNearTagging = await executeQuery(`
          SELECT 
            id, 
            email, 
            status,
            COALESCE(form_submitted_at, approved_at, created_at) as last_activity,
            ? as days_until_tagging,
            ? as cycle_number,
            ? as cycle_name
          FROM users_tbl 
          WHERE status = 'ACT'
            AND COALESCE(form_submitted_at, approved_at, created_at) < ?
          ORDER BY last_activity ASC
        `, [cycleInfo.daysLeftInPeriod, cycleInfo.cycle, cycleInfo.name, activePeriodStart]);
      }

      // During TAG period, show TAG users who will be deleted soon
      if (cycleInfo.period === 'TAG_TRANSITION') {
        tagUsersNearDeletion = await executeQuery(`
          SELECT 
            id, 
            email, 
            status,
            COALESCE(status_updated_at, tagged_at, created_at) as last_activity,
            ? as days_until_deletion,
            ? as cycle_number,
            ? as cycle_name
          FROM users_tbl 
          WHERE status = 'TAG'
            AND COALESCE(status_updated_at, tagged_at, created_at) < ?
          ORDER BY last_activity ASC
        `, [cycleInfo.daysLeftInPeriod, cycleInfo.cycle, cycleInfo.name, activePeriodStart]);
      }

      return {
        currentCycle: cycleInfo.cycle,
        cycleName: cycleInfo.name,
        currentPeriod: cycleInfo.period,
        daysLeftInPeriod: cycleInfo.daysLeftInPeriod,
        tagUsersNearDeletion,
        actUsersNearTagging
      };
    } catch (error) {
      logger.error('Error fetching users approaching status change:', error);
      throw error;
    }
  },

  /**
   * Get statistics for current cycle
   */
  async getCycleStatistics() {
    try {
      const cycleInfo = this.getCurrentCycleInfo();
      if (!cycleInfo) {
        return null;
      }

      const activePeriodStart = this.getActivePeriodStartDate(cycleInfo);

      const stats = await executeQuery(`
        SELECT 
          status,
          COUNT(*) as total,
          SUM(CASE 
            WHEN COALESCE(form_submitted_at, approved_at, created_at) >= ?
            THEN 1 
            ELSE 0 
          END) as submitted_in_active_period,
          SUM(CASE 
            WHEN COALESCE(form_submitted_at, approved_at, created_at) < ?
            THEN 1 
            ELSE 0 
          END) as not_submitted_in_active_period
        FROM users_tbl
        WHERE status IN ('ACT', 'TAG', 'DEL')
        GROUP BY status
      `, [activePeriodStart, activePeriodStart]);

      return {
        currentCycle: cycleInfo.cycle,
        cycleName: cycleInfo.name,
        currentPeriod: cycleInfo.period,
        dayOfYear: this.getDayOfYear(),
        daysLeftInPeriod: cycleInfo.daysLeftInPeriod,
        statistics: stats
      };
    } catch (error) {
      logger.error('Error fetching cycle statistics:', error);
      throw error;
    }
  }
};

const scheduleStatusUpdates = () => {  
  // Run every day at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    await autoStatusChangeService.runStatusUpdates();
  }, {
    timezone: "Asia/Manila"
  });
};

const createManualTriggerRoute = (router) => {
  // Manual trigger for status updates
  router.post('/admin/trigger-status-update', async (req, res) => {
    try {
      const result = await autoStatusChangeService.runStatusUpdates();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to run status update',
        details: error.message
      });
    }
  });

  // 🔔 NEW: Manual trigger for notifications only
  router.post('/admin/trigger-warning-notifications', async (req, res) => {
    try {
      const result = await autoStatusChangeService.sendStatusChangeWarningNotifications();
      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to send warning notifications',
        details: error.message
      });
    }
  });

  // Get users at risk of status change
  router.get('/admin/users-at-risk', async (req, res) => {
    try {
      const usersAtRisk = await autoStatusChangeService.getUsersApproachingStatusChange();
      res.json({
        success: true,
        data: usersAtRisk
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch at-risk users',
        details: error.message
      });
    }
  });

  // Get current cycle statistics
  router.get('/admin/cycle-statistics', async (req, res) => {
    try {
      const stats = await autoStatusChangeService.getCycleStatistics();
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch cycle statistics',
        details: error.message
      });
    }
  });

  // Get current cycle info
  router.get('/admin/current-cycle', async (req, res) => {
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
          nextPeriod: cycleInfo?.nextPeriod
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch current cycle info',
        details: error.message
      });
    }
  });
};

module.exports = {
  autoStatusChangeService,
  scheduleStatusUpdates,
  createManualTriggerRoute,
  QUARTERLY_CYCLES
};